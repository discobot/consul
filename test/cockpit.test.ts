import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	JsonlDecoder,
	OwnerSupervisor,
	appendRequirementRpcCommand,
	isSleepJump,
	killTaskRpcCommand,
	loadCockpitSnapshot,
	nextRestart,
	parseJsonl,
	renderCockpit,
	renderCockpitPage,
} from "../src/cockpit.ts";

function fixture(): { cwd: string; dir: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-cockpit-"));
	const root = path.join(cwd, ".pi", "council");
	const dir = path.join(root, "tasks", "abc123");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(root, "current"), "abc123\n");
	fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
		id: "abc123",
		statement: "Ship a separate cockpit",
		requirements: [{ text: "Show both gates" }, { text: "Never mutate task files" }],
		status: "active",
	}));
	return { cwd, dir };
}

test("snapshot projects status, activity, verdict history, design, and spend", () => {
	const { cwd, dir } = fixture();
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		phase: "IMPLEMENTING",
		heartbeatAt: new Date(now).toISOString(),
		gates: {
			design: { verifiers: [{ name: "clean-code", state: "go" }] },
			implementation: { verifiers: [{ name: "interfaces", state: "no-go", comments: ["Fix RPC framing"] }] },
		},
		blockers: ["interfaces: Fix RPC framing"],
	}));
	fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify({ children: [{ name: "worker:rpc", status: "running" }] }));
	fs.writeFileSync(path.join(dir, "design.md"), "# Cockpit\n");
	fs.writeFileSync(path.join(dir, "verdicts.jsonl"), '{"gate":"design","verifier":"old","verdict":"go"}\n{"torn":');
	fs.writeFileSync(path.join(dir, "spend.jsonl"), [
		JSON.stringify({ tokens: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25 }),
		JSON.stringify({ totalTokens: 300, costUsd: 0.05 }),
		"",
	].join("\n"));

	const snapshot = loadCockpitSnapshot(cwd, now);
	assert.equal(snapshot.taskId, "abc123");
	assert.equal(snapshot.phase, "IMPLEMENTING");
	assert.equal(snapshot.connected, true);
	assert.deepEqual(snapshot.requirements, ["Show both gates", "Never mutate task files"]);
	assert.deepEqual(snapshot.gates.design.map((row) => [row.name, row.state]), [["clean-code", "GO"]]);
	assert.deepEqual(snapshot.gates.implementation[0].comments, ["Fix RPC framing"]);
	assert.deepEqual(snapshot.children, [{ name: "worker:rpc", status: "running" }]);
	assert.deepEqual(snapshot.spend, { cost: 0.3, tokens: 1500, entries: 2 });
	assert.equal(snapshot.design, "# Cockpit\n");
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("stale Owner heartbeat is a board-level reconnect condition", () => {
	const { cwd, dir } = fixture();
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		phase: "DESIGN_GATE",
		heartbeatAt: new Date(now - 60_000).toISOString(),
		design: { verifiers: [{ name: "design", state: "reviewing" }] },
	}));
	const snapshot = loadCockpitSnapshot(cwd, now);
	assert.equal(snapshot.connected, false);
	assert.equal(snapshot.gates.design[0].state, "reviewing");
	assert.match(renderCockpit(snapshot, 80).join("\n"), /reconnecting/);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("render is a bounded, complete task board with visible controls", () => {
	const { cwd } = fixture();
	const lines = renderCockpit(loadCockpitSnapshot(cwd), 48, "Requirement accepted by Owner");
	for (const line of lines) assert.ok(Array.from(line).length <= 48, JSON.stringify(line));
	const text = lines.join("\n");
	assert.match(text, /Statement:/);
	assert.match(text, /Requirements/);
	assert.match(text, /DESIGN GATE/);
	assert.match(text, /IMPLEMENTATION GATE/);
	assert.match(text, /Blocking comments/);
	assert.match(text, /Running children/);
	assert.match(text, /Spend/);
	assert.match(text, /\[a\] append requirement/);
	assert.match(text, /\[k\] kill task/);
	assert.match(text, /\[q\/Esc\] close/);
	const page = renderCockpitPage({ ...loadCockpitSnapshot(cwd), requirements: Array.from({ length: 30 }, (_, i) => `requirement ${i}`) }, 40, 12, 999);
	assert.equal(page.lines.length, 12);
	assert.match(page.lines.at(-1)!, /\+req.*kill.*close/);
	assert.ok(page.maxOffset > 0);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("JSONL framing uses LF only and ignores a torn final disk record", () => {
	assert.deepEqual(parseJsonl('{"ok":1}\n{"torn":'), [{ ok: 1 }]);
	const decoder = new JsonlDecoder();
	assert.deepEqual(decoder.push(Buffer.from('{"message":"a\u2028b"}')), []);
	assert.deepEqual(decoder.push("\r\n"), ['{"message":"a b"}']);
});

test("controls produce Owner RPC prompts rather than file mutations", () => {
	const append = appendRequirementRpcCommand("retain exact text\nwith newline");
	assert.equal(append.type, "prompt");
	assert.equal(append.streamingBehavior, "followUp");
	assert.match(String(append.message), /task_requirements_add/);
	assert.match(String(append.message), /retain exact text\\nwith newline/);
	assert.deepEqual(killTaskRpcCommand(), { type: "prompt", message: "/task-kill" });
});

test("Owner supervisor delivers multiple queued RPC appends without hanging", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-supervisor-"));
	const script = path.join(cwd, "fake-owner.mjs");
	fs.writeFileSync(script, `let b=""; process.stdin.on("data",d=>{b+=d; let i; while((i=b.indexOf("\\n"))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); setTimeout(()=>console.log(JSON.stringify({type:"response",id:m.id,success:true})),20)}});`);
	const previous = process.env.COUNCIL_PI;
	process.env.COUNCIL_PI = script;
	const supervisor = new OwnerSupervisor(cwd, path.join(cwd, "index.ts"), () => {});
	try {
		supervisor.start();
		const results = await Promise.race([
			Promise.all([supervisor.append("one"), supervisor.append("two")]),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supervisor append hung")), 2_000)),
		]);
		assert.equal(results.length, 2);
		assert.ok(results.every((result) => result.includes("accepted")));
	} finally {
		supervisor.stop();
		if (previous === undefined) delete process.env.COUNCIL_PI; else process.env.COUNCIL_PI = previous;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("restart backoff is bounded/resettable and sleep jumps are explicit", () => {
	let state = { attempts: 0, lastStartedAt: 1_000 };
	let restart = nextRestart(state, 2_000);
	assert.equal(restart.delayMs, 500);
	state = { attempts: 20, lastStartedAt: 2_000 };
	restart = nextRestart(state, 3_000);
	assert.equal(restart.delayMs, 30_000);
	restart = nextRestart(state, 70_000);
	assert.equal(restart.delayMs, 500);
	assert.equal(isSleepJump(10_000, 40_001), true);
	assert.equal(isSleepJump(10_000, 40_000), false);
});
