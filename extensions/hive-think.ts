/**
 * Hive Think — Deep multi-model parallel reasoning for complex decisions
 *
 * Spawns multiple `pi` processes with different models (4× deepseek-v4-pro +
 * 4× deepseek-v4-flash), all with --thinking xhigh and read+bash tools.
 * Each model thinks independently. The main agent compares all perspectives
 * and makes the final decision.
 *
 * Modes (biologically inspired):
 *   parallel         — simple parallel (original)
 *   global_workspace — GWT: competition + broadcast
 *   cortical_column  — hierarchical abstraction layers
 *   waggle_dance     — scout → recruit → converge
 *   integrate_fire   — evidence accumulation with adaptive depth
 *   dmn_tpn          — free association ↔ focused analysis
 *
 * Install: pi install git:github.com/.../hive-think
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hive composition: 4 strong + 4 fast scouts = 8 models, all --thinking xhigh
export const DEFAULT_MODELS = [
	"deepseek-v4-pro",
	"deepseek-v4-pro",
	"deepseek-v4-pro",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"deepseek-v4-flash",
	"deepseek-v4-flash",
	"deepseek-v4-flash",
];

const HIVE_TOOLS = "read,grep,find,ls,bash";
export const ANSWER_END = "</ANSWER>";

// Max concurrent pi subprocesses
const MAX_CONCURRENCY = 4;

// Per-node hard timeout: a deepseek subprocess that never emits </ANSWER> and
// never exits is killed after this many ms (SIGTERM → 5s grace → SIGKILL), so one
// stuck node can't hang the whole hive. 0 disables. Env: HIVE_NODE_TIMEOUT_MS.
//
// Overall budget: if the whole hive_think call exceeds this, still-running nodes are
// aborted and whatever completed is returned as a partial result, so a stuck hive
// never hangs to the outer (CI job) timeout with zero output. 0 disables.
// Env: HIVE_BUDGET_MS.
//
// Invariant for callers: NODE_TIMEOUT_MS < HIVE_BUDGET_MS < outer job timeout, so a
// single stuck node is killed first, the budget catches pathological/serial stacking,
// and the job timeout never has to fire.
export function resolvePositiveMs(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback; // n === 0 disables
}

export const NODE_TIMEOUT_MS = resolvePositiveMs(process.env.HIVE_NODE_TIMEOUT_MS, 30 * 60_000); // 30 min
export const HIVE_BUDGET_MS = resolvePositiveMs(process.env.HIVE_BUDGET_MS, 45 * 60_000); // 45 min

// Merge AbortSignals into one that fires when any input fires (e.g. external job
// cancel + the hive budget). Avoids depending on AbortSignal.any across runtimes.
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	for (const s of signals) {
		if (!s) continue;
		if (s.aborted) {
			controller.abort();
			break;
		}
		s.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

// ---------------------------------------------------------------------------
// Mode metadata
// ---------------------------------------------------------------------------

const MODE_META: Record<string, { emoji: string; label: string; description: string }> = {
	parallel: { emoji: "🐝", label: "Hive Think", description: "Simple parallel — all models think independently (original mode, 8 calls)" },
	global_workspace: { emoji: "🧠", label: "Global Workspace", description: "2-round competition+broadcast, iterative convergence (11 calls)" },
	cortical_column: { emoji: "🧱", label: "Cortical Column", description: "Hierarchical layers with bidirectional feedback (7 calls)" },
	waggle_dance: { emoji: "💃", label: "Waggle Dance", description: "Scout diverse directions, converge on best (8 calls)" },
	integrate_fire: { emoji: "⚡", label: "Integrate-Fire", description: "All specialists think twice, second pass builds on first (13 calls)" },
	dmn_tpn: { emoji: "🌊", label: "DMN/TPN", description: "Free association ↔ focused analysis cycles (11 calls)" },
};

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const HIVE_SYSTEM_PROMPT = `You are in HIVE THINK mode — a deep, multi-perspective analytical mode for complex software decisions.

You have access to read-only tools (read, grep, find, ls) and bash for verification/testing.
⚠️  DO NOT modify any code. No write, no edit. Read and test only.

## Core Principles

1. **First Principles**: Strip assumptions. Reason from fundamentals. What is the *actual* problem, not just the presented one?
2. **Active Investigation**: If context seems incomplete, use read/grep/find/ls to look up the actual code. Use bash to run tests and verify your assumptions. Don't guess — check.
3. **Multi-Perspective**: Examine the problem from at least these angles:
   - User / Developer experience
   - System architecture & maintainability
   - Performance & scalability
   - Security & correctness
4. **Trade-off Analysis**: Every choice has costs — surface them explicitly. Use a decision matrix when comparing options.
5. **Actionable Output**: End with a clear, implementable recommendation. No hedging — commit to a position.

## Thinking Process

1. Restate the problem in your own words (prove you understood it)
2. Identify constraints and requirements (explicit AND implicit)
3. **Investigate**: read relevant files, grep for related code, run tests to verify assumptions
4. Generate at least 3 distinct approaches — stretch for creative alternatives
5. Evaluate each on: simplicity, performance, maintainability, risk, extensibility
6. Choose the best approach with explicit reasoning
7. Identify what could go wrong and how to mitigate

## Output Format

### Problem Restatement
[1-2 sentences — restate to confirm understanding]

### Investigation
[Key findings from reading code / running tests, if any]

### Constraints & Requirements
- Explicit: ...
- Implicit: ...

### Approaches

#### Approach A: [Name]
- **How it works**: ...
- **Strengths**: ...
- **Weaknesses**: ...
- **Best when**: ...
- **Worst when**: ...

#### Approach B: [Name]
...

#### Approach C: [Name]
...

### Decision Matrix
| Criterion (weight) | A | B | C |
|---|---|---|---|
| Simplicity | ★/5 | ★/5 | ★/5 |
| Performance | ★/5 | ★/5 | ★/5 |
| Maintainability | ★/5 | ★/5 | ★/5 |
| Risk (inverse) | ★/5 | ★/5 | ★/5 |
| Extensibility | ★/5 | ★/5 | ★/5 |
| **Total** | ★★/25 | ★★/25 | ★★/25 |

### Recommendation
[Clear, actionable recommendation with explicit rationale. Why this over the others?]

### Risks & Mitigations
- **Risk 1**: ... → Mitigation: ...
- **Risk 2**: ... → Mitigation: ...

---

## Completion Signal

When you have reached your final recommendation, wrap the entire final output section (from "### Problem Restatement" through "### Risks & Mitigations") in <ANSWER>...</ANSWER> tags. Do NOT use this tag for intermediate thinking or tool-call results. Only for your final answer.

Think deeply. Challenge your own assumptions. Question whether the presented problem is the real problem. Quality over speed.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelResult {
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

interface HiveThinkDetails {
	question: string;
	models: string[];
	mode?: string;
	results: ModelResult[];
}

// ---------------------------------------------------------------------------
// Model runner (core)
// ---------------------------------------------------------------------------

async function runModel(
	model: string,
	question: string,
	context: string,
	history: string,
	defaultCwd: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	customSystemPrompt?: string,
): Promise<ModelResult> {
	const args: string[] = [
		"--mode", "json",
		"-p",
		"--no-session",
		"--model", model,
		"--thinking", "xhigh",
		"--tools", HIVE_TOOLS,
	];

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const startTime = Date.now();

	const result: ModelResult = {
		model,
		exitCode: 0,
		durationMs: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};

	try {
		const promptContent = customSystemPrompt ?? HIVE_SYSTEM_PROMPT;
		const tmp = await writePromptToTempFile(promptContent);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		const taskParts: string[] = [];
		if (history && history.trim()) {
			taskParts.push("## Full Conversation History", history.trim());
		}
		if (context && context.trim()) {
			taskParts.push("## Additional Context", context.trim());
		}
		taskParts.push("## Question", question);
		const taskContent = taskParts.join("\n\n");

		let wasAborted = false;
		let nodeTimedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Per-node hard timeout: kill a subprocess that never produces </ANSWER>
			// and never exits, so one stuck node can't hang the whole hive.
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
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				}, NODE_TIMEOUT_MS);
			}

			// Write task content via stdin to avoid E2BIG (MAX_ARG_STRLEN=128KB)
			proc.stdin.on("error", (_err) => { /* EPIPE if proc exits early, ignore */ });
			proc.stdin.write(taskContent);
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

						for (const part of msg.content) {
							if (part.type === "text" && (part as any).text?.includes(ANSWER_END)) {
								resolved = true;
								clearNodeTimer();
								proc.kill("SIGTERM");
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

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					clearNodeTimer();
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		result.durationMs = Date.now() - startTime;

		// A timed-out or aborted node is reported as a failed result (non-zero exit),
		// NOT thrown: the hive keeps the perspectives that finished, and an external
		// or budget abort degrades to a partial result instead of erroring out.
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
		if (tmpPromptPath)
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir)
			try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

async function runModelWithTask(
	model: string,
	task: string,
	specificQuestion: string,
	question: string,
	context: string,
	history: string,
	defaultCwd: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	priorFindings?: string,
): Promise<ModelResult> {
	const priorBlock = priorFindings
		? `\n## Prior Findings (from other analysts)\n${priorFindings}\n\nBuild upon or challenge these findings.`
		: "";
	const prompt = `${HIVE_SYSTEM_PROMPT}\n\n## Your Task: ${task}\n**What you must answer**: ${specificQuestion}${priorBlock}\n\nFocus on your question. Be specific and evidence-based.`;
	return runModel(model, question, context, history, defaultCwd, cwd, signal, prompt);
}

function buildResult(
	mode: string,
	question: string,
	models: string[],
	allResults: ModelResult[],
	finalText: string,
): { details: HiveThinkDetails; output: string } {
	const meta = MODE_META[mode];
	const emoji = meta?.emoji || "🐝";
	const label = meta?.label || mode;
	const successCount = allResults.filter((r) => r.exitCode === 0).length;
	const totalDurationMs = allResults.reduce((s, r) => s + r.durationMs, 0);
	return {
		details: { question, models, mode, results: allResults },
		output: `${emoji} ${label} — ${successCount}/${allResults.length} calls in ${(totalDurationMs / 1000).toFixed(1)}s\n\n${finalText}`,
	};
}

// Build a degraded result from whatever nodes completed before the overall budget
// fired. Used when hive_think is aborted by HIVE_BUDGET_MS so the caller still gets
// usable perspectives (or a clear "proceed on your own" signal) instead of an error.
export function buildPartialOutput(
	mode: string,
	question: string,
	models: string[],
	lastDetails: HiveThinkDetails | undefined,
	budgetMs: number,
): { details: HiveThinkDetails; output: string } {
	const meta = MODE_META[mode];
	const emoji = meta?.emoji || "\u{1F41D}";
	const label = meta?.label || mode;
	const collected = (lastDetails?.results ?? []).filter((r) => r.exitCode !== -1);
	const completed = collected.filter((r) => r.exitCode === 0);
	const minutes = Math.round(budgetMs / 60000);
	const header = `${emoji} ${label} \u2014 \u23F1 hive budget (${minutes}min) reached; aborted remaining nodes. ${completed.length}/${models.length} nodes completed (partial result).`;
	const summaries = completed.map((r) => {
		const out = getFinalOutput(r.messages);
		const preview = out.slice(0, 200) + (out.length > 200 ? "..." : "");
		return `### ${r.model} \u2713\n${preview || "(no output)"}`;
	});
	const body =
		summaries.length > 0
			? summaries.join("\n\n")
			: "(No node finished before the budget. Treat hive_think as unavailable and proceed with your own analysis \u2014 do not retry blindly.)";
	return {
		details: { question, models, mode, results: collected },
		output: `${header}\n\n${body}`,
	};
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
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

function buildHistory(ctxMessages: Message[]): string {
	let history = (ctxMessages ?? [])
		.map((m: Message) => {
			const roleTag = m.role === "user" ? "[User]" : m.role === "assistant" ? "[Assistant]" : `[${m.role}]`;
			const textParts = (m.content ?? [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("\n");
			if (!textParts) return null;
			return `${roleTag}: ${textParts}`;
		})
		.filter(Boolean)
		.join("\n\n");

	const MAX_HISTORY_CHARS = 512_000;
	if (history.length > MAX_HISTORY_CHARS) {
		history = "... [earlier messages truncated]\n\n" + history.slice(history.length - MAX_HISTORY_CHARS);
	}
	return history;
}

// ===========================================================================
// MODE: parallel (original simple parallel)
// ===========================================================================

async function executeParallel(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const allResults: ModelResult[] = new Array(models.length);
	for (let i = 0; i < models.length; i++) {
		allResults[i] = {
			model: models[i], exitCode: -1, durationMs: 0, messages: [], stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const emitUpdate = () => {
		if (onUpdate) {
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			onUpdate({
				content: [{ type: "text", text: `🐝 Hive thinking... ${done}/${models.length} done, ${running} running` }],
				details: { question, models, results: [...allResults] },
			});
		}
	};

	emitUpdate();

	const results = await mapWithConcurrencyLimit(models, MAX_CONCURRENCY, async (model, index) => {
		const result = await runModel(model, question, context, history, cwd, paramsCwd, signal);
		allResults[index] = result;
		emitUpdate();
		return result;
	});

	const successCount = results.filter((r) => r.exitCode === 0).length;
	const totalDurationMs = results.reduce((s, r) => s + r.durationMs, 0);
	const summaries = results.map((r) => {
		const output = getFinalOutput(r.messages);
		const duration = r.durationMs > 0 ? ` [${(r.durationMs / 1000).toFixed(1)}s]` : "";
		const preview = output.slice(0, 120) + (output.length > 120 ? "..." : "");
		return `### ${r.model} ${r.exitCode === 0 ? "✓" : "✗"}${duration}\n${preview || "(no output)"}`;
	});

	return {
		details: { question, models, mode: "parallel", results },
		output: `🐝 Hive Think — ${successCount}/${results.length} models completed in ${(totalDurationMs / 1000).toFixed(1)}s total\n\n${summaries.join("\n\n")}`,
	};
}

// ===========================================================================
// MODE: global_workspace (GWT) — 2-round competition + broadcast
// ===========================================================================

async function executeGlobalWorkspace(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const NUM_ROUNDS = 2;
	const allResults: ModelResult[] = [];

	// Define specialists with concrete tasks (not role labels)
	const specialists: { model: string; task: string; question: string }[] = [
		{ model: models[0] || "deepseek-v4-pro", task: "System Architecture", question: "What architectural patterns, module boundaries, and design decisions are optimal? Consider coupling, cohesion, and future evolution." },
		{ model: models[1] || "deepseek-v4-pro", task: "Performance & Scalability", question: "What are the performance implications, bottlenecks, and scaling limits? What throughput/latency trade-offs exist?" },
		{ model: models[2] || "deepseek-v4-pro", task: "Security & Correctness", question: "What are the attack surfaces, data integrity risks, failure modes, and correctness guarantees?" },
		{ model: models[3] || "deepseek-v4-flash", task: "Developer Experience", question: "How simple is this to understand, test, debug, and onboard new developers? What's the learning curve?" },
		{ model: models[4] || "deepseek-v4-flash", task: "Risk Analysis", question: "What edge cases, migration risks, unknown unknowns, and worst-case scenarios must be considered?" },
	];

	let broadcast = ""; // In-memory workspace — accumulates key insights

	for (let round = 0; round < NUM_ROUNDS; round++) {
		if (onUpdate) onUpdate({
			content: [{ type: "text", text: `🧠 GWT Round ${round + 1}/${NUM_ROUNDS} — specialists analyzing...` }],
			details: { question, models, mode: "global_workspace", results: [...allResults] },
		});

		// Phase 1: specialists produce proposals (parallel)
		const proposals = await mapWithConcurrencyLimit(specialists, MAX_CONCURRENCY, async (spec) => {
			return runModelWithTask(
				spec.model, spec.task, spec.question,
				round === 0 ? question : `[Round ${round + 1}] ${question}`,
				round === 0 ? context : `${context}\n\n## Previous Broadcast (Round 1)\n${broadcast}`,
				history, cwd, paramsCwd, signal,
				round > 0 ? broadcast : undefined,
			);
		});

		for (const r of proposals) allResults.push(r);

		// Phase 2: arbiter (strong model) selects and synthesizes the winner
		const proposalTexts = proposals
			.filter((p) => p.exitCode === 0)
			.map((p, i) => `### ${specialists[i]?.task ?? "analyst"}\n${getFinalOutput(p.messages)}`)
			.join("\n\n---\n\n");

		if (proposalTexts && round === 0) {
			const arbiterResult = await runModel(
				models[0] || "deepseek-v4-pro", // Use strong model for arbiter
				`Synthesize the most important insight from round ${round + 1}`,
				`## Specialist Analyses\n${proposalTexts.slice(0, 15000)}\n\nIdentify the 2-3 most critical, non-obvious insights. Write them as clear, concise bullet points (max 500 words total).`,
				"", cwd, paramsCwd, signal,
			);
			allResults.push(arbiterResult);
			broadcast = getFinalOutput(arbiterResult.messages);
		}
	}

	// Final synthesis
	const allOutputs = allResults
		.filter((r) => r.exitCode === 0)
		.map((r) => getFinalOutput(r.messages))
		.join("\n\n---\n\n");

	const finalResult = await runModel(
		models[0] || "deepseek-v4-pro",
		`Synthesize final recommendation from the global workspace`,
		`## Round 1 Broadcast\n${broadcast.slice(0, 5000)}\n\n## Round 2 Analyses\n${allOutputs.slice(0, 12000)}\n\n## Original Question\n${question}`,
		history, cwd, paramsCwd, signal,
	);
	allResults.push(finalResult);

	return buildResult("global_workspace", question, models, allResults, getFinalOutput(finalResult.messages));
}

// ===========================================================================
// MODE: cortical_column (hierarchical layers)
// ===========================================================================

async function executeCorticalColumn(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const allResults: ModelResult[] = [];
	const m = (i: number) => models[i] || "deepseek-v4-pro";

	type Layer = { name: string; model: string; task: string; question: string };
	const layers: Layer[] = [
		{ name: "concrete", model: m(5), task: "Code-Level Facts", question: "Read source files, check types, list dependencies, run tests. Report FACTS only: dependencies, type signatures, test results, current file structure." },
		{ name: "tactical", model: m(4), task: "Implementation Tactics", question: "Based on the concrete facts above, analyze: API design, data flow, module interfaces, error handling patterns. What are the tactical problems and opportunities?" },
		{ name: "architectural", model: m(1), task: "System Architecture", question: "Based on the tactical analysis, evaluate: module boundaries, coupling/cohesion, design patterns, architectural fitness. Propose architectural options with trade-offs." },
		{ name: "strategic", model: m(0), task: "Strategic Decision", question: "Based on the architectural analysis, decide: long-term maintainability, team scalability, migration paths, business alignment. Give a definitive recommendation with rationale." },
	];

	const layerOutputs: Record<string, string> = {};

	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🧱 Cortical Column — bottom-up feed-forward pass..." }],
		details: { question, models, mode: "cortical_column", results: [] },
	});

	// Phase 1: Feed-forward (bottom-up)
	for (const layer of layers) {
		const lowerContext = Object.entries(layerOutputs)
			.map(([name, out]) => `## ${name} layer findings\n${out}`)
			.join("\n\n");

		const result = await runModelWithTask(
			layer.model, layer.task, layer.question,
			question,
			`${context}\n\n## Lower Layer Findings\n${lowerContext || "(none — this is the first layer)"}`,
			history, cwd, paramsCwd, signal,
			lowerContext || undefined,
		);
		allResults.push(result);
		layerOutputs[layer.name] = getFinalOutput(result.messages);
	}

	// Phase 2: Top-down feedback (only if strategic/architectural produced constraints)
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🧱 Cortical Column — top-down feedback pass..." }],
		details: { question, models, mode: "cortical_column", results: [...allResults] },
	});

	const strategicConstraints = `## Strategic Constraints\n${layerOutputs["strategic"]}\n\n## Architectural Constraints\n${layerOutputs["architectural"]}`;

	for (const layer of layers.filter(l => l.name === "concrete" || l.name === "tactical")) {
		const result = await runModelWithTask(
			layer.model, `${layer.task} (Revised)`, `Revise: ${layer.question}`,
			question,
			`${context}\n\n## Top-Down Constraints\n${strategicConstraints}\n\n## Your Previous ${layer.name} Analysis\n${layerOutputs[layer.name]}`,
			history, cwd, paramsCwd, signal,
			strategicConstraints,
		);
		allResults.push(result);
		layerOutputs[`${layer.name}_revised`] = getFinalOutput(result.messages);
	}

	// Final synthesis
	const allOut = Object.entries(layerOutputs).map(([k, v]) => `## ${k}\n${v}`).join("\n\n");
	const synthesis = await runModel(
		m(0),
		`Synthesize the full cortical column analysis`,
		`## All Layer Outputs\n${allOut}\n\n## Original Question\n${question}`,
		history, cwd, paramsCwd, signal,
	);
	allResults.push(synthesis);

	return buildResult("cortical_column", question, models, allResults, getFinalOutput(synthesis.messages));
}

// ===========================================================================
// MODE: waggle_dance — simplified: scout → converge
// ===========================================================================

async function executeWaggleDance(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const allResults: ModelResult[] = [];
	const m = (i: number) => models[i] || "deepseek-v4-flash";

	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "💃 Waggle Dance — scouting diverse directions..." }],
		details: { question, models, mode: "waggle_dance", results: [] },
	});

	// Round 1: Scout — each model explores a DISTINCT creative direction
	const directions = [
		"Explore the most RADICAL approach — something unconventional that might seem crazy at first.",
		"Explore the SIMPLEST possible approach — what's the minimal viable solution?",
		"Explore the most ROBUST approach — optimize for correctness and reliability above all else.",
		"Explore the most SCALABLE approach — design for 10x growth from day one.",
		"Explore the most DEVELOPER-FRIENDLY approach — optimize for readability, testability, and onboarding.",
		"Explore the most COST-EFFECTIVE approach — minimize infrastructure, maintenance, and operational burden.",
		"Explore a HYBRID approach — combine the best ideas from multiple paradigms.",
		"Explore a FUTURE-PROOF approach — anticipate where the technology/domain is heading in 3 years.",
	];

	const scoutModels = models.slice(0, directions.length);
	const scouts = await mapWithConcurrencyLimit(scoutModels, MAX_CONCURRENCY, async (model, i) => {
		const dir = directions[i] || directions[directions.length - 1];
		return runModelWithTask(
			model, `Scout: ${dir}`, dir,
			question, context, history, cwd, paramsCwd, signal,
		);
	});

	for (const s of scouts) allResults.push(s);

	// Collect all scout findings
	const scoutFindings = scouts
		.filter((r) => r.exitCode === 0)
		.map((r, i) => `### Approach ${i + 1}: ${directions[i]}\n${getFinalOutput(r.messages)}`)
		.join("\n\n---\n\n");

	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "💃 Waggle Dance — converging on best approach..." }],
		details: { question, models, mode: "waggle_dance", results: [...allResults] },
	});

	// Round 2: Converge — one strong model evaluates all approaches and synthesizes
	const converger = await runModel(
		m(0),
		`Evaluate all approaches and synthesize the best recommendation`,
		`## All Scout Approaches\n${scoutFindings.slice(0, 20000)}\n\n## Original Question\n${question}\n\nYour task:\n1. Rank the approaches by overall merit\n2. Identify the strongest ideas from each\n3. Synthesize a final recommendation that combines the best elements\n4. Explain why the chosen combination is superior to any single approach`,
		history, cwd, paramsCwd, signal,
	);
	allResults.push(converger);

	return buildResult("waggle_dance", question, models, allResults, getFinalOutput(converger.messages));
}

