/**
 * Background Process Manager — non-blocking hive sessions
 *
 * Owns the lifecycle of `hive_think({ async: true })` runs: budgets, crash
 * recovery, TTL, and completion notifications.
 *
 * It does not spawn anything itself. Both the synchronous tool call and this
 * manager drive `runPipeline`, so the two paths cannot drift — an earlier version
 * kept a second copy of the spawn logic here and only ever ran a single flat batch
 * of models, which the five-stage pipeline is not.
 *
 * Concurrency is enforced process-wide inside hive-runner, so several background
 * hives plus a foreground call still share one subprocess cap.
 */

import * as crypto from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HiveConfig } from "./hive-config.js";
import { type PipelineOutcome, renderOutcome, runPipeline, type StageName } from "./hive-pipeline.js";
import { getFinalOutput, type ModelResult } from "./hive-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HiveStatus = "launched" | "running" | "completed" | "aborted" | "error" | "timeout" | "lost";

export interface BackgroundHive {
	sessionId: string;
	status: HiveStatus;
	question: string;
	models: string[];
	/** Node results in run order. Never keyed by model: a roster repeats models. */
	results: ModelResult[];
	outcome?: PipelineOutcome;
	abort: AbortController;
	startTime: number;
	/** Set when the run finishes, so TTL is measured from completion. */
	endTime?: number;
	budgetMs: number;
	notified: boolean;
	stage?: StageName;
	doneCount: number;
	totalCount: number;
}

export interface HiveStatusResult {
	sessionId: string;
	status: HiveStatus;
	question: string;
	models: string[];
	stage?: string;
	doneCount: number;
	totalCount: number;
	durationMs: number;
}

export interface HiveSummary {
	sessionId: string;
	status: HiveStatus;
	question: string;
	stage?: string;
	doneCount: number;
	totalCount: number;
}

interface HiveSessionState {
	sessionId: string;
	status: HiveStatus;
	question: string;
	models: string[];
	doneCount: number;
	totalCount: number;
	startTime: number;
}

type OnProgress = (update: { sessionId: string; doneCount: number; totalCount: number; stage?: string }) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIVE_BUDGET_MS_DEFAULT = 45 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 5000;
/** How long a finished hive's results stay collectable. */
const TTL_MS = 5 * 60 * 1000;
const MAX_HIVES = 5;

// ---------------------------------------------------------------------------
// BackgroundProcessManager
// ---------------------------------------------------------------------------

class BackgroundProcessManager {
	private static instance: BackgroundProcessManager | null = null;

	private pi: ExtensionAPI | null = null;
	private hives = new Map<string, BackgroundHive>();
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private onProgress: OnProgress | null = null;
	private shutdown = false;

	static getInstance(): BackgroundProcessManager {
		if (!BackgroundProcessManager.instance) {
			BackgroundProcessManager.instance = new BackgroundProcessManager();
		}
		return BackgroundProcessManager.instance;
	}

	init(pi: ExtensionAPI) {
		if (this.pi) return; // already initialized
		this.pi = pi;

		pi.on("session_start", async (_event: unknown, ctx: any) => {
			try {
				for (const entry of ctx.sessionManager.getEntries()) {
					if ((entry as any).customType === "hive:state" && (entry as any).data) {
						this.restoreState((entry as any).data);
					}
				}
			} catch { /* best-effort recovery */ }
		});

		pi.on("agent_end", () => this.emitHiveComplete());
		pi.on("session_shutdown", () => this.doShutdown());

		this.startWatchdog();
	}

	// -----------------------------------------------------------------------
	// Launch
	// -----------------------------------------------------------------------

	launchHive(params: {
		question: string;
		context: string;
		history: string;
		cwd: string;
		config: HiveConfig;
		maxNodes?: number;
		budgetMs?: number;
		signal?: AbortSignal;
	}): string {
		// Make room rather than refuse: the caller asked for this run, and the
		// oldest still-running hive is the least likely to still be wanted.
		const active = [...this.hives.values()].filter((h) => h.status === "launched" || h.status === "running");
		if (active.length >= MAX_HIVES) {
			const oldest = active.sort((a, b) => a.startTime - b.startTime)[0];
			if (oldest) this.abortHive(oldest.sessionId);
		}

		const sessionId = crypto.randomBytes(6).toString("hex");
		const hive: BackgroundHive = {
			sessionId,
			status: "launched",
			question: params.question,
			models: [...params.config.models],
			results: [],
			abort: new AbortController(),
			startTime: Date.now(),
			budgetMs: params.budgetMs ?? HIVE_BUDGET_MS_DEFAULT,
			notified: false,
			doneCount: 0,
			// Not yet known: the fan-out is decided after decomposition, so this is a
			// floor that grows once the pipeline reports its first stage.
			totalCount: params.config.minNodes,
		};
		this.hives.set(sessionId, hive);
		this.persistState(hive);

		if (params.signal) {
			if (params.signal.aborted) this.abortHive(sessionId);
			else params.signal.addEventListener("abort", () => this.abortHive(sessionId), { once: true });
		}

		void this.drive(hive, params);
		return sessionId;
	}

