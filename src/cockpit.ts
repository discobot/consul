import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LaunchStore, type StatusGate, totalSpend } from "./state.ts";

export type BoardState = "GO" | "NO-GO" | "overruled" | "stale" | "pending" | "reviewing";

export interface BoardVerifier {
	name: string;
	state: BoardState;
	comments: string[];
	/** When this verifier last returned a verdict (from the verdict ledger). */
	lastRunAt?: string;
}

export interface BoardChild {
	name: string;
	status: string;
	since?: string;
}

export interface BoardRequirement { text: string; addedAt?: string }
export interface BoardBlocker { text: string; at?: string; stale?: boolean }
/** One finished child run from the spend ledger (workers and verifiers, not Owner turns). */
export interface BoardRun { at: string; kind: string; name: string; status: string; costUsd: number }

export interface BoardSnapshot {
	taskId?: string;
	active: boolean;
	statement: string;
	requirements: BoardRequirement[];
	phase: string;
	gates: { design: BoardVerifier[]; implementation: BoardVerifier[] };
	blockers: BoardBlocker[];
	children: BoardChild[];
	runs: BoardRun[];
	spend: { cost: number; tokens: number; entries: number };
	lastTurnAt?: string;
	design: string;
	connected: boolean;
	updatedAt?: string;
	errors: string[];
}

export interface JsonObject { [key: string]: unknown }

const STATUS_STALE_MS = 15_000;
const SLEEP_JUMP_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const INACTIVITY_MS = 20_000;

function stateName(value: unknown): BoardState {
	const normalized = String(value ?? "pending").toLowerCase();
	if (normalized === "go") return "GO";
	if (normalized === "no-go" || normalized === "nogo") return "NO-GO";
	if (normalized === "stale" || normalized === "reviewing" || normalized === "overruled") return normalized;
	return "pending";
}

/** Canonical disk projection. Freshness is consumed only from engine-written status.json. */
export function loadCockpitSnapshot(cwd: string, now = Date.now()): BoardSnapshot {
	const errors: string[] = [];
	try {
		const store = new LaunchStore(cwd);
		const task = store.latest();
		if (!task) return { active: false, statement: "No active task — close the board and start one in an Owner session", requirements: [], phase: "IDLE", gates: { design: [], implementation: [] }, blockers: [], children: [], runs: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: true, errors };
		const status = store.readStatus();
		const activity = store.readActivity();
		const spendEntries = store.loadSpend();
		const totals = totalSpend(spendEntries);
		const heartbeat = status?.heartbeatAt;
		const connected = task.status !== "active" || Boolean(heartbeat && now - Date.parse(heartbeat) <= STATUS_STALE_MS);
		// Latest verdict time per verifier: the ledger is chronological, so last write wins.
		const lastVerdictAt = new Map<string, string>();
		for (const verdict of store.loadVerdicts()) {
			if (verdict.at) lastVerdictAt.set(verdict.verifier, verdict.at);
		}
		const rows = (gate?: StatusGate): BoardVerifier[] => gate?.verifiers.map((verifier) => ({ name: verifier.name, state: stateName(verifier.state), comments: verifier.comments ?? [], lastRunAt: lastVerdictAt.get(verifier.name) })) ?? [];
		const gates = { design: rows(status?.design), implementation: rows(status?.implementation) };
		const staleVerifiers = new Set([...gates.design, ...gates.implementation].filter((row) => row.state === "stale").map((row) => row.name));
		const blocker = (text: string): BoardBlocker => {
			const name = text.includes(":") ? text.slice(0, text.indexOf(":")).trim() : undefined;
			return { text, at: name ? lastVerdictAt.get(name) : undefined, stale: name ? staleVerifiers.has(name) : false };
		};
		return {
			taskId: task.id,
			active: task.status === "active",
			statement: task.statement,
			requirements: task.requirements.map((requirement) => ({ text: requirement.text, addedAt: requirement.addedAt })),
			phase: task.status === "done" ? "DONE" : task.status === "killed" ? "KILLED" : status?.phase ?? "UNKNOWN",
			gates,
			blockers: (status?.blockers ?? (task.status === "active" ? ["Gate status unavailable until the Owner reconnects"] : [])).map(blocker),
			children: activity?.children.map((child) => ({ name: child.name, status: child.detail ?? child.status, since: child.startedAt })) ?? [],
			runs: spendEntries.filter((entry) => entry.kind !== "owner").slice(-100).reverse().map((entry) => ({ at: entry.at, kind: entry.kind, name: entry.name, status: entry.status, costUsd: entry.costUsd })),
			spend: { cost: totals.costUsd, tokens: totals.tokens.total, entries: totals.runs },
			lastTurnAt: spendEntries.at(-1)?.at,
			design: store.readDesign() ?? "",
			connected,
			updatedAt: heartbeat,
			errors,
		};
	} catch (error) {
		errors.push((error as Error).message);
		return { active: false, statement: "Task state unavailable", requirements: [], phase: "UNKNOWN", gates: { design: [], implementation: [] }, blockers: [{ text: "Canonical task status is unavailable" }], children: [], runs: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: false, errors };
	}
}

function clean(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function charWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (/\p{Mark}/u.test(char)) return 0;
	return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff)) ? 2 : 1;
}

function displayWidth(text: string): number { return Array.from(text).reduce((sum, char) => sum + charWidth(char), 0); }

