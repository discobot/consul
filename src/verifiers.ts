/**
 * Verifier panel: discovery of verifier definitions (built-in + project overrides),
 * the context block children receive, and verdict parsing.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gate, LaunchStore, TaskRecord, Verdict } from "./state.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const BROWSER_VERIFIERS = new Set(["design", "ux-bugs", "user-local-pov", "user-global-pov"]);
const DEFAULT_VERIFIER_TOOLS = [...READ_ONLY_TOOLS];
const INLINE_DIFF_CAP_BYTES = 60 * 1024;
const AGENT_PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "agents");

function loadAgentPrompt(name: string): string {
	const file = path.join(AGENT_PROMPTS_DIR, name);
	try {
		const prompt = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim();
		if (!prompt) throw new Error("prompt is empty");
		return prompt;
	} catch (err) {
		throw new Error(`Cannot load agent prompt ${file}: ${String(err)}`);
	}
}

/** Select one reusable markdown section, including its heading. */
function promptSection(prompt: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = prompt.indexOf(marker);
	if (start < 0) throw new Error(`Agent prompt is missing section ${marker}`);
	const next = prompt.indexOf("\n## ", start + marker.length);
	return prompt.slice(start, next < 0 ? undefined : next).trim();
}

const VERDICT_PROTOCOL = loadAgentPrompt("verdict-protocol.md");
const REVIEW_HISTORY_PROTOCOL = promptSection(VERDICT_PROTOCOL, "Review history protocol");
const VERDICT_RESPONSE_PROTOCOL = promptSection(VERDICT_PROTOCOL, "Verdict response protocol");
const BROWSER_GUIDANCE = loadAgentPrompt("browser-guidance.md");