// ===========================================================================
// MODE: integrate_fire — all specialists think twice, second pass builds on first
// ===========================================================================

async function executeIntegrateFire(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const allResults: ModelResult[] = [];
	const NUM_ROUNDS = 2;

	// Define specialists with concrete questions
	const specialists: { model: string; task: string; question: string }[] = [
		{ model: models[0] || "deepseek-v4-pro", task: "Architecture", question: "What is the optimal system design? Consider patterns, modularity, coupling, and evolution." },
		{ model: models[1] || "deepseek-v4-pro", task: "Performance", question: "What are the performance characteristics, bottlenecks, and scaling considerations?" },
		{ model: models[2] || "deepseek-v4-pro", task: "Security", question: "What are the security implications, attack surfaces, and correctness guarantees?" },
		{ model: models[3] || "deepseek-v4-flash", task: "Developer Experience", question: "How easy is this to build, test, debug, and onboard? What's the DX trade-off?" },
		{ model: models[4] || "deepseek-v4-flash", task: "Risk", question: "What are the edge cases, failure modes, and worst-case scenarios?" },
		{ model: models[5] || "deepseek-v4-flash", task: "Cost & Maintenance", question: "What is the implementation cost, operational burden, and long-term maintenance profile?" },
	];

	// Round 1: First pass — all specialists produce initial analysis
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: `⚡ Integrate-Fire Round 1/${NUM_ROUNDS} — first pass...` }],
		details: { question, models, mode: "integrate_fire", results: [] },
	});

	const firstPass = await mapWithConcurrencyLimit(specialists, MAX_CONCURRENCY, async (spec) => {
		return runModelWithTask(spec.model, spec.task, spec.question, question, context, history, cwd, paramsCwd, signal);
	});

	for (const r of firstPass) allResults.push(r);

	// Collect first-pass findings for cross-pollination
	const firstPassFindings = firstPass
		.filter((r) => r.exitCode === 0)
		.map((r, i) => `### ${specialists[i]?.task ?? "analyst"}\n${getFinalOutput(r.messages)}`)
		.join("\n\n---\n\n");

	// Round 2: Second pass — each specialist refines based on all round-1 findings
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: `⚡ Integrate-Fire Round 2/${NUM_ROUNDS} — refining...` }],
		details: { question, models, mode: "integrate_fire", results: [...allResults] },
	});

	const secondPass = await mapWithConcurrencyLimit(specialists, MAX_CONCURRENCY, async (spec, i) => {
		return runModelWithTask(
			spec.model,
			`${spec.task} (Refined)`,
			`Refine your analysis. Given what OTHER specialists found:\n\n${firstPassFindings.slice(0, 12000)}\n\nYour refined question: ${spec.question}`,
			question,
			context,
			history, cwd, paramsCwd, signal,
			firstPassFindings.slice(0, 8000),
		);
	});

	for (const r of secondPass) allResults.push(r);

	// Final synthesis from all second-pass results
	const allRefined = secondPass
		.filter((r) => r.exitCode === 0)
		.map((r, i) => `### ${specialists[i]?.task ?? "analyst"} (refined)\n${getFinalOutput(r.messages)}`)
		.join("\n\n---\n\n");

	const synthesis = await runModel(
		models[0] || "deepseek-v4-pro",
		`Synthesize the final recommendation`,
		`## All Refined Analyses\n${allRefined.slice(0, 15000)}\n\n## Original Question\n${question}\n\nSynthesize a definitive recommendation. Address points of consensus and disagreement among the specialists.`,
		history, cwd, paramsCwd, signal,
	);
	allResults.push(synthesis);

	return buildResult("integrate_fire", question, models, allResults, getFinalOutput(synthesis.messages));
}