function cut(text: string, width: number): string {
	if (width <= 0) return "";
	const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
	if (displayWidth(cleaned) <= width) return cleaned;
	let result = "";
	let used = 0;
	for (const char of cleaned) {
		const next = charWidth(char);
		if (used + next > Math.max(0, width - 1)) break;
		result += char;
		used += next;
	}
	return `${result}…`;
}

function splitToken(token: string, width: number): string[] {
	const parts: string[] = [];
	let part = "";
	let used = 0;
	for (const char of token) {
		const cells = charWidth(char);
		if (part && used + cells > Math.max(1, width)) { parts.push(part); part = char; used = cells; }
		else { part += char; used += cells; }
	}
	if (part || parts.length === 0) parts.push(part);
	return parts;
}

function wrap(text: string, width: number, prefix = ""): string[] {
	const words = clean(text).split(" ").filter(Boolean);
	const indent = " ".repeat(displayWidth(prefix));
	const lines: string[] = [];
	let lead = prefix;
	let line = "";
	for (const word of words) {
		let capacity = Math.max(1, width - displayWidth(lead));
		if (line && displayWidth(line) + 1 + displayWidth(word) <= capacity) { line += ` ${word}`; continue; }
		if (line) { lines.push(lead + line); lead = indent; line = ""; capacity = Math.max(1, width - displayWidth(lead)); }
		const parts = splitToken(word, capacity);
		for (const part of parts.slice(0, -1)) { lines.push(lead + part); lead = indent; }
		line = parts.at(-1) ?? "";
	}
	lines.push(lead + line);
	return lines;
}

// ── Themed full-screen board ──────────────────────────────────────────────────
// Rendering stays dependency-free (testable under bare `node --test`): styling
// goes through a palette shim, and the identity palette renders plain text.

export type PaletteColor = "accent" | "success" | "error" | "warning" | "muted" | "dim";
export interface Palette { fg(color: PaletteColor, text: string): string; bold(text: string): string }
export const PLAIN_PALETTE: Palette = { fg: (_color, text) => text, bold: (text) => text };

export interface Span { text: string; color?: PaletteColor; bold?: boolean }

const SPINNER = ["◇", "◈", "◆", "◈"];
const BORDER: PaletteColor = "dim";
const STATE_STYLE: Record<BoardState, { icon: string; color: PaletteColor }> = {
	GO: { icon: "✓", color: "success" },
	"NO-GO": { icon: "✗", color: "error" },
	overruled: { icon: "⊘", color: "muted" },
	stale: { icon: "⚠", color: "warning" },
	pending: { icon: "○", color: "muted" },
	reviewing: { icon: "◈", color: "accent" },
};

function span(text: string, color?: PaletteColor, bold?: boolean): Span { return { text, color, bold }; }
function spansWidth(spans: Span[]): number { return spans.reduce((sum, part) => sum + displayWidth(part.text), 0); }

function paint(spans: Span[], palette: Palette): string {
	return spans.map((part) => {
		let text = part.text;
		if (part.bold) text = palette.bold(text);
		if (part.color) text = palette.fg(part.color, text);
		return text;
	}).join("");
}

function fitSpans(spans: Span[], width: number): Span[] {
	if (spansWidth(spans) <= width) return spans;
	const fitted: Span[] = [];
	let used = 0;
	for (const part of spans) {
		const partWidth = displayWidth(part.text);
		if (used + partWidth <= width) { fitted.push(part); used += partWidth; continue; }
		fitted.push({ ...part, text: cut(part.text, width - used) });
		break;
	}
	return fitted;
}

/** Wrapped rows where the first row's prefix carries its own tint. */
function prefixedRows(text: string, width: number, prefix: string, prefixColor?: PaletteColor, textColor?: PaletteColor): Span[][] {
	return wrap(text, width, prefix).map((line, index) => index === 0
		? [span(line.slice(0, prefix.length), prefixColor), span(line.slice(prefix.length), textColor)]
		: [span(line, textColor)]);
}

/** Greedy cell flow with a muted separator; cells too wide for one row are cut, never dropped. */
function packSpanCells(cells: Span[][], width: number, separator = " · "): Span[][] {
	const separatorWidth = displayWidth(separator);
	const rows: Span[][] = [];
	let row: Span[] = [];
	let used = 0;
	for (const cell of cells) {
		const cellWidth = spansWidth(cell);
		if (row.length && used + separatorWidth + cellWidth > width) { rows.push(row); row = []; used = 0; }
		if (row.length) { row.push(span(separator, "muted")); used += separatorWidth; }
		const fitted = fitSpans(cell, Math.max(1, width - used));
		row.push(...fitted);
		used += spansWidth(fitted);
	}
	if (row.length) rows.push(row);
	return rows;
}

// A node is one focusable row: a one-line summary (optionally different while
// collapsed, e.g. a preview), wrapped detail blocks shown when expanded, and children.
interface DetailBlock { text: string; prefix: string; prefixColor?: PaletteColor; color?: PaletteColor }
export interface BoardNode {
	id: string;
	summary: Span[];
	collapsedSummary?: Span[];
	details?: DetailBlock[];
	children?: BoardNode[];
	defaultExpanded?: boolean;
}

function expandable(node: BoardNode): boolean { return Boolean(node.children?.length || node.details?.length); }

function clock(iso?: string): string { return iso && iso.length >= 19 ? iso.slice(11, 19) : (iso ?? "—"); }

