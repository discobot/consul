import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	JsonlDecoder,
	OwnerSupervisor,
	type Palette,
	appendRequirementRpcCommand,
	isSleepJump,
	killTaskRpcCommand,
	loadCockpitSnapshot,
	nextRestart,
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
		requirements: [{ text: "Show both gates", addedAt: "now" }, { text: "Never mutate task files", addedAt: "now" }],
		baseCommit: "00000000", baseBranch: "main", createdAt: "now",
		status: "active",
	}));
	return { cwd, dir };
}

test("snapshot projects status, activity, verdict history, design, and spend", () => {
	const { cwd, dir } = fixture();
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		taskId: "abc123", phase: "IMPLEMENTING", generatedAt: new Date(now).toISOString(),
		heartbeatAt: new Date(now).toISOString(), pendingInputIds: [],
		design: { hash: "d", holds: true, verifiers: [{ name: "clean-code", fingerprint: "f", state: "go" }] },
		implementation: { hash: "i", holds: false, verifiers: [{ name: "interfaces", fingerprint: "f", state: "no-go", comments: ["Fix RPC framing"] }] },
		blockers: ["interfaces: Fix RPC framing"], spend: { runs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byKind: {} },
	}));
	fs.writeFileSync(path.join(dir, "activity.json"), JSON.stringify({ taskId: "abc123", updatedAt: "now", children: [{ id: "worker:rpc", kind: "worker", name: "worker:rpc", status: "running", startedAt: "now", updatedAt: "now" }] }));
	fs.writeFileSync(path.join(dir, "design.md"), "# Cockpit\n");
	fs.writeFileSync(path.join(dir, "verdicts.jsonl"), '{"gate":"design","verifier":"old","verdict":"go"}\n{"torn":');
	fs.writeFileSync(path.join(dir, "spend.jsonl"), [
		JSON.stringify({ at: "now", kind: "worker", name: "w", model: "p/m", tokens: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, status: "ok" }),
		JSON.stringify({ at: "now", kind: "verifier", name: "v", model: "p/m", tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.05, status: "ok" }),
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
		taskId: "abc123", phase: "DESIGN_GATE", generatedAt: new Date(now - 60_000).toISOString(),
		heartbeatAt: new Date(now - 60_000).toISOString(), pendingInputIds: [], blockers: [],
		design: { hash: "d", holds: false, verifiers: [{ name: "design", fingerprint: "f", state: "reviewing" }] },
		implementation: { hash: "i", holds: false, verifiers: [] },
		spend: { runs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byKind: {} },
	}));
	const snapshot = loadCockpitSnapshot(cwd, now);
	assert.equal(snapshot.connected, false);
	assert.equal(snapshot.gates.design[0].state, "reviewing");
	assert.match(renderCockpit(snapshot, 80).join("\n"), /reconnecting/);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("render is a bounded, complete task board with visible controls", () => {
	const { cwd } = fixture();
	const lines = renderCockpit(loadCockpitSnapshot(cwd), 48);
	for (const line of lines) assert.ok(Array.from(line).length <= 48, JSON.stringify(line));
	const text = lines.join("\n");
	assert.match(text, /council cockpit/);
	assert.match(text, /Ship a separate cockpit/);
	assert.match(text, /2 requirements/);
	assert.match(text, /Design gate/);
	assert.match(text, /Implementation gate/);
	assert.match(text, /\(verdicts pending\)/);
	assert.match(text, /Blockers/);
	assert.match(text, /Spend/);
	assert.equal(lines.filter((line) => line.includes("1. ")).length, 1, "wrapped requirements are numbered once");
	const page = renderCockpitPage({ ...loadCockpitSnapshot(cwd), requirements: Array.from({ length: 30 }, (_, i) => `requirement ${i}`) }, 40, 12, 999, "Requirement accepted by Owner");
	assert.equal(page.lines.length, 12);
	const footer = page.lines.slice(-6).join(" ");
	assert.match(footer, /Requirement accepted by Owner/, "feedback stays fixed");
	assert.match(footer, /\d+–\d+\/\d+/, "scroll position stays fixed");
	assert.match(footer, /a append/);
	assert.match(footer, /k kill/);
	assert.match(footer, /q close/);
	assert.ok(page.maxOffset > 0);
	assert.equal(page.offset, page.maxOffset, "overscroll clamps to the last page");
	const narrow = renderCockpitPage({ ...loadCockpitSnapshot(cwd), spend: { cost: 1.25, tokens: 12345, entries: 9 } }, 20, 14, 0, "Requirement delivery failed; retry after reconnect");
	const narrowText = narrow.lines.join(" ");
	assert.match(narrowText, /delivery failed/);
	assert.match(narrowText, /close/);
	assert.ok(narrow.lines.length <= 14);
	for (const line of narrow.lines) assert.ok(Array.from(line).length <= 20, JSON.stringify(line));
	const narrowFull = renderCockpit({ ...loadCockpitSnapshot(cwd), spend: { cost: 1.25, tokens: 12345, entries: 9 } }, 20).join(" ");
	assert.match(narrowFull, /12,345/);
	assert.match(narrowFull, /9 runs/);
	const narrowHeader = renderCockpit(loadCockpitSnapshot(cwd), 20).join(" ");
	assert.match(narrowHeader, /abc123/);
	assert.match(narrowHeader, /UNKNOWN/);
	assert.match(narrowHeader, /reconnecting/);
	const taskFile = path.join(cwd, ".pi", "council", "tasks", "abc123", "task.json");
	const closed = JSON.parse(fs.readFileSync(taskFile, "utf8")); closed.status = "done"; closed.closedAt = "now"; fs.writeFileSync(taskFile, JSON.stringify(closed));
	const closedPage = renderCockpitPage(loadCockpitSnapshot(cwd), 50, 12);
	assert.doesNotMatch(closedPage.lines.join(" "), /append|kill/);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate panels sit side by side on wide terminals and stack when narrow", () => {
	const { cwd, dir } = fixture();
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		taskId: "abc123", phase: "DESIGN_GATE", generatedAt: new Date(now).toISOString(),
		heartbeatAt: new Date(now).toISOString(), pendingInputIds: [], blockers: [],
		design: { hash: "d", holds: false, verifiers: [{ name: "clean-code", fingerprint: "f", state: "go" }, { name: "design", fingerprint: "f", state: "reviewing" }] },
		implementation: { hash: "i", holds: false, verifiers: [{ name: "interfaces", fingerprint: "f", state: "no-go", comments: ["Fix RPC framing"] }] },
		spend: { runs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byKind: {} },
	}));
	const wide = renderCockpit(loadCockpitSnapshot(cwd, now), 100);
	assert.ok(wide.some((line) => line.includes("Design gate") && line.includes("Implementation gate")), "gates share a row at width 100");
	for (const line of wide) assert.ok(Array.from(line).length <= 100, JSON.stringify(line));
	const stacked = renderCockpit(loadCockpitSnapshot(cwd, now), 48);
	assert.ok(!stacked.some((line) => line.includes("Design gate") && line.includes("Implementation gate")), "gates stack at width 48");
	assert.ok(stacked.some((line) => line.includes("Design gate")));
	assert.ok(stacked.some((line) => line.includes("Implementation gate")));
	assert.match(stacked.join("\n"), /↳ Fix RPC framing/);
	assert.match(stacked.join("\n"), /1\/2 GO/, "partial gate shows its GO count");
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("palette paints states, chrome, and feedback; the spinner advances with the frame", () => {
	const { cwd, dir } = fixture();
	const now = Date.now();
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
		taskId: "abc123", phase: "DESIGN_GATE", generatedAt: new Date(now).toISOString(),
		heartbeatAt: new Date(now).toISOString(), pendingInputIds: [], blockers: ["interfaces: Fix RPC framing"],
		design: { hash: "d", holds: false, verifiers: [{ name: "clean-code", fingerprint: "f", state: "go" }, { name: "design", fingerprint: "f", state: "reviewing" }] },
		implementation: { hash: "i", holds: false, verifiers: [{ name: "interfaces", fingerprint: "f", state: "no-go", comments: ["Fix RPC framing"] }] },
		spend: { runs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byKind: {} },
	}));
	const marker: Palette = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `<b>${text}</b>` };
	const page = renderCockpitPage(loadCockpitSnapshot(cwd, now), 90, 34, 0, "hello", marker, 0);
	const text = page.lines.join("\n");
	assert.match(text, /<accent><b>◆ council cockpit<\/b><\/accent>/, "brand is accented");
	assert.match(text, /<success><b>✓<\/b><\/success>/, "GO paints success");
	assert.match(text, /<error><b>✗<\/b><\/error>/, "NO-GO paints error");
	assert.match(text, /<accent><b>◇<\/b><\/accent>/, "reviewing paints an accent spinner");
	assert.match(text, /<dim>╭─ <\/dim>/, "borders stay dim");
	assert.match(text, /<accent>▸ hello<\/accent>/, "feedback is accented");
	assert.match(text, /<error><b>Blockers<\/b><\/error>/, "blockers title paints error");
	const later = renderCockpitPage(loadCockpitSnapshot(cwd, now), 90, 34, 0, "", marker, 1).lines.join("\n");
	assert.match(later, /<accent><b>◈<\/b><\/accent>/, "spinner advances with the frame");
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("missing status never promotes historical verdicts to fresh gate state", () => {
	const { cwd, dir } = fixture();
	fs.writeFileSync(path.join(dir, "verdicts.jsonl"), '{"gate":"design","verifier":"design","verdict":"go","hash":"old"}\n');
	const snapshot = loadCockpitSnapshot(cwd);
	assert.deepEqual(snapshot.gates.design, []);
	assert.equal(snapshot.phase, "UNKNOWN");
	assert.match(snapshot.blockers.join(" "), /status unavailable/i);
	fs.rmSync(cwd, { recursive: true, force: true });
});

test("RPC JSONL framing uses LF only", () => {
	const decoder = new JsonlDecoder();
	assert.deepEqual(decoder.push(Buffer.from('{"message":"a\u2028b"}')), []);
	assert.deepEqual(decoder.push("\r\n"), ['{"message":"a b"}']);
});

test("controls produce Owner RPC prompts rather than file mutations", () => {
	const append = appendRequirementRpcCommand("retain exact text\nwith newline");
	assert.equal(append.type, "prompt");
	assert.equal(append.streamingBehavior, "followUp");
	assert.equal(append.message, "retain exact text\nwith newline");
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
