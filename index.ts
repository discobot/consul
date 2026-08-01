/**
 * council — a launch-committee development process for pi.
 *
 * The user sets a task (their first message); the session agent becomes the Owner and
 * completes it non-interactively: derive requirements → design → design gate (parallel
 * verifier panel, go/no-go) → implement (parallel workers) → implementation gate → done.
 * Verdicts are pinned to content hashes; any change (including appended requirements)
 * stales the affected approvals, and the gates are enforced in code.
 *
 * See DESIGN.md. Load with `pi -e path/to/council/index.ts` or symlink this
 * directory into .pi/extensions/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { storeFor } from "./src/state.ts";
import { registerTools } from "./src/tools.ts";
import { RESUME_NUDGE, createStatusUI } from "./src/ui.ts";
import { discoverVerifiers, verifiersForGate } from "./src/verifiers.ts";

const OWNER_PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts", "agents", "owner.md");

export default function (pi: ExtensionAPI) {
	const liveChildren = new Map<string, string>();
	const ownerSpendSeen = new Set<string>();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const ui = createStatusUI(pi, liveChildren);
	registerTools(pi, {
		children: liveChildren,
		onChange: ui.refresh,
		initialInput: (cwd) => storeFor(cwd).readInitialInput() ?? undefined,
		clearInitialInput: (cwd) => storeFor(cwd).clearInitialInput(),
	});

	const ownerPrompt = fs.readFileSync(OWNER_PROMPT_PATH, "utf-8");

	pi.on("session_start", async (event, ctx) => {
		// Read the previous owner's heartbeat before our own refresh overwrites it.
		const store = storeFor(ctx.cwd);
		const previousBeat = (() => { try { return store.readStatus()?.heartbeatAt; } catch { return undefined; } })();
		try { store.clearActivity(); } catch { /* no task yet */ }
		ui.refresh(ctx);
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(() => ui.refresh(ctx), 5_000);
		heartbeat.unref?.();
		// Resume-in-place: an interactive session opened over an active task continues it
		// automatically (picker → enter → work resumes). Never in RPC mode — the board
		// supervisor respawns its Owner constantly and must not trigger turns — and never
		// when another live Owner is already heartbeating on this task.
		if (ctx.mode !== "tui" || (event.reason !== "startup" && event.reason !== "resume")) return;
		const task = (() => { try { return store.current(); } catch { return null; } })();
		const anotherOwnerLive = Boolean(previousBeat && Date.now() - Date.parse(previousBeat) <= 15_000);
		if (task?.status === "active" && !anotherOwnerLive) {
			pi.sendUserMessage(RESUME_NUDGE, { deliverAs: "followUp" });
			ctx.ui.notify(`Resuming task #${task.id} — messages append requirements; /task-kill abandons.`, "info");
		}
	});
	pi.on("session_shutdown", () => { if (heartbeat) clearInterval(heartbeat); });
	pi.on("message_end", (event, ctx) => {
		const message = event.message as any;
		if (message?.role !== "assistant" || !message.usage) return;
		const key = `${message.timestamp}:${message.provider}:${message.model}:${message.responseId ?? ""}`;
		if (ownerSpendSeen.has(key)) return;
		const store = storeFor(ctx.cwd);
		if (!store.latest()) return;
		ownerSpendSeen.add(key);
		store.appendSpend({
			at: new Date(message.timestamp ?? Date.now()).toISOString(), kind: "owner", name: "Owner",
			model: `${message.provider}/${message.model}`,
			tokens: { input: message.usage.input ?? 0, output: message.usage.output ?? 0, cacheRead: message.usage.cacheRead ?? 0, cacheWrite: message.usage.cacheWrite ?? 0 },
			costUsd: message.usage.cost?.total ?? 0,
			status: message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "aborted" : "ok",
		});
		store.refreshStatusSpend();
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
			const designDefs = verifiersForGate(all, "design");
			const implDefs = verifiersForGate(all, "implementation");
			const design = await store
				.gateReport("design", designDefs.map((v) => v.name), new Map(designDefs.map((v) => [v.name, v.fingerprint])))
				.catch(() => null);
			const impl = await store
				.gateReport("implementation", implDefs.map((v) => v.name), new Map(implDefs.map((v) => [v.name, v.fingerprint])))
				.catch(() => null);
			const pending = task.pendingInputs ?? [];
			const gateLine = (label: string, report: typeof design) =>
				report
					? `${label}: ${report.holds ? "HOLDS" : "not held"} (${report.verifiers.map((v) => `${v.name}=${v.state}`).join(", ")})`
					: `${label}: unavailable`;
			snapshot = [
				`Active task #${task.id}: ${task.statement}`,
				`Requirements: ${task.requirements.length} (see /task or task files)`,
				...(pending.length ? [`Pending input IDs: ${pending.map((input) => input.id).join(", ")} — record with task_requirements_add(inputIds: ...)`] : []),
				`Design doc: ${store.readDesign() ? "written" : "MISSING"}`,
				gateLine("Design gate", design),
				gateLine("Implementation gate", impl),
			].join("\n");
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${ownerPrompt}\n\n## Current task state\n${snapshot}` };
	});

	const protectedTools = new Set(["request_verdicts", "task_complete"]);
	const readOnlyTools = new Set(["read", "grep", "find", "ls", "gate_status"]);
	const activeMutations = new Set<string>();
	let activeProtected: string | undefined;
	pi.on("tool_call", async (event) => {
		const callId = event.toolCallId;
		if (protectedTools.has(event.toolName)) {
			if (activeProtected || activeMutations.size) return { block: true, reason: `Blocked ${event.toolName}: another mutation or gate operation is still running.` };
			activeProtected = callId;
			return;
		}
		if (readOnlyTools.has(event.toolName)) return;
		if (activeProtected) return { block: true, reason: `Blocked ${event.toolName}: verdict sourcing is in flight; it lifts as soon as the verdicts land.` };
		// Gates are the Owner's to self-impose — the prompt sequences design → gate →
		// implement, and task_complete enforces both gates mechanically at the end.
		// The harness never blocks work mid-task; it only serializes mutations against
		// verdict sourcing so verdicts stay pinned to a stable tree.
		activeMutations.add(callId);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		activeMutations.delete(event.toolCallId);
		if (activeProtected === event.toolCallId) activeProtected = undefined;
		if (!["read", "grep", "find", "ls"].includes(event.toolName)) ui.refresh(ctx);
	});

	// User input is task intake, a requirement append, or a kill — never steering.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const text = event.text.trim();
		if (!text || text.startsWith("/")) return { action: "continue" };
		const store = storeFor(ctx.cwd);
		const task = store.current();
		let notice: string;
		if (!task || task.status !== "active") {
			store.captureInitialInput(event.text, event.images ?? []);
			notice = "[council] This message sets the task. Finalize it with task_set (verbatim statement + derived requirements), then run the full process to completion.";
		} else {
			const pending = store.addPendingInputWithImages(event.text, event.images ?? []);
			notice = `[council] Mid-task user input ${pending.id} on task #${task.id}. This is an appended requirement (or explicit kill), not chat: record it with task_requirements_add(inputIds: [\"${pending.id}\"]), propagate it, and re-source stale verdicts.`;
			ui.refresh(ctx);
		}
		return { action: "transform", text: `${notice}\n\n${event.text}`, images: event.images };
	});
}
