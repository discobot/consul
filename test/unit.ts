/**
 * Logic tests for council that need no LLM: task store, hash pinning,
 * staleness cascade, gate enforcement, verdict parsing, verifier discovery.
 *
 * Run: node --test test/unit.ts  (from the council directory, node >= 22.19)
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LaunchStore, type Verdict } from "../src/state.ts";
import { discoverVerifiers, parseFrontmatter, parseVerdict, verifiersForGate } from "../src/verifiers.ts";
import "./children.test.ts";
import "./cockpit.test.ts";
import "./presentation.test.ts";
import "./state.test.ts";
import "./terminal-recovery.test.ts";

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-test-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-q");
	git("config", "user.email", "test@test");
	git("config", "user.name", "test");
	fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
	git("add", ".");
	git("commit", "-qm", "initial");
	return dir;
}

function goVerdict(store: LaunchStore, gate: "design" | "implementation", verifier: string, hash: string): Verdict {
	const v: Verdict = { gate, verifier, verdict: "go", comments: [], hash, at: new Date().toISOString() };
	store.appendVerdict(v);
	return v;
}

test("task lifecycle: create, single-active, append-only requirements", async () => {
	const store = new LaunchStore(makeRepo());
	assert.equal(store.current(), null);
	const task = await store.createTask("build a widget", ["it renders", "it is fast"]);
	assert.equal(task.status, "active");
	assert.equal(task.requirements.length, 2);
	await assert.rejects(() => store.createTask("another", ["x"]), /already active/);
	store.addRequirements(["it is accessible"]);
	assert.equal(store.current()!.requirements.length, 3);
	assert.equal(store.current()!.statement, "build a widget");
	store.close("killed");
	assert.equal(store.current(), null);
	const again = await store.createTask("second task", ["y"]);
	assert.notEqual(again.id, task.id);
});

test("gates: pending -> go -> holds; edits and appended requirements stale approvals", async () => {
	const store = new LaunchStore(makeRepo());
	await store.createTask("task", ["req one"]);
	store.writeDesign("# Design v1");
	const panel = ["a", "b"];

	let report = await store.gateReport("design", panel);
	assert.equal(report.holds, false);
	assert.deepEqual(report.verifiers.map((v) => v.state), ["pending", "pending"]);

	const hash1 = await store.designHash();
	goVerdict(store, "design", "a", hash1);
	goVerdict(store, "design", "b", hash1);
	report = await store.gateReport("design", panel);
	assert.equal(report.holds, true);

	// design edit stales the design gate
	store.writeDesign("# Design v2");
	report = await store.gateReport("design", panel);
	assert.equal(report.holds, false);
	assert.deepEqual(report.verifiers.map((v) => v.state), ["stale", "stale"]);

	// re-source against the new hash
	const hash2 = await store.designHash();
	assert.notEqual(hash1, hash2);
	goVerdict(store, "design", "a", hash2);
	goVerdict(store, "design", "b", hash2);
	assert.equal((await store.gateReport("design", panel)).holds, true);

	// an appended requirement stales it again — the propagation cascade
	store.addRequirements(["req two"]);
	report = await store.gateReport("design", panel);
	assert.equal(report.holds, false);
	assert.deepEqual(report.verifiers.map((v) => v.state), ["stale", "stale"]);
});

test("implementation hash tracks committed changes and runtime state stays neutral", async () => {
	const dir = makeRepo();
	const store = new LaunchStore(dir);
	await store.createTask("task", ["r"]);
	store.writeDesign("# D");
	const h1 = await store.implementationHash();

	// council's own bookkeeping must not stale the gate it just sourced
	goVerdict(store, "implementation", "a", h1);
	assert.equal(await store.implementationHash(), h1);

	// uncommitted edits do not change the committed artifact, but block cleanliness
	fs.appendFileSync(path.join(dir, "hello.txt"), "more\n");
	assert.equal(await store.implementationHash(), h1);
	assert.equal(await store.isWorktreeClean(), false);
	execFileSync("git", ["add", "hello.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "change"], { cwd: dir });
	const h2 = await store.implementationHash();
	assert.notEqual(h1, h2);

	// a no-go verdict never lets the gate hold
	const bad: Verdict = { gate: "implementation", verifier: "a", verdict: "no-go", comments: ["x"], hash: h2, at: "now" };
	store.appendVerdict(bad);
	const report = await store.gateReport("implementation", ["a"]);
	assert.equal(report.holds, false);
	assert.equal(report.verifiers[0].state, "no-go");
});

test("latest verdict per (gate, verifier) wins", async () => {
	const store = new LaunchStore(makeRepo());
	await store.createTask("task", ["r"]);
	store.writeDesign("# D");
	const hash = await store.designHash();
	store.appendVerdict({ gate: "design", verifier: "a", verdict: "no-go", comments: ["bad"], hash, at: "t1" });
	goVerdict(store, "design", "a", hash);
	const report = await store.gateReport("design", ["a"]);
	assert.equal(report.verifiers[0].state, "go");
	assert.equal(report.holds, true);
});

test("parseVerdict: fenced, bare, and garbage", () => {
	assert.deepEqual(parseVerdict('text\n```json\n{"verdict": "go", "comments": ["nice"]}\n```'), {
		verdict: "go",
		comments: ["nice"],
		parseError: false,
	});
	assert.equal(parseVerdict('first\n```json\n{"verdict":"go"}\n```\nthen\n```json\n{"verdict":"no-go","comments":["x"]}\n```').verdict, "no-go");
	assert.equal(parseVerdict('conclusion: {"verdict": "go", "comments": []}').verdict, "go");
	const garbage = parseVerdict("I approve of this change wholeheartedly!");
	assert.equal(garbage.verdict, "no-go");
	assert.equal(garbage.parseError, true);
	const nogoNoComments = parseVerdict('```json\n{"verdict": "no-go"}\n```');
	assert.equal(nogoNoComments.comments.length, 1);
});

test("verifier discovery: nine built-ins, project overrides win, gates respected", () => {
	const dir = makeRepo();
	const builtins = discoverVerifiers(dir);
	const names = builtins.map((v) => v.name).sort();
	assert.deepEqual(names, [
		"clean-code",
		"design",
		"github-clarity",
		"interfaces",
		"task-completeness",
		"user-global-pov",
		"user-local-pov",
		"ux-bugs",
		"visual-design",
	]);
	assert.equal(verifiersForGate(builtins, "design").length, 6); // three verifiers are implementation-only
	assert.equal(verifiersForGate(builtins, "implementation").length, 9);
	for (const v of builtins) assert.ok(v.systemPrompt.length > 100, `${v.name} has a real system prompt`);

	const visual = builtins.find((v) => v.name === "visual-design")!;
	assert.deepEqual(visual.gates, ["implementation"]);
	assert.equal(visual.browser, true);
	assert.ok(visual.tools.includes("bash"));
	const prompt = visual.systemPrompt.toLowerCase();
	assert.match(prompt, /render/);
	assert.match(prompt, /code alone|code-only/);
	assert.match(prompt, /pty|pseudo-terminal/);
	assert.match(prompt, /several[^.\n]*width|narrow[^.\n]*typical[^.\n]*wide/);
	assert.match(prompt, /browser/);
	assert.match(prompt, /unavailable/);
	assert.match(prompt, /blocking/);
	assert.match(prompt, /visual hierarchy/);
	assert.match(prompt, /spacing/);
	assert.match(prompt, /alignment/);
	assert.match(prompt, /rhythm/);
	assert.match(prompt, /color/);
	assert.match(prompt, /contrast/);
	assert.match(prompt, /typograph/);
	assert.match(prompt, /cross-surface|between surfaces|across surfaces/);
	assert.match(prompt, /design[^.\n]*(intended design|information design)|intended design[^.\n]*design verifier/);

	const design = builtins.find((v) => v.name === "design")!;
	assert.deepEqual(design.gates, ["design", "implementation"]);
	assert.match(design.systemPrompt.toLowerCase(), /intended\s+design/);
	assert.match(design.systemPrompt.toLowerCase(), /information design/);
	assert.match(design.systemPrompt.toLowerCase(), /visual-design/);

	const canonical = fs.readFileSync(path.resolve("prompts/agents/verifiers/visual-design.md"), "utf8");
	const compatibility = fs.readFileSync(path.resolve("verifiers/visual-design.md"), "utf8");
	assert.equal(compatibility, canonical);

	const overrideDir = path.join(dir, ".pi", "council", "verifiers");
	fs.mkdirSync(overrideDir, { recursive: true });
	fs.writeFileSync(
		path.join(overrideDir, "clean-code.md"),
		"---\nname: clean-code\ndescription: custom\ngates: design\n---\nCustom prompt body.",
	);
	fs.writeFileSync(
		path.join(overrideDir, "visual-design.md"),
		"---\nname: visual-design\ndescription: custom visual review\ngates: implementation\nbrowser: true\n---\nRender and review the surface.",
	);
	const merged = discoverVerifiers(dir);
	const custom = merged.find((v) => v.name === "clean-code")!;
	assert.equal(custom.source, "project");
	assert.deepEqual(custom.gates, ["design"]);
	const customVisual = merged.find((v) => v.name === "visual-design")!;
	assert.equal(customVisual.source, "project");
	assert.equal(customVisual.browser, true);
	assert.ok(customVisual.tools.includes("bash"));
	assert.deepEqual(customVisual.gates, ["implementation"]);
	assert.equal(merged.length, 9);
});

test("visual-design uses the compact vd label and the panel-sized concurrency default", () => {
	const toolsSource = fs.readFileSync(path.resolve("src/tools.ts"), "utf8");
	const uiSource = fs.readFileSync(path.resolve("src/ui.ts"), "utf8");
	assert.match(toolsSource, /const DEFAULT_CONCURRENCY = 9;/);
	assert.match(uiSource, /"visual-design": "vd"/);
});

test("parseFrontmatter handles fences and no-frontmatter", () => {
	const parsed = parseFrontmatter("---\nname: x\ndesc: a: b\n---\nbody");
	assert.equal(parsed.frontmatter.name, "x");
	assert.equal(parsed.frontmatter.desc, "a: b");
	assert.equal(parsed.body, "body");
	assert.deepEqual(parseFrontmatter("plain").frontmatter, {});
});
