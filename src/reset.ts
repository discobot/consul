/**
 * Programmatic task reset: wipe the council process state, reseed the same task, carry
 * the previous design forward verbatim, and run the judges' pass headlessly — so a fresh
 * Owner wakes into a sourced gate and a Clerk ledger instead of an empty room.
 * The operator command for "start over, judges first".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { applyClerkRound, buildClerkPrompt, CLERK_PROMPT, formatItemsForOwner, parseClerkOutput } from "./clerk.ts";
import { runChild, runPool } from "./spawn.ts";
import { emptyClerkState, LaunchStore, type Verdict } from "./state.ts";
import { buildVerifierPrompt, discoverVerifiers, parseVerdict, verifiersForGate } from "./verifiers.ts";

export interface ResetOptions {
	/** Run the headless judges pass after reseeding (needs models + pi). Default true. */
	judges?: boolean;
	log?: (line: string) => void;
}

export interface ResetResult {
	previousTaskId: string;
	taskId: string;
	requirements: number;
	designCarried: boolean;
	verdicts: { verifier: string; verdict: string }[];
	openItems: number;
}

/** Wipe process state, reseed the same statement/requirements, carry the design. */
export async function resetTask(cwd: string, options: ResetOptions = {}): Promise<ResetResult> {
	const log = options.log ?? (() => {});
	const before = new LaunchStore(cwd);
	const task = before.latest();
	if (!task) throw new Error("No task to reset — nothing under .pi/council/tasks.");
	const statement = task.statement;
	const requirements = task.requirements.map((r) => r.text);
	const design = before.readDesign();

	const councilDir = path.join(before.cwd, ".pi", "council");
	for (const entry of ["tasks", "current", "last", "intake.json", "owner-sessions", "board.lock"]) {
		fs.rmSync(path.join(councilDir, entry), { recursive: true, force: true });
	}
	log(`wiped process state (previous task ${task.id})`);

	const store = new LaunchStore(cwd);
	const fresh = await store.createTask(statement, requirements);
	log(`reseeded task ${fresh.id} with ${requirements.length} requirements`);
	if (design) {
		store.writeDesign(design);
		log(`carried previous design verbatim (${design.length} chars)`);
	}

	const result: ResetResult = { previousTaskId: task.id, taskId: fresh.id, requirements: requirements.length, designCarried: Boolean(design), verdicts: [], openItems: 0 };
	if (design && (options.judges ?? true)) {
		const summary = await judgesPass(store, log);
		result.verdicts = summary.verdicts;
		result.openItems = summary.openItems;
	}
	return result;
}

/** Source the design gate headlessly: full panel, then the Clerk. No Owner involved. */
async function judgesPass(store: LaunchStore, log: (line: string) => void): Promise<{ verdicts: { verifier: string; verdict: string }[]; openItems: number }> {
	const cwd = store.cwd;
	const task = store.mustCurrent();
	const config = store.loadConfig();
	const verifierModel = (name: string, override?: string) => override ?? config.verifierModels?.[name] ?? config.verifierModel ?? config.model ?? missingModel("verifierModel");
	const clerkModel = config.clerkModel ?? config.model ?? missingModel("clerkModel");
	const timeoutMs = (config.timeoutMinutes ?? 20) * 60_000;
	const inactivityMs = (config.inactivityMinutes ?? 10) * 60_000;
	const panel = verifiersForGate(discoverVerifiers(cwd), "design");

	log(`judges pass: ${panel.map((v) => v.name).join(", ")}`);
	const verdicts = await runPool(panel, config.concurrency ?? 9, async (def) => {
		const prompt = await buildVerifierPrompt(store, task, "design", def.name, def.fingerprint, def.browser);
		const run = await runChild(
			{ kind: "verifier", name: def.name, systemPrompt: def.systemPrompt, prompt, tools: def.tools, model: verifierModel(def.name, def.model), cwd, timeoutMs, inactivityMs },
			undefined,
			(p) => log(`  ${def.name}: ${p.lastActivity} (turn ${p.turns + 1})`),
		);
		store.appendSpend({ at: new Date().toISOString(), kind: "verifier", name: def.name, model: verifierModel(def.name, def.model), tokens: run.tokens, costUsd: run.costUsd, status: run.ok ? "ok" : "failed" });
		const parsed = run.ok ? parseVerdict(run.output) : { verdict: "no-go" as const, comments: [`Verifier run failed: ${run.errorMessage ?? "unknown"}`], parseError: true };
		const verdict: Verdict = { gate: "design", verifier: def.name, fingerprint: def.fingerprint, verdict: parsed.verdict, comments: parsed.comments, hash: await store.gateHash("design"), at: new Date().toISOString(), ...(parsed.parseError ? { parseError: true } : {}) };
		store.appendVerdict(verdict);
		log(`  ${def.name} → ${parsed.verdict.toUpperCase()}`);
		return verdict;
	});

	log("clerk: arbitrating the opening round");
	const { buildTaskContext } = await import("./verifiers.ts");
	const clerkRun = await runChild(
		{ kind: "clerk", name: "clerk", systemPrompt: CLERK_PROMPT, prompt: buildClerkPrompt(await buildTaskContext(store, task), emptyClerkState(), "design", verdicts), tools: ["read", "grep", "find", "ls"], model: clerkModel, cwd, timeoutMs, inactivityMs },
		undefined,
		(p) => log(`  clerk: ${p.lastActivity} (turn ${p.turns + 1})`),
	);
	store.appendSpend({ at: new Date().toISOString(), kind: "clerk", name: "clerk", model: clerkModel, tokens: clerkRun.tokens, costUsd: clerkRun.costUsd, status: clerkRun.ok ? "ok" : "failed" });
	let openItems = 0;
	const parsed = clerkRun.ok ? parseClerkOutput(clerkRun.output) : null;
	if (parsed) {
		const state = applyClerkRound(emptyClerkState(), parsed, verdicts, new Date().toISOString());
		store.writeClerk(state);
		openItems = state.items.filter((item) => item.status === "open").length;
		log(formatItemsForOwner(state, "design"));
	} else {
		log("clerk output unparseable — raw verdicts stand");
	}
	return { verdicts: verdicts.map((v) => ({ verifier: v.verifier, verdict: v.verdict })), openItems };
}

function missingModel(key: string): never {
	throw new Error(`No model for spawned agents: set ${key} (or model) in .pi/council/config.json.`);
}
