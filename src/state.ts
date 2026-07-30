/**
 * Task state: persistence under .pi/launch/, content hashing, and gate logic.
 *
 * Everything is plain files so the user can inspect task state without the TUI
 * and so state survives session restarts.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Gate = "design" | "implementation";
export const GATES: Gate[] = ["design", "implementation"];

/** Path prefix (relative, POSIX) excluded from implementation-gate hashing so that
 * recording verdicts and task state never stales the gate it just sourced. */
const LAUNCH_DIR_PREFIX = ".pi/launch";

export interface Requirement {
	text: string;
	addedAt: string;
}

export interface TaskRecord {
	id: string;
	statement: string;
	requirements: Requirement[];
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
}

export type VerifierGateState = "go" | "no-go" | "stale" | "pending";

export interface GateReport {
	gate: Gate;
	hash: string;
	verifiers: { name: string; state: VerifierGateState; verdict?: Verdict }[];
	holds: boolean;
}

export interface LaunchConfig {
	/** "provider/model" used for all spawned children unless overridden below. */
	model?: string;
	verifierModel?: string;
	workerModel?: string;
	/** Max children running at once. */
	concurrency?: number;
	/** Per-child wall-clock timeout. */
	timeoutMinutes?: number;
}

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
		this.cwd = cwd;
	}

	get rootDir(): string {
		return path.join(this.cwd, ".pi", "launch");
	}

	private get currentFile(): string {
		return path.join(this.rootDir, "current");
	}

	taskDir(id: string): string {
		return path.join(this.rootDir, "tasks", id);
	}

	designPath(id: string): string {
		return path.join(this.taskDir(id), "design.md");
	}

	loadConfig(): LaunchConfig {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.rootDir, "config.json"), "utf-8"));
		} catch {
			return {};
		}
	}

	current(): TaskRecord | null {
		let id: string;
		try {
			id = fs.readFileSync(this.currentFile, "utf-8").trim();
		} catch {
			return null;
		}
		if (!id) return null;
		try {
			return JSON.parse(fs.readFileSync(path.join(this.taskDir(id), "task.json"), "utf-8"));
		} catch {
			return null;
		}
	}

	private saveTask(task: TaskRecord): void {
		fs.mkdirSync(this.taskDir(task.id), { recursive: true });
		fs.writeFileSync(path.join(this.taskDir(task.id), "task.json"), `${JSON.stringify(task, null, "\t")}\n`);
		const rendered = task.requirements.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
		fs.writeFileSync(
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
				`launch-review requires a git repository with at least one commit (${err instanceof Error ? err.message.split("\n")[0] : err}).`,
			);
		}
		const now = new Date().toISOString();
		const task: TaskRecord = {
			id: crypto.randomBytes(2).toString("hex"),
			statement,
			requirements: requirements.map((text) => ({ text, addedAt: now })),
			baseCommit,
			baseBranch,
			createdAt: now,
			status: "active",
		};
		this.saveTask(task);
		fs.writeFileSync(this.currentFile, `${task.id}\n`);
		return task;
	}

	addRequirements(texts: string[]): TaskRecord {
		const task = this.mustCurrent();
		const now = new Date().toISOString();
		task.requirements.push(...texts.map((text) => ({ text, addedAt: now })));
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
		const task = this.current();
		if (!task) return null;
		try {
			return fs.readFileSync(this.designPath(task.id), "utf-8");
		} catch {
			return null;
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
		const task = this.current();
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

	close(status: "done" | "killed", summary?: string): TaskRecord {
		const task = this.mustCurrent();
		task.status = status;
		task.closedAt = new Date().toISOString();
		if (summary) task.summary = summary;
		this.saveTask(task);
		fs.writeFileSync(this.currentFile, "\n");
		return task;
	}

	/** What design-gate verdicts are pinned to: statement + requirements + design doc. */
	async designHash(): Promise<string> {
		const task = this.mustCurrent();
		return sha256(task.statement, ...task.requirements.map((r) => r.text), this.readDesign() ?? "");
	}

	/** What implementation-gate verdicts are pinned to: the design hash + every change
	 * to the working tree since the task's base commit (tracked and untracked),
	 * excluding launch-review's own state directory. */
	async implementationHash(): Promise<string> {
		const task = this.mustCurrent();
		const diff = await git(this.cwd, ["diff", task.baseCommit, "--", ".", `:(exclude)${LAUNCH_DIR_PREFIX}`]);
		const untracked = await this.untrackedFiles();
		const untrackedHashes = untracked.map((file) => {
			try {
				return `${file}:${crypto.createHash("sha256").update(fs.readFileSync(path.join(this.cwd, file))).digest("hex")}`;
			} catch {
				return `${file}:unreadable`;
			}
		});
		return sha256(await this.designHash(), diff, ...untrackedHashes);
	}

	private async untrackedFiles(): Promise<string[]> {
		const out = await git(this.cwd, ["ls-files", "--others", "--exclude-standard"]);
		return out
			.split("\n")
			.filter((f) => f && !f.startsWith(`${LAUNCH_DIR_PREFIX}/`))
			.sort();
	}

	async gateHash(gate: Gate): Promise<string> {
		return gate === "design" ? this.designHash() : this.implementationHash();
	}

	/** Truthful per-verifier gate state, recomputed against current content. */
	async gateReport(gate: Gate, applicableVerifiers: string[]): Promise<GateReport> {
		const hash = await this.gateHash(gate);
		const latest = new Map<string, Verdict>();
		for (const v of this.loadVerdicts()) {
			if (v.gate === gate) latest.set(v.verifier, v);
		}
		const verifiers = applicableVerifiers.map((name) => {
			const verdict = latest.get(name);
			let state: VerifierGateState;
			if (!verdict) state = "pending";
			else if (verdict.hash !== hash) state = "stale";
			else state = verdict.verdict;
			return { name, state, verdict };
		});
		return { gate, hash, verifiers, holds: verifiers.length > 0 && verifiers.every((v) => v.state === "go") };
	}

	/** Repo status block included in every child's context. */
	async repoStatus(): Promise<string> {
		const task = this.mustCurrent();
		const branch = await git(this.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "?");
		const status = await git(this.cwd, ["status", "--short"]).catch(() => "");
		const log = await git(this.cwd, ["log", "--oneline", "-5"]).catch(() => "");
		const diffStat = await git(this.cwd, ["diff", "--stat", task.baseCommit]).catch(() => "");
		return [
			`Branch: ${branch} (task base: ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)})`,
			status ? `\nWorking tree (git status --short):\n${status}` : "\nWorking tree: clean",
			diffStat ? `\nChanges since task base (git diff --stat):\n${diffStat}` : "",
			log ? `\nRecent commits:\n${log}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	/** Full diff since base for implementation-gate review (caller caps size). */
	async implementationDiff(): Promise<string> {
		const task = this.mustCurrent();
		const diff = await git(this.cwd, ["diff", task.baseCommit, "--", ".", `:(exclude)${LAUNCH_DIR_PREFIX}`]);
		const untracked = await this.untrackedFiles();
		return untracked.length ? `${diff}\n\nUntracked files (also part of the change):\n${untracked.join("\n")}` : diff;
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
