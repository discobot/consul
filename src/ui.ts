/**
 * User-visible status: a persistent widget above the editor, and the /task command
 * (full status report, or `/task-kill` to archive the task and start over).
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { packCellRows } from "./presentation.ts";
import { derivePhase, type Gate, type GateReport, storeFor } from "./state.ts";
import { discoverVerifiers, verifiersForGate } from "./verifiers.ts";

const WIDGET_KEY = "council";
const REFRESH_THROTTLE_MS = 1000;

export function compact(text: string, width: number): string {
	return truncateToWidth(text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim(), width, "…");
}

/** Compact verifier labels for the one-line-per-gate widget. */
const SHORT_LABELS: Record<string, string> = {
	"clean-code": "code",
	interfaces: "iface",
	"user-local-pov": "ulocal",
	"user-global-pov": "uglobal",
	design: "design",
	"ux-bugs": "ux",
	"visual-design": "vd",
	"github-clarity": "github",
	"task-completeness": "complete",
};

const STATE_ICONS: Record<string, { icon: string; color: string }> = {
	go: { icon: "✓", color: "success" },
	"no-go": { icon: "✗", color: "error" },
	stale: { icon: "⚠", color: "warning" },
	pending: { icon: "○", color: "muted" },
};

export async function gateReports(cwd: string): Promise<{ design: GateReport; impl: GateReport }> {
	const store = storeFor(cwd);
	const all = discoverVerifiers(cwd);
	const designDefs = verifiersForGate(all, "design");
	const implDefs = verifiersForGate(all, "implementation");
	const design = await store.gateReport("design", designDefs.map((v) => v.name), new Map(designDefs.map((v) => [v.name, v.fingerprint])));
	const impl = await store.gateReport(
		"implementation",
		implDefs.map((v) => v.name),
		new Map(implDefs.map((v) => [v.name, v.fingerprint])),
	);
	return { design, impl };
}

function packWidgetCells(prefix: string, cells: string[], width: number): string[] {
	width = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	const indent = " ".repeat(Math.min(prefixWidth, Math.max(0, width - 1)));
	return packCellRows(prefixWidth, cells.map(visibleWidth), width).map((row, index) =>
		truncateToWidth(`${index === 0 ? prefix : indent}${row.map((cellIndex) => cells[cellIndex]).join(" ")}`, width, "…"),
	);
}

export function gateLines(report: GateReport, theme: ExtensionContext["ui"]["theme"], running: Set<string>, width: number): string[] {
	const cells = report.verifiers.map((v) => {
		const label = SHORT_LABELS[v.name] ?? v.name;
		if (running.has(`${report.gate}:${v.name}`)) return theme.fg("accent", `${label}…`);
		const { icon, color } = STATE_ICONS[v.state];
		return theme.fg(color as any, `${label}${icon}`);
	});
	if (report.holds) cells.push(theme.fg("success", "HOLDS"));
	const title = report.gate === "design" ? "design" : "impl  ";
	return packWidgetCells(`  ${theme.fg("muted", title)} `, cells, width);
}

