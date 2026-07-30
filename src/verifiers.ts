/**
 * Verifier panel: discovery of verifier definitions (built-in + project overrides),
 * the context block children receive, and verdict parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gate, LaunchStore, TaskRecord, Verdict } from "./state.ts";

const DEFAULT_VERIFIER_TOOLS = ["read", "grep", "find", "ls", "bash"];
const INLINE_DIFF_CAP_BYTES = 60 * 1024;

export interface VerifierDef {
	name: string;
	description: string;
	gates: Gate[];
	tools: string[];
	model?: string;
	systemPrompt: string;
	source: "builtin" | "project";
}

/** Minimal frontmatter parser: `key: value` string pairs between `---` fences. */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		frontmatter[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
	}
	return { frontmatter, body: content.slice(match[0].length) };
}

function loadVerifierDir(dir: string, source: "builtin" | "project"): VerifierDef[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const defs: VerifierDef[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		let content: string;
		try {
			content = fs.readFileSync(path.join(dir, entry), "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const gates = (frontmatter.gates ?? "design, implementation")
			.split(",")
			.map((g) => g.trim())
			.filter((g): g is Gate => g === "design" || g === "implementation");
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		defs.push({
			name: frontmatter.name,
			description: frontmatter.description,
			gates: gates.length > 0 ? gates : ["design", "implementation"],
			tools: tools && tools.length > 0 ? tools : DEFAULT_VERIFIER_TOOLS,
			model: frontmatter.model,
			systemPrompt: body.trim(),
			source,
		});
	}
	return defs;
}

/** Built-ins ship next to the extension; projects may override or extend any of them
 * by name in `.pi/launch/verifiers/*.md`. */
export function discoverVerifiers(cwd: string): VerifierDef[] {
	const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "verifiers");
	const projectDir = path.join(cwd, ".pi", "launch", "verifiers");
	const merged = new Map<string, VerifierDef>();
	for (const def of loadVerifierDir(builtinDir, "builtin")) merged.set(def.name, def);
	for (const def of loadVerifierDir(projectDir, "project")) merged.set(def.name, def);
	return Array.from(merged.values());
}

export function verifiersForGate(all: VerifierDef[], gate: Gate): VerifierDef[] {
	return all.filter((v) => v.gates.includes(gate));
}

/** The context every child (verifier or worker) starts from: the task, its
 * requirements, and where the repo stands. Fresh each dispatch — no memory. */
export async function buildTaskContext(store: LaunchStore, task: TaskRecord): Promise<string> {
	const design = store.readDesign();
	return [
		`## Task (immutable statement, set ${task.createdAt})`,
		task.statement,
		"",
		"## Requirements",
		task.requirements.map((r, i) => `${i + 1}. ${r.text}`).join("\n"),
		"",
		"## Repository status",
		await store.repoStatus(),
		...(design ? ["", "## Current design (design.md)", design] : []),
	].join("\n");
}

export async function buildVerifierPrompt(store: LaunchStore, task: TaskRecord, gate: Gate): Promise<string> {
	const sections = [
		`You are serving on the launch committee. Deliver your go / no-go verdict for the **${gate} gate** of the task below. Judge only the concern defined in your system prompt.`,
		"",
		await buildTaskContext(store, task),
	];
	if (gate === "implementation") {
		const diff = await store.implementationDiff();
		if (Buffer.byteLength(diff, "utf8") <= INLINE_DIFF_CAP_BYTES) {
			sections.push("", "## The change under review (diff since task base)", "```diff", diff, "```");
		} else {
			sections.push(
				"",
				"## The change under review",
				`The diff since task base commit ${task.baseCommit.slice(0, 8)} is too large to inline. Inspect it yourself, e.g. \`git diff ${task.baseCommit.slice(0, 8)} --stat\` and then per-file.`,
			);
		}
	}
	sections.push(
		"",
		"## Verdict protocol",
		"Inspect the repository as needed with your tools. Then end your reply with exactly one fenced JSON block and nothing after it:",
		"```json",
		'{"verdict": "go", "comments": ["optional advisory notes"]}',
		"```",
		'or `{"verdict": "no-go", "comments": ["each blocking problem, concrete and actionable"]}`.',
		"A no-go must carry at least one comment. An unparseable reply is treated as no-go.",
	);
	return sections.join("\n");
}

/** Parse the verdict from a verifier's final output. Unparseable → no-go (safe default). */
export function parseVerdict(output: string): { verdict: "go" | "no-go"; comments: string[]; parseError: boolean } {
	const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
	const candidate = fenced.length > 0 ? fenced[fenced.length - 1][1] : output.match(/\{[^{}]*"verdict"[\s\S]*\}/)?.[0];
	if (candidate) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed.verdict === "go" || parsed.verdict === "no-go") {
				const comments = Array.isArray(parsed.comments) ? parsed.comments.map(String) : [];
				if (parsed.verdict === "no-go" && comments.length === 0) {
					comments.push("(verifier gave no-go without comments)");
				}
				return { verdict: parsed.verdict, comments, parseError: false };
			}
		} catch {
			// fall through to the safe default
		}
	}
	return {
		verdict: "no-go",
		comments: [`Verifier reply had no parseable verdict. Reply ended with: ${output.slice(-500) || "(empty)"}`],
		parseError: true,
	};
}

export function formatVerdictLine(v: Verdict): string {
	const mark = v.verdict === "go" ? "GO" : "NO-GO";
	const notes = v.comments.length > 0 ? ` — ${v.comments.join(" • ")}` : "";
	return `${v.verifier}: ${mark}${notes}`;
}
