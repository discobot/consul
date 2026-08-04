/**
 * Task state: persistence under .pi/council/, content hashing, and gate logic.
 *
 * Everything is plain files so the user can inspect task state without the TUI
 * and so state survives session restarts.
 */

import { execFile, execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Gate = "design" | "implementation";
export const GATES: Gate[] = ["design", "implementation"];

/** Runtime bookkeeping is not product implementation. Project config and verifier
 * overrides deliberately remain in committed artifacts and cleanliness checks. */
const RUNTIME_PATHSPECS = [":(exclude).pi/council/current", ":(exclude).pi/council/last", ":(exclude).pi/council/intake.json", ":(exclude).pi/council/tasks/**"];

export interface Requirement {
	text: string;
	addedAt: string;
}

export interface PendingInputAttachment {
	path: string;
	name?: string;
	mediaType?: string;
}

export interface InitialInput {
	text: string;
	images?: { data: string; mimeType: string }[];
	capturedAt: string;
}

export interface PendingInput {
	id: string;
	text: string;
	receivedAt: string;
	attachments?: PendingInputAttachment[];
}

export interface TaskRecord {
	id: string;
	statement: string;
	requirements: Requirement[];
	/** Attachments from the immutable first task message. */
	attachments?: PendingInputAttachment[];
	/** User messages captured after task creation and not yet recorded as requirements. */
	pendingInputs?: PendingInput[];
	baseCommit: string;
	baseBranch: string;
	createdAt: string;
	status: "active" | "done" | "killed";
	closedAt?: string;
	summary?: string;
}

export interface Verdict {
	gate: Gate;
	verifier: string;
	verdict: "go" | "no-go";
	comments: string[];
	hash: string;
	at: string;
	parseError?: boolean;
	/** Fingerprint of the normalized verifier definition used for this review. */
	fingerprint?: string;
}

export type VerifierGateState = "go" | "no-go" | "overruled" | "stale" | "pending";

export interface GateReport {
	gate: Gate;
	hash: string;
	verifiers: { name: string; state: VerifierGateState; verdict?: Verdict }[];
	holds: boolean;
	pendingInputIds?: string[];
}

export type LifecyclePhase =
	| "REQUIREMENTS"
	| "DESIGNING"
	| "DESIGN_GATE"
	| "IMPLEMENTING"
	| "IMPL_GATE"
	| "DONE"
	| "KILLED";

export interface ReviewActivity {
	design?: boolean;
	implementation?: boolean;
}

export type SpendKind = "owner" | "worker" | "verifier" | "clerk";
export type SpendStatus = "ok" | "failed" | "aborted";

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One completed, observable agent run. Monetary values are always USD. */
export interface SpendEntry {
	at: string;
	kind: SpendKind;
	name: string;
	model: string;
	tokens: TokenUsage;
	costUsd: number;
	status: SpendStatus;
}

export interface SpendBreakdown {
	runs: number;
	tokens: TokenUsage & { total: number };
	costUsd: number;
}

export interface SpendTotals extends SpendBreakdown {
	byKind: Record<SpendKind, SpendBreakdown>;
}

export interface ChildActivity {
	id: string;
	kind: "worker" | "verifier" | "clerk";
	name: string;
	status: "running" | "terminating";
	startedAt: string;
	updatedAt: string;
	model?: string;
	detail?: string;
}

export interface ActivitySnapshot {
	taskId: string;
	updatedAt: string;
	children: ChildActivity[];
}

export type ProjectedVerifierState = VerifierGateState | "reviewing";

export interface StatusVerifier {
	name: string;
	fingerprint: string;
	state: ProjectedVerifierState;
	comments?: string[];
}

export interface StatusGate {
	hash: string;
	holds: boolean;
	verifiers: StatusVerifier[];
}

/** Shared, persisted presentation contract consumed by in-pi and cockpit views. */
export interface StatusSnapshot {
	taskId: string;
	phase: LifecyclePhase;
	generatedAt: string;
	heartbeatAt: string;
	pendingInputIds: string[];
	blockers: string[];
	spend: SpendTotals;
	design: StatusGate;
	implementation: StatusGate;
}

function emptyTokenUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyBreakdown(): SpendBreakdown {
	return { runs: 0, tokens: { ...emptyTokenUsage(), total: 0 }, costUsd: 0 };
}

export function totalSpend(entries: readonly SpendEntry[]): SpendTotals {
	const totals: SpendTotals = {
		...emptyBreakdown(),
		byKind: { owner: emptyBreakdown(), worker: emptyBreakdown(), verifier: emptyBreakdown(), clerk: emptyBreakdown() },
	};
	for (const entry of entries) {
		const buckets = [totals, totals.byKind[entry.kind]];
		for (const bucket of buckets) {
			bucket.runs++;
			bucket.costUsd += entry.costUsd;
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				bucket.tokens[key] += entry.tokens[key];
				bucket.tokens.total += entry.tokens[key];
			}
		}
	}
	return totals;
}

