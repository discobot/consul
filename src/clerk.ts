/**
 * The Clerk: stateful arbitration between the stateless panel and the Owner.
 * Judges re-roll fresh objections every round; the Clerk carries the ledger —
 * dedups findings into items, rules on tug-of-wars once, kills re-litigation,
 * and may overrule a verdict so a gate can close over a neutralized holdout.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClerkItem, ClerkOverrule, ClerkState, Gate, Verdict } from "./state.ts";

const CLERK_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "agents", "clerk.md");
export const CLERK_PROMPT = fs.readFileSync(CLERK_PROMPT_PATH, "utf8").trim();

export interface ClerkParsed {
	items: { id: string; gate: Gate; title: string; detail: string; status: ClerkItem["status"]; ruling?: string; sources?: string[] }[];
	verdictOverrules: { gate: Gate; verifier: string; reason: string }[];
}

/** Parse the clerk's final JSON. Null on any shape violation — caller falls back. */
export function parseClerkOutput(output: string): ClerkParsed | null {
	const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
	const candidate = fenced.length > 0 ? fenced[fenced.length - 1][1] : null;
	if (!candidate) return null;
	try {
		const parsed = JSON.parse(candidate);
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items) || !Array.isArray(parsed.verdictOverrules)) return null;
		const gateOk = (g: unknown) => g === "design" || g === "implementation";
		const statusOk = (s: unknown) => s === "open" || s === "resolved" || s === "overruled";
		for (const item of parsed.items) {
			if (!item || typeof item.id !== "string" || !item.id.trim() || !gateOk(item.gate) || typeof item.title !== "string" || !item.title.trim() || typeof item.detail !== "string" || !statusOk(item.status)) return null;
			if (item.ruling !== undefined && typeof item.ruling !== "string") return null;
			if (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.some((s: unknown) => typeof s !== "string"))) return null;
		}
		for (const o of parsed.verdictOverrules) {
			if (!o || !gateOk(o.gate) || typeof o.verifier !== "string" || !o.verifier.trim() || typeof o.reason !== "string" || !o.reason.trim()) return null;
		}
		return parsed as ClerkParsed;
	} catch {
		return null;
	}
}

/** Fold a parsed clerk round into the persistent ledger. Pure. */
export function applyClerkRound(previous: ClerkState, parsed: ClerkParsed, roundVerdicts: Verdict[], at: string): ClerkState {
	const prevById = new Map(previous.items.map((item) => [item.id, item]));
	const verdictByVerifier = new Map(roundVerdicts.map((v) => [`${v.gate}:${v.verifier}`, v]));
	const items: ClerkItem[] = parsed.items.map((item) => {
		const prev = prevById.get(item.id);
		const sources = [...(prev?.sources ?? [])];
		for (const name of item.sources ?? []) {
			const v = verdictByVerifier.get(`${item.gate}:${name}`);
			if (v?.at && !sources.some((s) => s.verifier === name && s.at === v.at)) sources.push({ verifier: name, at: v.at, hash: v.hash });
		}
		return { id: item.id, gate: item.gate, title: item.title.trim(), detail: item.detail.trim(), status: item.status, sources, ...(item.ruling?.trim() ? { ruling: item.ruling.trim() } : {}), updatedAt: prev && prev.status === item.status && prev.title === item.title.trim() && prev.detail === item.detail.trim() ? prev.updatedAt : at };
	});
	const overrules: ClerkOverrule[] = [...previous.overrules];
	for (const o of parsed.verdictOverrules) {
		const v = verdictByVerifier.get(`${o.gate}:${o.verifier}`);
		if (!v) continue; // may only overrule a verdict from this round
		if (v.verdict === "go") continue;
		if (!overrules.some((x) => x.gate === o.gate && x.verifier === o.verifier && x.hash === v.hash)) {
			overrules.push({ gate: o.gate, verifier: o.verifier, hash: v.hash, reason: o.reason.trim(), at });
		}
	}
	return { v: 1, items, overrules, updatedAt: at };
}

export function openItems(state: ClerkState, gate?: Gate): ClerkItem[] {
	return state.items.filter((item) => item.status === "open" && (!gate || item.gate === gate));
}

/** The Owner-facing unified list — the only review surface the Owner works from. */
export function formatItemsForOwner(state: ClerkState, gate: Gate): string {
	const open = openItems(state, gate);
	const resolved = state.items.filter((i) => i.gate === gate && i.status === "resolved").length;
	const overruled = state.items.filter((i) => i.gate === gate && i.status === "overruled").length;
	const head = `Clerk ledger for the ${gate} gate: ${open.length} open · ${resolved} resolved · ${overruled} overruled.`;
	if (open.length === 0) return `${head}\nNo open items.`;
	return [head, ...open.map((item) => `- ${item.id} ${item.title}\n    ${item.detail.replace(/\n/g, "\n    ")}${item.ruling ? `\n    Ruling: ${item.ruling}` : ""}`)].join("\n");
}

export function buildClerkPrompt(taskContext: string, previous: ClerkState, gate: Gate, roundVerdicts: Verdict[]): string {
	return [
		`Arbitrate this round of the **${gate} gate**.`,
		"",
		taskContext,
		"",
		"## Ledger before this round",
		"```json",
		JSON.stringify({ items: previous.items, priorOverrules: previous.overrules.length }, null, 1),
		"```",
		"",
		"## This round's verdicts",
		...roundVerdicts.map((v) => [`### ${v.verifier} → ${v.verdict.toUpperCase()} (at ${v.at})`, ...v.comments.map((c) => `- ${c}`)].join("\n")),
		"",
		"Update the ledger per your protocol. The complete items array replaces the ledger.",
	].join("\n");
}
