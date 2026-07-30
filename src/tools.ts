/**
 * The Owner's process tools. The state machine is enforced here, in code:
 * gates recompute hashes and verdict freshness mechanically — the Owner cannot
 * advance by assertion.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ChildSpec, runChild, runPool } from "./spawn.ts";
import { type Gate, type GateReport, storeFor, type Verdict } from "./state.ts";
import {
	buildTaskContext,
	buildVerifierPrompt,
	discoverVerifiers,
	formatVerdictLine,
	parseVerdict,
	type VerifierDef,
	verifiersForGate,
} from "./verifiers.ts";

const DEFAULT_CONCURRENCY = 9;
const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_INACTIVITY_MINUTES = 3;
const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const WORKER_PROMPT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "agents", "worker.md"), "utf8").trim();

export interface LiveActivity {
	/** name → short status, shown live in the widget while children run */
	children: Map<string, string>;
	onChange: (ctx: ExtensionContext) => void;
	initialInput?: (cwd: string) => { text: string; images?: { data: string; mimeType: string }[] } | undefined;
	clearInitialInput?: (cwd: string) => void;
}

function resolveModel(ctx: ExtensionContext, kind: "verifier" | "worker", override?: string, verifierName?: string): string {
	const config = storeFor(ctx.cwd).loadConfig();
	const model =
		override ??
		(kind === "verifier" && verifierName ? config.verifierModels?.[verifierName] : undefined) ??
		(kind === "verifier" ? config.verifierModel : config.workerModel) ??
		config.model ??
		(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (!model) {
		throw new Error(
			"No model available for spawned agents. Set `model` (\"provider/model\") in .pi/council/config.json.",
		);
	}
	return model;
}

function childSettings(ctx: ExtensionContext): { concurrency: number; timeoutMs: number; inactivityMs: number } {
	const config = storeFor(ctx.cwd).loadConfig();
	return {
		concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
		timeoutMs: (config.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60 * 1000,
		inactivityMs: (config.inactivityMinutes ?? DEFAULT_INACTIVITY_MINUTES) * 60 * 1000,
	};
}

function persistImages(store: ReturnType<typeof storeFor>, taskId: string, prefix: string, images: { data: string; mimeType: string }[]) {
	const dir = path.join(store.taskDir(taskId), "attachments");
	fs.mkdirSync(dir, { recursive: true });
	return images.map((image, index) => {
		const extension = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
		const relative = `attachments/${prefix}-${index}.${extension}`;
		fs.writeFileSync(path.join(store.taskDir(taskId), relative), Buffer.from(image.data, "base64"));
		return { path: relative, mediaType: image.mimeType };
	});
}

function fingerprints(defs: VerifierDef[]): Map<string, string> {
	return new Map(defs.map((def) => [def.name, def.fingerprint]));
}

function persistActivity(ctx: ExtensionContext, live: LiveActivity): void {
	try {
		const store = storeFor(ctx.cwd);
		const task = store.mustCurrent();
		const now = new Date().toISOString();
		store.writeActivity({
			taskId: task.id,
			updatedAt: now,
			children: [...live.children.entries()].map(([key, detail]) => ({ id: key, kind: key.startsWith("worker:") ? "worker" : "verifier", name: key, status: "running", startedAt: now, updatedAt: now, detail })),
		});
	} catch { /* projection failure must not break agent execution */ }
}

function gateSummary(report: GateReport): string {
	const parts = report.verifiers.map((v) => `${v.name}=${v.state}`);
	return `${report.gate} gate ${report.holds ? "HOLDS" : "does NOT hold"} (hash ${report.hash}): ${parts.join(", ")}`;
}

function blockersText(report: GateReport): string {
	const blockers = report.verifiers.filter((v) => v.state !== "go");
	const lines = blockers.map((v) => {
			if (v.state === "no-go" && v.verdict) return `- ${v.name} (no-go):\n${v.verdict.comments.map((c) => `    - ${c}`).join("\n")}`;
			if (v.state === "stale") return `- ${v.name}: approval is stale (content changed since verdict) — re-source it`;
			return `- ${v.name}: not yet sourced`;
		});
	if (report.pendingInputIds?.length) lines.unshift(`- pending user input must be recorded: ${report.pendingInputIds.join(", ")}`);
	return lines.join("\n");
}

export function registerTools(pi: ExtensionAPI, live: LiveActivity): void {
	pi.registerTool({
		name: "task_set",
		label: "Finalize task requirements",
		description:
			"Finalize the captured council task with the verbatim statement plus derived requirements. One task at a time; the statement is immutable afterwards.",
		parameters: Type.Object({
			statement: Type.String({ description: "The user's task statement, verbatim" }),
			requirements: Type.Array(Type.String(), {
				description: "Complete list of checkable requirements derived from the statement",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.requirements.length === 0) throw new Error("Derive at least one requirement.");
			const captured = live.initialInput?.(ctx.cwd);
			if (captured && params.statement !== captured.text) {
				throw new Error("The task statement must exactly match the user's captured first message.");
			}
			const store = storeFor(ctx.cwd);
			const task = await store.createTask(params.statement, params.requirements);
			if (captured?.images?.length) store.setTaskAttachments(persistImages(store, task.id, "task", captured.images));
			live.clearInitialInput?.(ctx.cwd);
			live.onChange(ctx);
			const panel = discoverVerifiers(ctx.cwd);
			return {
				content: [
					{
						type: "text",
						text: [
							`Task #${task.id} created (base ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)}) with ${task.requirements.length} requirements.`,
							`Verifier panel: ${panel.map((v) => v.name).join(", ")}.`,
							"Next: investigate, then write the design with design_write and source the design gate with request_verdicts.",
						].join("\n"),
					},
				],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "task_requirements_add",
		label: "Append requirements",
		description:
			"Append new requirements to the active task (from a mid-task user message, or discovered constraints). Requirements are append-only. This stales all existing gate approvals — you must propagate the change and re-source.",
		parameters: Type.Object({
			requirements: Type.Array(Type.String(), { description: "Requirements to append, each checkable" }),
			inputIds: Type.Optional(Type.Array(Type.String(), { description: "Captured pending-input IDs acknowledged by these requirements" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.requirements.length === 0) throw new Error("Nothing to append.");
			const store = storeFor(ctx.cwd);
			const task = store.addRequirements(params.requirements, params.inputIds ?? []);
			live.onChange(ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							`Appended ${params.requirements.length} requirement(s); task #${task.id} now has ${task.requirements.length}.`,
							"All prior verdicts are now stale by hash. Propagate: update design.md if affected, update the implementation, then re-source verdicts (gate_status shows what is stale).",
						].join("\n"),
					},
				],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "design_write",
		label: "Write design",
		description:
			"Write (or fully rewrite) the task's design document. The design must state what will change, the contracts involved, and how each requirement is addressed. Editing the design stales prior approvals of it.",
		parameters: Type.Object({
			content: Type.String({ description: "Full markdown content of design.md" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			store.writeDesign(params.content);
			const hash = await store.designHash();
			live.onChange(ctx);
			return {
				content: [
					{
						type: "text",
						text: `design.md written (${params.content.length} chars). Design-gate content hash is now ${hash}; source or re-source verdicts with request_verdicts.`,
					},
				],
				details: { hash },
			};
		},
	});

	pi.registerTool({
		name: "dispatch_workers",
		label: "Dispatch workers",
		description:
			"Dispatch transient worker agents in parallel for independent chunks of work (research, implementation slices, test runs). Each worker is a fresh headless agent that receives the task context plus your instructions, and reports back its final message. No memory between dispatches.",
		parameters: Type.Object({
			workers: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short unique name for this worker (shown in status)" }),
					instructions: Type.String({ description: "Complete, self-contained instructions for the worker" }),
					tools: Type.Optional(
						Type.String({ description: "Comma-separated tool allowlist (default: read,bash,edit,write,grep,find,ls)" }),
					),
					model: Type.Optional(Type.String({ description: "Optional provider/model override for this worker" })),
				}),
				{ description: "Workers to run in parallel" },
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			const task = store.mustCurrent();
			if (params.workers.length === 0) throw new Error("Dispatch at least one worker.");
			const names = params.workers.map((worker) => worker.name.trim());
			if (names.some((name) => !name) || new Set(names).size !== names.length) {
				throw new Error("Worker names must be non-empty and unique.");
			}
			for (const worker of params.workers) {
				if (!worker.instructions.trim()) throw new Error(`Worker ${worker.name} instructions must not be empty.`);
				if (worker.model !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(worker.model)) throw new Error(`Worker ${worker.name} model must be provider/model.`);
				const requestedTools = worker.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
				if (worker.tools !== undefined && (!requestedTools?.length || requestedTools.some((tool) => !DEFAULT_WORKER_TOOLS.includes(tool)))) {
					throw new Error(`Worker ${worker.name} tools must be a non-empty subset of ${DEFAULT_WORKER_TOOLS.join(",")}.`);
				}
			}
			const context = await buildTaskContext(store, task);
			const all = discoverVerifiers(ctx.cwd);
			const designDefs = verifiersForGate(all, "design");
			const designReport = await store.gateReport("design", designDefs.map((v) => v.name), fingerprints(designDefs));
			if (designReport.holds && (await store.currentBranch()) === task.baseBranch) {
				throw new Error(`Implementation workers are blocked on base branch ${task.baseBranch}. Next: switch to a dedicated work branch.`);
			}
			const isolatedRoot = designReport.holds ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "council-worker-"));
			if (isolatedRoot) execFileSync("git", ["clone", "--quiet", "--no-hardlinks", store.cwd, isolatedRoot]);
			const { concurrency, timeoutMs, inactivityMs } = childSettings(ctx);

			const emit = () => {
				persistActivity(ctx, live);
				live.onChange(ctx);
				onUpdate?.({
					content: [{ type: "text", text: [...live.children.entries()].map(([n, s]) => `${n}: ${s}`).join("\n") }],
					details: {},
				});
			};

			const results = await runPool(params.workers, concurrency, async (worker) => {
				const key = `worker:${worker.name}`;
				live.children.set(key, "starting");
				emit();
				const spec: ChildSpec = {
					name: worker.name,
					systemPrompt: [WORKER_PROMPT, "", context].join("\n"),
					prompt: worker.instructions,
					tools: worker.tools
						? worker.tools.split(",").map((t) => t.trim()).filter(Boolean)
						: DEFAULT_WORKER_TOOLS,
					kind: "worker",
					model: resolveModel(ctx, "worker", worker.model),
					cwd: isolatedRoot ?? ctx.cwd,
					timeoutMs,
					inactivityMs,
				};
				const result = await runChild(spec, signal, (p) => {
					live.children.set(key, `${p.lastActivity} (turn ${p.turns + 1})`);
					emit();
				});
				store.appendSpend({ at: new Date().toISOString(), kind: "worker", name: worker.name, model: spec.model, tokens: result.tokens, costUsd: result.costUsd, status: result.ok ? "ok" : result.errorMessage === "aborted" ? "aborted" : "failed" });
				live.children.delete(key);
				emit();
				return result;
			});

			if (isolatedRoot) fs.rmSync(isolatedRoot, { recursive: true, force: true });
			const failed = results.filter((r) => !r.ok);
			const sections = results.map(
				(r) =>
					`### ${r.name} — ${r.ok ? "completed" : `FAILED (${r.errorMessage ?? r.stopReason})`}\n\n${r.output || "(no output)"}`,
			);
			if (failed.length === results.length) throw new Error(`All workers failed:\n${sections.join("\n\n")}`);
			return {
				content: [
					{
						type: "text",
						text: `${results.length - failed.length}/${results.length} workers succeeded.\n\n${sections.join("\n\n---\n\n")}`,
					},
				],
				details: { results },
			};
		},
	});

	pi.registerTool({
		name: "request_verdicts",
		label: "Request verdicts",
		description:
			"Fan out the verifier panel for a gate. All applicable verifiers run in parallel, each fresh (own system prompt + repo status + task only), and return go/no-go with comments. Verdicts are pinned to the current content hash. Pass `verifiers` to re-source a subset after addressing their comments; omit it to run the full panel.",
		parameters: Type.Object({
			gate: StringEnum(["design", "implementation"] as const, { description: "Which gate to source" }),
			verifiers: Type.Optional(
				Type.Array(Type.String(), { description: "Subset of verifier names to (re-)run; default: all applicable" }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			const task = store.mustCurrent();
			const gate = params.gate as Gate;
			const all = discoverVerifiers(ctx.cwd);
			const applicable = verifiersForGate(all, gate);

			if (gate === "design" && !store.readDesign()) {
				throw new Error("No design.md yet — write the design with design_write before sourcing the design gate.");
			}
			if (gate === "implementation") {
				const designDefs = verifiersForGate(all, "design");
				const designReport = await store.gateReport("design", designDefs.map((v) => v.name), fingerprints(designDefs));
				if (!designReport.holds) {
					throw new Error(
						`The design gate must hold before sourcing the implementation gate.\n${gateSummary(designReport)}\n${blockersText(designReport)}`,
					);
				}
				const branch = await store.currentBranch();
				if (branch === task.baseBranch) throw new Error(`Implementation review is blocked on base branch ${branch}. Next: switch to a dedicated work branch.`);
				const changes = await store.worktreeChanges();
				if (changes.length) throw new Error(`Implementation review requires a clean worktree. Commit or remove:\n${changes.join("\n")}`);
			}

			let panel: VerifierDef[];
			if (params.verifiers && new Set(params.verifiers).size !== params.verifiers.length) throw new Error("Verifier names must be unique.");
			if (params.verifiers && params.verifiers.length > 0) {
				panel = params.verifiers.map((name) => {
					const def = applicable.find((v) => v.name === name);
					if (!def) {
						throw new Error(
							`Unknown or inapplicable verifier "${name}" for the ${gate} gate. Applicable: ${applicable.map((v) => v.name).join(", ")}.`,
						);
					}
					return def;
				});
			} else {
				panel = applicable;
			}

			const hash = await store.gateHash(gate);
			const { concurrency, timeoutMs, inactivityMs } = childSettings(ctx);

			const emit = () => {
				persistActivity(ctx, live);
				live.onChange(ctx);
				onUpdate?.({
					content: [{ type: "text", text: [...live.children.entries()].map(([n, s]) => `${n}: ${s}`).join("\n") }],
					details: {},
				});
			};

			const verdicts = await runPool(panel, concurrency, async (def) => {
				const key = `${gate}:${def.name}`;
				live.children.set(key, "reviewing");
				emit();
				const result = await runChild(
					{
						name: def.name,
						systemPrompt: def.systemPrompt,
						kind: "verifier",
						prompt: await buildVerifierPrompt(store, task, gate, def.name, def.fingerprint, def.browser),
						tools: def.tools,
						model: resolveModel(ctx, "verifier", def.model, def.name),
						cwd: ctx.cwd,
						timeoutMs,
						inactivityMs,
					},
					signal,
					(p) => {
						live.children.set(key, `${p.lastActivity} (turn ${p.turns + 1})`);
						emit();
					},
				);
				store.appendSpend({ at: new Date().toISOString(), kind: "verifier", name: def.name, model: resolveModel(ctx, "verifier", def.model, def.name), tokens: result.tokens, costUsd: result.costUsd, status: result.ok ? "ok" : result.errorMessage === "aborted" ? "aborted" : "failed" });
				live.children.delete(key);
				const parsed = result.ok
					? parseVerdict(result.output)
					: {
							verdict: "no-go" as const,
							comments: [`Verifier run failed: ${result.errorMessage ?? result.stopReason ?? "unknown error"}`],
							parseError: true,
						};
				const verdict: Verdict = {
					gate,
					verifier: def.name,
					fingerprint: def.fingerprint,
					verdict: parsed.verdict,
					comments: parsed.comments,
					hash,
					at: new Date().toISOString(),
					...(parsed.parseError ? { parseError: true } : {}),
				};
				store.appendVerdict(verdict);
				emit();
				return verdict;
			});

			const report = await store.gateReport(gate, applicable.map((v) => v.name), fingerprints(applicable));
			live.onChange(ctx);
			const lines = verdicts.map((v) => formatVerdictLine(v));
			return {
				content: [
					{
						type: "text",
						text: [
							`Sourced ${verdicts.length} verdict(s) for the ${gate} gate (pinned to hash ${hash}):`,
							...lines.map((l) => `- ${l}`),
							"",
							gateSummary(report),
							...(report.holds ? [] : ["", "Blockers:", blockersText(report)]),
						].join("\n"),
					},
				],
				details: { verdicts, report },
			};
		},
	});

	pi.registerTool({
		name: "gate_status",
		label: "Gate status",
		description:
			"Recompute both gates against current content: per-verifier go / no-go / stale / pending, and exactly what each gate is blocked on. Use after any change to see which approvals you staled.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			store.mustCurrent();
			const all = discoverVerifiers(ctx.cwd);
			const sections: string[] = [];
			for (const gate of ["design", "implementation"] as Gate[]) {
				const defs = verifiersForGate(all, gate);
				const report = await store.gateReport(gate, defs.map((v) => v.name), fingerprints(defs));
				sections.push(gateSummary(report));
				const blockers = blockersText(report);
				if (blockers) sections.push(blockers);
			}
			return { content: [{ type: "text", text: sections.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "task_kill",
		label: "Kill task",
		description: "Permanently end and archive the active task after an explicit user kill request.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			const task = store.close("killed");
			live.onChange(ctx);
			const record = `.pi/council/tasks/${task.id}/`;
			return {
				content: [{ type: "text", text: `Task #${task.id} killed permanently. Record: ${record} The next message starts a new task.` }],
				details: { task },
			};
		},
	});

	pi.registerTool({
		name: "task_complete",
		label: "Complete task",
		description:
			"Request task completion. Succeeds only when both gates hold with fresh all-GO verdicts; otherwise it refuses and lists exactly what is blocking.",
		parameters: Type.Object({
			summary: Type.String({ description: "Short summary of what shipped, for the task record" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			store.mustCurrent();
			const all = discoverVerifiers(ctx.cwd);
			const changes = await store.worktreeChanges();
			if (changes.length) throw new Error(`Completion requires a clean reviewed worktree. Commit or remove:\n${changes.join("\n")}`);
			const failures: string[] = [];
			const finalReports = new Map<Gate, { report: GateReport; defs: VerifierDef[] }>();
			for (const gate of ["design", "implementation"] as Gate[]) {
				const defs = verifiersForGate(all, gate);
				const report = await store.gateReport(gate, defs.map((v) => v.name), fingerprints(defs));
				finalReports.set(gate, { report, defs });
				if (!report.holds) failures.push(`${gateSummary(report)}\n${blockersText(report)}`);
			}
			if (failures.length > 0) {
				throw new Error(`Refused — gates do not hold.\n\n${failures.join("\n\n")}`);
			}
			if (!params.summary.trim()) throw new Error("Completion summary must not be empty.");
			const taskBeforeClose = store.mustCurrent();
			const project = (gate: Gate) => {
				const { report, defs } = finalReports.get(gate)!;
				const definitions = new Map(defs.map((def) => [def.name, def.fingerprint]));
				return { hash: report.hash, holds: report.holds, verifiers: report.verifiers.map((verifier) => ({ name: verifier.name, fingerprint: definitions.get(verifier.name)!, state: verifier.state, ...(verifier.verdict?.comments.length ? { comments: verifier.verdict.comments } : {}) })) };
			};
			const now = new Date().toISOString();
			store.writeStatus({ taskId: taskBeforeClose.id, phase: "IMPL_GATE", generatedAt: now, heartbeatAt: now, pendingInputIds: [], blockers: [], spend: store.spendTotals(), design: project("design"), implementation: project("implementation") });
			const task = store.close("done", params.summary.trim());
			live.onChange(ctx);
			const record = `.pi/council/tasks/${task.id}/`;
			return {
				content: [{ type: "text", text: `Task #${task.id} complete: ${params.summary.trim()}\nRecord: ${record}\nThe next message starts a new task.` }],
				details: { task },
			};
		},
	});
}