/** The single lifecycle authority used by status surfaces. */
export function derivePhase(
	task: TaskRecord,
	hasDesign: boolean,
	design: GateReport,
	implementation: GateReport,
	activity: ReviewActivity = {},
): LifecyclePhase {
	if (task.status === "done") return "DONE";
	if (task.status === "killed") return "KILLED";
	if (task.requirements.length === 0 || (task.pendingInputs?.length ?? 0) > 0) return "REQUIREMENTS";
	if (!hasDesign) return "DESIGNING";
	if (!design.holds) return "DESIGN_GATE";
	if (implementation.holds) return "IMPL_GATE";
	return activity.implementation ? "IMPL_GATE" : "IMPLEMENTING";
}

export interface LaunchConfig {
	/** "provider/model" used for all spawned children unless overridden below. */
	model?: string;
	verifierModel?: string;
	workerModel?: string;
	clerkModel?: string;
	/** Persistent model overrides keyed by verifier name. */
	verifierModels?: Record<string, string>;
	/** Max children running at once. */
	concurrency?: number;
	/** Per-child wall-clock timeout. */
	timeoutMinutes?: number;
	/** Minutes without a parsed child JSONL event before termination. */
	inactivityMinutes?: number;
}


/** The Clerk's persistent arbitration ledger — the stateful counterpart to stateless judges. */
export interface ClerkItem {
	id: string;
	gate: Gate;
	title: string;
	detail: string;
	status: "open" | "resolved" | "overruled";
	sources: { verifier: string; at: string; hash: string }[];
	ruling?: string;
	updatedAt: string;
}
export interface ClerkOverrule { gate: Gate; verifier: string; hash: string; reason: string; at: string }
export interface ClerkState { v: 1; items: ClerkItem[]; overrules: ClerkOverrule[]; updatedAt?: string }
export const emptyClerkState = (): ClerkState => ({ v: 1, items: [], overrules: [] });

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return stdout.trimEnd();
}

function sha256(...parts: string[]): string {
	const h = crypto.createHash("sha256");
	for (const part of parts) {
		h.update(part);
		h.update("\0");
	}
	return h.digest("hex").slice(0, 16);
}

export class LaunchStore {
	readonly cwd: string;

	constructor(cwd: string) {
		try {
			this.cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		} catch {
			// createTask supplies the more useful error for non-repositories.
			this.cwd = path.resolve(cwd);
		}
	}

	get rootDir(): string {
		return path.join(this.cwd, ".pi", "council");
	}

	private get currentFile(): string {
		return path.join(this.rootDir, "current");
	}

	private get lastFile(): string {
		return path.join(this.rootDir, "last");
	}

	taskDir(id: string): string {
		return path.join(this.rootDir, "tasks", id);
	}

	designPath(id: string): string {
		return path.join(this.taskDir(id), "design.md");
	}