// ===========================================================================
// MODE: dmn_tpn (Default Mode / Task Positive Network alternation)
// ===========================================================================

async function executeDMNTPN(
	models: string[],
	question: string,
	context: string,
	history: string,
	cwd: string,
	paramsCwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
): Promise<{ details: HiveThinkDetails; output: string }> {
	const allResults: ModelResult[] = [];
	const m = (i: number) => models[i] || (i % 2 === 0 ? "deepseek-v4-pro" : "deepseek-v4-flash");

	// Phase 1: DMN — Free Association (3 models)
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🌊 DMN Phase 1 — free association..." }],
		details: { question, models, mode: "dmn_tpn", results: [] },
	});

	const dmn1Prompt = `DEFAULT MODE NETWORK PHASE: Free Association

You are in a creative, unrestricted brainstorming mode. Rules:
- NO judgment, NO filtering, NO evaluation
- Generate as many ideas, associations, and hunches as possible
- Wild ideas are welcome — don't self-censor
- Write in stream-of-consciousness style
- Quantity over quality at this stage
- Tag interesting ideas with [INTERESTING]

Wrap your free association in <ANSWER>...</ANSWER>.`;

	const dmn1Models = [m(4), m(5), m(6)];

	const dmn1Results = await mapWithConcurrencyLimit(dmn1Models, MAX_CONCURRENCY, async (model) => {
		return runModelWithTask(model, "Free Association", "Generate as many unconventional ideas as possible", question,
			`${context}\n\n${dmn1Prompt}`, history, cwd, paramsCwd, signal);
	});
	for (const r of dmn1Results) allResults.push(r);

	// Phase 2: TPN — Focused evaluation (5 models)
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🌊 TPN Phase 2 — focused evaluation..." }],
		details: { question, models, mode: "dmn_tpn", results: [...allResults] },
	});

	const dmnOutput = dmn1Results
		.filter((r) => r.exitCode === 0)
		.map((r) => getFinalOutput(r.messages))
		.join("\n\n---\n\n");

	const tpnPrompt = `TASK POSITIVE NETWORK PHASE: Focused Evaluation

You are in rigorous analytical mode. Review the free association output below and:
1. Identify the 3-5 most promising ideas
2. Evaluate each against constraints
3. Cross-reference ideas — which complement each other?
4. Rank by feasibility and impact
5. Identify any critical gaps

Be precise, critical, and evidence-based. No brainstorming — pure analysis.

## Free Association Output
${dmnOutput.slice(0, 10000)}`;

	const tpnModels = [m(0), m(1), m(2), m(3), m(7) || m(5)];

	const tpnResults = await mapWithConcurrencyLimit(tpnModels, MAX_CONCURRENCY, async (model) => {
		return runModelWithTask(model, "Focused Evaluation", "Rigorously evaluate the free association ideas: identify top 3-5, rank by feasibility/impact, cross-reference", question,
			`${context}\n\n${tpnPrompt}`, history, cwd, paramsCwd, signal,
			dmnOutput.slice(0, 5000));
	});
	for (const r of tpnResults) allResults.push(r);

	// Phase 3: DMN again — Divergent refinement
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🌊 DMN Phase 3 — divergent refinement..." }],
		details: { question, models, mode: "dmn_tpn", results: [...allResults] },
	});

	const tpnOutput = tpnResults
		.filter((r) => r.exitCode === 0)
		.map((r) => getFinalOutput(r.messages))
		.join("\n\n---\n\n");

	const dmn2Prompt = `DEFAULT MODE NETWORK PHASE: Divergent Refinement

Based on the rigorous evaluation below, freely associate again:
- What was missed? What assumptions were challenged?
- Are there synthesis ideas that combine multiple evaluated approaches?
- Any "obvious but overlooked" solutions?

## Evaluation Results
${tpnOutput.slice(0, 8000)}`;

	const dmn2Models = [m(5), m(6)];

	const dmn2Results = await mapWithConcurrencyLimit(dmn2Models, MAX_CONCURRENCY, async (model) => {
		return runModelWithTask(model, "Divergent Refinement", "After seeing the rigorous evaluation, what was missed? What synthesis ideas emerge? Any overlooked solutions?", question,
			`${context}\n\n${dmn2Prompt}`, history, cwd, paramsCwd, signal,
			tpnOutput.slice(0, 5000));
	});
	for (const r of dmn2Results) allResults.push(r);

	// Phase 4: TPN — Final synthesis
	if (onUpdate) onUpdate({
		content: [{ type: "text", text: "🌊 TPN Phase 4 — final synthesis..." }],
		details: { question, models, mode: "dmn_tpn", results: [...allResults] },
	});

	const dmn2Output = dmn2Results
		.filter((r) => r.exitCode === 0)
		.map((r) => getFinalOutput(r.messages))
		.join("\n\n---\n\n");

	const finalResult = await runModel(
		m(0),
		`Synthesize the full DMN → TPN → DMN → TPN analysis`,
		`## Phase 1: Free Association\n${dmnOutput.slice(0, 5000)}\n\n## Phase 2: Evaluation\n${tpnOutput.slice(0, 5000)}\n\n## Phase 3: Divergent Refinement\n${dmn2Output.slice(0, 5000)}\n\n## Original Question\n${question}\n\nProduce the definitive recommendation. Reference specific ideas from the DMN phases that were validated by TPN analysis.`,
		history, cwd, paramsCwd, signal,
	);
	allResults.push(finalResult);

	return buildResult("dmn_tpn", question, models, allResults, getFinalOutput(finalResult.messages));
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const HiveThinkParams = Type.Object({
	question: Type.String({ description: "The question or problem to think deeply about" }),
	context: Type.Optional(
		Type.String({
			description:
				"Additional context: conversation summary, relevant code, constraints, etc. Include as much relevant detail as possible for deep analysis.",
		}),
	),
	models: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Model names to use. CRITICAL: If the user specifies models (e.g. 'use Opus' or '--model claude-opus-4-6-thinking'), you MUST pass them here. Default: 4×deepseek-v4-pro + 4×deepseek-v4-flash (all with --thinking xhigh, tools: read,grep,find,ls,bash). When in doubt, use the user's preferred models.",
		}),
	),
	mode: Type.Optional(
		Type.String({
			default: "parallel",
			description:
				"Thinking paradigm. Pick based on problem type: 'parallel' for quick multi-perspective (default), 'cortical_column' for layered analysis (architecture, deep design), 'global_workspace' for consensus-building on contentious decisions, 'waggle_dance' for creative brainstorming, 'integrate_fire' for risk/quality assessment, 'dmn_tpn' for free-form exploration. Available: parallel, global_workspace, cortical_column, waggle_dance, integrate_fire, dmn_tpn.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subprocesses" })),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_think",
		label: "Hive Think",
		description: [
			"MUST USE for any non-trivial decision, architecture question, refactoring plan, or multi-faceted problem.",
			"DO NOT answer complex questions yourself — delegate to hive_think to get multiple independent perspectives.",
			"Strong triggers (proactive — do not ask user first): architecture decisions, complex refactoring strategy, technology/library choices,",
			"multi-faceted problems where you're unsure of the best path, user asks to 'think deeply' or 'analyze from multiple angles'.",
			"Weak triggers (consider using): non-trivial design decisions with trade-offs, conflicting requirements, you've been debating an approach.",
			"Do NOT use for: simple factual questions, single obvious one-line changes, tasks where speed matters more than thoroughness.",
			"Models: ALWAYS use user-specified models if they mention any (e.g. 'use Opus', '--model X'). Otherwise default to 4×pro + 4×flash.",
			"After hive_think completes, use hive_read (extract_answer=false) to get full output before acting on the decision.",
		].join(" "),
		parameters: HiveThinkParams,
		promptSnippet: "Multi-model parallel reasoning for complex decisions — spawns multiple models (4×pro + 4×flash by default) with --thinking xhigh",
		promptGuidelines: [
			"Use hive_think for any architecture decision, complex refactoring, technology choice, or multi-faceted problem. Do NOT answer complex questions yourself — delegate to hive_think.",
			"Use hive_think proactively without asking the user for: architecture decisions, complex refactoring strategy, technology/library choices, or when the user asks to 'think deeply' or 'analyze from multiple angles'.",
			"When the user specifies models (e.g. 'use Opus' or '--model X'), pass them to hive_think's models parameter. Do not ignore user model preferences.",
			"Pick the hive_think mode based on problem type: 'cortical_column' for layered architecture analysis, 'global_workspace' for contentious decisions needing consensus, 'waggle_dance' for creative brainstorming, 'parallel' for quick multi-perspective (default).",
			"After hive_think completes, use hive_read with extract_answer=false to get full model outputs before making the final decision.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const models: string[] = params.models && params.models.length > 0 ? params.models : DEFAULT_MODELS;
			const question: string = params.question;
			const context: string = params.context ?? "";
			const mode: string = (params.mode as string) || "parallel";

			if (!MODE_META[mode]) {
				throw new Error(`Unknown mode "${mode}". Available: ${Object.keys(MODE_META).join(", ")}`);
			}

			const history = buildHistory(ctx.messages ?? []);

			const executors: Record<string, typeof executeParallel> = {
				parallel: executeParallel,
				global_workspace: executeGlobalWorkspace,
				cortical_column: executeCorticalColumn,
				waggle_dance: executeWaggleDance,
				integrate_fire: executeIntegrateFire,
				dmn_tpn: executeDMNTPN,
			};
			const executor = executors[mode];
			if (!executor) throw new Error(`Mode "${mode}" not implemented yet.`);

			// Overall wall-clock budget: if the hive doesn't finish in time, abort the
			// still-running nodes and return whatever completed, so a stuck hive never
			// hangs to the outer (CI job) timeout. Per-node NODE_TIMEOUT_MS independently
			// kills a single stuck subprocess inside runModel().
			let budgetFired = false;
			const budgetController = new AbortController();
			const budgetTimer =
				HIVE_BUDGET_MS > 0
					? setTimeout(() => {
							budgetFired = true;
							budgetController.abort();
						}, HIVE_BUDGET_MS)
					: undefined;
			const effectiveSignal = combineSignals(signal, budgetController.signal);

			try {
				const { details, output } = await executor(
					models, question, context, history, ctx.cwd, params.cwd, effectiveSignal, onUpdate,
				);
				if (budgetFired) {
					const partial = buildPartialOutput(mode, question, models, details, HIVE_BUDGET_MS);
					return { content: [{ type: "text", text: partial.output }], details: partial.details };
				}
				return { content: [{ type: "text", text: output }], details };
			} finally {
				if (budgetTimer) clearTimeout(budgetTimer);
			}
		},

		renderCall(args, theme, _context) {
			const models: string[] = (args.models as string[]) ?? DEFAULT_MODELS;
			const mode: string = (args.mode as string) || "parallel";
			const emoji = MODE_META[mode]?.emoji || "🐝";
			const question = (args.question as string) || "...";
			const preview = question.length > 80 ? `${question.slice(0, 80)}...` : question;

			const modelSummary =
				models.length <= 4
					? models.join(", ")
					: `${models.slice(0, 3).join(", ")} +${models.length - 3} more`;

			let text =
				theme.fg("toolTitle", theme.bold("hive_think ")) +
				theme.fg("accent", `${emoji} ${models.length} models`) +
				theme.fg("muted", ` [${mode} · xhigh · read,bash]`) +
				`\n  ${theme.fg("dim", modelSummary)}`;
			text += `\n  ${theme.fg("dim", preview)}`;

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as HiveThinkDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const mode = details.mode || "parallel";
			const emoji = MODE_META[mode]?.emoji || "🐝";

			const aggregateUsage = (results: ModelResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode === 0).length;
			const failCount = details.results.filter((r) => r.exitCode > 0).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} completed`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", `${emoji} ${mode} — ${status}`)}`,
						0, 0,
					),
				);
				container.addChild(
					new Text(
						theme.fg("muted", "Models: ") + theme.fg("dim", details.models.join(", ")),
						0, 0,
					),
				);
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", "Question: ") + theme.fg("dim", details.question), 0, 0),
				);

				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const output = getFinalOutput(r.messages);
					const usageStr = formatUsageStats(r.usage);

					container.addChild(new Spacer(1));
					const durationTag = r.durationMs > 0 ? ` ${theme.fg("dim", `[${(r.durationMs / 1000).toFixed(1)}s]`)}` : "";
					container.addChild(
						new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.model)} ${rIcon}${durationTag}${usageStr ? theme.fg("dim", `  ${usageStr}`) : ""}`,
							0, 0,
						),
					);

					if (r.errorMessage) {
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					} else if (output) {
						container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					}
				}

				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
				}

				return container;
			}

			// Collapsed view
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", `${emoji} ${mode} — ${status}`)}`;
			for (const r of details.results.slice(0, 5)) {
				const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳")
					: r.exitCode === 0 ? theme.fg("success", "✓")
					: theme.fg("error", "✗");
				const output = getFinalOutput(r.messages);
				const lines = output.split("\n").filter((l) => l.trim()).slice(0, 3)
					.map((l) => l.replace(/^#+\s*/, "")).join(" ");
				const preview = lines.slice(0, 120) + (lines.length > 120 ? "..." : "");

				text += `\n  ${rIcon} ${theme.fg("accent", r.model)}`;
				if (r.durationMs > 0) text += ` ${theme.fg("dim", `[${(r.durationMs / 1000).toFixed(1)}s]`)}`;
				if (r.exitCode === -1) text += ` ${theme.fg("dim", "(running...)")}`;
				else if (preview.trim()) text += ` ${theme.fg("dim", preview.trim())}`;
				else if (r.errorMessage) text += ` ${theme.fg("error", r.errorMessage)}`;
				else text += ` ${theme.fg("muted", "(no output)")}`;
			}
			if (details.results.length > 5) {
				text += `\n  ${theme.fg("muted", `... and ${details.results.length - 5} more results`)}`;
			}

			if (!isRunning) {
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand · use hive_read for full output)")}`;

			return new Text(text, 0, 0);
		},
	});
}
