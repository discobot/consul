import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	derivePhase,
	LaunchStore,
	totalSpend,
	type ActivitySnapshot,
	type GateReport,
	type SpendEntry,
	type StatusSnapshot,
	type Verdict,
} from "../src/state.ts";

function makeRepo(): { dir: string; git: (...args: string[]) => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-state-"));
	const git = (...args: string[]) => void execFileSync("git", args, { cwd: dir });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "tracked.txt"), "initial\n");
	git("add", ".");
	git("commit", "-qm", "initial");
	return { dir, git };
}

function report(holds: boolean): GateReport {
	return { gate: "design", hash: "hash", verifiers: [], holds };
}

test("pending input acknowledgement updates canonical task and projection", async (t) => {
	const { dir } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const nested = path.join(dir, "nested");
	fs.mkdirSync(nested);
	const store = new LaunchStore(nested);
	assert.equal(fs.realpathSync(store.cwd), fs.realpathSync(dir));
	store.captureInitialInput("statement", [{ data: "aGVsbG8=", mimeType: "text/plain" }]);
	assert.equal(new LaunchStore(dir).readInitialInput()?.text, "statement", "captured intake survives restart");
	const task = await store.createTask("statement", ["first"]);
	store.clearInitialInput();
	assert.equal(store.readInitialInput(), null);
	assert.match(task.id, /^[0-9a-f]{24}$/);
	const input = store.addPendingInput("also do this", [{ path: "attachments/one.png", mediaType: "image/png" }]);
	assert.equal((await store.gateReport("design", ["reviewer"])).holds, false);
	assert.throws(() => store.addRequirements(["bad"], ["missing"]), /Unknown pending input/);
	const updated = store.addRequirements(["second"], [input.id]);
	assert.deepEqual(updated.pendingInputs, []);
	assert.deepEqual(updated.requirements.map((item) => item.text), ["first", "second"]);
	assert.match(fs.readFileSync(path.join(store.taskDir(task.id), "requirements.md"), "utf8"), /1\. first\n2\. second/);
	assert.equal(fs.readdirSync(store.taskDir(task.id)).some((name) => name.includes(".tmp-")), false);
});

test("implementation artifacts are committed while clean-tree checks include config", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = new LaunchStore(dir);
	await store.createTask("statement", ["requirement"]);
	store.writeDesign("design");
	const before = await store.implementationHash();

	fs.appendFileSync(path.join(dir, "tracked.txt"), "uncommitted\n");
	assert.equal(await store.implementationHash(), before);
	assert.equal(await store.isWorktreeClean(), false);
	git("add", "tracked.txt");
	git("commit", "-qm", "implementation");
	assert.notEqual(await store.implementationHash(), before);
	assert.equal(await store.isWorktreeClean(), true);

	fs.writeFileSync(path.join(store.rootDir, "config.json"), '{"concurrency":2}\n');
	assert.equal(await store.isWorktreeClean(), false, "project config is reviewable");
	fs.writeFileSync(path.join(store.taskDir(store.mustCurrent().id), "scratch"), "runtime");
	fs.writeFileSync(path.join(store.rootDir, "current"), `${store.mustCurrent().id}\n`);
	assert.deepEqual(await store.worktreeChanges(), ["?? .pi/council/config.json"]);
});

test("fingerprints stale legacy or changed verifier verdicts", async (t) => {
	const { dir } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = new LaunchStore(dir);
	await store.createTask("statement", ["requirement"]);
	store.writeDesign("design");
	const hash = await store.designHash();
	const verdict: Verdict = { gate: "design", verifier: "a", verdict: "go", comments: [], hash, at: "now" };
	store.appendVerdict(verdict);
	assert.equal((await store.gateReport("design", ["a"])).holds, true);
	assert.equal((await store.gateReport("design", ["a"], { a: "v1" })).verifiers[0].state, "stale");
	store.appendVerdict({ ...verdict, fingerprint: "v1" });
	assert.equal((await store.gateReport("design", ["a"], new Map([["a", "v1"]]))).holds, true);
	assert.equal((await store.gateReport("design", ["a"], { a: "v2" })).verifiers[0].state, "stale");
});