	captureInitialInput(text: string, images: { data: string; mimeType: string }[] = []): InitialInput {
		const value: InitialInput = { text, capturedAt: new Date().toISOString(), ...(images.length ? { images } : {}) };
		this.atomicWrite(path.join(this.rootDir, "intake.json"), `${JSON.stringify(value)}\n`);
		return value;
	}

	readInitialInput(): InitialInput | null {
		const file = path.join(this.rootDir, "intake.json");
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8")) as InitialInput;
			if (!value || typeof value.text !== "string" || typeof value.capturedAt !== "string") throw new Error("invalid intake shape");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(`Cannot load captured council intake at ${file}: ${(error as Error).message}`);
		}
	}

	clearInitialInput(): void {
		try { fs.unlinkSync(path.join(this.rootDir, "intake.json")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}

	loadConfig(): LaunchConfig {
		const configPath = path.join(this.rootDir, "config.json");
		let raw: string;
		try {
			raw = fs.readFileSync(configPath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`Cannot read council config at ${configPath}: ${(error as Error).message}`);
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new Error(`Invalid JSON in council config at ${configPath}: ${(error as Error).message}`);
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`Invalid council config at ${configPath}: expected a JSON object.`);
		}
		const config = value as Record<string, unknown>;
		const validModel = (model: unknown): model is string => typeof model === "string" && /^[^/\s]+\/[^/\s]+$/.test(model);
		for (const key of ["model", "verifierModel", "workerModel", "clerkModel"] as const) {
			if (config[key] !== undefined && !validModel(config[key])) {
				throw new Error(`Invalid council config at ${configPath}: ${key} must be provider/model.`);
			}
		}
		if (config.verifierModels !== undefined) {
			if (!config.verifierModels || typeof config.verifierModels !== "object" || Array.isArray(config.verifierModels)) {
				throw new Error(`Invalid council config at ${configPath}: verifierModels must be an object.`);
			}
			for (const [name, model] of Object.entries(config.verifierModels as Record<string, unknown>)) {
				if (!name.trim() || !validModel(model)) {
					throw new Error(`Invalid council config at ${configPath}: verifierModels must map non-empty names to provider/model strings.`);
				}
			}
		}
		if (
			config.concurrency !== undefined &&
			(typeof config.concurrency !== "number" || !Number.isInteger(config.concurrency) || config.concurrency < 1)
		) {
			throw new Error(`Invalid council config at ${configPath}: concurrency must be a positive integer.`);
		}
		if (
			config.timeoutMinutes !== undefined &&
			(typeof config.timeoutMinutes !== "number" || !Number.isFinite(config.timeoutMinutes) || config.timeoutMinutes <= 0)
		) {
			throw new Error(`Invalid council config at ${configPath}: timeoutMinutes must be a positive number.`);
		}
		if (
			config.inactivityMinutes !== undefined &&
			(typeof config.inactivityMinutes !== "number" || !Number.isFinite(config.inactivityMinutes) || config.inactivityMinutes < 0.1 || config.inactivityMinutes > 120)
		) {
			throw new Error(`Invalid council config at ${configPath}: inactivityMinutes must be between 0.1 and 120.`);
		}
		return config as LaunchConfig;
	}

	private taskFromPointer(file: string, label: string): TaskRecord | null {
		let id: string;
		try {
			id = fs.readFileSync(file, "utf-8").trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(`Cannot read council ${label} pointer at ${file}: ${(error as Error).message}`);
		}
		if (!id) return null;
		const taskPath = path.join(this.taskDir(id), "task.json");
		try {
			const task = JSON.parse(fs.readFileSync(taskPath, "utf-8")) as TaskRecord;
			if (
				!task || task.id !== id || typeof task.statement !== "string" || !Array.isArray(task.requirements) ||
				!task.requirements.every((item) => item && typeof item.text === "string" && typeof item.addedAt === "string") ||
				typeof task.baseCommit !== "string" || typeof task.baseBranch !== "string" || typeof task.createdAt !== "string" ||
				!["active", "done", "killed"].includes(task.status) || (task.pendingInputs !== undefined && !Array.isArray(task.pendingInputs))
			) throw new Error("invalid task record shape");
			return task;
		} catch (error) {
			throw new Error(`Cannot load ${label} council task from ${taskPath}: ${(error as Error).message}`);
		}
	}

	current(): TaskRecord | null {
		const task = this.taskFromPointer(this.currentFile, "current-task");
		if (task && task.status !== "active") {
			// Idempotent recovery for a crash after terminal task.json was committed.
			this.atomicWrite(this.lastFile, `${task.id}\n`);
			this.atomicWrite(this.currentFile, "\n");
			return null;
		}
		return task;
	}
	latest(): TaskRecord | null { return this.current() ?? this.taskFromPointer(this.lastFile, "last-task"); }

	private atomicWrite(file: string, content: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
		try {
			fs.writeFileSync(temporary, content);
			fs.renameSync(temporary, file);
		} finally {
			try {
				fs.unlinkSync(temporary);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}

	private saveTask(task: TaskRecord): void {
		fs.mkdirSync(this.taskDir(task.id), { recursive: true });
		this.atomicWrite(path.join(this.taskDir(task.id), "task.json"), `${JSON.stringify(task, null, "\t")}\n`);
		const rendered = task.requirements.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
		this.atomicWrite(
			path.join(this.taskDir(task.id), "requirements.md"),
			`# Requirements — task #${task.id}\n\n${rendered}\n`,
		);
	}

	async createTask(statement: string, requirements: string[]): Promise<TaskRecord> {
		const existing = this.current();
		if (existing) {
			throw new Error(
				`Task #${existing.id} is already active. Only one task at a time; the user may kill it with /task kill.`,
			);
		}
		let baseCommit: string;
		let baseBranch: string;
		try {
			baseCommit = await git(this.cwd, ["rev-parse", "HEAD"]);
			baseBranch = await git(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		} catch (err) {
			throw new Error(
				`council requires a git repository with at least one commit (${err instanceof Error ? err.message.split("\n")[0] : err}).`,
			);
		}
		const now = new Date().toISOString();
		let id: string;
		do id = crypto.randomBytes(12).toString("hex");
		while (fs.existsSync(this.taskDir(id)));
		const task: TaskRecord = {
			id,
			statement,
			requirements: requirements.map((text) => ({ text, addedAt: now })),
			pendingInputs: [],
			baseCommit,
			baseBranch,
			createdAt: now,
			status: "active",
		};
		this.saveTask(task);
		this.atomicWrite(this.currentFile, `${task.id}\n`);
		return task;
	}

	setTaskAttachments(attachments: PendingInputAttachment[]): TaskRecord {
		const task = this.mustCurrent();
		task.attachments = attachments;
		this.saveTask(task);
		return task;
	}

	addPendingInput(text: string, attachments?: PendingInputAttachment[]): PendingInput {
		const task = this.mustCurrent();
		const input: PendingInput = {
			id: crypto.randomBytes(12).toString("hex"),
			text,
			receivedAt: new Date().toISOString(),
			...(attachments?.length ? { attachments } : {}),
		};
		(task.pendingInputs ??= []).push(input);
		this.saveTask(task);
		return input;
	}

	addPendingInputWithImages(text: string, images: { data: string; mimeType: string }[] = []): PendingInput {
		const task = this.mustCurrent();
		const id = crypto.randomBytes(12).toString("hex");
		const attachments = images.map((image, index) => {
			const extension = image.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
			const relative = `attachments/${id}-${index}.${extension}`;
			fs.mkdirSync(path.dirname(path.join(this.taskDir(task.id), relative)), { recursive: true });
			fs.writeFileSync(path.join(this.taskDir(task.id), relative), Buffer.from(image.data, "base64"));
			return { path: relative, mediaType: image.mimeType };
		});
		const input: PendingInput = { id, text, receivedAt: new Date().toISOString(), ...(attachments.length ? { attachments } : {}) };
		(task.pendingInputs ??= []).push(input);
		this.saveTask(task);
		return input;
	}

	/** Append canonical requirements and atomically acknowledge captured inputs. */
	addRequirements(texts: string[], inputIds: string[] = []): TaskRecord {
		const task = this.mustCurrent();
		const pending = task.pendingInputs ?? [];
		const requested = new Set(inputIds);
		if (requested.size !== inputIds.length) throw new Error("Pending input IDs must be unique.");
		const known = new Set(pending.map((input) => input.id));
		const unknown = inputIds.filter((id) => !known.has(id));
		if (unknown.length > 0) throw new Error(`Unknown pending input ID(s): ${unknown.join(", ")}.`);
		const now = new Date().toISOString();
		task.requirements.push(...texts.map((text) => ({ text, addedAt: now })));
		task.pendingInputs = pending.filter((input) => !requested.has(input.id));
		this.saveTask(task);
		return task;
	}

	mustCurrent(): TaskRecord {
		const task = this.current();
		if (!task) throw new Error("No active task. The user's first message sets the task via task_set.");
		if (task.status !== "active") throw new Error(`Task #${task.id} is ${task.status}; no active task.`);
		return task;
	}

	readDesign(): string | null {
		const task = this.latest();
		if (!task) return null;
		try {
			return fs.readFileSync(this.designPath(task.id), "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(`Cannot read council design at ${this.designPath(task.id)}: ${(error as Error).message}`);
		}
	}

	writeDesign(content: string): void {
		const task = this.mustCurrent();
		fs.writeFileSync(this.designPath(task.id), content.endsWith("\n") ? content : `${content}\n`);
	}

	appendVerdict(verdict: Verdict): void {
		const task = this.mustCurrent();
		fs.appendFileSync(path.join(this.taskDir(task.id), "verdicts.jsonl"), `${JSON.stringify(verdict)}\n`);
	}

	loadVerdicts(): Verdict[] {
		const task = this.latest();
		if (!task) return [];
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(this.taskDir(task.id), "verdicts.jsonl"), "utf-8");
		} catch {
			return [];
		}
		const verdicts: Verdict[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				verdicts.push(JSON.parse(line));
			} catch {
				// tolerate a torn write; the verdict is simply re-sourced
			}
		}
		return verdicts;
	}

	appendSpend(entry: SpendEntry): void {
		const task = this.latest();
		if (!task) throw new Error("No current or recently closed task for spend attribution.");
		this.validateSpendEntry(entry, "new spend entry");
		fs.appendFileSync(path.join(this.taskDir(task.id), "spend.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/** Read complete ledger records. Only an unterminated malformed final record is ignored. */
	loadSpend(): SpendEntry[] {
		const task = this.latest();
		if (!task) return [];
		const file = path.join(this.taskDir(task.id), "spend.jsonl");
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error(`Cannot read council spend ledger at ${file}: ${(error as Error).message}`);
		}
		const lines = raw.split("\n");
		const entries: SpendEntry[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as SpendEntry;
				this.validateSpendEntry(entry, `spend ledger line ${index + 1}`);
				entries.push(entry);
			} catch (error) {
				if (index === lines.length - 1 && !raw.endsWith("\n")) break;
				throw new Error(`Invalid council spend ledger at ${file}:${index + 1}: ${(error as Error).message}`);
			}
		}
		return entries;
	}

	spendTotals(): SpendTotals {
		return totalSpend(this.loadSpend());
	}

	writeActivity(snapshot: ActivitySnapshot): void {
		const task = this.mustCurrent();
		if (snapshot.taskId !== task.id || !Array.isArray(snapshot.children)) {
			throw new Error(`Invalid activity snapshot for task #${task.id}.`);
		}
		this.atomicWrite(path.join(this.taskDir(task.id), "activity.json"), `${JSON.stringify(snapshot, null, "\t")}\n`);
	}

	readActivity(): ActivitySnapshot | null {
		return this.readProjection<ActivitySnapshot>("activity.json");
	}

	/** Startup recovery uses an empty list rather than carrying stale running children forward. */
	clearActivity(): ActivitySnapshot {
		const task = this.mustCurrent();
		const snapshot: ActivitySnapshot = { taskId: task.id, updatedAt: new Date().toISOString(), children: [] };
		this.writeActivity(snapshot);
		return snapshot;
	}

	writeStatus(snapshot: StatusSnapshot): void {
		const task = this.mustCurrent();
		if (snapshot.taskId !== task.id || !snapshot.design || !snapshot.implementation) {
			throw new Error(`Invalid status snapshot for task #${task.id}.`);
		}
		this.atomicWrite(path.join(this.taskDir(task.id), "status.json"), `${JSON.stringify(snapshot, null, "\t")}\n`);
	}

	readStatus(): StatusSnapshot | null {
		return this.readProjection<StatusSnapshot>("status.json");
	}

	refreshStatusSpend(): void {
		const task = this.latest();
		const status = this.readStatus();
		if (!task || !status) return;
		const updated = { ...status, spend: this.spendTotals(), generatedAt: new Date().toISOString() };
		this.atomicWrite(path.join(this.taskDir(task.id), "status.json"), `${JSON.stringify(updated, null, "\t")}\n`);
	}

	private readProjection<T extends { taskId: string }>(name: string): T | null {
		const task = this.latest();
		if (!task) return null;
		const file = path.join(this.taskDir(task.id), name);
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf-8")) as T;
			if (!value || value.taskId !== task.id) throw new Error("task ID does not match current task");
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(`Cannot load council ${name} from ${file}: ${(error as Error).message}`);
		}
	}

	private validateSpendEntry(entry: SpendEntry, source: string): void {
		const tokenKeys: (keyof TokenUsage)[] = ["input", "output", "cacheRead", "cacheWrite"];
		if (
			!entry || !["owner", "worker", "verifier", "clerk"].includes(entry.kind) ||
			typeof entry.at !== "string" || typeof entry.name !== "string" || !entry.name.trim() ||
			typeof entry.model !== "string" || !entry.model.trim() ||
			!["ok", "failed", "aborted"].includes(entry.status) || !entry.tokens ||
			tokenKeys.some((key) => !Number.isFinite(entry.tokens[key]) || entry.tokens[key] < 0) ||
			!Number.isFinite(entry.costUsd) || entry.costUsd < 0
		) throw new Error(`Invalid ${source}.`);
	}

	close(status: "done" | "killed", summary?: string): TaskRecord {
		const task = this.mustCurrent();
		task.status = status;
		task.closedAt = new Date().toISOString();
		if (summary) task.summary = summary;
		this.saveTask(task);
		let existingStatus: StatusSnapshot | null = null;
		try { existingStatus = this.readStatus(); } catch { /* terminal state remains canonical even if a projection is corrupt */ }
		if (existingStatus) {
			const finalStatus = { ...existingStatus, phase: status === "done" ? "DONE" as const : "KILLED" as const, generatedAt: task.closedAt!, heartbeatAt: task.closedAt! };
			this.atomicWrite(path.join(this.taskDir(task.id), "status.json"), `${JSON.stringify(finalStatus, null, "\t")}\n`);
		}
		this.atomicWrite(this.lastFile, `${task.id}\n`);
		this.atomicWrite(this.currentFile, "\n");
		return task;
	}

	/** What design-gate verdicts are pinned to: statement + requirements + design doc. */
	async designHash(): Promise<string> {
		const task = this.mustCurrent();
		return sha256(task.statement, ...task.requirements.map((r) => r.text), this.readDesign() ?? "");
	}

	/** Implementation reviews are pinned only to committed base..HEAD content. */
	async implementationHash(): Promise<string> {
		const task = this.mustCurrent();
		const diff = await git(this.cwd, ["diff", "--binary", `${task.baseCommit}..HEAD`, "--", ".", ...RUNTIME_PATHSPECS]);
		return sha256(await this.designHash(), diff);
	}

	/** Uncommitted and untracked product/config changes must be resolved before review. */
	async worktreeChanges(): Promise<string[]> {
		const out = await git(this.cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", ...RUNTIME_PATHSPECS]);
		return out ? out.split("\n") : [];
	}

	async isWorktreeClean(): Promise<boolean> {
		return (await this.worktreeChanges()).length === 0;
	}

	async currentBranch(): Promise<string> {
		return git(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	}

	async gateHash(gate: Gate): Promise<string> {
		return gate === "design" ? this.designHash() : this.implementationHash();
	}

	/** Truthful per-verifier gate state, recomputed against current content. */
	readClerk(): ClerkState {
		const task = this.latest();
		if (!task) return emptyClerkState();
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(this.taskDir(task.id), "clerk.json"), "utf-8"));
			if (raw?.v !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.overrules)) return emptyClerkState();
			return raw as ClerkState;
		} catch {
			return emptyClerkState();
		}
	}

	writeClerk(state: ClerkState): void {
		const task = this.mustCurrent();
		fs.writeFileSync(path.join(this.taskDir(task.id), "clerk.json"), JSON.stringify(state, null, 1));
	}

	async gateReport(
		gate: Gate,
		applicableVerifiers: string[],
		expectedFingerprints?: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
	): Promise<GateReport> {
		const hash = await this.gateHash(gate);
		const clerk = this.readClerk();
		const latest = new Map<string, Verdict>();
		for (const v of this.loadVerdicts()) {
			if (v.gate === gate) latest.set(v.verifier, v);
		}
		const expectedFingerprint = (name: string): string | undefined =>
			expectedFingerprints instanceof Map ? expectedFingerprints.get(name) : expectedFingerprints?.[name];
		const verifiers = applicableVerifiers.map((name) => {
			const verdict = latest.get(name);
			const fingerprint = expectedFingerprint(name);
			let state: VerifierGateState;
			if (!verdict) state = "pending";
			else if (verdict.hash !== hash || (fingerprint !== undefined && verdict.fingerprint !== fingerprint)) state = "stale";
			else if (verdict.verdict === "no-go" && clerk.overrules.some((o) => o.gate === gate && o.verifier === name && o.hash === verdict.hash)) state = "overruled";
			else state = verdict.verdict;
			return { name, state, verdict };
		});
		const pendingInputIds = this.mustCurrent().pendingInputs?.map((input) => input.id) ?? [];
		return {
			gate,
			hash,
			verifiers,
			holds:
				pendingInputIds.length === 0 && verifiers.length > 0 && verifiers.every((verifier) => verifier.state === "go" || verifier.state === "overruled"),
			...(pendingInputIds.length ? { pendingInputIds } : {}),
		};
	}

	/** Repo status block included in every child's context. */
	async repoStatus(): Promise<string> {
		const task = this.mustCurrent();
		const branch = await git(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "?");
		const status = await git(this.cwd, ["status", "--short"]).catch(() => "");
		const log = await git(this.cwd, ["log", "--oneline", "-5"]).catch(() => "");
		const diffStat = await git(this.cwd, ["diff", "--stat", task.baseCommit]).catch(() => "");
		const github = await execFileP("gh", ["pr", "view", "--json", "url,state,statusCheckRollup,reviewDecision"], { cwd: this.cwd })
			.then(({ stdout }) => stdout.trim())
			.catch(() => "unavailable (no authenticated PR or gh installation)");
		return [
			`Branch: ${branch} (task base: ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)})`,
			status ? `\nWorking tree (git status --short):\n${status}` : "\nWorking tree: clean",
			diffStat ? `\nChanges since task base (git diff --stat):\n${diffStat}` : "",
			log ? `\nRecent commits:\n${log}` : "",
			`\nGitHub PR/check status: ${github}`,
		]
			.filter(Boolean)
			.join("\n");
	}

}

const stores = new Map<string, LaunchStore>();

export function storeFor(cwd: string): LaunchStore {
	let store = stores.get(cwd);
	if (!store) {
		store = new LaunchStore(cwd);
		stores.set(cwd, store);
	}
	return store;
}
