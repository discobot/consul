/**
 * User-visible status: a persistent widget above the editor, and the /task command
 * (full status report, or `/task kill` to archive the task and start over).
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { type Gate, type GateReport, storeFor, type TaskRecord } from "./state.ts";
import { discoverVerifiers, verifiersForGate } from "./verifiers.ts";

const WIDGET_KEY = "launch-review";
const REFRESH_THROTTLE_MS = 1000;

/** Compact verifier labels for the one-line-per-gate widget. */
const SHORT_LABELS: Record<string, string> = {
	"clean-code": "code",
	interfaces: "api",
	"user-local-pov": "ulocal",
	"user-global-pov": "uglobal",
	"design-consistency": "design",
	"ux-bugs": "ux",
	"github-clarity": "github",
	"task-completeness": "complete",
};

const STATE_ICONS: Record<string, { icon: string; color: string }> = {
	go: { icon: "✓", color: "success" },
	"no-go": { icon: "✗", color: "error" },
	stale: { icon: "⚠", color: "warning" },
	pending: { icon: "○", color: "muted" },
};

function derivePhase(task: TaskRecord, hasDesign: boolean, design: GateReport, impl: GateReport): string {
	if (task.status !== "active") return task.status;
	if (!hasDesign) return "designing";
	if (!design.holds) return "design gate";
	if (!impl.holds) return "implementing";
	return "gates hold — completing";
}

async function gateReports(ctx: ExtensionContext): Promise<{ design: GateReport; impl: GateReport }> {
	const store = storeFor(ctx.cwd);
	const all = discoverVerifiers(ctx.cwd);
	const design = await store.gateReport("design", verifiersForGate(all, "design").map((v) => v.name));
	const impl = await store.gateReport(
		"implementation",
		verifiersForGate(all, "implementation").map((v) => v.name),
	);
	return { design, impl };
}

function gateLine(report: GateReport, theme: ExtensionContext["ui"]["theme"], running: Set<string>): string {
	const cells = report.verifiers.map((v) => {
		const label = SHORT_LABELS[v.name] ?? v.name;
		if (running.has(`${report.gate}:${v.name}`)) return theme.fg("accent", `${label}…`);
		const { icon, color } = STATE_ICONS[v.state];
		return theme.fg(color as any, `${label}${icon}`);
	});
	const title = report.gate === "design" ? "design" : "impl  ";
	const held = report.holds ? theme.fg("success", " HOLDS") : "";
	return `  ${theme.fg("muted", title)} ${cells.join(" ")}${held}`;
}

export function createStatusUI(pi: ExtensionAPI, liveChildren: Map<string, string>) {
	let lastRefresh = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;

	async function render(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const task = storeFor(ctx.cwd).current();
		if (!task || task.status === "killed") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(WIDGET_KEY, undefined);
			return;
		}
		const { design, impl } = await gateReports(ctx);
		const phase = derivePhase(task, storeFor(ctx.cwd).readDesign() !== null, design, impl);
		const running = new Set(liveChildren.keys());

		const statement = task.statement.length > 46 ? `${task.statement.slice(0, 46)}…` : task.statement;
		const lines = [
			theme.fg("accent", `◆ launch #${task.id} `) +
				theme.fg("warning", phase) +
				theme.fg("muted", ` · ${task.requirements.length} reqs · ${statement}`),
			gateLine(design, theme, running),
			gateLine(impl, theme, running),
		];
		if (liveChildren.size > 0) {
			const active = [...liveChildren.entries()].map(([name, s]) => `${name} ${s}`).join(" · ");
			lines.push(theme.fg("dim", `  running ${active.length > 100 ? `${active.slice(0, 100)}…` : active}`));
		}
		if (task.status === "done") lines.splice(1); // header only once done
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
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
		const task = store.current();
		if (!task) return "No task. Send a message to set one — the first message becomes the immutable task statement.";
		const { design, impl } = await gateReports(ctx);
		const phase = derivePhase(task, store.readDesign() !== null, design, impl);

		const gateSection = (report: GateReport) => {
			const rows = report.verifiers.map((v) => {
				const when = v.verdict ? v.verdict.at.slice(0, 16).replace("T", " ") : "—";
				return `| ${v.name} | ${v.state} | ${when} |`;
			});
			const comments = report.verifiers
				.filter((v) => v.state === "no-go" && v.verdict)
				.flatMap((v) => v.verdict!.comments.map((c) => `- **${v.name}**: ${c}`));
			return [
				`### ${report.gate} gate — ${report.holds ? "HOLDS ✓" : "not held"} (hash \`${report.hash}\`)`,
				"",
				"| verifier | state | last verdict |",
				"|---|---|---|",
				...rows,
				...(comments.length > 0 ? ["", "Blocking comments:", ...comments] : []),
			].join("\n");
		};

		return [
			`## launch-review — task #${task.id} · ${phase}`,
			"",
			`**Statement**: ${task.statement}`,
			`**Base**: ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)} · created ${task.createdAt.slice(0, 16).replace("T", " ")}`,
			...(task.summary ? [`**Outcome**: ${task.summary}`] : []),
			"",
			"### Requirements",
			...task.requirements.map((r, i) => `${i + 1}. ${r.text}`),
			"",
			gateSection(design),
			"",
			gateSection(impl),
			...(liveChildren.size > 0
				? ["", "### Running now", ...[...liveChildren.entries()].map(([n, s]) => `- ${n}: ${s}`)]
				: []),
			"",
			`_Task files: .pi/launch/tasks/${task.id}/ · append requirements by sending a message · /task kill to abandon_`,
		].join("\n");
	}

	pi.registerMessageRenderer("launch-review-status", (message, _opts, _theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		return new Markdown(text, 1, 1, getMarkdownTheme());
	});

	pi.registerCommand("task", {
		description: "Show launch-review task status, or `/task kill` to abandon the task",
		handler: async (args, ctx) => {
			const store = storeFor(ctx.cwd);
			if (args.trim() === "kill") {
				const task = store.current();
				if (!task || task.status !== "active") {
					ctx.ui.notify("No active task to kill.", "info");
					return;
				}
				const ok = await ctx.ui.confirm(
					"Kill task?",
					`Task #${task.id} will be archived (its files stay in .pi/launch/tasks/${task.id}/). You can then set a new task.`,
				);
				if (!ok) return;
				store.close("killed");
				refresh(ctx);
				ctx.ui.notify(`Task #${task.id} killed.`, "info");
				return;
			}
			pi.sendMessage({
				customType: "launch-review-status",
				content: await statusMarkdown(ctx),
				display: true,
			});
		},
	});

	return { refresh, statusMarkdown };
}
