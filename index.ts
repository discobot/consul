/**
 * launch-review — a launch-committee development process for pi.
 *
 * The user sets a task (their first message); the session agent becomes the Owner and
 * completes it non-interactively: derive requirements → design → design gate (parallel
 * verifier panel, go/no-go) → implement (parallel workers) → implementation gate → done.
 * Verdicts are pinned to content hashes; any change (including appended requirements)
 * stales the affected approvals, and the gates are enforced in code.
 *
 * See DESIGN.md. Load with `pi -e path/to/launch-review/index.ts` or symlink this
 * directory into .pi/extensions/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { storeFor } from "./src/state.ts";
import { registerTools } from "./src/tools.ts";
import { createStatusUI } from "./src/ui.ts";
import { discoverVerifiers, verifiersForGate } from "./src/verifiers.ts";

const OWNER_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "owner.md");

export default function (pi: ExtensionAPI) {
	const liveChildren = new Map<string, string>();
	const ui = createStatusUI(pi, liveChildren);
	registerTools(pi, { children: liveChildren, onChange: ui.refresh });

	const ownerPrompt = fs.readFileSync(OWNER_PROMPT_PATH, "utf-8");

	pi.on("session_start", async (_event, ctx) => {
		ui.refresh(ctx);
	});

	// The Owner role and a truthful task snapshot ride along on every agent run.
	pi.on("before_agent_start", async (event, ctx) => {
		const store = storeFor(ctx.cwd);
		const task = store.current();
		let snapshot: string;
		if (!task || task.status !== "active") {
			snapshot = "There is no active task. The next user message sets it: call task_set first.";
		} else {
			const all = discoverVerifiers(ctx.cwd);
			const design = await store
				.gateReport("design", verifiersForGate(all, "design").map((v) => v.name))
				.catch(() => null);
			const impl = await store
				.gateReport("implementation", verifiersForGate(all, "implementation").map((v) => v.name))
				.catch(() => null);
			const gateLine = (label: string, report: typeof design) =>
				report
					? `${label}: ${report.holds ? "HOLDS" : "not held"} (${report.verifiers.map((v) => `${v.name}=${v.state}`).join(", ")})`
					: `${label}: unavailable`;
			snapshot = [
				`Active task #${task.id}: ${task.statement}`,
				`Requirements: ${task.requirements.length} (see /task or task files)`,
				`Design doc: ${store.readDesign() ? "written" : "MISSING"}`,
				gateLine("Design gate", design),
				gateLine("Implementation gate", impl),
			].join("\n");
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${ownerPrompt}\n\n## Current task state\n${snapshot}` };
	});

	// User input is task intake, a requirement append, or a kill — never steering.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" };
		const task = storeFor(ctx.cwd).current();
		const notice =
			!task || task.status !== "active"
				? "[launch-review] This message sets the task. Record it with task_set (verbatim statement + derived requirements), then run the full process to completion."
				: `[launch-review] Mid-task user message on task #${task.id}. This is an appended requirement (or an explicit kill request), not chat: record it with task_requirements_add, then propagate — update the design and implementation as needed and re-source every verdict this stales.`;
		return { action: "transform", text: `${notice}\n\n${event.text}`, images: event.images };
	});
}
