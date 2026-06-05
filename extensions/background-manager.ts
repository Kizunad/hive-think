/**
 * Background Process Manager — Singleton orchestrator for background hive_think
 *
 * Manages async hive_think sessions: subprocess queue, timeouts, budgets,
 * crash recovery, and TUI notifications. All hives share a single
 * MAX_CONCURRENCY=4 subprocess pool with FIFO fairness.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import {
	ANSWER_END,
	getFinalOutput,
	HIVE_SYSTEM_PROMPT,
	NODE_TIMEOUT_MS,
} from "./hive-think.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelResult {
	model: string;
	exitCode: number;
	sessionId?: string;
	durationMs: number;
	messages: Message[];
	stderr: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	stopReason?: string;
	errorMessage?: string;
}

export type HiveStatus = "launched" | "running" | "completed" | "aborted" | "error" | "timeout" | "lost";

export interface BackgroundHive {
	sessionId: string;
	status: HiveStatus;
	question: string;
	mode: string;
	models: string[];
	results: Map<string, ModelResult>;
	subprocesses: ChildProcess[];
	startTime: number;
	budgetMs: number;
	notified: boolean;
	doneCount: number;
	totalCount: number;
	cwd: string;
	context: string;
	history: string;
}

export interface HiveStatusResult {
	sessionId: string;
	status: HiveStatus;
	question: string;
	mode: string;
	models: string[];
	doneCount: number;
	totalCount: number;
	durationMs: number;
}

export interface HiveSummary {
	sessionId: string;
	status: HiveStatus;
	question: string;
	doneCount: number;
	totalCount: number;
}

interface HiveSessionState {
	sessionId: string;
	status: HiveStatus;
	question: string;
	mode: string;
	models: string[];
	doneCount: number;
	totalCount: number;
	startTime: number;
	results?: ModelResult[];
}

type OnProgress = (update: { sessionId: string; doneCount: number; totalCount: number }) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 4;
const HIVE_BUDGET_MS_DEFAULT = 45 * 60 * 1000; // 45 min
const WATCHDOG_INTERVAL_MS = 5000;
const TTL_MS = 5 * 60 * 1000; // 5 min after completion
const MAX_HIVES = 5;
const HIVE_TOOLS = "read,grep,find,ls,bash";

// ---------------------------------------------------------------------------
// BackgroundProcessManager
// ---------------------------------------------------------------------------

class BackgroundProcessManager {
	private static instance: BackgroundProcessManager | null = null;

	private pi: ExtensionAPI | null = null;
	private hives = new Map<string, BackgroundHive>();
	private queue: Array<{ sessionId: string; model: string; nodeIndex: number }> = [];
	private activeSlots = 0;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private onProgress: OnProgress | null = null;
	private shutdown = false;

	static getInstance(): BackgroundProcessManager {
		if (!BackgroundProcessManager.instance) {
			BackgroundProcessManager.instance = new BackgroundProcessManager();
		}
		return BackgroundProcessManager.instance;
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	init(pi: ExtensionAPI) {
		if (this.pi) return; // already initialized
		this.pi = pi;

		// Crash recovery on session start
		pi.on("session_start", async (_event, ctx) => {
			try {
				const entries = ctx.sessionManager.getEntries();
				for (const entry of entries) {
					if ((entry as any).customType === "hive:state" && (entry as any).data) {
						this.restoreState((entry as any).data);
					}
				}
			} catch { /* best-effort recovery */ }
		});

		// Notify on agent_end
		pi.on("agent_end", () => {
			this.emitHiveComplete();
		});

		// Cleanup on shutdown
		pi.on("session_shutdown", () => {
			this.doShutdown();
		});

		// Start watchdog
		this.startWatchdog();
	}

	// -----------------------------------------------------------------------
	// Launch
	// -----------------------------------------------------------------------

	launchHive(params: {
		question: string;
		context: string;
		history: string;
		models: string[];
		mode: string;
		cwd: string;
		budgetMs?: number;
		signal?: AbortSignal;
		onProgress?: OnProgress;
	}): string {
		// Enforce max hives (reject if full)
		const active = [...this.hives.values()].filter(
			(h) => h.status === "launched" || h.status === "running",
		);
		if (active.length >= MAX_HIVES) {
			// Abort oldest to make room
			const oldest = active.sort((a, b) => a.startTime - b.startTime)[0];
			if (oldest) this.abortHive(oldest.sessionId);
		}

		const sessionId = crypto.randomBytes(6).toString("hex");
		const nodeCount = params.models.length;

		const hive: BackgroundHive = {
			sessionId,
			status: "launched",
			question: params.question,
			mode: params.mode,
			models: [...params.models],
			results: new Map(),
			subprocesses: [],
			startTime: Date.now(),
			budgetMs: params.budgetMs ?? HIVE_BUDGET_MS_DEFAULT,
			notified: false,
			doneCount: 0,
			totalCount: nodeCount,
			cwd: params.cwd,
			context: params.context,
			history: params.history,
		};

		this.hives.set(sessionId, hive);

		// Enqueue all nodes
		for (let i = 0; i < nodeCount; i++) {
			this.queue.push({ sessionId, model: params.models[i], nodeIndex: i });
		}

		// Persist launch state
		this.persistState(hive);

		// Start processing
		this.processQueue();

		// Register abort signal
		if (params.signal) {
			if (params.signal.aborted) {
				this.abortHive(sessionId);
			} else {
				params.signal.addEventListener("abort", () => this.abortHive(sessionId), { once: true });
			}
		}

		return sessionId;
	}

	// -----------------------------------------------------------------------
	// Query
	// -----------------------------------------------------------------------

	getStatus(sessionId: string): HiveStatusResult | null {
		const hive = this.hives.get(sessionId);
		if (!hive) return null;
		return {
			sessionId: hive.sessionId,
			status: hive.status,
			question: hive.question,
			mode: hive.mode,
			models: hive.models,
			doneCount: hive.doneCount,
			totalCount: hive.totalCount,
			durationMs: Date.now() - hive.startTime,
		};
	}

	readResults(sessionId: string): ModelResult[] | null {
		const hive = this.hives.get(sessionId);
		if (!hive) return null;
		if (hive.status !== "completed" && hive.status !== "error" && hive.status !== "timeout") {
			return null; // not ready yet
		}
		const results = [...hive.results.values()];
		this.hives.delete(sessionId); // destructive read
		return results;
	}

	listHives(): HiveSummary[] {
		return [...this.hives.values()]
			.filter((h) => h.status !== "lost")
			.sort((a, b) => b.startTime - a.startTime)
			.map((h) => ({
				sessionId: h.sessionId,
				status: h.status,
				question: h.question.slice(0, 80),
				doneCount: h.doneCount,
				totalCount: h.totalCount,
			}));
	}

	abortHive(sessionId: string): boolean {
		const hive = this.hives.get(sessionId);
		if (!hive) return false;
		if (hive.status === "completed" || hive.status === "aborted" || hive.status === "lost") {
			return false;
		}

		hive.status = "aborted";
		for (const proc of hive.subprocesses) {
			try { proc.kill("SIGTERM"); } catch { /* already dead */ }
		}
		// Remove pending nodes from queue
		this.queue = this.queue.filter((q) => q.sessionId !== sessionId);
		this.processQueue();
		this.persistState(hive);
		return true;
	}

	get completedUnnotified(): BackgroundHive[] {
		return [...this.hives.values()].filter(
			(h) => h.status === "completed" && !h.notified,
		);
	}

	// -----------------------------------------------------------------------
	// Internal: Subprocess Queue
	// -----------------------------------------------------------------------

	private async processQueue() {
		while (this.activeSlots < MAX_CONCURRENCY && this.queue.length > 0 && !this.shutdown) {
			const next = this.queue.shift()!;
			const hive = this.hives.get(next.sessionId);
			if (!hive || hive.status === "aborted" || hive.status === "timeout") continue;

			this.activeSlots++;
			if (hive.status === "launched") {
				hive.status = "running";
				this.persistState(hive);
			}

			this.spawnNode(hive, next.model, next.nodeIndex);
		}
	}

	private async spawnNode(hive: BackgroundHive, model: string, nodeIndex: number) {
		const startTime = Date.now();

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;

		const result: ModelResult = {
			model,
			exitCode: 0,
			durationMs: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};

		try {
			// Write system prompt to temp file
			tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-bg-hive-"));
			tmpPromptPath = path.join(tmpPromptDir, "system-prompt.md");
			await withFileMutationQueue(tmpPromptPath, async () => {
				await fs.promises.writeFile(tmpPromptPath!, HIVE_SYSTEM_PROMPT, {
					encoding: "utf-8",
					mode: 0o600,
				});
			});

			const args = [
				"--mode", "json",
				"-p",
				"--no-session",
				"--model", model,
				"--thinking", "xhigh",
				"--tools", HIVE_TOOLS,
				"--append-system-prompt", tmpPromptPath,
			];

			const currentScript = process.argv[1];
			let command: string;
			let cmdArgs: string[];
			if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
				command = process.execPath;
				cmdArgs = [currentScript, ...args];
			} else {
				command = "pi";
				cmdArgs = args;
			}

			const taskContent = [
				hive.history ? `## Full Conversation History\n${hive.history}` : "",
				hive.context ? `## Additional Context\n${hive.context}` : "",
				`## Question\n${hive.question}`,
			].filter(Boolean).join("\n\n");

			const proc = spawn(command, cmdArgs, {
				cwd: hive.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			hive.subprocesses.push(proc);

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
					}, 5000);
				}
			};

			// Per-node timeout
			let nodeTimer: ReturnType<typeof setTimeout> | undefined;
			let nodeTimedOut = false;
			if (NODE_TIMEOUT_MS > 0) {
				nodeTimer = setTimeout(() => {
					nodeTimedOut = true;
					terminate();
				}, NODE_TIMEOUT_MS);
			}

			// Write task via stdin
			proc.stdin.on("error", () => { /* EPIPE, ignore */ });
			proc.stdin.write(taskContent);
			proc.stdin.end();

			let buffer = "";
			let resolved = false;
			let doneCalled = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try { event = JSON.parse(line); } catch { return; }

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

						for (const part of msg.content) {
							if (part.type === "text" && (part as any).text?.includes(ANSWER_END)) {
								resolved = true;
								if (nodeTimer) clearTimeout(nodeTimer);
								result.exitCode = 0;
								done();
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

			const done = () => {
				if (doneCalled) return;
				doneCalled = true;

				if (nodeTimer) clearTimeout(nodeTimer);

				if (nodeTimedOut && result.exitCode !== 0 && !result.errorMessage) {
					result.errorMessage = `node timeout after ${Math.round(NODE_TIMEOUT_MS / 1000)}s`;
				}
				if (!result.errorMessage && result.stderr.trim()) {
					result.errorMessage = `stderr: ${result.stderr.trim().split("\n")[0].slice(0, 120)}`;
				}

				result.durationMs = Date.now() - startTime;
				hive.results.set(model, result);

				// Cleanup temp files
				if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
				if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }

				// Notify and process queue
				this.activeSlots--;
				this.onNodeComplete(hive);
				this.processQueue();
			};

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = nodeTimedOut ? 124 : (code ?? 0);
				if (!resolved) done();
			});

			proc.on("error", () => {
				result.exitCode = 1;
				if (!resolved) done();
			});

		} catch (err: any) {
			result.exitCode = 1;
			result.errorMessage = err?.message || "spawn failed";
			hive.results.set(model, result);
			this.activeSlots--;
			this.onNodeComplete(hive);
			this.processQueue();

			if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
			if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
		}
	}

	private onNodeComplete(hive: BackgroundHive) {
		hive.doneCount++;

		this.onProgress?.({
			sessionId: hive.sessionId,
			doneCount: hive.doneCount,
			totalCount: hive.totalCount,
		});

		// Check if all nodes done
		if (hive.doneCount >= hive.totalCount) {
			hive.status = "completed";
			hive.startTime = Date.now(); // update for TTL tracking
			this.persistState(hive);
			this.emitHiveComplete();
		}
	}

	// -----------------------------------------------------------------------
	// Watchdog: checks budgets and emits notifications
	// -----------------------------------------------------------------------

	private startWatchdog() {
		if (this.watchdogTimer) return;
		this.watchdogTimer = setInterval(() => {
			this.checkBudgets();
			this.checkTTL();
			this.emitHiveComplete();
		}, WATCHDOG_INTERVAL_MS);
	}

	private checkBudgets() {
		const now = Date.now();
		for (const hive of this.hives.values()) {
			if (hive.status !== "running") continue;
			if (now - hive.startTime > hive.budgetMs) {
				hive.status = "timeout";
				for (const proc of hive.subprocesses) {
					try { proc.kill("SIGTERM"); } catch { /* dead */ }
				}
				this.queue = this.queue.filter((q) => q.sessionId !== hive.sessionId);
				this.processQueue();
				this.persistState(hive);
			}
		}
	}

	private checkTTL() {
		const now = Date.now();
		for (const [id, hive] of this.hives) {
			if (
				(hive.status === "completed" || hive.status === "error" || hive.status === "timeout") &&
				now - hive.startTime > TTL_MS
			) {
				hive.status = "lost";
				this.persistState(hive);
				this.hives.delete(id);
			}
		}
	}

	private emitHiveComplete() {
		if (!this.pi) return;
		for (const hive of this.completedUnnotified) {
			hive.notified = true;
			const allResults = [...hive.results.values()];
			const successCount = allResults.filter((r) => r.exitCode === 0).length;
			const icon = hive.status === "timeout" ? "⏱" : "🐝";

			// Build summary: list each model with brief output
			const summaries = allResults.map((r) => {
				const status = r.exitCode === 0 ? "✓" : "✗";
				const output = getFinalOutput(r.messages);
				const preview = output.slice(0, 150).replace(/\n/g, " ");
				return `### ${r.model} ${status} [${(r.durationMs / 1000).toFixed(1)}s]\n${preview || (r.errorMessage ? `Error: ${r.errorMessage}` : "(no output)")}`;
			}).join("\n\n");

			const msg = [
				`${icon} Background hive \`${hive.sessionId}\` complete: **${successCount}/${hive.totalCount}** models finished (${hive.mode} mode).`,
				"",
				summaries,
				"",
				`Read full results: \`hive_read({ sessionId: "${hive.sessionId}" })\``,
			].join("\n");

			this.pi.sendMessage({
				customType: "hive_complete",
				content: msg,
				display: false,
				details: {
					sessionId: hive.sessionId,
					status: hive.status,
					question: hive.question.slice(0, 100),
					successCount,
					totalCount: hive.totalCount,
					results: allResults.map((r) => ({
						model: r.model,
						exitCode: r.exitCode,
						durationMs: r.durationMs,
						text: getFinalOutput(r.messages),
						errorMessage: r.errorMessage,
					})),
				},
			}, { triggerTurn: false });
		}
	}

	// -----------------------------------------------------------------------
	// Persistence (best-effort crash recovery)
	// -----------------------------------------------------------------------

	private persistState(hive: BackgroundHive) {
		if (!this.pi) return;
		try {
			const state: HiveSessionState = {
				sessionId: hive.sessionId,
				status: hive.status,
				question: hive.question,
				mode: hive.mode,
				models: hive.models,
				doneCount: hive.doneCount,
				totalCount: hive.totalCount,
				startTime: hive.startTime,
			};
			// Write hive:state for crash recovery
			this.pi.appendEntry("hive:state", state);
			// Write hive:result with full model data on completion (enables cross-module hive_read)
			if (hive.status === "completed" || hive.status === "error" || hive.status === "timeout") {
				const rawResults = [...hive.results.values()].map((r) => ({
					model: r.model,
					exitCode: r.exitCode,
					durationMs: r.durationMs,
					text: getFinalOutput(r.messages),
					errorMessage: r.errorMessage,
					usage: r.usage,
				}));
				this.pi.appendEntry("hive:result", { sessionId: hive.sessionId, results: rawResults });
			}
		} catch { /* best-effort */ }
	}

	restoreState(data: HiveSessionState) {
		if (!data?.sessionId) return;
		const existing = this.hives.get(data.sessionId);
		if (existing && existing.status !== "lost") return; // already restored

		const hive: BackgroundHive = {
			sessionId: data.sessionId,
			status: data.status === "running" ? "lost" : data.status, // running=lost after crash
			question: data.question,
			mode: data.mode,
			models: data.models,
			results: new Map(),
			subprocesses: [],
			startTime: data.startTime,
			budgetMs: HIVE_BUDGET_MS_DEFAULT,
			notified: data.status === "completed",
			doneCount: data.doneCount,
			totalCount: data.totalCount,
			cwd: "",
			context: "",
			history: "",
		};

		if (data.results) {
			for (const r of data.results) {
				hive.results.set(r.model, r);
			}
		}

		this.hives.set(data.sessionId, hive);

		// Notify if completed
		if (hive.status === "completed" && !hive.notified) {
			setTimeout(() => this.emitHiveComplete(), 1000);
		}
	}

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------

	private doShutdown() {
		this.shutdown = true;
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
		for (const hive of this.hives.values()) {
			for (const proc of hive.subprocesses) {
				try { proc.kill("SIGTERM"); } catch { /* dead */ }
			}
		}
		this.queue = [];
		this.hives.clear();
	}

	// -----------------------------------------------------------------------
	// Accessibility for extension files
	// -----------------------------------------------------------------------

	setProgressHandler(handler: OnProgress | null) {
		this.onProgress = handler;
	}
}

// Export via globalThis to ensure all extension files share the same singleton
// (pi loads each extension file as a separate module instance)
const GLOBAL_KEY = Symbol.for("pi.hive.backgroundManager");
const _g = globalThis as any;
export const backgroundManager: BackgroundProcessManager = _g[GLOBAL_KEY] || (_g[GLOBAL_KEY] = BackgroundProcessManager.getInstance());
export { BackgroundProcessManager };