export function buildBoardNodes(snapshot: BoardSnapshot, frame = 0): BoardNode[] {
	const nodes: BoardNode[] = [];
	if (!snapshot.taskId) {
		nodes.push({ id: "board", summary: [span("Board", undefined, true)], details: [{ text: snapshot.statement, prefix: "" }], defaultExpanded: true });
	} else {
		const count = snapshot.requirements.length;
		const noun = count === 1 ? "requirement" : "requirements";
		nodes.push({
			id: "task",
			summary: [span("Task", undefined, true), span(` · ${count} ${noun}`, "muted")],
			collapsedSummary: [span("Task", undefined, true), span(` · ${count} ${noun} · ${clean(snapshot.statement)}`, "muted")],
			details: count ? [{ text: snapshot.statement, prefix: "" }] : [{ text: snapshot.statement, prefix: "" }, { text: "(none recorded)", prefix: " ", color: "muted" as PaletteColor }],
			children: snapshot.requirements.map((requirement, index) => ({
				id: `req:${index}`,
				summary: [span(` ${index + 1}. `, "muted"), span(clean(requirement.text)), ...(requirement.addedAt ? [span(` · ${clock(requirement.addedAt)}`, "muted")] : [])],
				details: [{ text: requirement.text, prefix: "" }],
			})),
		});
		const gate = (label: string, key: string, rows: BoardVerifier[]): BoardNode => {
			const go = rows.filter((row) => row.state === "GO").length;
			const badge: Span[] = rows.length === 0
				? [span(" · verdicts pending", "muted")]
				: go === rows.length
					? [span(" · ✓ HOLDS", "success", true)]
					: [span(` · ${go}/${rows.length} GO`, go > 0 ? "warning" : "muted")];
			return {
				id: `gate:${key}`,
				summary: [span(label, undefined, true), ...badge],
				children: rows.map((row) => {
					const style = STATE_STYLE[row.state];
					const icon = row.state === "reviewing" ? SPINNER[frame % SPINNER.length] : style.icon;
					const name: Span[] = [
						span(icon, style.color, true), span(" "), span(row.name, row.state === "NO-GO" ? "error" : undefined),
						...(row.lastRunAt ? [span(` · ${clock(row.lastRunAt)}`, "muted")] : []),
					];
					return {
						id: `verifier:${key}:${row.name}`,
						summary: name,
						collapsedSummary: row.comments.length ? [...name, span(` ↳ ${clean(row.comments[0])}`, "muted")] : undefined,
						details: row.comments.map((comment) => ({ text: comment, prefix: "↳ ", color: "muted" as PaletteColor })),
					};
				}),
				// A healthy gate folds to one line; an unheld one opens for review.
				defaultExpanded: rows.length > 0 && go !== rows.length,
			};
		};
		nodes.push(gate("Design gate", "design", snapshot.gates.design));
		nodes.push(gate("Implementation gate", "implementation", snapshot.gates.implementation));
		if (snapshot.blockers.length) {
			const staleCount = snapshot.blockers.filter((blocker) => blocker.stale).length;
			nodes.push({
				id: "blockers",
				summary: [span("Items", "error", true), span(` · ${snapshot.blockers.length}${staleCount ? ` (${staleCount} from a stale round)` : ""}`, "muted")],
				children: snapshot.blockers.map((blocker, index) => ({
					id: `blocker:${index}:${blocker.text.slice(0, 32)}`,
					summary: [
						span(blocker.stale ? "⚠ " : "✗ ", blocker.stale ? "warning" : "error", true), span(clean(blocker.text)),
						...(blocker.at ? [span(` · ${clock(blocker.at)}`, "muted")] : []),
					],
					details: [{ text: blocker.text, prefix: "" }],
				})),
				// Blockers duplicate the gate comments; the count is the signal, drill in for text.
				defaultExpanded: false,
			});
		}
		const running = snapshot.children.length;
		const pulse = snapshot.spend.entries
			? `Owner — ${snapshot.spend.entries} runs · last finished ${clock(snapshot.lastTurnAt)}`
			: "Owner — no runs recorded yet";
		nodes.push({
			id: "activity",
			summary: [span("Activity", "accent", true), span(running ? ` · ${running} running` : " · owner only", "muted")],
			children: [
				{ id: "owner-pulse", summary: [span("● ", snapshot.connected ? "success" : "warning", true), span(pulse)] },
				...snapshot.children.map((child) => ({
					id: `child:${child.name}`,
					summary: [span(`${SPINNER[frame % SPINNER.length]} `, "accent", true), span(`${child.name} — ${clean(child.status)}${child.since ? ` · since ${clock(child.since)}` : ""}`)],
					details: [{ text: `${child.name} — ${child.status}`, prefix: "" }],
				})),
			],
			defaultExpanded: true,
		});
		const spendText = `$${snapshot.spend.cost.toFixed(4)} · ${snapshot.spend.tokens.toLocaleString("en-US")} tokens · ${snapshot.spend.entries} runs`;
		nodes.push({
			id: "spend",
			summary: [span("Spend", undefined, true), span(` · ${spendText}`, "muted")],
			details: [{ text: spendText, prefix: "", color: "muted" as PaletteColor }],
		});
	}
	if (snapshot.errors.length) nodes.push({
		id: "warnings",
		summary: [span("State warnings", "warning", true), span(` · ${snapshot.errors.length}`, "muted")],
		children: snapshot.errors.map((error, index) => ({ id: `warning:${index}`, summary: [span("⚠ ", "warning", true), span(clean(error))], details: [{ text: error, prefix: "" }] })),
		defaultExpanded: true,
	});
	return nodes;
}