	private async drive(
		hive: BackgroundHive,
		params: { question: string; context: string; history: string; cwd: string; config: HiveConfig; maxNodes?: number },
	) {
		// An abort can land between `launchHive` registering the hive and this
		// running — an already-aborted signal aborts it synchronously. Without this
		// guard the status would be overwritten back to "running".
		if (hive.status !== "launched") return;

		hive.status = "running";
		this.persistState(hive);

		try {
			const outcome = await runPipeline({
				question: params.question,
				context: params.context,
				history: params.history,
				cwd: params.cwd,
				config: params.config,
				maxNodes: params.maxNodes,
				signal: hive.abort.signal,
				onProgress: (progress) => {
					hive.stage = progress.stage;
					hive.results = progress.results;
					hive.doneCount = progress.results.filter((r) => r.exitCode !== -1).length;
					hive.totalCount = Math.max(hive.totalCount, hive.doneCount, progress.total);
					this.onProgress?.({
						sessionId: hive.sessionId,
						doneCount: hive.doneCount,
						totalCount: hive.totalCount,
						stage: progress.stage,
					});
				},
			});

			hive.outcome = outcome;
			hive.results = outcome.results;
			hive.doneCount = outcome.results.length;
			hive.totalCount = outcome.results.length;
			// Only claim a terminal status if nothing already set one. The watchdog marks
			// a budget overrun as "timeout" and then aborts; overwriting that with the
			// generic "aborted" would lose why the run stopped. An aborted run still
			// carries whatever the finished stages produced either way.
			if (hive.status === "running") {
				hive.status = hive.abort.signal.aborted ? "aborted" : "completed";
			}
		} catch (err) {
			hive.status = "error";
			hive.outcome = undefined;
			const message = err instanceof Error ? err.message : String(err);
			// Surface the failure where hive_read looks, so a crashed pipeline is not
			// an empty result with no explanation.
			hive.results = [
				...hive.results,
				{
					model: "(pipeline)",
					exitCode: 1,
					durationMs: Date.now() - hive.startTime,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: `pipeline failed: ${message}`,
				},
			];
		} finally {
			hive.endTime = Date.now();
			this.persistState(hive);
			this.emitHiveComplete();
		}
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
			models: hive.models,
			stage: hive.stage,
			doneCount: hive.doneCount,
			totalCount: hive.totalCount,
			durationMs: (hive.endTime ?? Date.now()) - hive.startTime,
		};
	}

	private isFinished(status: HiveStatus): boolean {
		return status === "completed" || status === "error" || status === "timeout" || status === "aborted";
	}

	/** Destructive: collecting a finished hive's results also retires it. */
	readResults(sessionId: string): ModelResult[] | null {
		const hive = this.hives.get(sessionId);
		if (!hive) return null;
		if (!this.isFinished(hive.status)) return null; // still running
		const results = hive.results;
		this.hives.delete(sessionId);
		return results;
	}

	/** The rendered verdict for a finished hive, if the pipeline got far enough. */
	readOutcome(sessionId: string): string | null {
		const hive = this.hives.get(sessionId);
		if (!hive?.outcome) return null;
		return renderOutcome(hive.outcome);
	}

	listHives(): HiveSummary[] {
		return [...this.hives.values()]
			.filter((h) => h.status !== "lost")
			.sort((a, b) => b.startTime - a.startTime)
			.map((h) => ({
				sessionId: h.sessionId,
				status: h.status,
				question: h.question.slice(0, 80),
				stage: h.stage,
				doneCount: h.doneCount,
				totalCount: h.totalCount,
			}));
	}

	abortHive(sessionId: string): boolean {
		const hive = this.hives.get(sessionId);
		if (!hive) return false;
		if (this.isFinished(hive.status) || hive.status === "lost") return false;

		hive.status = "aborted";
		// The pipeline propagates this to every live subprocess; `drive` records
		// whatever had already completed.
		hive.abort.abort();
		this.persistState(hive);
		return true;
	}

	get completedUnnotified(): BackgroundHive[] {
		return [...this.hives.values()].filter((h) => this.isFinished(h.status) && !h.notified);
	}

	// -----------------------------------------------------------------------
	// Watchdog
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
				hive.abort.abort();
				hive.status = "timeout";
				this.persistState(hive);
			}
		}
	}

	private checkTTL() {
		const now = Date.now();
		for (const [id, hive] of this.hives) {
			if (!this.isFinished(hive.status)) continue;
			// Measured from completion, not from launch — a long run would otherwise
			// expire the instant it finished.
			if (now - (hive.endTime ?? hive.startTime) > TTL_MS) {
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
			const successCount = hive.results.filter((r) => r.exitCode === 0).length;
			const icon = hive.status === "timeout" ? "⏱" : hive.status === "completed" ? "🐝" : "⚠";

			const verdict = hive.outcome
				? renderOutcome(hive.outcome)
				: hive.results
						.map((r) => {
							const status = r.exitCode === 0 ? "✓" : "✗";
							const preview = getFinalOutput(r.messages).slice(0, 150).replace(/\n/g, " ");
							return `### ${r.model} ${status} [${(r.durationMs / 1000).toFixed(1)}s]\n${preview || (r.errorMessage ? `Error: ${r.errorMessage}` : "(no output)")}`;
						})
						.join("\n\n");

			this.pi.sendMessage(
				{
					customType: "hive_complete",
					content: [
						`${icon} Background hive \`${hive.sessionId}\` ${hive.status}: **${successCount}/${hive.results.length}** nodes finished.`,
						"",
						verdict,
						"",
						`Read full per-node output: \`hive_read({ sessionId: "${hive.sessionId}" })\``,
					].join("\n"),
					display: false,
					details: {
						sessionId: hive.sessionId,
						status: hive.status,
						question: hive.question.slice(0, 100),
						successCount,
						totalCount: hive.results.length,
						results: hive.results.map((r) => ({
							model: r.model,
							stage: r.stage,
							exitCode: r.exitCode,
							durationMs: r.durationMs,
							text: getFinalOutput(r.messages),
							errorMessage: r.errorMessage,
						})),
					},
				},
				{ triggerTurn: false },
			);
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
				models: hive.models,
				doneCount: hive.doneCount,
				totalCount: hive.totalCount,
				startTime: hive.startTime,
			};
			this.pi.appendEntry("hive:state", state);

			if (this.isFinished(hive.status)) {
				this.pi.appendEntry("hive:result", {
					sessionId: hive.sessionId,
					verdict: hive.outcome ? renderOutcome(hive.outcome) : undefined,
					results: hive.results.map((r) => ({
						model: r.model,
						stage: r.stage,
						exitCode: r.exitCode,
						durationMs: r.durationMs,
						text: getFinalOutput(r.messages),
						errorMessage: r.errorMessage,
						usage: r.usage,
					})),
				});
			}
		} catch { /* best-effort */ }
	}

	restoreState(data: HiveSessionState) {
		if (!data?.sessionId) return;
		const existing = this.hives.get(data.sessionId);
		if (existing && existing.status !== "lost") return; // already restored

		// A hive recorded as running cannot be running now: its subprocesses died
		// with the previous process. It is marked lost rather than resumed.
		this.hives.set(data.sessionId, {
			sessionId: data.sessionId,
			status: data.status === "running" || data.status === "launched" ? "lost" : data.status,
			question: data.question,
			models: data.models,
			// Restored hives carry no node results: only the rendered text was
			// persisted, and fabricating ModelResult shells here would hand
			// getFinalOutput a message list that does not exist.
			results: [],
			abort: new AbortController(),
			startTime: data.startTime,
			endTime: Date.now(),
			budgetMs: HIVE_BUDGET_MS_DEFAULT,
			notified: true, // already reported in the session it completed in
			doneCount: data.doneCount,
			totalCount: data.totalCount,
		});
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
		for (const hive of this.hives.values()) hive.abort.abort();
		this.hives.clear();
	}

	setProgressHandler(handler: OnProgress | null) {
		this.onProgress = handler;
	}

	/** True once session_shutdown has run; callers should stop launching. */
	get isShuttingDown(): boolean {
		return this.shutdown;
	}
}

// Exported via globalThis so every extension file shares one instance — pi loads
// each extension as a separate module.
const GLOBAL_KEY = Symbol.for("pi.hive.backgroundManager");
const _g = globalThis as any;
export const backgroundManager: BackgroundProcessManager =
	_g[GLOBAL_KEY] || (_g[GLOBAL_KEY] = BackgroundProcessManager.getInstance());
export { BackgroundProcessManager };
