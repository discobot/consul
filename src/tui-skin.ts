/**
 * The launch-review TUI skin, loaded by bin/launch-review alongside the main
 * extension: a branded header that always shows the task at a glance, a terminal
 * title, and a committee-flavored working indicator. The gate-by-gate detail
 * lives in the main extension's widget and /task report.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { storeFor, type TaskRecord } from "./state.ts";

const TASK_CACHE_MS = 500;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle("launch-review");
		ctx.ui.setWorkingIndicator({ frames: ["◇", "◈", "◆", "◈"], intervalMs: 160 });

		let cached: TaskRecord | null = null;
		let cachedAt = 0;
		const currentTask = (): TaskRecord | null => {
			const now = Date.now();
			if (now - cachedAt > TASK_CACHE_MS) {
				cached = storeFor(ctx.cwd).current();
				cachedAt = now;
			}
			return cached;
		};

		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const brand = theme.fg("accent", theme.bold(" ◆ LAUNCH REVIEW "));
				const task = currentTask();
				let detail: string;
				if (!task) {
					detail = theme.fg("muted", "no task — your first message sets it");
				} else {
					const state =
						task.status === "active"
							? storeFor(ctx.cwd).readDesign()
								? "in flight"
								: "designing"
							: task.status;
					const room = Math.max(10, width - 34 - state.length);
					const statement = task.statement.length > room ? `${task.statement.slice(0, room)}…` : task.statement;
					detail =
						theme.fg("warning", `#${task.id} ${state}`) +
						theme.fg("muted", ` · ${task.requirements.length} reqs · ${statement}`);
				}
				return [`${brand}${detail}`, theme.fg("muted", "─".repeat(Math.max(0, width)))];
			},
		}));
	});
}
