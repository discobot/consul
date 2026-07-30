/**
 * Child agent execution: each worker or verifier is a fresh headless pi process
 * (`--mode json -p --no-session -ne`) with its own system prompt and tool set.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const OUTPUT_CAP_BYTES = 50 * 1024;
const KILL_GRACE_MS = 5000;

export interface ChildSpec {
	name: string;
	systemPrompt: string;
	prompt: string;
	tools: string[];
	/** "provider/model" passed to `pi --model`. */
	model: string;
	cwd: string;
	timeoutMs: number;
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
}

/** Re-invoke the same pi that is running us (works for dev checkouts, npm installs,
 * and standalone binaries). Mirrors the reference subagent extension.
 * LAUNCH_REVIEW_PI overrides (a pi binary, or a .js/.ts entry run with node). */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const override = process.env.LAUNCH_REVIEW_PI;
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
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "launch-review-"));
	const promptFile = path.join(tmpDir, "system-prompt.md");
	await fs.promises.writeFile(promptFile, spec.systemPrompt, { encoding: "utf-8", mode: 0o600 });

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"-ne",
		"--model",
		spec.model,
		"--tools",
		spec.tools.join(","),
		"--append-system-prompt",
		promptFile,
		spec.prompt,
	];

	const result: ChildResult = {
		name: spec.name,
		ok: false,
		output: "",
		exitCode: 0,
		turns: 0,
		costUsd: 0,
	};

	const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(spec.timeoutMs)]) : AbortSignal.timeout(spec.timeoutMs);

	try {
		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: spec.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let stderr = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "tool_execution_start") {
					onProgress?.({ name: spec.name, turns: result.turns, lastActivity: event.toolName });
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const msg = event.message;
					result.turns++;
					result.costUsd += msg.usage?.cost?.total || 0;
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					const text = (msg.content ?? [])
						.filter((part: any) => part.type === "text")
						.map((part: any) => part.text)
						.join("\n");
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
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (code !== 0 && !result.errorMessage) result.errorMessage = stderr.trim().slice(-2000) || `exit code ${code}`;
				resolve(code ?? 0);
			});
			proc.on("error", (err) => {
				result.errorMessage = String(err);
				resolve(1);
			});

			const kill = () => {
				if (!result.errorMessage) {
					result.errorMessage = combinedSignal.reason?.name === "TimeoutError" ? "timed out" : "aborted";
				}
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, KILL_GRACE_MS).unref();
			};
			if (combinedSignal.aborted) kill();
			else combinedSignal.addEventListener("abort", kill, { once: true });
		});
	} finally {
		fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}

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
