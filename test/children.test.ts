import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runChild, watchdogFailure } from "../src/spawn.ts";
import {
	buildVerifierPrompt,
	discoverVerifiers,
	parseVerdict,
	verifierFingerprint,
} from "../src/verifiers.ts";

function fakePi(dir: string): string {
	const script = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		script,
		`import fs from "node:fs";
fs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:"message_update",message:{role:"assistant",content:[{type:"text",text:"checking the repository"}]}}));
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop",usage:{cost:{total:0.01}}}}));
`,
	);
	return script;
}

test("verifier children replace the prompt and disable ambient resources", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-child-"));
	const argvOut = path.join(dir, "argv.json");
	const oldPi = process.env.COUNCIL_PI;
	const oldOut = process.env.ARGV_OUT;
	process.env.COUNCIL_PI = fakePi(dir);
	process.env.ARGV_OUT = argvOut;
	try {
		const progress: string[] = [];
		const result = await runChild(
			{
				kind: "verifier",
				name: "review",
				systemPrompt: "replacement",
				prompt: "inspect",
				tools: ["read", "grep"],
				model: "test/model",
				cwd: dir,
				timeoutMs: 10_000,
			},
			undefined,
			(update) => progress.push(update.lastActivity),
		);
		assert.equal(result.ok, true);
		assert.equal(result.output, "done");
		const argv: string[] = JSON.parse(fs.readFileSync(argvOut, "utf-8"));
		for (const flag of [
			"--mode",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--system-prompt",
		]) {
			assert.ok(argv.includes(flag), `missing ${flag}`);
		}
		assert.equal(argv[argv.indexOf("--system-prompt") + 1], "replacement");
		assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "", "ambient append prompt is explicitly suppressed");
		assert.ok(progress.some((value) => value.startsWith("responding: checking")));
	} finally {
		if (oldPi === undefined) delete process.env.COUNCIL_PI;
		else process.env.COUNCIL_PI = oldPi;
		if (oldOut === undefined) delete process.env.ARGV_OUT;
		else process.env.ARGV_OUT = oldOut;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("workers keep append prompt, JSON print, and no-session behavior", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-worker-"));
	const argvOut = path.join(dir, "argv.json");
	const oldPi = process.env.COUNCIL_PI;
	const oldOut = process.env.ARGV_OUT;
	process.env.COUNCIL_PI = fakePi(dir);
	process.env.ARGV_OUT = argvOut;
	try {
		await runChild(
			{
				kind: "worker",
				name: "worker",
				systemPrompt: "owner context",
				prompt: "work",
				tools: ["read", "edit"],
				model: "test/model",
				cwd: dir,
				timeoutMs: 10_000,
			},
			undefined,
		);
		const argv: string[] = JSON.parse(fs.readFileSync(argvOut, "utf-8"));
		assert.deepEqual(argv.slice(0, 5), ["--mode", "json", "-p", "--no-session", "--no-extensions"]);
		assert.ok(argv.includes("--append-system-prompt"));
		assert.ok(!argv.includes("--system-prompt"));
	} finally {
		if (oldPi === undefined) delete process.env.COUNCIL_PI;
		else process.env.COUNCIL_PI = oldPi;
		if (oldOut === undefined) delete process.env.ARGV_OUT;
		else process.env.ARGV_OUT = oldOut;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("verifier definitions are read-only, validated, and fingerprinted", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-def-"));
	const verifierDir = path.join(dir, ".pi", "council", "verifiers");
	fs.mkdirSync(verifierDir, { recursive: true });
	fs.writeFileSync(
		path.join(verifierDir, "unsafe.md"),
		"---\nname: unsafe\ndescription: bad\ntools: read,bash\n---\nReview it.",
	);
	assert.throws(() => discoverVerifiers(dir), /non-empty subset/);
	fs.rmSync(path.join(dir, ".pi"), { recursive: true, force: true });
	const defs = discoverVerifiers(dir);
	assert.ok(defs.filter((def) => !def.browser).every((def) => def.tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool))));
	for (const name of ["design", "ux-bugs", "user-local-pov", "user-global-pov", "visual-design"]) {
		const def = defs.find((item) => item.name === name)!;
		assert.equal(def.browser, true);
		assert.ok(def.tools.includes("bash"));
	}
	assert.ok(defs.every((def) => def.fingerprint === verifierFingerprint(def) && /^[a-f0-9]{64}$/.test(def.fingerprint)));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("verifier history is bounded to the same verifier and definition", async () => {
	const verdict = (verifier: string, fingerprint: string, at: string) => ({
		gate: "design" as const,
		verifier,
		fingerprint,
		verdict: "go" as const,
		comments: [at],
		hash: at,
		at,
	});
	const store = {
		readDesign: () => "# Design",
		repoStatus: async () => "clean",
		loadVerdicts: () => [
			verdict("mine", "current", "old"),
			verdict("other", "current", "other"),
			verdict("mine", "current", "newer"),
			verdict("mine", "legacy", "legacy"),
			verdict("mine", "current", "newest"),
		],
	};
	const task = {
		id: "abcd",
		statement: "task",
		requirements: [],
		baseCommit: "00000000",
		baseBranch: "main",
		createdAt: "now",
		status: "active" as const,
	};
	const prompt = await buildVerifierPrompt(store as never, task, "design", "mine", "current", true);
	assert.ok(!prompt.includes("old @ hash old"));
	assert.ok(!prompt.includes("other @ hash other"));
	assert.ok(!prompt.includes("newer @ hash newer"), "history is bounded");
	assert.ok(prompt.includes("legacy @ hash legacy"), "definition changes stale approval but retain review history");
	assert.ok(prompt.includes("newest @ hash newest"));
	assert.ok(prompt.includes("Playwright/Chromium"));
	assert.ok(prompt.includes("degrade gracefully"));
});

test("watchdog detects inactivity and sleep-sized clock jumps", async () => {
	assert.equal(watchdogFailure(10_000, 0, 9_000, 5_000, 1_000), "inactivity watchdog expired");
	assert.equal(watchdogFailure(50_000, 49_500, 1_000, 5_000, 1_000), "system sleep/wake detected");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-inactive-"));
	const script = path.join(dir, "idle.mjs");
	fs.writeFileSync(script, "setInterval(() => {}, 1000)");
	const oldPi = process.env.COUNCIL_PI;
	process.env.COUNCIL_PI = script;
	try {
		const result = await runChild({ kind: "worker", name: "idle", systemPrompt: "x", prompt: "x", tools: ["read"], model: "test/model", cwd: dir, timeoutMs: 10_000, inactivityMs: 100 }, undefined);
		assert.equal(result.ok, false);
		assert.equal(result.errorMessage, "inactivity watchdog expired");
	} finally {
		if (oldPi === undefined) delete process.env.COUNCIL_PI; else process.env.COUNCIL_PI = oldPi;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("verdict comments have a strict string-array shape", () => {
	assert.equal(parseVerdict('{"verdict":"go","comments":["ok"]}').parseError, false);
	assert.equal(parseVerdict('{"verdict":"go","comments":"ok"}').parseError, true);
	assert.equal(parseVerdict('{"verdict":"go","comments":[1]}').parseError, true);
	assert.equal(parseVerdict('{"verdict":"no-go","comments":[]}').parseError, true);
});
