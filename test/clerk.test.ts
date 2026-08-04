import * as assert from "node:assert/strict";
import { test } from "node:test";
import { applyClerkRound, formatItemsForOwner, openItems, parseClerkOutput } from "../src/clerk.ts";
import { emptyClerkState, type Verdict } from "../src/state.ts";

const verdict = (verifier: string, v: "go" | "no-go", at: string, hash = "h1"): Verdict => ({ gate: "design", verifier, verdict: v, comments: ["c"], hash, at });

test("parseClerkOutput accepts the protocol and rejects malformed ledgers", () => {
	const ok = parseClerkOutput('preamble\n```json\n{"items":[{"id":"I-001","gate":"design","title":"T","detail":"D","status":"open","sources":["design"]}],"verdictOverrules":[{"gate":"design","verifier":"clean-code","reason":"r"}]}\n```');
	assert.ok(ok);
	assert.equal(ok!.items[0].id, "I-001");
	assert.equal(parseClerkOutput("no json here"), null);
	assert.equal(parseClerkOutput('```json\n{"items":[{"id":"","gate":"design","title":"T","detail":"D","status":"open"}],"verdictOverrules":[]}\n```'), null, "empty id rejected");
	assert.equal(parseClerkOutput('```json\n{"items":[{"id":"I-1","gate":"nope","title":"T","detail":"D","status":"open"}],"verdictOverrules":[]}\n```'), null, "bad gate rejected");
	assert.equal(parseClerkOutput('```json\n{"items":[],"verdictOverrules":[{"gate":"design","verifier":"x","reason":""}]}\n```'), null, "empty reason rejected");
});

test("applyClerkRound merges sources, pins overrules to this round's hashes, and dedups", () => {
	const round1 = applyClerkRound(emptyClerkState(), {
		items: [{ id: "I-001", gate: "design", title: "Audio overlaps", detail: "Serialize speech", status: "open", sources: ["design"] }],
		verdictOverrules: [],
	}, [verdict("design", "no-go", "t1")], "t1");
	assert.equal(round1.items.length, 1);
	assert.deepEqual(round1.items[0].sources, [{ verifier: "design", at: "t1", hash: "h1" }]);

	const round2 = applyClerkRound(round1, {
		items: [
			{ id: "I-001", gate: "design", title: "Audio overlaps", detail: "Serialize speech", status: "resolved", sources: ["clean-code"] },
			{ id: "I-002", gate: "design", title: "New defect", detail: "Fix it", status: "open", sources: [] },
		],
		verdictOverrules: [
			{ gate: "design", verifier: "clean-code", reason: "all comments overruled" },
			{ gate: "design", verifier: "absent-judge", reason: "may not overrule non-participants" },
		],
	}, [verdict("clean-code", "no-go", "t2", "h2")], "t2");
	assert.equal(round2.items.length, 2);
	assert.equal(round2.items[0].status, "resolved");
	assert.equal(round2.items[0].sources.length, 2, "sources accumulate across rounds");
	assert.deepEqual(round2.overrules, [{ gate: "design", verifier: "clean-code", hash: "h2", reason: "all comments overruled", at: "t2" }], "overrule pinned to this round's verdict hash; absent judges ignored");
	assert.equal(openItems(round2, "design").length, 1);
	assert.match(formatItemsForOwner(round2, "design"), /1 open · 1 resolved/);
	assert.match(formatItemsForOwner(round2, "design"), /I-002 New defect/);

	// a GO verdict cannot be overruled
	const round3 = applyClerkRound(round2, { items: round2.items.map((i) => ({ ...i, sources: [] })), verdictOverrules: [{ gate: "design", verifier: "design", reason: "x" }] }, [verdict("design", "go", "t3", "h3")], "t3");
	assert.equal(round3.overrules.length, 1, "go verdicts are not overruled");
});