const RUN_STYLE: Record<string, { icon: string; color: PaletteColor }> = {
	ok: { icon: "✓", color: "success" },
	failed: { icon: "✗", color: "error" },
	aborted: { icon: "⚠", color: "warning" },
};

/** The Runs tab: recent worker and verifier runs from the spend ledger, newest first. */
export function buildRunNodes(snapshot: BoardSnapshot): BoardNode[] {
	if (!snapshot.runs.length) return [{ id: "runs", summary: [span("Runs", undefined, true), span(" · no worker or verifier runs recorded yet", "muted")] }];
	const workers = snapshot.runs.filter((run) => run.kind === "worker").length;
	return [{
		id: "runs",
		summary: [span("Runs", undefined, true), span(` · last ${snapshot.runs.length} (${workers} workers) · newest first`, "muted")],
		children: snapshot.runs.map((run, index) => {
			const style = RUN_STYLE[run.status] ?? { icon: "○", color: "muted" as PaletteColor };
			return {
				id: `run:${index}:${run.at}:${run.name}`,
				summary: [
					span(style.icon, style.color, true),
					span(` ${clock(run.at)} `, "muted"),
					span(run.kind.padEnd(9), run.kind === "worker" ? "accent" : "muted"),
					span(run.name),
					span(` · $${run.costUsd.toFixed(2)}`, "muted"),
					...(run.status !== "ok" ? [span(` · ${run.status}`, style.color)] : []),
				],
			};
		}),
		defaultExpanded: true,
	}];
}

export interface BoardRow { spans: Span[]; nodeId?: string }

export function flattenBoardNodes(nodes: BoardNode[], width: number, expanded: (node: BoardNode) => boolean, depth = 0): BoardRow[] {
	const rows: BoardRow[] = [];
	for (const node of nodes) {
		const indent = "  ".repeat(depth);
		const open = expandable(node) && expanded(node);
		const arrow = expandable(node) ? (open ? "▾ " : "▸ ") : "  ";
		const summary = !open && node.collapsedSummary ? node.collapsedSummary : node.summary;
		rows.push({ nodeId: node.id, spans: fitSpans([span(indent), span(arrow, expandable(node) ? "accent" : undefined), ...summary], Math.max(1, width)) });
		if (!open) continue;
		const detailIndent = `${indent}    `;
		for (const block of node.details ?? []) {
			for (const row of prefixedRows(block.text, Math.max(1, width - displayWidth(detailIndent)), block.prefix, block.prefixColor ?? block.color, block.color)) rows.push({ spans: [span(detailIndent), ...row] });
		}
		if (node.children) rows.push(...flattenBoardNodes(node.children, width, expanded, depth + 1));
	}
	return rows;
}

export function renderHeader(snapshot: BoardSnapshot, width: number, palette: Palette = PLAIN_PALETTE, frame = 0): string[] {
	width = Math.max(1, width);
	const phaseColor: PaletteColor = snapshot.phase === "DONE" ? "success" : snapshot.phase === "KILLED" ? "error" : snapshot.phase === "IDLE" ? "muted" : "warning";
	const cells: Span[][] = [[span("◆ council cockpit", "accent", true)]];
	if (snapshot.taskId) cells.push([span(`#${snapshot.taskId}`, "warning")]);
	cells.push([span(snapshot.phase, phaseColor, true)]);
	if (snapshot.taskId) cells.push(snapshot.connected ? [span("● live", "success")] : [span(`${SPINNER[frame % SPINNER.length]} reconnecting…`, "warning")]);
	return [...packSpanCells(cells, width).map((row) => paint(row, palette)), paint([span("─".repeat(width), BORDER)], palette)];
}

/** Reading width cap: ultra-wide terminals get a readable column, not 300-cell lines. */
const MAX_BOARD_WIDTH = 120;

/** The complete board, fully expanded — reference rendering and test surface. */
export function renderCockpit(snapshot: BoardSnapshot, width: number, palette: Palette = PLAIN_PALETTE, frame = 0): string[] {
	width = Math.max(1, Math.min(width, MAX_BOARD_WIDTH));
	const rows = flattenBoardNodes(buildBoardNodes(snapshot, frame), width, () => true);
	return [...renderHeader(snapshot, width, palette, frame), ...rows.map((row) => paint(fitSpans(row.spans, width), palette))];
}

/**
 * Keyboard-navigable board: ↑/↓ move a focus cursor over nodes, ⏎/space toggle,
 * ←/→ fold (← on a collapsed node jumps to its parent), and the viewport follows
 * the cursor. Expansion overrides and focus survive snapshot refreshes by node id.
 */
export class BoardView {
	private overrides = new Map<string, boolean>();
	private nodesById = new Map<string, BoardNode>();
	private parentById = new Map<string, string>();
	private focusable: string[] = [];
	private focusId?: string;
	private focusIndex = 0;
	private scroll = 0;
	private pageRows = 8;
	private tab: "board" | "runs" = "board";

	get activeTab(): "board" | "runs" { return this.tab; }
	switchTab(): void {
		this.tab = this.tab === "board" ? "runs" : "board";
		this.focusId = undefined;
		this.focusIndex = 0;
		this.scroll = 0;
	}

	private isExpanded = (node: BoardNode): boolean => this.overrides.get(node.id) ?? node.defaultExpanded ?? false;