export function createStatusUI(pi: ExtensionAPI, liveChildren: Map<string, string>) {
	let lastRefresh = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;

	async function render(ctx: ExtensionContext): Promise<void> {
		const store = storeFor(ctx.cwd);
		const task = store.latest();
		if (!task) {
			if (ctx.hasUI) { ctx.ui.setWidget(WIDGET_KEY, undefined); ctx.ui.setStatus(WIDGET_KEY, undefined); }
			return;
		}
		if (task.status !== "active") {
			if (ctx.hasUI) {
				const phase = task.status === "done" ? "DONE" : "KILLED";
				const spend = store.spendTotals();
				ctx.ui.setWidget(WIDGET_KEY, [`◆ council #${task.id} ${phase} · $${spend.costUsd.toFixed(4)} · ${task.summary ?? "task archived"}`], { placement: "aboveEditor" });
				ctx.ui.setStatus(WIDGET_KEY, `◆ #${task.id} ${phase}`);
			}
			return;
		}
		const { design, impl } = await gateReports(ctx.cwd);
		const running = new Set(liveChildren.keys());
		const liveGate: Gate | undefined = [...running].some((key) => key.startsWith("design:"))
			? "design"
			: [...running].some((key) => key.startsWith("implementation:"))
				? "implementation"
				: undefined;
		const phase = derivePhase(task, store.readDesign() !== null, design, impl, {
			["design"]: liveGate === "design",
			["implementation"]: liveGate === "implementation",
		});
		const spend = store.spendTotals();
		const currentFingerprints = new Map(discoverVerifiers(ctx.cwd).map((verifier) => [verifier.name, verifier.fingerprint]));
		const projectGate = (report: GateReport) => ({
			hash: report.hash,
			holds: report.holds,
			verifiers: report.verifiers.map((verifier) => ({
				name: verifier.name,
				fingerprint: currentFingerprints.get(verifier.name) ?? "",
				state: running.has(`${report.gate}:${verifier.name}`) ? "reviewing" as const : verifier.state,
				...(verifier.verdict?.comments.length ? { comments: verifier.verdict.comments } : {}),
			})),
		});
		const blockers = [...design.verifiers, ...impl.verifiers]
			.filter((verifier) => verifier.state === "no-go" || verifier.state === "stale")
			.flatMap((verifier) => verifier.verdict?.comments.map((comment) => `${verifier.name}: ${comment}`) ?? []);
		store.writeStatus({ taskId: task.id, phase, generatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), pendingInputIds: task.pendingInputs?.map((input) => input.id) ?? [], blockers, spend, design: projectGate(design), implementation: projectGate(impl) });
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;

		const statement = compact(task.statement, 46);
		const count = task.requirements.length;
		const pendingCount = task.pendingInputs?.length ?? 0;
		const widgetLines = (width: number) => {
			const header = theme.fg("accent", `◆ council #${task.id} `) +
				theme.fg("warning", phase) +
				theme.fg("muted", ` · ${count} ${count === 1 ? "requirement" : "requirements"}${pendingCount ? ` (+${pendingCount} new)` : ""} · ${statement}`);
			const lines = [
				truncateToWidth(header, width, "…"),
				...gateLines(design, theme, running, width),
				...gateLines(impl, theme, running, width),
				...packWidgetCells(theme.fg("muted", "  spend "), [
					theme.fg("muted", `$${spend.costUsd.toFixed(4)}`),
					theme.fg("muted", `${spend.tokens.total.toLocaleString()} tokens`),
					theme.fg("muted", `${spend.runs} runs`),
				], width),
			];
			if (liveChildren.size > 0) {
				const active = [...liveChildren.entries()].map(([name, s]) => `${name} ${s}`);
				lines.push(...packWidgetCells(theme.fg("dim", "  running "), active.map((item) => theme.fg("dim", item)), width));
			}
			return lines;
		};
		ctx.ui.setWidget(WIDGET_KEY, () => ({ render: widgetLines, invalidate() {} }), { placement: "aboveEditor" });
		ctx.ui.setStatus(WIDGET_KEY, theme.fg("accent", `◆ #${task.id} ${phase}`));
	}

	/** Throttled refresh — child progress events arrive in bursts. */
	function refresh(ctx: ExtensionContext): void {
		const now = Date.now();
		const run = () => {
			lastRefresh = Date.now();
			render(ctx).catch(() => {});
		};
		if (now - lastRefresh >= REFRESH_THROTTLE_MS) {
			run();
		} else if (!pending) {
			pending = setTimeout(() => {
				pending = undefined;
				run();
			}, REFRESH_THROTTLE_MS - (now - lastRefresh));
			pending.unref?.();
		}
	}

	async function statusMarkdown(ctx: ExtensionContext): Promise<string> {
		const store = storeFor(ctx.cwd);
		const task = store.latest();
		if (!task) return "No task. Send a message to set one — the first message becomes the immutable task statement.";
		if (task.status !== "active") {
			const spend = store.spendTotals();
			return [`## council — task #${task.id} · ${task.status === "done" ? "DONE" : "KILLED"}`, "", `**Statement**: ${task.statement}`, ...(task.summary ? [`**Outcome**: ${task.summary}`] : []), `**Task spend**: $${spend.costUsd.toFixed(4)} · ${spend.tokens.total.toLocaleString()} tokens`, "", `Record: .pi/council/tasks/${task.id}/ · send a new message to start the next task`].join("\n");
		}
		const { design, impl } = await gateReports(ctx.cwd);
		const liveGate: Gate | undefined = [...liveChildren.keys()].some((key) => key.startsWith("design:"))
			? "design"
			: [...liveChildren.keys()].some((key) => key.startsWith("implementation:"))
				? "implementation"
				: undefined;
		const phase = derivePhase(task, store.readDesign() !== null, design, impl, {
			["design"]: liveGate === "design",
			["implementation"]: liveGate === "implementation",
		});

		const gateSection = (report: GateReport) => {
			const rows = report.verifiers.map((v) => {
				const when = v.verdict ? v.verdict.at.slice(0, 16).replace("T", " ") : "—";
				return `- **${v.name}** — ${v.state} · last verdict ${when}`;
			});
			const comments = report.verifiers
				.filter((v) => (v.state === "no-go" || v.state === "stale") && v.verdict)
				.flatMap((v) =>
					v.verdict!.comments.map(
						(c) => `- **${v.name}**${v.state === "stale" ? " _(stale; retained for context)_" : ""}: ${c}`,
					),
				);
			return [
				`### ${report.gate} gate — ${report.holds ? "HOLDS ✓" : "not held"} (hash \`${report.hash}\`)`,
				"",
				...rows,
				...(comments.length > 0 ? ["", "Current and stale review comments:", ...comments] : []),
			].join("\n");
		};

		const spend = store.spendTotals();
		return [
			`## council — task #${task.id} · ${phase}`,
			"",
			`**Statement**: ${task.statement}`,
			`**Base**: ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)} · created ${task.createdAt.slice(0, 16).replace("T", " ")}`,
			...(task.summary ? [`**Outcome**: ${task.summary}`] : []),
			"",
			"**Legend**: ✓ go · ✗ no-go · ⚠ stale (artifact changed) · ○ pending · … reviewing",
			`**Task spend**: $${spend.costUsd.toFixed(4)} · ${spend.tokens.total.toLocaleString()} tokens · ${spend.runs} runs (Owner ${spend.byKind.owner.runs}, workers ${spend.byKind.worker.runs}, verifiers ${spend.byKind.verifier.runs})`,
			"",
			"### Requirements",
			...task.requirements.map((r, i) => `${i + 1}. ${r.text}`),
			...(task.pendingInputs?.length
				? [
						"",
						"### Pending user input",
						...task.pendingInputs.map((input) => {
							const attachments = input.attachments?.length ?? 0;
							return `- \`${input.id}\`: ${compact(input.text, 100)}${attachments ? ` (${attachments} ${attachments === 1 ? "attachment" : "attachments"})` : ""} — waiting for the Owner to record this; no action needed`;
						}),
					]
				: []),
			"",
			gateSection(design),
			"",
			gateSection(impl),
			...(liveChildren.size > 0
				? ["", "### Running now", ...[...liveChildren.entries()].map(([n, s]) => `- ${n}: ${s}`)]
				: []),
			"",
			`_Task files: .pi/council/tasks/${task.id}/ · append requirements by sending a message · /task-kill to abandon_`,
		].join("\n");
	}

	pi.registerMessageRenderer("council-status", (message, _opts, _theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 1, 1, getMarkdownTheme());
	});

	async function killTask(ctx: ExtensionContext): Promise<void> {
		const store = storeFor(ctx.cwd);
		const task = store.current();
		if (!task || task.status !== "active") {
			ctx.ui.notify("No active task to kill.", "info");
			return;
		}
		const recordPath = `.pi/council/tasks/${task.id}/`;
		const ok = await ctx.ui.confirm(
			"Kill task?",
			`Task #${task.id} is terminal once killed. Its record stays in ${recordPath}; your next message can set a new task.`,
		);
		if (!ok) return;
		store.close("killed");
		refresh(ctx);
		ctx.ui.notify(`Task #${task.id} killed. Record: ${recordPath} Next: send a message to set a new task.`, "info");
	}

	pi.registerCommand("task-kill", {
		description: "Kill the active council task and archive its record",
		handler: async (_args, ctx) => killTask(ctx),
	});

	// Extension-sourced input passes the intake handler untouched, so resuming after a
	// restart does not append a requirement (and therefore stales no approvals).
	pi.registerCommand("task-resume", {
		description: "Nudge the Owner to continue the active task after a restart (records no requirement)",
		handler: async (_args, ctx) => {
			const store = storeFor(ctx.cwd);
			const task = store.current();
			if (!task || task.status !== "active") {
				ctx.ui.notify("No active task to resume.", "info");
				return;
			}
			pi.sendUserMessage(
				"[council] Resume the active task from its current disk state: check gate_status, continue the work in flight, re-source stale verdicts once their artifacts are settled, and drive the process to completion. This nudge is not user input — do not record it with task_requirements_add.",
				{ deliverAs: "followUp" },
			);
			ctx.ui.notify(`Resume nudge sent to the Owner for task #${task.id}.`, "info");
		},
	});

	pi.registerCommand("task", {
		description: "Show council task status (`/task kill` remains an alias for `/task-kill`)",
		handler: async (args, ctx) => {
			if (args.trim() === "kill") return killTask(ctx);
			pi.sendMessage({
				customType: "council-status",
				content: await statusMarkdown(ctx),
				display: true,
			});
		},
	});

	return { refresh, statusMarkdown };
}
