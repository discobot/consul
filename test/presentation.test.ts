import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const launcher = path.resolve("bin/council");

function fakePi(dir: string, body: string): string {
	const file = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(file, body);
	return file;
}

test("launcher passes arguments and preserves normal exit status", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-launcher-"));
	const output = path.join(dir, "args.json");
	const fake = fakePi(dir, `import fs from "node:fs"; fs.writeFileSync(process.env.ARGS_OUT, JSON.stringify(process.argv.slice(2))); process.exit(7);`);
	const result = spawnSync(process.execPath, [launcher, "--model", "provider/model", "with space"], {
		env: { ...process.env, COUNCIL_PI: fake, ARGS_OUT: output },
	});
	assert.equal(result.status, 7);
	const args: string[] = JSON.parse(fs.readFileSync(output, "utf8"));
	assert.deepEqual(args.slice(-3), ["--model", "provider/model", "with space"]);
	assert.equal(args.filter((arg) => arg === "-e").length, 2);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("launcher reports a missing target with recovery and nonzero status", () => {
	const target = path.join(os.tmpdir(), `missing-council-pi-${process.pid}`);
	const result = spawnSync(process.execPath, [launcher], { env: { ...process.env, COUNCIL_PI: target }, encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(result.stderr, /Check that COUNCIL_PI/);
});

test("launcher board mode loads only the cockpit extension", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-board-"));
	const output = path.join(dir, "args.json");
	const fake = fakePi(dir, `import fs from "node:fs"; fs.writeFileSync(process.env.ARGS_OUT, JSON.stringify(process.argv.slice(2)));`);
	const result = spawnSync(process.execPath, [launcher, "board", "--model", "provider/model"], { env: { ...process.env, COUNCIL_PI: fake, ARGS_OUT: output } });
	assert.equal(result.status, 0);
	const args: string[] = JSON.parse(fs.readFileSync(output, "utf8"));
	assert.equal(args.filter((arg) => arg === "-e").length, 1);
	assert.match(args[args.indexOf("-e") + 1], /src\/cockpit\.ts$/);
	assert.ok(!args.includes("board"));
	fs.rmSync(dir, { recursive: true, force: true });
});

test("launcher maps child signals to a nonzero status", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-launcher-signal-"));
	const fake = fakePi(dir, `process.kill(process.pid, "SIGTERM");`);
	const result = spawnSync(process.execPath, [launcher], { env: { ...process.env, COUNCIL_PI: fake } });
	assert.equal(result.status, 143);
	fs.rmSync(dir, { recursive: true, force: true });
});