	private index(nodes: BoardNode[], parent?: string): void {
		for (const node of nodes) {
			this.nodesById.set(node.id, node);
			if (parent) this.parentById.set(node.id, parent);
			if (node.children) this.index(node.children, node.id);
		}
	}

	/** Flatten the current snapshot and re-anchor focus (by id, else by position). */
	private rowsFor(snapshot: BoardSnapshot, width: number, frame: number): BoardRow[] {
		const nodes = this.tab === "runs" ? buildRunNodes(snapshot) : buildBoardNodes(snapshot, frame);
		this.nodesById.clear();
		this.parentById.clear();
		this.index(nodes);
		const rows = flattenBoardNodes(nodes, Math.max(1, width - 2), this.isExpanded);
		this.focusable = rows.filter((row) => row.nodeId !== undefined).map((row) => row.nodeId!);
		if (this.focusable.length === 0) { this.focusId = undefined; this.focusIndex = 0; }
		else if (this.focusId !== undefined && this.focusable.includes(this.focusId)) this.focusIndex = this.focusable.indexOf(this.focusId);
		else { this.focusIndex = Math.max(0, Math.min(this.focusIndex, this.focusable.length - 1)); this.focusId = this.focusable[this.focusIndex]; }
		return rows;
	}

	get focus(): string | undefined { return this.focusId; }

	move(delta: number): void {
		if (this.focusable.length === 0) return;
		this.focusIndex = Math.max(0, Math.min(this.focusable.length - 1, this.focusIndex + delta));
		this.focusId = this.focusable[this.focusIndex];
	}
	movePage(direction: 1 | -1): void { this.move(direction * this.pageRows); }
	first(): void { this.move(-Number.MAX_SAFE_INTEGER); }
	last(): void { this.move(Number.MAX_SAFE_INTEGER); }

	toggle(): void {
		const node = this.focusId !== undefined ? this.nodesById.get(this.focusId) : undefined;
		if (node && expandable(node)) this.overrides.set(node.id, !this.isExpanded(node));
	}
	expand(): void {
		const node = this.focusId !== undefined ? this.nodesById.get(this.focusId) : undefined;
		if (node && expandable(node) && !this.isExpanded(node)) this.overrides.set(node.id, true);
	}
	/** Fold the focused node, or climb to its parent when already folded. */
	collapse(): void {
		const node = this.focusId !== undefined ? this.nodesById.get(this.focusId) : undefined;
		if (!node) return;
		if (expandable(node) && this.isExpanded(node)) { this.overrides.set(node.id, false); return; }
		const parent = this.parentById.get(node.id);
		if (parent !== undefined && this.focusable.includes(parent)) { this.focusId = parent; this.focusIndex = this.focusable.indexOf(parent); }
	}

	renderPage(snapshot: BoardSnapshot, width: number, height: number, feedback = "", palette: Palette = PLAIN_PALETTE, frame = 0): string[] {
		width = Math.max(1, Math.min(width, MAX_BOARD_WIDTH));
		height = Math.max(4, height);
		const header = renderHeader(snapshot, width, palette, frame);
		const rows = this.rowsFor(snapshot, width, frame);
		const key = (label: string, action: string): Span[] => [span(label, "accent", true), span(` ${action}`, "muted")];
		const tabHint = key("⇥", this.tab === "board" ? "runs" : "board");
		const hintRows = packSpanCells(snapshot.active
			? [key("↑↓", "move"), key("⏎", "open"), key("←→", "fold"), tabHint, key("⇞⇟", "page"), key("a", "append"), key("k", "kill"), key("q", "close")]
			: [key("↑↓", "move"), key("⏎", "open"), tabHint, key("q", "close")], width);
		let feedbackRows = feedback ? wrap(feedback, Math.max(1, width - 2), "▸ ").map((line) => [span(line, "accent")]) : [];
		const fixed = header.length + hintRows.length + 1;
		feedbackRows = feedbackRows.slice(0, Math.max(0, height - fixed - 1));
		const bodyHeight = Math.max(1, height - fixed - feedbackRows.length);
		this.pageRows = bodyHeight;
		const focusRow = this.focusId !== undefined ? rows.findIndex((row) => row.nodeId === this.focusId) : -1;
		if (focusRow >= 0) {
			if (focusRow < this.scroll) this.scroll = focusRow;
			if (focusRow > this.scroll + bodyHeight - 1) this.scroll = focusRow - bodyHeight + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - bodyHeight)));
		const visible = rows.slice(this.scroll, this.scroll + bodyHeight).map((row) => {
			const focused = row.nodeId !== undefined && row.nodeId === this.focusId;
			const gutter = focused ? span("❯ ", "accent", true) : span("  ");
			return paint([gutter, ...(focused ? row.spans.map((part) => ({ ...part, bold: true })) : row.spans)], palette);
		});
		while (visible.length < bodyHeight) visible.push("");
		const last = Math.min(rows.length, this.scroll + bodyHeight);
		const status: Span[] = [
			span(this.scroll > 0 ? "▲ " : "  ", "accent"),
			span(`${rows.length ? this.scroll + 1 : 0}–${last}/${rows.length}`, "muted"),
			span(last < rows.length ? " ▼" : "  ", "accent"),
			...(snapshot.updatedAt ? [span(`   heartbeat ${snapshot.updatedAt.slice(11, 19)}`, "dim")] : []),
		];
		const lines = [...header, ...visible, ...feedbackRows.map((row) => paint(row, palette)), paint(fitSpans(status, width), palette), ...hintRows.map((row) => paint(row, palette))];
		return lines.slice(0, height);
	}
}

