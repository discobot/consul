/**
 * Child agent execution: each worker or verifier is a fresh headless pi process
 * (`--mode json -p --no-session -ne`) with its own system prompt and tool set.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OUTPUT_CAP_BYTES = 50 * 1024;
const KILL_GRACE_MS = 5000;

export interface ChildSpec {
	name: string;
	systemPrompt: string;
	prompt: string;
	tools: string[];
	/** Verifiers get a replacement prompt and complete resource isolation. */
	kind?: "worker" | "verifier";
	/** "provider/model" passed to `pi --model`. */
	model: string;
	cwd: string;
	timeoutMs: number;
	/** No parsed JSONL event for this long terminates the child. */
	inactivityMs?: number;
}

export interface ChildProgress {
	name: string;
	turns: number;
	lastActivity: string;
}

export interface ChildResult {
	name: string;
	ok: boolean;
	/** Final assistant text, capped at 50KB. */
	output: string;
	stopReason?: string;
	errorMessage?: string;
	exitCode: number;
	turns: number;
	costUsd: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Re-invoke the same pi that is running us (works for dev checkouts, npm installs,
 * and standalone binaries). Mirrors the reference subagent extension.
 * COUNCIL_PI overrides (a pi binary, or a .js/.ts entry run with node). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const override = process.env.COUNCIL_PI;
	if (override) {
		return /\.(js|ts|mjs)$/.test(override)
			? { command: process.execPath, args: [override, ...args] }
			: { command: override, args };
	}
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function watchdogFailure(
	now: number,
	lastEventAt: number,
	lastCheckAt: number,
	inactivityMs: number,
	checkIntervalMs: number,
): string | undefined {
	if (now - lastCheckAt > checkIntervalMs + 30_000) return "system sleep/wake detected";
	if (now - lastEventAt >= inactivityMs) return "inactivity watchdog expired";
	return undefined;
}

function capBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let cut = text.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated at ${maxBytes} bytes.]`;
}

export async function runChild(
	spec: ChildSpec,
	signal: AbortSignal | undefined,
	onProgress?: (progress: ChildProgress) => void,
): Promise<ChildResult> {
	const verifierArgs =
		spec.kind === "verifier"
			? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]
			: ["--no-extensions"];
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		...verifierArgs,
		"--model",
		spec.model,
		"--tools",
		spec.tools.join(","),
		spec.kind === "verifier" ? "--system-prompt" : "--append-system-prompt",
		spec.systemPrompt,
		...(spec.kind === "verifier" ? ["--append-system-prompt", ""] : []),
		spec.prompt,
	];

	const result: ChildResult = {
		name: spec.name,
		ok: false,
		output: "",
		exitCode: 0,
		turns: 0,
		costUsd: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(spec.timeoutMs)]) : AbortSignal.timeout(spec.timeoutMs);

	result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: spec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let stderr = "";
			let closed = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let watchdogTimer: NodeJS.Timeout | undefined;
			let lastEventAt = Date.now();
			let lastCheckAt = lastEventAt;
			const inactivityMs = spec.inactivityMs ?? spec.timeoutMs;
			const checkIntervalMs = Math.min(1000, Math.max(25, Math.floor(inactivityMs / 4)));
			const abortChild = () => kill();

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				combinedSignal.removeEventListener("abort", abortChild);
				if (killTimer) clearTimeout(killTimer);
				if (watchdogTimer) clearInterval(watchdogTimer);
				resolve(code);
			};
			const messageText = (message: any): string =>
				(message?.content ?? [])
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n");
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				lastEventAt = Date.now();
				if (event.type === "tool_execution_start") {
					onProgress?.({ name: spec.name, turns: result.turns, lastActivity: event.toolName });
				}
				if (event.type === "message_update" && event.message?.role === "assistant") {
					const preview = messageText(event.message).replace(/[\r\n\t]+/g, " ").trim().slice(-80);
					onProgress?.({
						name: spec.name,
						turns: result.turns,
						lastActivity: preview ? `responding: ${preview}` : "responding",
					});
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const msg = event.message;
					result.turns++;
					result.costUsd += msg.usage?.cost?.total || 0;
					for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) result.tokens[key] += msg.usage?.[key] || 0;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					const text = messageText(msg);
					if (text.trim()) result.output = text;
					onProgress?.({ name: spec.name, turns: result.turns, lastActivity: "thinking" });
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code, exitSignal) => {
				closed = true;
				if (buffer.trim()) processLine(buffer);
				if ((code !== 0 || exitSignal) && !result.errorMessage) {
					result.errorMessage =
						stderr.trim().slice(-2000) || (exitSignal ? `terminated by ${exitSignal}` : `exit code ${code}`);
				}
				finish(code ?? (exitSignal ? 1 : 0));
			});
			proc.on("error", (err) => {
				result.errorMessage = String(err);
				finish(1);
			});

			function kill(reason?: string) {
				if (!result.errorMessage) {
					result.errorMessage = reason ?? (combinedSignal.reason?.name === "TimeoutError" ? "timed out" : "aborted");
				}
				proc.kill("SIGTERM");
				if (!killTimer) {
					killTimer = setTimeout(() => {
						if (!closed) proc.kill("SIGKILL");
					}, KILL_GRACE_MS);
					killTimer.unref();
				}
			}
			watchdogTimer = setInterval(() => {
				const now = Date.now();
				const reason = watchdogFailure(now, lastEventAt, lastCheckAt, inactivityMs, checkIntervalMs);
				lastCheckAt = now;
				if (reason) kill(reason);
			}, checkIntervalMs);
			watchdogTimer.unref();
			if (combinedSignal.aborted) abortChild();
			else combinedSignal.addEventListener("abort", abortChild, { once: true });
	});

	result.output = capBytes(result.output, OUTPUT_CAP_BYTES);
	result.ok =
		result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted" && !result.errorMessage;
	return result;
}

export async function runPool<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