export interface VerifierDef {
	name: string;
	description: string;
	gates: Gate[];
	tools: string[];
	model?: string;
	browser: boolean;
	systemPrompt: string;
	source: "builtin" | "project";
	/** Hash of the normalized, behavior-affecting definition fields. */
	fingerprint: string;
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

function normalizedFingerprint(def: Omit<VerifierDef, "fingerprint" | "source">): string {
	const normalized = JSON.stringify({
		name: def.name.trim(),
		description: def.description.trim(),
		gates: [...new Set(def.gates)].sort(),
		tools: [...new Set(def.tools)].sort(),
		model: def.model?.trim() || null,
		browser: def.browser,
		systemPrompt: def.systemPrompt.replace(/\r\n?/g, "\n").trim(),
	});
	return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function verifierFingerprint(def: VerifierDef): string {
	return normalizedFingerprint(def);
}

function loadVerifierDir(dir: string, source: "builtin" | "project"): VerifierDef[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const defs: VerifierDef[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const file = path.join(dir, entry);
		let content: string;
		try {
			content = fs.readFileSync(file, "utf-8");
		} catch (err) {
			throw new Error(`Cannot read verifier definition ${file}: ${String(err)}`);
		}
		const { frontmatter, body } = parseFrontmatter(content);
		const fail = (reason: string): never => {
			throw new Error(`Invalid verifier definition ${file}: ${reason}`);
		};
		const name = frontmatter.name?.trim();
		const description = frontmatter.description?.trim();
		if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail("name must be a lowercase slug");
		if (!description) fail("description is required");
		const rawGates = (frontmatter.gates ?? "design, implementation").split(",").map((g) => g.trim());
		if (rawGates.length === 0 || rawGates.some((g) => g !== "design" && g !== "implementation")) {
			fail("gates must be a non-empty comma-separated subset of design, implementation");
		}
		const gates = [...new Set(rawGates)].sort() as Gate[];
		const browser = frontmatter.browser === "true";
		if (frontmatter.browser !== undefined && frontmatter.browser !== "true" && frontmatter.browser !== "false") {
			fail("browser must be true or false");
		}
		if (browser && !BROWSER_VERIFIERS.has(name)) fail("browser capability is reserved for perception verifiers");
		const allowedTools = browser ? [...READ_ONLY_TOOLS, "bash"] : [...READ_ONLY_TOOLS];
		const defaults = browser ? allowedTools : DEFAULT_VERIFIER_TOOLS;
		const rawTools = (frontmatter.tools ?? defaults.join(",")).split(",").map((tool) => tool.trim());
		if (rawTools.length === 0 || rawTools.some((tool) => !allowedTools.includes(tool))) {
			fail(`tools must be a non-empty subset of ${allowedTools.join(",")}`);
		}
		if (browser && !rawTools.includes("bash")) fail("browser capability requires bash");
		const tools = [...new Set(rawTools)].sort();
		const concernPrompt = body.replace(/\r\n?/g, "\n").trim();
		if (!concernPrompt) fail("system prompt body is required");
		// Shared behavior is part of the effective system prompt, and therefore its
		// fingerprint. Changing council protocol correctly stales old approvals.
		const systemPrompt = [concernPrompt, VERDICT_PROTOCOL, ...(browser ? [BROWSER_GUIDANCE] : [])].join("\n\n");
		if (frontmatter.model !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(frontmatter.model)) fail("model must be provider/model");
		const normalized = {
			name,
			description,
			gates,
			tools,
			...(frontmatter.model ? { model: frontmatter.model.trim() } : {}),
			browser,
			systemPrompt,
		};
		if (defs.some((def) => def.name === name)) fail(`duplicate verifier name ${name}`);
		defs.push({ ...normalized, source, fingerprint: normalizedFingerprint(normalized) });
	}
	return defs;
}

/** Built-ins ship next to the extension; projects may override or extend any of them
 * by name in `.pi/council/verifiers/*.md`. */
export function discoverVerifiers(cwd: string): VerifierDef[] {
	const builtinDir = path.join(AGENT_PROMPTS_DIR, "verifiers");
	const projectDir = path.join(cwd, ".pi", "council", "verifiers");
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
		...(task.attachments?.length
			? ["", "## Task attachments", ...task.attachments.map((attachment) => `- ${attachment.path}${attachment.mediaType ? ` (${attachment.mediaType})` : ""}`)]
			: []),
		...(task.pendingInputs?.length
			? ["", "## Pending user input", ...task.pendingInputs.map((input) => `- ${input.id}: ${input.text}${input.attachments?.length ? ` [attachments: ${input.attachments.map((a) => a.path).join(", ")}]` : ""}`)]
			: []),
		"",
		"## Repository status",
		await store.repoStatus(),
		...(design ? ["", "## Current design (design.md)", design] : []),
	].join("\n");
}

export async function buildVerifierPrompt(
	store: LaunchStore,
	task: TaskRecord,
	gate: Gate,
	verifierName: string,
	_definitionFingerprint?: string,
	browser = false,
): Promise<string> {
	const sections = [
		`You are serving on the council. Deliver your go / no-go verdict for the **${gate} gate** of the task below. Judge only the concern defined in your system prompt.`,
		"",
		await buildTaskContext(store, task),
	];
	const history = store
		.loadVerdicts()
		.filter((v) => v.gate === gate && v.verifier === verifierName)
		.slice(-2);
	if (history.length > 0) {
		sections.push(
			"",
			"## Your review history on this gate",
			...history.map(
				(v) =>
					`- ${v.at} @ hash ${v.hash}: ${v.verdict.toUpperCase()}${v.comments.length > 0 ? ` — ${v.comments.join(" • ").slice(0, 600)}` : ""}`,
			),
			`The full committee record is in .pi/council/tasks/${task.id}/verdicts.jsonl.`,
			REVIEW_HISTORY_PROTOCOL,
		);
	}
	if (browser) {
		sections.push("", BROWSER_GUIDANCE);
	}
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
	sections.push("", VERDICT_RESPONSE_PROTOCOL);
	return sections.join("\n");
}

/** Parse the verdict from a verifier's final output. Unparseable → no-go (safe default). */
export function parseVerdict(output: string): { verdict: "go" | "no-go"; comments: string[]; parseError: boolean } {
	const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
	const candidate = fenced.length > 0 ? fenced[fenced.length - 1][1] : output.match(/\{[^{}]*"verdict"[\s\S]*\}/)?.[0];
	if (candidate) {
		try {
			const parsed = JSON.parse(candidate);
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				Object.keys(parsed).sort().join(",") === "comments,verdict" &&
				(parsed.verdict === "go" || parsed.verdict === "no-go") &&
				Array.isArray(parsed.comments) &&
				parsed.comments.every((comment: unknown) => typeof comment === "string" && comment.trim().length > 0) &&
				(parsed.verdict === "go" || parsed.comments.length > 0)
			) {
				return { verdict: parsed.verdict, comments: parsed.comments, parseError: false };
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
