/**
 * Dedicated council TUI skin. Gate detail remains in the extension widget and
 * `/task`; this header is deliberately compact and safe at every terminal width.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { derivePhase, storeFor, type Gate, type LifecyclePhase, type TaskRecord } from "./state.ts";
import { gateReports } from "./ui.ts";

export function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	let phase: LifecyclePhase | undefined;
	let phaseTaskId: string | undefined;
	let liveGate: Gate | undefined;
	let refreshPhase: ((ctx: ExtensionContext) => Promise<void>) | undefined;

	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "request_verdicts" || !refreshPhase) return;
		liveGate = event.args?.gate === "implementation" ? "implementation" : "design";
		await refreshPhase(ctx);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!refreshPhase) return;
		if (event.toolName === "request_verdicts") liveGate = undefined;
		await refreshPhase(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => refreshPhase?.(ctx));
	pi.on("session_info_changed", async (_event, ctx) => refreshPhase?.(ctx));

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({ frames: ["◇", "◈", "◆", "◈"], intervalMs: 160 });

		refreshPhase = async (refreshCtx: ExtensionContext): Promise<void> => {
			const store = storeFor(refreshCtx.cwd);
			const task = store.latest();
			if (!task) {
				phase = undefined;
				phaseTaskId = undefined;
				refreshCtx.ui.setTitle("council");
				return;
			}
			try {
				if (task.status !== "active") {
					phase = task.status === "done" ? "DONE" : "KILLED";
					phaseTaskId = task.id;
					refreshCtx.ui.setTitle(`council · #${task.id} · ${phase}`);
					return;
				}
				const reports = await gateReports(refreshCtx.cwd);
				phase = derivePhase(task, store.readDesign() !== null, reports.design, reports.impl, {
					design: liveGate === "design",
					implementation: liveGate === "implementation",
				});
				phaseTaskId = task.id;
			} catch {
				// Keep the header useful if Git or a malformed project verifier prevents a report.
				phase = task.status === "done" ? "DONE" : task.status === "killed" ? "KILLED" : undefined;
				phaseTaskId = task.id;
			}
			refreshCtx.ui.setTitle(`council · #${task.id}${phase ? ` · ${phase}` : ""}`);
		};

		await refreshPhase(ctx);
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				// Deliberately uncached: task creation/closure must appear on the next render.
				const task: TaskRecord | null = storeFor(ctx.cwd).latest();
				const brand = theme.fg("accent", theme.bold(" ◆ council "));
				let detail: string;
				if (!task) {
					detail = theme.fg("muted", "no task — your first message sets it");
				} else {
					const shownPhase = task.id === phaseTaskId && phase ? phase : task.status.toUpperCase();
					const count = task.requirements.length;
					const noun = count === 1 ? "requirement" : "requirements";
					detail =
						theme.fg("warning", `#${task.id} ${shownPhase}`) +
						theme.fg("muted", ` · ${count} ${noun} · ${oneLine(task.statement)}`);
				}
				const header = truncateToWidth(`${brand}${detail}`, Math.max(0, width), "…");
				return [header, theme.fg("muted", "─".repeat(Math.max(0, width)))];
			},
		}));
	});
}
