import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LaunchStore, type StatusGate } from "./state.ts";

export type BoardState = "GO" | "NO-GO" | "stale" | "pending" | "reviewing";

export interface BoardVerifier {
	name: string;
	state: BoardState;
	comments: string[];
}

export interface BoardChild {
	name: string;
	status: string;
}

export interface BoardSnapshot {
	taskId?: string;
	active: boolean;
	statement: string;
	requirements: string[];
	phase: string;
	gates: { design: BoardVerifier[]; implementation: BoardVerifier[] };
	blockers: string[];
	children: BoardChild[];
	spend: { cost: number; tokens: number; entries: number };
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
	if (normalized === "stale" || normalized === "reviewing") return normalized;
	return "pending";
}

/** Canonical disk projection. Freshness is consumed only from engine-written status.json. */
export function loadCockpitSnapshot(cwd: string, now = Date.now()): BoardSnapshot {
	const errors: string[] = [];
	try {
		const store = new LaunchStore(cwd);
		const task = store.latest();
		if (!task) return { active: false, statement: "No active task — close the board and start one in an Owner session", requirements: [], phase: "IDLE", gates: { design: [], implementation: [] }, blockers: [], children: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: true, errors };
		const status = store.readStatus();
		const activity = store.readActivity();
		const totals = store.spendTotals();
		const heartbeat = status?.heartbeatAt;
		const connected = task.status !== "active" || Boolean(heartbeat && now - Date.parse(heartbeat) <= STATUS_STALE_MS);
		const rows = (gate?: StatusGate): BoardVerifier[] => gate?.verifiers.map((verifier) => ({ name: verifier.name, state: stateName(verifier.state), comments: verifier.comments ?? [] })) ?? [];
		return {
			taskId: task.id,
			active: task.status === "active",
			statement: task.statement,
			requirements: task.requirements.map((requirement) => requirement.text),
			phase: task.status === "done" ? "DONE" : task.status === "killed" ? "KILLED" : status?.phase ?? "UNKNOWN",
			gates: { design: rows(status?.design), implementation: rows(status?.implementation) },
			blockers: status?.blockers ?? (task.status === "active" ? ["Gate status unavailable until the Owner reconnects"] : []),
			children: activity?.children.map((child) => ({ name: child.name, status: child.detail ?? child.status })) ?? [],
			spend: { cost: totals.costUsd, tokens: totals.tokens.total, entries: totals.runs },
			design: store.readDesign() ?? "",
			connected,
			updatedAt: heartbeat,
			errors,
		};
	} catch (error) {
		errors.push((error as Error).message);
		return { active: false, statement: "Task state unavailable", requirements: [], phase: "UNKNOWN", gates: { design: [], implementation: [] }, blockers: ["Canonical task status is unavailable"], children: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: false, errors };
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

function panel(title: Span[], rows: Span[][], width: number, palette: Palette, badge: Span[] = []): string[] {
	if (width < 12) return [fitSpans(title, width), ...rows.map((row) => fitSpans(row, width))].map((row) => paint(row, palette));
	const inner = width - 4;
	// A badge that cannot leave room for at least one title cell is dropped, never overflowed.
	const shown = badge.length && spansWidth(badge) <= width - 9 ? badge : [];
	const titleBudget = Math.max(1, shown.length ? width - 8 - spansWidth(shown) : width - 5);
	const titleFit = fitSpans(title, titleBudget);
	const fill = "─".repeat(Math.max(0, titleBudget - spansWidth(titleFit)));
	const top: Span[] = [span("╭─ ", BORDER), ...titleFit, span(" ", BORDER), span(fill, BORDER), ...(shown.length ? [span(" "), ...shown, span(" ─", BORDER)] : []), span("╮", BORDER)];
	const body = (rows.length ? rows : [[span("")]]).map((row) => {
		const fitted = fitSpans(row, inner);
		return [span("│ ", BORDER), ...fitted, span(" ".repeat(Math.max(0, inner - spansWidth(fitted)))), span(" │", BORDER)];
	});
	return [top, ...body, [span(`╰${"─".repeat(width - 2)}╯`, BORDER)]].map((row) => paint(row, palette));
}

function gatePanel(name: string, rows: BoardVerifier[], width: number, palette: Palette, frame: number): string[] {
	const inner = Math.max(1, width - 4);
	const go = rows.filter((row) => row.state === "GO").length;
	const badge: Span[] = rows.length === 0 ? [] : go === rows.length
		? [span("✓ HOLDS", "success", true)]
		: [span(`${go}/${rows.length} GO`, go > 0 ? "warning" : "muted")];
	const body: Span[][] = rows.length
		? rows.flatMap((row) => {
			const style = STATE_STYLE[row.state];
			const icon = row.state === "reviewing" ? SPINNER[frame % SPINNER.length] : style.icon;
			const label: Span[] = [span(icon, style.color, true), span(" "), span(cut(row.name, Math.max(1, inner - 2)), row.state === "NO-GO" ? "error" : undefined)];
			return [label, ...row.comments.flatMap((comment) => wrap(comment, inner, "  ↳ ").map((line) => [span(line, "muted")]))];
		})
		: [[span("(verdicts pending)", "muted")]];
	return panel([span(name, undefined, true)], body, width, palette, badge);
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

export function renderPanels(snapshot: BoardSnapshot, width: number, palette: Palette = PLAIN_PALETTE, frame = 0): string[] {
	width = Math.max(1, width);
	const inner = Math.max(1, width - 4);
	const lines: string[] = [];
	const count = snapshot.requirements.length;
	const taskBody: Span[][] = wrap(snapshot.statement, inner).map((line) => [span(line)]);
	if (snapshot.taskId) {
		taskBody.push([span("")]);
		if (count) for (const [index, requirement] of snapshot.requirements.entries()) taskBody.push(...prefixedRows(requirement, inner, ` ${index + 1}. `, "muted"));
		else taskBody.push([span(" (none recorded)", "muted")]);
	}
	lines.push(...panel([span(snapshot.taskId ? "Task" : "Board", undefined, true)], taskBody, width, palette, snapshot.taskId ? [span(`${count} ${count === 1 ? "requirement" : "requirements"}`, "muted")] : []));
	if (snapshot.taskId) {
		if (width >= 64) {
			const leftWidth = Math.floor((width - 1) / 2);
			const left = gatePanel("Design gate", snapshot.gates.design, leftWidth, palette, frame);
			const right = gatePanel("Implementation gate", snapshot.gates.implementation, width - 1 - leftWidth, palette, frame);
			for (let index = 0; index < Math.max(left.length, right.length); index++) lines.push(`${left[index] ?? " ".repeat(leftWidth)} ${right[index] ?? ""}`);
		} else {
			lines.push(...gatePanel("Design gate", snapshot.gates.design, width, palette, frame));
			lines.push(...gatePanel("Implementation gate", snapshot.gates.implementation, width, palette, frame));
		}
		if (snapshot.blockers.length) lines.push(...panel([span("Blockers", "error", true)], snapshot.blockers.flatMap((blocker) => prefixedRows(blocker, inner, " ✗ ", "error")), width, palette));
		if (snapshot.children.length) lines.push(...panel([span("Activity", "accent", true)], snapshot.children.flatMap((child) => prefixedRows(`${child.name} — ${child.status}`, inner, `${SPINNER[frame % SPINNER.length]} `, "accent")), width, palette));
		lines.push(...panel([span("Spend", undefined, true)], wrap(`$${snapshot.spend.cost.toFixed(4)} · ${snapshot.spend.tokens.toLocaleString("en-US")} tokens · ${snapshot.spend.entries} runs`, inner).map((line) => [span(line, "muted")]), width, palette));
	}
	if (snapshot.errors.length) lines.push(...panel([span("State warnings", "warning", true)], snapshot.errors.flatMap((error) => prefixedRows(error, inner, " ⚠ ", "warning")), width, palette));
	return lines;
}

export function renderCockpit(snapshot: BoardSnapshot, width: number, palette: Palette = PLAIN_PALETTE, frame = 0): string[] {
	return [...renderHeader(snapshot, width, palette, frame), ...renderPanels(snapshot, width, palette, frame)];
}

export function renderCockpitPage(snapshot: BoardSnapshot, width: number, height: number, offset = 0, feedback = "", palette: Palette = PLAIN_PALETTE, frame = 0): { lines: string[]; offset: number; maxOffset: number; pageSize: number } {
	width = Math.max(1, width);
	height = Math.max(4, height);
	const header = renderHeader(snapshot, width, palette, frame);
	const body = renderPanels(snapshot, width, palette, frame);
	const key = (label: string, action: string): Span[] => [span(label, "accent", true), span(` ${action}`, "muted")];
	const hintRows = packSpanCells(snapshot.active
		? [key("a", "append"), key("k", "kill"), key("↑↓", "scroll"), key("⇞⇟", "page"), key("g/G", "ends"), key("q", "close")]
		: [key("↑↓", "scroll"), key("q", "close")], width);
	let feedbackRows = feedback ? wrap(feedback, Math.max(1, width - 2), "▸ ").map((line) => [span(line, "accent")]) : [];
	const fixed = header.length + hintRows.length + 1;
	feedbackRows = feedbackRows.slice(0, Math.max(0, height - fixed - 1));
	const pageSize = Math.max(1, height - fixed - feedbackRows.length);
	const maxOffset = Math.max(0, body.length - pageSize);
	const finalOffset = Math.max(0, Math.min(offset, maxOffset));
	const visible = body.slice(finalOffset, finalOffset + pageSize);
	while (visible.length < pageSize) visible.push("");
	const last = Math.min(body.length, finalOffset + pageSize);
	const status: Span[] = [
		span(finalOffset > 0 ? "▲ " : "  ", "accent"),
		span(`${body.length ? finalOffset + 1 : 0}–${last}/${body.length}`, "muted"),
		span(last < body.length ? " ▼" : "  ", "accent"),
		...(snapshot.updatedAt ? [span(`   heartbeat ${snapshot.updatedAt.slice(11, 19)}`, "dim")] : []),
	];
	const lines = [...header, ...visible, ...feedbackRows.map((row) => paint(row, palette)), paint(fitSpans(status, width), palette), ...hintRows.map((row) => paint(row, palette))];
	return { lines: lines.slice(0, height), offset: finalOffset, maxOffset, pageSize };
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

export class OwnerSupervisor {
	private child?: ChildProcessWithoutNullStreams;
	private heartbeat?: ReturnType<typeof setInterval>;
	private restartTimer?: ReturnType<typeof setTimeout>;
	private lastEvent = Date.now();
	private expectedTick = Date.now() + HEARTBEAT_MS;
	private restartState: RestartState = { attempts: 0 };
	private stopped = false;
	private ready = false;
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
		this.send("get_state", {}).then((ok) => { if (ok) { this.ready = true; this.changed("Owner connected"); this.flushQueuedAppend(); } });
	}

	private tick(): void {
		const now = Date.now();
		if (isSleepJump(this.expectedTick, now) || now - this.lastEvent > INACTIVITY_MS) {
			this.changed(isSleepJump(this.expectedTick, now) ? "Sleep/wake detected; restarting Owner…" : "Owner heartbeat timed out; restarting…");
			this.terminate();
		} else if (this.child) void this.send("get_state", {});
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
		if (!this.ready) return new Promise((resolve) => { this.queuedAppends.push({ text, resolve }); this.changed(`${this.queuedAppends.length} requirement(s) queued while Owner reconnects`); });
		return this.promptAppend(text);
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
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let snapshot = loadCockpitSnapshot(ctx.cwd);
		let feedback = "Owner starting…";
		let tuiRender = () => {};
		const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
		const supervisor = new OwnerSupervisor(ctx.cwd, extensionPath, (message) => { feedback = message; snapshot = loadCockpitSnapshot(ctx.cwd); tuiRender(); });
		supervisor.start();
		const stopWatch = watchState(ctx.cwd, () => { snapshot = loadCockpitSnapshot(ctx.cwd); tuiRender(); });
		cleanup = () => { stopWatch(); supervisor.stop(); };
		ctx.ui.setTitle("council cockpit");
		void ctx.ui.custom<void>((tui, theme, _keys, done) => {
			let scroll = 0;
			let frame = 0;
			let pageSize = 8;
			const palette: Palette = theme ? { fg: (color, text) => theme.fg(color as never, text), bold: (text) => theme.bold(text) } : PLAIN_PALETTE;
			const live = () => !snapshot.connected || snapshot.children.length > 0 || [...snapshot.gates.design, ...snapshot.gates.implementation].some((row) => row.state === "reviewing");
			const spinner = setInterval(() => { if (live()) { frame += 1; tui.requestRender(); } }, 160);
			spinner.unref?.();
			tuiRender = () => tui.requestRender();
			return {
				render: (width: number) => {
					const page = renderCockpitPage(snapshot, width, Math.max(8, (process.stdout.rows ?? 24) - 2), scroll, feedback, palette, frame);
					scroll = page.offset;
					pageSize = page.pageSize;
					return page.lines;
				},
				invalidate() { snapshot = loadCockpitSnapshot(ctx.cwd); },
				handleInput(data: string) {
					if (["j", "J", "\u001b[B"].includes(data)) { scroll += 1; tui.requestRender(); return; }
					if (["u", "U", "\u001b[A"].includes(data)) { scroll = Math.max(0, scroll - 1); tui.requestRender(); return; }
					if (data === "\u001b[6~" || data === " ") { scroll += pageSize; tui.requestRender(); return; }
					if (data === "\u001b[5~") { scroll = Math.max(0, scroll - pageSize); tui.requestRender(); return; }
					if (data === "g" || data === "\u001b[H") { scroll = 0; tui.requestRender(); return; }
					if (data === "G" || data === "\u001b[F") { scroll = Number.MAX_SAFE_INTEGER; tui.requestRender(); return; }
					if (data === "q" || data === "Q" || data === "\u001b") { clearInterval(spinner); cleanup?.(); done(undefined); ctx.shutdown(); return; }
					if (snapshot.active && (data === "a" || data === "A")) void ctx.ui.input("Append requirement", "The Owner will record and propagate this requirement").then((text) => {
						if (!text?.trim()) return;
						feedback = "Requirement sending…";
						tui.requestRender();
						supervisor.append(text.trim()).then((message) => { feedback = message; tui.requestRender(); });
					});
					if (snapshot.active && (data === "k" || data === "K")) void ctx.ui.confirm("Kill task?", "This permanently ends the task but keeps all records.").then((confirmed) => {
						if (confirmed) supervisor.killTask().then((message) => { feedback = message; tui.requestRender(); });
					});
				},
			};
		}).finally(() => cleanup?.());
	});
	pi.on("session_shutdown", () => cleanup?.());
}
