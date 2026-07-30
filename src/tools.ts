/**
 * The Owner's process tools. The state machine is enforced here, in code:
 * gates recompute hashes and verdict freshness mechanically — the Owner cannot
 * advance by assertion.
 */

import { StringEnum } from "@earendil-works/pi-ai";
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

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface LiveActivity {
	/** name → short status, shown live in the widget while children run */
	children: Map<string, string>;
	onChange: (ctx: ExtensionContext) => void;
}

function resolveModel(ctx: ExtensionContext, kind: "verifier" | "worker", override?: string): string {
	const config = storeFor(ctx.cwd).loadConfig();
	const model =
		override ??
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

function childSettings(ctx: ExtensionContext): { concurrency: number; timeoutMs: number } {
	const config = storeFor(ctx.cwd).loadConfig();
	return {
		concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
		timeoutMs: (config.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60 * 1000,
	};
}

function gateSummary(report: GateReport): string {
	const parts = report.verifiers.map((v) => `${v.name}=${v.state}`);
	return `${report.gate} gate ${report.holds ? "HOLDS" : "does NOT hold"} (hash ${report.hash}): ${parts.join(", ")}`;
}

function blockersText(report: GateReport): string {
	const blockers = report.verifiers.filter((v) => v.state !== "go");
	if (blockers.length === 0) return "";
	return blockers
		.map((v) => {
			if (v.state === "no-go" && v.verdict) return `- ${v.name} (no-go):\n${v.verdict.comments.map((c) => `    - ${c}`).join("\n")}`;
			if (v.state === "stale") return `- ${v.name}: approval is stale (content changed since verdict) — re-source it`;
			return `- ${v.name}: not yet sourced`;
		})
		.join("\n");
}

export function registerTools(pi: ExtensionAPI, live: LiveActivity): void {
	pi.registerTool({
		name: "task_set",
		label: "Set task",
		description:
			"Create the council task from the user's message: the verbatim statement plus the requirements you derived from it. One task at a time; the statement is immutable afterwards.",
		parameters: Type.Object({
			statement: Type.String({ description: "The user's task statement, verbatim" }),
			requirements: Type.Array(Type.String(), {
				description: "Complete list of checkable requirements derived from the statement",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.requirements.length === 0) throw new Error("Derive at least one requirement.");
			const store = storeFor(ctx.cwd);
			const task = await store.createTask(params.statement, params.requirements);
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
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.requirements.length === 0) throw new Error("Nothing to append.");
			const store = storeFor(ctx.cwd);
			const task = store.addRequirements(params.requirements);
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
				}),
				{ description: "Workers to run in parallel" },
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const store = storeFor(ctx.cwd);
			const task = store.mustCurrent();
			const context = await buildTaskContext(store, task);
			const model = resolveModel(ctx, "worker");
			const { concurrency, timeoutMs } = childSettings(ctx);

			const emit = () => {
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
					systemPrompt: [
						"You are a worker agent dispatched by the Owner of a council task. Complete your instructions fully and autonomously, then report what you did (and anything the Owner must know) as your final message. You have no memory: your instructions and the context below are everything.",
						"",
						context,
					].join("\n"),
					prompt: worker.instructions,
					tools: worker.tools
						? worker.tools.split(",").map((t) => t.trim()).filter(Boolean)
						: DEFAULT_WORKER_TOOLS,
					model,
					cwd: ctx.cwd,
					timeoutMs,
				};
				const result = await runChild(spec, signal, (p) => {
					live.children.set(key, `${p.lastActivity} (turn ${p.turns + 1})`);
					emit();
				});
				live.children.delete(key);
				emit();
				return result;
			});

			const failed = results.filter((r) => !r.ok);
			const sections = results.map(
				(r) =>
					`### ${r.name} — ${r.ok ? "completed" : `FAILED (${r.errorMessage ?? r.stopReason})`}\n\n${r.output || "(no output)"}`,
			);
			return {
				content: [
					{
						type: "text",
						text: `${results.length - failed.length}/${results.length} workers succeeded.\n\n${sections.join("\n\n---\n\n")}`,
					},
				],
				details: { results },
				...(failed.length === results.length && results.length > 0 ? { isError: true } : {}),
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
				const designReport = await store.gateReport("design", verifiersForGate(all, "design").map((v) => v.name));
				if (!designReport.holds) {
					throw new Error(
						`The design gate must hold before sourcing the implementation gate.\n${gateSummary(designReport)}\n${blockersText(designReport)}`,
					);
				}
			}

			let panel: VerifierDef[];
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
			const prompt = await buildVerifierPrompt(store, task, gate);
			const { concurrency, timeoutMs } = childSettings(ctx);

			const emit = () => {
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
						prompt,
						tools: def.tools,
						model: resolveModel(ctx, "verifier", def.model),
						cwd: ctx.cwd,
						timeoutMs,
					},
					signal,
					(p) => {
						live.children.set(key, `${p.lastActivity} (turn ${p.turns + 1})`);
						emit();
					},
				);
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

			const report = await store.gateReport(gate, applicable.map((v) => v.name));
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
				const report = await store.gateReport(gate, verifiersForGate(all, gate).map((v) => v.name));
				sections.push(gateSummary(report));
				const blockers = blockersText(report);
				if (blockers) sections.push(blockers);
			}
			return { content: [{ type: "text", text: sections.join("\n") }], details: {} };
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
			const failures: string[] = [];
			for (const gate of ["design", "implementation"] as Gate[]) {
				const report = await store.gateReport(gate, verifiersForGate(all, gate).map((v) => v.name));
				if (!report.holds) failures.push(`${gateSummary(report)}\n${blockersText(report)}`);
			}
			if (failures.length > 0) {
				throw new Error(`Refused — gates do not hold.\n\n${failures.join("\n\n")}`);
			}
			const task = store.close("done", params.summary);
			live.onChange(ctx);
			return {
				content: [{ type: "text", text: `Task #${task.id} complete. Both gates hold with fresh all-GO verdicts.` }],
				details: { task },
			};
		},
	});
}
