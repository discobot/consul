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

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Reads complete JSONL records and deliberately ignores a torn final record. */
export function parseJsonl(raw: string): JsonObject[] {
	const lines = raw.split("\n");
	const complete = raw.endsWith("\n") ? lines : lines.slice(0, -1);
	const result: JsonObject[] = [];
	for (const line of complete) {
		if (!line.trim()) continue;
		try {
			const value = object(JSON.parse(line));
			if (value) result.push(value);
		} catch {
			// A bad/torn record is not canonical state; the engine can re-source it.
		}
	}
	return result;
}

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
		if (!task) return { statement: "No active task — send a task through the Owner first", requirements: [], phase: "IDLE", gates: { design: [], implementation: [] }, blockers: [], children: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: true, errors };
		const status = store.readStatus();
		const activity = store.readActivity();
		const totals = store.spendTotals();
		const heartbeat = status?.heartbeatAt;
		const connected = task.status !== "active" || Boolean(heartbeat && now - Date.parse(heartbeat) <= STATUS_STALE_MS);
		const rows = (gate?: StatusGate): BoardVerifier[] => gate?.verifiers.map((verifier) => ({ name: verifier.name, state: stateName(verifier.state), comments: verifier.comments ?? [] })) ?? [];
		return {
			taskId: task.id,
			statement: task.statement,
			requirements: task.requirements.map((requirement) => requirement.text),
			phase: status?.phase ?? (task.status === "done" ? "DONE" : task.status === "killed" ? "KILLED" : "UNKNOWN"),
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
		return { statement: "Task state unavailable", requirements: [], phase: "UNKNOWN", gates: { design: [], implementation: [] }, blockers: ["Canonical task status is unavailable"], children: [], spend: { cost: 0, tokens: 0, entries: 0 }, design: "", connected: false, errors };
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

function wrap(text: string, width: number, prefix = ""): string[] {
	const value = clean(text);
	const indent = " ".repeat(displayWidth(prefix));
	const lines: string[] = [];
	let lead = prefix;
	let line = "";
	let used = displayWidth(lead);
	for (const char of value) {
		const cells = charWidth(char);
		if (line && used + cells > Math.max(1, width)) {
			lines.push(lead + line);
			lead = indent;
			line = char === " " ? "" : char;
			used = displayWidth(lead) + (char === " " ? 0 : cells);
		} else { line += char; used += cells; }
	}
	lines.push(lead + line);
	return lines;
}

/** Plain, deterministic board rendering; runtime theming is intentionally optional. */
export function renderCockpit(snapshot: BoardSnapshot, width: number): string[] {
	width = Math.max(1, width);
	const lines: string[] = [cut(`◆ council cockpit  #${snapshot.taskId ?? "—"}  ${snapshot.phase}${snapshot.connected ? "" : "  · reconnecting"}`, width)];
	lines.push(cut("─".repeat(width), width), ...wrap(snapshot.statement, width, "Statement: "));
	lines.push("Requirements");
	lines.push(...(snapshot.requirements.length ? snapshot.requirements.flatMap((r, i) => wrap(r, width, ` ${i + 1}. `)) : ["  (none recorded)"]));
	for (const [gate, rows] of [["DESIGN GATE", snapshot.gates.design], ["IMPLEMENTATION GATE", snapshot.gates.implementation]] as const) {
		lines.push("", cut(gate, width));
		lines.push(...(rows.length ? rows.flatMap((row) => [...wrap(`${row.state.padEnd(12)} ${row.name}`, width, " "), ...row.comments.flatMap((c) => wrap(c, width, "   ↳ "))]) : ["  (verdicts pending)"]));
	}
	lines.push("", "Blocking comments");
	lines.push(...(snapshot.blockers.length ? snapshot.blockers.flatMap((b) => wrap(b, width, " • ")) : ["  none"]));
	lines.push("", "Running children");
	lines.push(...(snapshot.children.length ? snapshot.children.flatMap((c) => wrap(`${c.name}: ${c.status}`, width, " • ")) : ["  none"]));
	lines.push("", cut(`Spend  $${snapshot.spend.cost.toFixed(4)} · ${snapshot.spend.tokens.toLocaleString("en-US")} tokens · ${snapshot.spend.entries} runs`, width));
	if (snapshot.errors.length) lines.push(...snapshot.errors.flatMap((error) => wrap(error, width, "State warning: ")));
	return lines.map((line) => cut(line, width));
}

export function renderCockpitPage(snapshot: BoardSnapshot, width: number, height: number, offset = 0, feedback = ""): { lines: string[]; offset: number; maxOffset: number } {
	const all = renderCockpit(snapshot, width);
	const controls = cut(snapshot.taskId ? "↑↓ [a]+req [k]kill [q]close" : "[q] close · no active task", width);
	const footer = feedback ? [cut(feedback, width), controls] : [controls];
	const bodyHeight = Math.max(1, height - footer.length);
	const maxOffset = Math.max(0, all.length - bodyHeight);
	const safeOffset = Math.max(0, Math.min(offset, maxOffset));
	return { lines: [...all.slice(safeOffset, safeOffset + bodyHeight), ...footer], offset: safeOffset, maxOffset };
}

export interface RestartState { attempts: number; lastStartedAt?: number }

export function appendRequirementRpcCommand(text: string): JsonObject {
	return {
		type: "prompt",
		message: `Append this user requirement exactly through council's task_requirements_add tool, propagate it through design and implementation, and re-source stale verdicts: ${JSON.stringify(text)}`,
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
		void ctx.ui.custom<void>((tui, _theme, _keys, done) => {
			let scroll = 0;
			tuiRender = () => tui.requestRender();
			return {
				render: (width: number) => {
					const page = renderCockpitPage(snapshot, width, Math.max(8, (process.stdout.rows ?? 24) - 2), scroll, feedback);
					scroll = page.offset;
					return page.lines;
				},
				invalidate() { snapshot = loadCockpitSnapshot(ctx.cwd); },
				handleInput(data: string) {
					if (["j", "J", "\u001b[B"].includes(data)) { scroll += 1; tui.requestRender(); return; }
					if (["u", "U", "\u001b[A"].includes(data)) { scroll = Math.max(0, scroll - 1); tui.requestRender(); return; }
					if (data === "q" || data === "Q" || data === "\u001b") { cleanup?.(); done(undefined); ctx.shutdown(); return; }
					if (snapshot.taskId && (data === "a" || data === "A")) void ctx.ui.input("Append requirement", "The Owner will record and propagate this requirement").then((text) => {
						if (!text?.trim()) return;
						feedback = "Requirement sending…";
						tui.requestRender();
						supervisor.append(text.trim()).then((message) => { feedback = message; tui.requestRender(); });
					});
					if (snapshot.taskId && (data === "k" || data === "K")) void ctx.ui.confirm("Kill task?", "This permanently ends the task but keeps all records.").then((confirmed) => {
						if (confirmed) supervisor.killTask().then((message) => { feedback = message; tui.requestRender(); });
					});
				},
			};
		}).finally(() => cleanup?.());
	});
	pi.on("session_shutdown", () => cleanup?.());
}
