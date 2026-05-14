/**
 * Hive Think — Deep multi-model parallel reasoning for complex decisions
 *
 * Spawns multiple `pi` processes with different models (4× deepseek-v4-pro +
 * 4× deepseek-v4-flash), all with --thinking xhigh and read+bash tools.
 * Each model thinks independently. The main agent compares all perspectives
 * and makes the final decision.
 *
 * Install: pi install git:github.com/.../hive-think
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Concurrency = number of models (all run in parallel)

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

// Max concurrent pi subprocesses — avoids rate-limiting when all models hit same DeepSeek API key
const MAX_CONCURRENCY = 4;

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
	results: ModelResult[];
}

// ---------------------------------------------------------------------------
// Model runner
// ---------------------------------------------------------------------------

async function runModel(
	model: string,
	question: string,
	context: string,
	history: string,
	defaultCwd: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
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
		const tmp = await writePromptToTempFile(HIVE_SYSTEM_PROMPT);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		// Build the task: history first, then context, then the question
		const taskParts: string[] = [];
		if (history && history.trim()) {
			taskParts.push("## Full Conversation History", history.trim());
		}
		if (context && context.trim()) {
			taskParts.push("## Additional Context", context.trim());
		}
		taskParts.push("## Question", question);
		args.push(taskParts.join("\n\n"));

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
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

						// Early resolve: if answer delimiter found in any text part
						for (const part of msg.content) {
							if (part.type === "text" && (part as any).text?.includes(ANSWER_END)) {
								resolved = true;
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
				if (!resolved) resolve(code ?? 0);
			});

			proc.on("error", () => { if (!resolved) resolve(1); });

			if (signal) {
				const killProc = () => {
					wasAborted = true;
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

		// Fallback: if process failed and no parsed error, surface stderr
		if (!result.errorMessage && result.stderr.trim()) {
			const firstLine = result.stderr.trim().split("\n")[0].slice(0, 120);
			result.errorMessage = `stderr: ${firstLine}`;
		}

		if (wasAborted) throw new Error("Hive think was aborted");
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch { /* ignore */ }
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch { /* ignore */ }
	}
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
				"Model names to use. Default: 4×deepseek-v4-pro + 4×deepseek-v4-flash (all with --thinking xhigh, tools: read,grep,find,ls,bash)",
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
			"Deep multi-model parallel thinking for complex decisions.",
			"Spawns independent pi processes with different models, all receiving the same full context.",
			"All models run with --thinking xhigh and have read+bash tools for active investigation.",
			"Use for architecture decisions, complex refactoring, technology choices, or multi-faceted problems.",
		].join(" "),
		parameters: HiveThinkParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const models: string[] = params.models && params.models.length > 0 ? params.models : DEFAULT_MODELS;
			const question: string = params.question;
			const context: string = params.context ?? "";

			// Serialize full conversation history for hive subprocesses
			let history = (ctx.messages ?? [])
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

			// Cap at ~128k tokens (rough: 1 token ≈ 4 chars → 512k chars)
			const MAX_HISTORY_CHARS = 512_000;
			if (history.length > MAX_HISTORY_CHARS) {
				history = "... [earlier messages truncated]\n\n" + history.slice(history.length - MAX_HISTORY_CHARS);
			}

			// Track all results for streaming updates
			const allResults: ModelResult[] = new Array(models.length);
			for (let i = 0; i < models.length; i++) {
				allResults[i] = {
					model: models[i],
					exitCode: -1,
					durationMs: 0,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};
			}

			const emitUpdate = () => {
				if (onUpdate) {
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [
							{
								type: "text",
								text: `🐝 Hive thinking... ${done}/${models.length} done, ${running} running`,
							},
						],
						details: {
							question,
							models,
							results: [...allResults],
						},
					});
				}
			};

			emitUpdate();

			const results = await mapWithConcurrencyLimit(models, MAX_CONCURRENCY, async (model, index) => {
				const result = await runModel(model, question, context, history, ctx.cwd, params.cwd, signal);
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

			const details: HiveThinkDetails = { question, models, results };

			return {
				content: [
					{
						type: "text",
						text: `🐝 Hive Think — ${successCount}/${results.length} models completed in ${(totalDurationMs / 1000).toFixed(1)}s total\n\n${summaries.join("\n\n")}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const models: string[] = (args.models as string[]) ?? DEFAULT_MODELS;
			const question = (args.question as string) || "...";
			const preview = question.length > 80 ? `${question.slice(0, 80)}...` : question;

			const modelSummary =
				models.length <= 4
					? models.join(", ")
					: `${models.slice(0, 3).join(", ")} +${models.length - 3} more`;

			let text =
				theme.fg("toolTitle", theme.bold("hive_think ")) +
				theme.fg("accent", `🐝 ${models.length} models`) +
				theme.fg("muted", ` [xhigh · read,bash]`) +
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
						`${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", status)}`,
						0,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg("muted", "Models: ") + theme.fg("dim", details.models.join(", ")),
						0,
						0,
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
					const sessionTag = r.sessionId ? ` ${theme.fg("dim", `session:${r.sessionId.slice(0, 8)}...`)}` : "";
					container.addChild(
						new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.model)} ${rIcon}${durationTag}${sessionTag}${usageStr ? theme.fg("dim", `  ${usageStr}`) : ""}`,
							0,
							0,
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
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
				const output = getFinalOutput(r.messages);
				const lines = output
					.split("\n")
					.filter((l) => l.trim())
					.slice(0, 3)
					.map((l) => l.replace(/^#+\s*/, ""))
					.join(" ");
				const preview = lines.slice(0, 120) + (lines.length > 120 ? "..." : "");

				text += `\n  ${rIcon} ${theme.fg("accent", r.model)}`;
				if (r.durationMs > 0) {
					text += ` ${theme.fg("dim", `[${(r.durationMs / 1000).toFixed(1)}s]`)}`;
				}
				if (r.exitCode === -1) {
					text += ` ${theme.fg("dim", "(running...)")}`;
				} else if (preview.trim()) {
					text += ` ${theme.fg("dim", preview.trim())}`;
				} else if (r.errorMessage) {
					text += ` ${theme.fg("error", r.errorMessage)}`;
				} else {
					text += ` ${theme.fg("muted", "(no output)")}`;
				}
			}

			if (!isRunning) {
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

			return new Text(text, 0, 0);
		},
	});
}
