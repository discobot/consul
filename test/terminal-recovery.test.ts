import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LaunchStore } from "../src/state.ts";

test("terminal close cannot be stranded by a corrupt status projection", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-terminal-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "file"), "x");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });
	const store = new LaunchStore(dir);
	const task = await store.createTask("task", ["requirement"]);
	fs.writeFileSync(path.join(store.taskDir(task.id), "status.json"), "broken");
	store.close("killed");
	assert.equal(store.current(), null);
	assert.equal(store.latest()?.status, "killed");
	const next = await store.createTask("next", ["requirement"]);
	assert.notEqual(next.id, task.id);
});