export interface RestartState { attempts: number; lastStartedAt?: number }

export function appendRequirementRpcCommand(text: string): JsonObject {
	return {
		type: "prompt",
		message: text,
		streamingBehavior: "followUp",
	};
}

export function killTaskRpcCommand(): JsonObject {
	return { type: "prompt", message: "/task-kill" };
}

/** Bounded exponential restart delay, reset after a stable minute. */
export function nextRestart(state: RestartState, now = Date.now()): { state: RestartState; delayMs: number } {
	const attempts = state.lastStartedAt !== undefined && now - state.lastStartedAt > 60_000 ? 0 : state.attempts;
	return { state: { attempts: attempts + 1, lastStartedAt: now }, delayMs: Math.min(30_000, 500 * 2 ** attempts) };
}

export function isSleepJump(expectedAt: number, now: number, toleranceMs = SLEEP_JUMP_MS): boolean {
	return now - expectedAt > toleranceMs;
}

/** Strict LF JSONL decoder (unlike node:readline, U+2028/U+2029 are data). */
export class JsonlDecoder {
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		for (;;) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) break;
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		return lines;
	}
}

/** An Owner whose last finished run is older than this is considered stalled. */
const REVIVE_AFTER_MS = 10 * 60_000;

export class OwnerSupervisor {
	private child?: ChildProcessWithoutNullStreams;
	private heartbeat?: ReturnType<typeof setInterval>;
	private restartTimer?: ReturnType<typeof setTimeout>;
	private lastEvent = Date.now();
	private expectedTick = Date.now() + HEARTBEAT_MS;
	private restartState: RestartState = { attempts: 0 };
	private stopped = false;
	private ready = false;
	/** lastTurnAt value at the previous revive; re-arm only after a newer turn lands. */
	private lastRevive?: string;
	private lastReviveAt?: number;
	private sequence = 0;
	private pending = new Map<string, (ok: boolean, error?: string) => void>();
	private queuedAppends: { text: string; resolve: (message: string) => void }[] = [];
	private confirmKill = false;
	private cwd: string;
	private extensionPath: string;
	private changed: (message: string) => void;

	constructor(cwd: string, extensionPath: string, changed: (message: string) => void) {
		this.cwd = cwd;
		this.extensionPath = extensionPath;
		this.changed = changed;
	}

