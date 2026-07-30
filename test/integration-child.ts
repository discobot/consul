/**
 * Integration: spawn one real verifier child against a scratch task and parse its
 * verdict. Requires pi auth. Run from the launch-review dir:
 *   node test/integration-child.ts <provider/model>
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChild } from "../src/spawn.ts";
import { LaunchStore } from "../src/state.ts";
import { buildVerifierPrompt, discoverVerifiers, parseVerdict } from "../src/verifiers.ts";

const model = process.argv[2];
if (!model) throw new Error("usage: node test/integration-child.ts <provider/model>");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-review-int-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
git("init", "-q");
git("config", "user.email", "t@t");
git("config", "user.name", "t");
fs.writeFileSync(path.join(dir, "greet.py"), 'def greet(name):\n    return "Hello, " + name + "!"\n');
git("add", ".");
git("commit", "-qm", "initial");

const store = new LaunchStore(dir);
const task = await store.createTask("Add a farewell(name) function to greet.py mirroring greet()", [
	"greet.py gains a farewell(name) function returning 'Goodbye, <name>!'",
]);
store.writeDesign(
	"# Design\n\nAdd `farewell(name)` to greet.py, one line, mirroring `greet` exactly: `return \"Goodbye, \" + name + \"!\"`. No other changes.",
);

const verifier = discoverVerifiers(dir).find((v) => v.name === "task-completeness");
if (!verifier) throw new Error("task-completeness verifier not found");
const prompt = await buildVerifierPrompt(store, task, "design");

console.log(`spawning ${verifier.name} (${model}) in ${dir} ...`);
const started = Date.now();
const result = await runChild(
	{
		name: verifier.name,
		systemPrompt: verifier.systemPrompt,
		prompt,
		tools: verifier.tools,
		model,
		cwd: dir,
		timeoutMs: 10 * 60 * 1000,
	},
	undefined,
	(p) => console.log(`  [progress] turn ${p.turns + 1}: ${p.lastActivity}`),
);

console.log(`\nchild finished in ${Math.round((Date.now() - started) / 1000)}s: ok=${result.ok} turns=${result.turns} exit=${result.exitCode} stop=${result.stopReason ?? "-"} err=${result.errorMessage ?? "-"}`);
console.log(`--- output (last 800 chars) ---\n${result.output.slice(-800)}\n---`);

const verdict = parseVerdict(result.output);
console.log(`parsed verdict: ${verdict.verdict} (parseError=${verdict.parseError})`);
for (const c of verdict.comments) console.log(`  - ${c}`);
if (!result.ok || verdict.parseError) {
	process.exitCode = 1;
	console.error("INTEGRATION FAILED");
} else {
	console.log("INTEGRATION OK");
}
fs.rmSync(dir, { recursive: true, force: true });
