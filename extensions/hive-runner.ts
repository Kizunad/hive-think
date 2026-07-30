/**
 * Hive Think — node runner
 *
 * One hive node is one `pi` subprocess. This module owns everything about
 * running them and nothing about what they are asked: prompt assembly lives in
 * the pipeline, so the synchronous and background paths share one runner instead
 * of keeping two copies of the spawn logic in sync.
 *
 * The subprocess handling here is load-bearing and was arrived at by fixing real
 * hangs — see the comments on early exit, per-node timeout, and kill escalation.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./hive-config.js";
import { ANSWER_END, resolvePositiveMs, Semaphore } from "./hive-util.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Read-only investigation plus bash for verification. Nodes must never mutate code. */
export const HIVE_TOOLS = "read,grep,find,ls,bash";

/** Max concurrent subprocesses across the whole process, to stay inside provider rate limits. */
export const MAX_CONCURRENCY = 4;

/**
 * Every node in the process passes through here, so the cap holds across
 * concurrent hives. Previously the synchronous path and the background manager
 * each enforced their own limit, letting several background hives multiply past it.
 */
const nodeSlots = new Semaphore(MAX_CONCURRENCY);

/**
 * Per-node hard timeout: a subprocess that never emits `</ANSWER>` and never
 * exits is killed after this (SIGTERM → 5s grace → SIGKILL), so one stuck node
 * cannot hang the hive. 0 disables.
 */
export const NODE_TIMEOUT_MS = resolvePositiveMs(process.env.HIVE_NODE_TIMEOUT_MS, 30 * 60_000);

/**
 * Overall budget: when the whole call exceeds this, remaining nodes are aborted
 * and whatever completed is returned as a partial result, so a stuck hive never
 * runs out the caller's outer timeout with zero output. 0 disables.
 *
 * Invariant for callers: NODE_TIMEOUT_MS < HIVE_BUDGET_MS < outer job timeout.
 */
export const HIVE_BUDGET_MS = resolvePositiveMs(process.env.HIVE_BUDGET_MS, 45 * 60_000);

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ModelResult {
	model: string;
	/** -1 while pending, 0 on success, 124 node timeout, 130 aborted, else failure. */
	exitCode: number;
	sessionId?: string;
	durationMs: number;
	messages: Message[];
	stderr: string;
	usage: NodeUsage;
	stopReason?: string;
	errorMessage?: string;
	/** Which pipeline stage produced this node, for grouped reporting. */
	stage?: string;
}

export interface RunNodeOptions {
	model: string;
	/** Appended to the node's system prompt. */
	systemPrompt: string;
	/** Task payload, piped over stdin so a large context cannot trip E2BIG. */
	task: string;
	cwd: string;
	thinking: ThinkingLevel;
	signal?: AbortSignal;
	stage?: string;
}

export function pendingResult(model: string, stage?: string): ModelResult {
	return {
		model,
		exitCode: -1,
		durationMs: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...(stage ? { stage } : {}),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
			if ((msg as any).errorMessage) return `[Error: ${(msg as any).errorMessage}]`;
		}
	}
	return "";
}

export function aggregateUsage(results: ModelResult[]): NodeUsage {
	const total: NodeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

async function writePromptToTempFile(content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-hive-"));
	const filePath = path.join(tmpDir, "hive-system-prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

// ---------------------------------------------------------------------------
// Node runner
// ---------------------------------------------------------------------------

/**
 * Run one hive node to completion and collect its result.
 *
 * Never throws for node-level failure: a crash, timeout, or abort comes back as a
 * non-zero `exitCode` with `errorMessage` set, so the hive keeps the nodes that
 * did finish and degrades to a partial result instead of erroring out wholesale.
 */
export async function runNode(opts: RunNodeOptions): Promise<ModelResult> {
	const args: string[] = [
		"--mode", "json",
		"-p",
		"--no-session",
		"--model", opts.model,
		"--thinking", opts.thinking,
		"--tools", HIVE_TOOLS,
	];

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const startTime = Date.now();
	const result = pendingResult(opts.model, opts.stage);
	result.exitCode = 0;

	const releaseSlot = await nodeSlots.acquire();

	// A node can sit queued for a long time; if the hive was aborted while it
	// waited, spawning now would only be work to kill.
	if (opts.signal?.aborted) {
		releaseSlot();
		result.exitCode = 130;
		result.errorMessage = "aborted before start (hive budget or external signal)";
		result.durationMs = Date.now() - startTime;
		return result;
	}

	try {
		const tmp = await writePromptToTempFile(opts.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		let wasAborted = false;
		let nodeTimedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Terminate with escalation: SIGTERM, then SIGKILL only if the process
			// truly hasn't exited. proc.killed means a signal was *sent*, not that the
			// process died — so track real exit via the "exit" event.
			let procExited = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			proc.once("exit", () => {
				procExited = true;
				if (killTimer) clearTimeout(killTimer);
			});
			const terminate = () => {
				proc.kill("SIGTERM");
				if (!killTimer) {
					killTimer = setTimeout(() => {
						if (!procExited) proc.kill("SIGKILL");
					}, KILL_GRACE_MS);
				}
			};

			let nodeTimer: ReturnType<typeof setTimeout> | undefined;
			const clearNodeTimer = () => {
				if (nodeTimer) {
					clearTimeout(nodeTimer);
					nodeTimer = undefined;
				}
			};
			if (NODE_TIMEOUT_MS > 0) {
				nodeTimer = setTimeout(() => {
					nodeTimedOut = true;
					terminate();
				}, NODE_TIMEOUT_MS);
			}

			// Task content goes over stdin: as an argv entry a long context trips
			// E2BIG (MAX_ARG_STRLEN is 128KB).
			proc.stdin.on("error", () => { /* EPIPE if the process exits early */ });
			proc.stdin.write(opts.task);
			proc.stdin.end();

			let buffer = "";
			let resolved = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "session" && event.id) {
					result.sessionId = event.id as string;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;

						// ANSWER early exit: once the closing tag lands there is nothing
						// left worth paying thinking tokens for, so kill the node now.
						for (const part of msg.content) {
							if (part.type === "text" && (part as any).text?.includes(ANSWER_END)) {
								resolved = true;
								clearNodeTimer();
								terminate();
								resolve(result.exitCode);
								return;
							}
						}
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				clearNodeTimer();
				if (!resolved) resolve(nodeTimedOut ? 124 : wasAborted ? 130 : (code ?? 0));
			});

			proc.on("error", () => {
				clearNodeTimer();
				if (!resolved) resolve(1);
			});

			if (opts.signal) {
				const killProc = () => {
					wasAborted = true;
					clearNodeTimer();
					terminate();
				};
				if (opts.signal.aborted) killProc();
				else opts.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.durationMs = Date.now() - startTime;

		if (nodeTimedOut && result.exitCode !== 0 && !result.errorMessage) {
			result.errorMessage = `node timeout after ${Math.round(NODE_TIMEOUT_MS / 1000)}s`;
		} else if (wasAborted && result.exitCode !== 0 && !result.errorMessage) {
			result.errorMessage = "aborted (hive budget or external signal)";
		}

		if (!result.errorMessage && result.stderr.trim()) {
			const firstLine = result.stderr.trim().split("\n")[0].slice(0, 120);
			result.errorMessage = `stderr: ${firstLine}`;
		}

		return result;
	} finally {
		releaseSlot();
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