	start(): void {
		this.stopped = false;
		this.spawnChild();
		this.expectedTick = Date.now() + HEARTBEAT_MS;
		this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	private invocation(): { command: string; args: string[] } {
		const target = process.env.COUNCIL_PI || "pi";
		return /\.(?:js|mjs|ts)$/.test(target) ? { command: process.execPath, args: [target] } : { command: target, args: [] };
	}

	private spawnChild(): void {
		if (this.stopped) return;
		const invocation = this.invocation();
		this.ready = false;
		this.lastEvent = Date.now();
		this.changed("Owner reconnecting…");
		const configuredArgs = (() => { try { const value = JSON.parse(process.env.COUNCIL_OWNER_ARGS ?? "[]"); return Array.isArray(value) ? value.map(String) : []; } catch { return []; } })();
		const sessionDir = path.join(this.cwd, ".pi", "council", "owner-sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const child = spawn(invocation.command, [...invocation.args, "--mode", "rpc", "--session-dir", sessionDir, "-e", this.extensionPath, "-c", "--name", "council Owner", ...configuredArgs], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		const decoder = new JsonlDecoder();
		child.stdout.on("data", (chunk) => {
			for (const line of decoder.push(chunk)) {
				let event: JsonObject;
				try { event = JSON.parse(line) as JsonObject; } catch { continue; }
				this.lastEvent = Date.now();
				this.ready = true;
				if (event.type === "extension_ui_request" && event.method === "confirm" && typeof event.id === "string" && this.confirmKill) {
					child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: true })}\n`);
				}
				if (event.type === "response" && typeof event.id === "string") {
					const resolve = this.pending.get(event.id);
					if (resolve) { this.pending.delete(event.id); resolve(event.success === true, typeof event.error === "string" ? event.error : undefined); }
				}
				this.flushQueuedAppend();
			}
		});
		child.on("error", (error) => this.changed(`Owner failed: ${error.message}`));
		child.on("exit", () => {
			if (this.child !== child) return;
			this.child = undefined;
			this.ready = false;
			for (const resolve of this.pending.values()) resolve(false, "Owner disconnected");
			this.pending.clear();
			if (!this.stopped) this.scheduleRestart();
		});
		this.send("get_state", {}).then((ok) => { if (ok) { this.ready = true; this.changed("Owner connected"); this.flushQueuedAppend(); this.reviveIfStalled(); } });
	}

	private tick(): void {
		const now = Date.now();
		if (isSleepJump(this.expectedTick, now) || now - this.lastEvent > INACTIVITY_MS) {
			this.changed(isSleepJump(this.expectedTick, now) ? "Sleep/wake detected; restarting Owner…" : "Owner heartbeat timed out; restarting…");
			this.terminate();
		} else if (this.child) {
			void this.send("get_state", {});
			this.reviveIfStalled();
		}
		this.expectedTick = now + HEARTBEAT_MS;
	}

	private scheduleRestart(): void {
		const restart = nextRestart(this.restartState);
		this.restartState = restart.state;
		this.restartTimer = setTimeout(() => this.spawnChild(), restart.delayMs);
		this.restartTimer.unref?.();
	}

	private terminate(): void {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this.ready = false;
		for (const resolve of this.pending.values()) resolve(false, "Owner disconnected");
		this.pending.clear();
		child.kill("SIGTERM");
		const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000);
		kill.unref?.();
		if (!this.stopped) this.scheduleRestart();
	}

	private send(type: string, fields: JsonObject): Promise<boolean> {
		const child = this.child;
		if (!child?.stdin.writable) return Promise.resolve(false);
		const id = `cockpit-${++this.sequence}`;
		return new Promise((resolve) => {
			this.pending.set(id, (ok) => resolve(ok));
			child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
				if (error) { this.pending.delete(id); resolve(false); }
			});
		});
	}

	append(text: string): Promise<string> {
		// Durable first: the pending input lands on disk immediately, so the append works
		// even when the Owner is dead, reconnecting, or supervised by someone else — the
		// Owner records it from the task snapshot on its next turn. The RPC prompt is
		// only a nudge to pick it up sooner.
		try {
			const pending = new LaunchStore(this.cwd).addPendingInputWithImages(text, []);
			if (!this.ready) { this.changed(`Requirement ${pending.id} queued on disk; Owner records it next turn`); return Promise.resolve(`Requirement ${pending.id} queued on disk`); }
			return this.send("prompt", { message: `[council] Pending input ${pending.id} is queued on disk — record it with task_requirements_add and propagate.`, streamingBehavior: "followUp" })
				.then((ok) => ok ? `Requirement ${pending.id} queued; Owner nudged` : `Requirement ${pending.id} queued on disk; nudge failed — Owner records it next turn`);
		} catch (error) {
			if (!this.ready) return new Promise((resolve) => { this.queuedAppends.push({ text, resolve }); this.changed(`${this.queuedAppends.length} requirement(s) queued while Owner reconnects`); });
			void error;
			return this.promptAppend(text);
		}
	}

	private promptAppend(text: string): Promise<string> {
		this.changed("Requirement sending…");
		const { type, ...fields } = appendRequirementRpcCommand(text);
		return this.send(String(type), fields)
			.then((ok) => ok ? "Requirement accepted by Owner; awaiting disk confirmation" : "Requirement delivery failed or was interrupted—retry if it does not appear");
	}

	private flushQueuedAppend(): void {
		if (!this.ready || this.queuedAppends.length === 0) return;
		const queued = this.queuedAppends.shift()!;
		this.promptAppend(queued.text).then((message) => { queued.resolve(message); this.flushQueuedAppend(); });
	}

	/**
	 * The board resuscitates a stalled task: when the last finished run is old, send
	 * /task-resume through the Owner (a command, so no requirement is appended). After a
	 * revive it re-arms only once a newer run lands — so a marathon turn or a dead-slow
	 * Owner gets at most one queued nudge per stall, never a drumbeat.
	 */
	private reviveIfStalled(): void {
		if (!this.ready) return;
		let snapshot: BoardSnapshot;
		try { snapshot = loadCockpitSnapshot(this.cwd); } catch { return; }
		if (!snapshot.active) return;
		// A cold start — fresh empty session over an active task — is nudged immediately:
		// the 10-minute age threshold exists to detect stalls in a live session, and a
		// just-restarted Owner should never serve a coma waiting it out.
		const coldStart = (() => {
			try { return fs.readdirSync(path.join(this.cwd, ".pi", "council", "owner-sessions")).filter((f) => f.endsWith(".jsonl")).length === 0; } catch { return true; }
		})();
		const marker = snapshot.lastTurnAt ?? "(no runs)";
		const sinceRevive = this.lastReviveAt ? Date.now() - this.lastReviveAt : Number.POSITIVE_INFINITY;
		// Re-arm on the same marker after another full interval: a dropped nudge must not
		// idle the task forever.
		if (this.lastRevive === marker && sinceRevive < REVIVE_AFTER_MS) return;
		const age = snapshot.lastTurnAt ? Date.now() - Date.parse(snapshot.lastTurnAt) : Number.POSITIVE_INFINITY;
		if (!coldStart && !Number.isNaN(age) && age < REVIVE_AFTER_MS) return;
		this.lastRevive = marker;
		this.lastReviveAt = Date.now();
		void this.send("prompt", { message: "/task-resume", streamingBehavior: "followUp" })
			.then((ok) => this.changed(ok ? "Owner looked stalled — sent /task-resume" : "Owner stalled; /task-resume delivery failed"));
	}

	killTask(): Promise<string> {
		if (!this.ready) return Promise.resolve("Owner unavailable—retry after reconnect");
		this.changed("Kill sending…");
		this.confirmKill = true;
		const { type, ...fields } = killTaskRpcCommand();
		return this.send(String(type), fields)
			.then((ok) => ok ? "Kill accepted by Owner" : "Kill failed")
			.finally(() => { this.confirmKill = false; });
	}

	stop(): void {
		this.stopped = true;
		for (const queued of this.queuedAppends.splice(0)) queued.resolve("Cockpit closed before requirement delivery");
		for (const resolve of this.pending.values()) resolve(false, "Cockpit closed");
		this.pending.clear();
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.terminate();
	}
}

/** One supervised Owner per task dir: a second board must not race the first.
 * Returns a release fn when the lock is ours, or null when a live board holds it. */
export function acquireBoardLock(cwd: string, pid = process.pid): (() => void) | null {
	const lockPath = path.join(cwd, ".pi", "council", "board.lock");
	try {
		const holder = Number(fs.readFileSync(lockPath, "utf8").trim());
		if (Number.isFinite(holder) && holder > 0) {
			try { process.kill(holder, 0); return null; } catch { /* stale */ }
		}
	} catch { /* absent */ }
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, String(pid));
	} catch { return null; }
	return () => { try { if (Number(fs.readFileSync(lockPath, "utf8").trim()) === pid) fs.rmSync(lockPath); } catch { /* gone */ } };
}

function watchState(cwd: string, changed: () => void): () => void {
	const root = path.join(cwd, ".pi", "council");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let taskWatcher: fs.FSWatcher | undefined;
	const watchers: fs.FSWatcher[] = [];
	const refresh = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { changed(); attachTask(); }, 50);
	};
	const attachTask = () => {
		taskWatcher?.close();
		const id = (() => { try { return fs.readFileSync(path.join(root, "current"), "utf8").trim(); } catch { return ""; } })();
		if (!id) return;
		try { taskWatcher = fs.watch(path.join(root, "tasks", id), refresh); } catch { taskWatcher = undefined; }
	};
	try { watchers.push(fs.watch(root, refresh)); } catch { /* root may not exist yet */ }
	attachTask();
	const poll = setInterval(refresh, 1_000);
	poll.unref?.();
	return () => { if (timer) clearTimeout(timer); clearInterval(poll); taskWatcher?.close(); for (const watcher of watchers) watcher.close(); };
}

export default function cockpit(pi: ExtensionAPI): void {
	let cleanup: (() => void) | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Key parsing must go through pi-tui so the Kitty keyboard protocol (Ghostty,
		// kitty) works; imported dynamically so bare-node unit tests can import this module.
		const { matchesKey, isKeyRelease } = await import("@earendil-works/pi-tui");
		let snapshot = loadCockpitSnapshot(ctx.cwd);
		let tuiRender = () => {};
		const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
		const lock = acquireBoardLock(ctx.cwd);
		let feedback = lock ? "Owner starting…" : "View-only: another board already supervises this task";
		const supervisor = lock ? new OwnerSupervisor(ctx.cwd, extensionPath, (message) => { feedback = message; snapshot = loadCockpitSnapshot(ctx.cwd); tuiRender(); }) : null;
		supervisor?.start();
		const stopWatch = watchState(ctx.cwd, () => { snapshot = loadCockpitSnapshot(ctx.cwd); tuiRender(); });
		cleanup = () => { stopWatch(); supervisor?.stop(); lock?.(); };
		ctx.ui.setTitle("council cockpit");
		void ctx.ui.custom<void>((tui, theme, _keys, done) => {
			const view = new BoardView();
			let frame = 0;
			const palette: Palette = theme ? { fg: (color, text) => theme.fg(color as never, text), bold: (text) => theme.bold(text) } : PLAIN_PALETTE;
			const live = () => !snapshot.connected || snapshot.children.length > 0 || [...snapshot.gates.design, ...snapshot.gates.implementation].some((row) => row.state === "reviewing");
			const spinner = setInterval(() => { if (live()) { frame += 1; tui.requestRender(); } }, 160);
			spinner.unref?.();
			tuiRender = () => tui.requestRender();
			return {
				render: (width: number) => view.renderPage(snapshot, width, Math.max(8, (process.stdout.rows ?? 24) - 2), feedback, palette, frame),
				invalidate() { snapshot = loadCockpitSnapshot(ctx.cwd); },
				handleInput(data: string) {
					if (isKeyRelease(data)) return;
					const is = (id: string): boolean => matchesKey(data, id as never);
					const rerender = () => tui.requestRender();
					if (is("down") || is("j") || is("shift+j")) { view.move(1); rerender(); return; }
					if (is("up") || is("u") || is("shift+u")) { view.move(-1); rerender(); return; }
					if (is("enter") || is("space")) { view.toggle(); rerender(); return; }
					if (is("right") || is("l")) { view.expand(); rerender(); return; }
					if (is("left") || is("h")) { view.collapse(); rerender(); return; }
					if (is("tab")) { view.switchTab(); rerender(); return; }
					if (is("pageDown")) { view.movePage(1); rerender(); return; }
					if (is("pageUp")) { view.movePage(-1); rerender(); return; }
					if (is("g") || is("home")) { view.first(); rerender(); return; }
					if (is("shift+g") || is("end")) { view.last(); rerender(); return; }
					if (is("q") || is("shift+q") || is("escape")) { clearInterval(spinner); cleanup?.(); done(undefined); ctx.shutdown(); return; }
					if (snapshot.active && (is("a") || is("shift+a"))) void ctx.ui.input("Append requirement", "The Owner will record and propagate this requirement").then((text) => {
						if (!text?.trim()) return;
						feedback = "Requirement sending…";
						tui.requestRender();
						supervisor?.append(text.trim()).then((message) => { feedback = message; tui.requestRender(); });
					});
					if (snapshot.active && (is("k") || is("shift+k"))) void ctx.ui.confirm("Kill task?", "This permanently ends the task but keeps all records.").then((confirmed) => {
						if (confirmed) supervisor?.killTask().then((message) => { feedback = message; tui.requestRender(); });
					});
				},
			};
		}).finally(() => cleanup?.());
	});
	pi.on("session_shutdown", () => cleanup?.());
}