test("phase derivation and config/state validation are explicit", async (t) => {
	const { dir } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = new LaunchStore(dir);
	const task = await store.createTask("statement", ["requirement"]);
	assert.equal(derivePhase(task, false, report(false), report(false)), "DESIGNING");
	assert.equal(derivePhase(task, true, report(false), report(false)), "DESIGN_GATE");
	assert.equal(derivePhase(task, true, report(true), report(false)), "IMPLEMENTING");
	assert.equal(derivePhase(task, true, report(true), report(false), { implementation: true }), "IMPL_GATE");
	task.pendingInputs = [{ id: "p", text: "new", receivedAt: "now" }];
	assert.equal(derivePhase(task, true, report(true), report(true)), "REQUIREMENTS");

	fs.writeFileSync(path.join(store.rootDir, "config.json"), '{"concurrency":0}');
	assert.throws(() => store.loadConfig(), /concurrency must be a positive integer/);
	fs.writeFileSync(path.join(store.rootDir, "config.json"), '{"inactivityMinutes":0}');
	assert.throws(() => store.loadConfig(), /inactivityMinutes must be between 0.1 and 120/);
	fs.writeFileSync(
		path.join(store.rootDir, "config.json"),
		'{"inactivityMinutes":3,"verifierModels":{"design":"provider/design"}}',
	);
	assert.deepEqual(store.loadConfig().verifierModels, { design: "provider/design" });
	fs.writeFileSync(path.join(store.rootDir, "config.json"), '{"verifierModels":{"design":""}}');
	assert.throws(() => store.loadConfig(), /verifierModels must map/);
	fs.writeFileSync(path.join(store.taskDir(task.id), "task.json"), "not json");
	assert.throws(() => store.current(), /Cannot load current-task council task/);
});

test("spend ledger aggregates tokens and cost and tolerates only a torn final record", async (t) => {
	const { dir } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = new LaunchStore(dir);
	const task = await store.createTask("statement", ["requirement"]);
	const worker: SpendEntry = {
		at: "2026-01-01T00:00:00.000Z",
		kind: "worker",
		name: "implementation",
		model: "provider/worker",
		tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
		costUsd: 0.25,
		status: "ok",
	};
	const verifier: SpendEntry = {
		...worker,
		kind: "verifier",
		name: "design",
		tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		costUsd: 0.05,
		status: "failed",
	};
	store.appendSpend(worker);
	store.appendSpend(verifier);
	const totals = store.spendTotals();
	assert.equal(totals.runs, 2);
	assert.deepEqual(totals.tokens, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 });
	assert.equal(totals.costUsd, 0.3);
	assert.equal(totals.byKind.worker.tokens.total, 100);
	assert.equal(totals.byKind.verifier.runs, 1);
	assert.equal(totalSpend([]).costUsd, 0);

	const ledger = path.join(store.taskDir(task.id), "spend.jsonl");
	fs.appendFileSync(ledger, '{"at":"torn"');
	assert.deepEqual(store.loadSpend(), [worker, verifier]);
	fs.writeFileSync(ledger, `${JSON.stringify(worker)}\nnot-json\n${JSON.stringify(verifier)}\n`);
	assert.throws(() => store.loadSpend(), /spend ledger.*:2/);
});

test("activity and status projections are atomically persisted and malformed state is surfaced", async (t) => {
	const { dir } = makeRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const store = new LaunchStore(dir);
	const task = await store.createTask("statement", ["requirement"]);
	assert.equal(store.readActivity(), null);
	assert.equal(store.readStatus(), null);
	const activity: ActivitySnapshot = {
		taskId: task.id,
		updatedAt: "now",
		children: [{
			id: "worker:one",
			kind: "worker",
			name: "one",
			status: "running",
			startedAt: "before",
			updatedAt: "now",
		}],
	};
	store.writeActivity(activity);
	assert.deepEqual(store.readActivity(), activity);
	assert.deepEqual(store.clearActivity().children, []);

	const zeroSpend = totalSpend([]);
	const status: StatusSnapshot = {
		taskId: task.id,
		phase: "DESIGN_GATE",
		generatedAt: "now",
		heartbeatAt: "now",
		pendingInputIds: [],
		blockers: ["design pending"],
		spend: zeroSpend,
		design: { hash: "d", holds: false, verifiers: [{ name: "design", fingerprint: "f", state: "reviewing" }] },
		implementation: { hash: "i", holds: false, verifiers: [] },
	};
	store.writeStatus(status);
	assert.deepEqual(store.readStatus(), status);
	store.close("done", "finished");
	assert.equal(store.current(), null);
	assert.equal(store.latest()?.status, "done");
	assert.equal(store.readStatus()?.phase, "DONE");
	store.appendSpend({ at: "after-close", kind: "owner", name: "Owner", model: "provider/model", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01, status: "ok" });
	store.refreshStatusSpend();
	assert.equal(store.spendTotals().byKind.owner.runs, 1, "terminal Owner response is attributed to the latest task");
	assert.equal(store.readStatus()?.spend.byKind.owner.runs, 1, "terminal status spend stays current");
	assert.equal(fs.readdirSync(store.taskDir(task.id)).some((name) => name.includes(".tmp-")), false);
	fs.writeFileSync(path.join(store.taskDir(task.id), "status.json"), "not-json");
	assert.throws(() => store.readStatus(), /Cannot load council status.json/);
});
