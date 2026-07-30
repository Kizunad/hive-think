/**
 * Hive Think — deep multi-model reasoning for complex decisions
 *
 * Registers the `hive_think` tool. All orchestration lives in hive-pipeline.ts and
 * all subprocess handling in hive-runner.ts; this file is registration, parameter
 * handling, and TUI rendering.
 *
 * There is one thinking workflow, not a menu of them: dissect the question to
 * first-principles claims, merge restatements, vote, solve, vote again. Consensus
 * arbitrates, so the model roster is a flat list with no privileged slot.
 *
 * Models are never defaulted — see hive-config.ts for why an unconfigured hive
 * reports setup instructions instead of guessing.
 *
 * Install: pi install git:github.com/Kizunad/hive-think
 */

import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { backgroundManager } from "./background-manager.js";
import {
	type HiveConfig,
	loadConfig,
	NODES_CEILING,
	NODES_FLOOR,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./hive-config.js";
import { type PipelineOutcome, renderOutcome, runPipeline } from "./hive-pipeline.js";
import { aggregateUsage, getFinalOutput, HIVE_BUDGET_MS, type ModelResult } from "./hive-runner.js";
import { combineSignals, formatUsageStats } from "./hive-util.js";

// ---------------------------------------------------------------------------
// Details payload (read back by hive_read / hive_status)
// ---------------------------------------------------------------------------

export interface HiveThinkDetails {
	question: string;
	models: string[];
	nodes?: number;
	stages?: string[];
	results: ModelResult[];
}

function detailsOf(outcome: PipelineOutcome): HiveThinkDetails {
	return {
		question: outcome.question,
		models: outcome.roster,
		nodes: outcome.nodes,
		stages: [...outcome.stagesRun],
		results: outcome.results,
	};
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const MAX_HISTORY_CHARS = 512_000;

export function buildHistory(ctxMessages: Message[]): string {
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

	if (history.length > MAX_HISTORY_CHARS) {
		history = `... [earlier messages truncated]\n\n${history.slice(history.length - MAX_HISTORY_CHARS)}`;
	}
	return history;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export const HiveThinkParams = Type.Object({
	question: Type.String({ description: "The question or problem to think deeply about" }),
	context: Type.Optional(
		Type.String({
			description:
				"Additional context: conversation summary, relevant code, constraints, trade-offs already discussed, your current thinking. More detail here directly improves the decomposition.",
		}),
	),
	models: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Override the configured model roster for this call only. Pass models the user named (e.g. 'use Opus'). Nodes are drawn from this list round-robin, so fewer entries than nodes is fine. Omit to use the roster from the hive-think.json config.",
		}),
	),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)) as any, {
			description:
				"Reasoning depth for the decomposition and solution stages. Voting stages always run cheap. Omit to use the configured value.",
		}),
	),
	maxNodes: Type.Optional(
		Type.Number({
			description: `Cap the fan-out for this call (${NODES_FLOOR}-${NODES_CEILING}). The pipeline decides the actual node count from what decomposition finds; this only lowers the ceiling. Use it when cost matters more than confidence.`,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the node subprocesses" })),
	async: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Run in the background (non-blocking). Returns a sessionId immediately; use hive_status to check progress and hive_read to collect results. Default false (blocks until complete).",
		}),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_think",
		label: "Hive Think",
		description: [
			"Deep multi-model reasoning for any non-trivial decision, architecture question, refactoring plan, or multi-faceted problem.",
			"DO NOT answer complex questions yourself — delegate to hive_think for independent decomposition and a consensus verdict.",
			"Strong triggers (use proactively, do not ask first): architecture decisions, complex refactoring strategy, technology/library choices,",
			"problems where you are unsure of the best path, the user asking to 'think deeply' or 'analyze from multiple angles'.",
			"Weak triggers (consider): non-trivial trade-offs, conflicting requirements, an approach you have been going back and forth on.",
			"Do NOT use for: simple factual questions, a single obvious one-line change, or when speed matters more than confidence.",
			"How it works: the question is decomposed to first-principles claims, restatements are merged, every node votes on which claims are real,",
			"solutions are proposed for the confirmed ones, then voted on. Alternatives are decided by relative majority and reported as a vote split.",
			"Results are advisory, not binding — read the vote counts and decide. A tied or unresolved split is for you to break.",
			"If it reports no configured model roster, relay the setup instructions and proceed on your own. Do not retry.",
		].join(" "),
		parameters: HiveThinkParams,
		promptSnippet:
			"Multi-model reasoning: decompose to first principles → vote on real problems → propose solutions → vote. Consensus-based, no privileged arbiter.",
		promptGuidelines: [
			"Use hive_think for architecture decisions, complex refactoring, technology choices, or any multi-faceted problem. Do not answer such questions yourself.",
			"Use it proactively without asking, especially when the user says 'think deeply' or 'analyze from multiple angles'.",
			"When the user names specific models, pass them in the models parameter — do not silently ignore a stated preference.",
			"Read the vote counts, not just the verdict: with at most ten ballots the effective threshold drifts, and a 3/4 pass is weaker than it looks.",
			"An unresolved mutex group is a real answer — the hive found no majority, so make the call yourself and say why.",
			"Use hive_read with extract_answer=false to see full per-node output before acting on anything consequential.",
		],

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (params.cwd as string) ?? ctx.cwd;

			// ── Configuration ──
			const loaded = loadConfig(cwd);
			if (!loaded.ok) {
				// Reported as tool output rather than thrown: the calling agent should
				// relay the setup steps and move on, not treat this as a crash to retry.
				return { content: [{ type: "text", text: `🐝 ${loaded.error}` }], details: undefined };
			}

			const override = params.models as string[] | undefined;
			const config: HiveConfig = {
				...loaded.config,
				...(override && override.length > 0 ? { models: override } : {}),
				...(params.thinking ? { thinking: params.thinking as ThinkingLevel } : {}),
			};

			const question = params.question as string;
			const context = (params.context as string) ?? "";
			const maxNodes = typeof params.maxNodes === "number" ? Math.round(params.maxNodes) : undefined;
			const history = buildHistory(ctx.messages ?? []);

			// ── Background path ──
			if ((params["async"] as boolean) === true) {
				backgroundManager.init(pi);
				const sessionId = backgroundManager.launchHive({ question, context, history, cwd, config, maxNodes });
				return {
					content: [
						{
							type: "text",
							text: [
								`🐝 Background hive launched: \`${sessionId}\``,
								`- Roster: ${config.models.length} model${config.models.length === 1 ? "" : "s"}`,
								`- Question: ${question.slice(0, 100)}${question.length > 100 ? "..." : ""}`,
								"",
								`Check progress with \`hive_status({ sessionId: "${sessionId}" })\`.`,
								`Collect results with \`hive_read({ sessionId: "${sessionId}" })\` once complete.`,
							].join("\n"),
						},
					],
					details: { sessionId, question, models: config.models, status: "launched", async: true },
				};
			}

			// ── Synchronous path ──
			// Overall budget: abort the remaining nodes and return whatever the
			// completed stages produced, so a stuck hive never runs out the caller's
			// outer timeout with no output at all.
			let budgetFired = false;
			const budgetController = new AbortController();
			const budgetTimer =
				HIVE_BUDGET_MS > 0
					? setTimeout(() => {
							budgetFired = true;
							budgetController.abort();
						}, HIVE_BUDGET_MS)
					: undefined;

			try {
				const outcome = await runPipeline({
					question,
					context,
					history,
					cwd,
					config,
					maxNodes,
					signal: combineSignals(signal, budgetController.signal),
					onProgress: onUpdate
						? (progress) => {
								onUpdate({
									content: [
										{
											type: "text",
											text: `🐝 ${progress.stage} — ${progress.done}/${progress.total} nodes`,
										},
									],
									details: { question, models: config.models, results: progress.results },
								});
							}
						: undefined,
				});

				if (budgetFired) {
					outcome.haltReason = `hive budget (${Math.round(HIVE_BUDGET_MS / 60000)}min) reached — ${outcome.haltReason ?? "remaining nodes aborted"}`;
				}

				return { content: [{ type: "text", text: renderOutcome(outcome) }], details: detailsOf(outcome) };
			} finally {
				if (budgetTimer) clearTimeout(budgetTimer);
			}
		},

		renderCall(args, theme, _context) {
			const override = args.models as string[] | undefined;
			const isAsync = (args["async"] as boolean) || false;
			const question = (args.question as string) || "...";
			const preview = question.length > 80 ? `${question.slice(0, 80)}...` : question;

			const roster = override && override.length > 0
				? override.length <= 4
					? override.join(", ")
					: `${override.slice(0, 3).join(", ")} +${override.length - 3} more`
				: "configured roster";

			const asyncTag = isAsync ? ` ${theme.fg("warning", "⏳ background")}` : "";
			let text =
				theme.fg("toolTitle", theme.bold("hive_think ")) +
				theme.fg("accent", "🐝 dissect → vote → solve → vote") +
				asyncTag +
				`\n  ${theme.fg("dim", roster)}`;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as HiveThinkDetails | undefined;
			if (!details || !details.results || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

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
				? `${successCount + failCount}/${details.results.length} nodes, ${running} running`
				: `${successCount}/${details.results.length} nodes`;
			const stageTag = details.stages?.length ? ` · ${details.stages.length} stages` : "";

			if (expanded && !isRunning) {
				const container = new Container();
				const mdTheme = getMarkdownTheme();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", `🐝 ${status}${stageTag}`)}`,
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Question: ") + theme.fg("dim", details.question), 0, 0));

				// Grouped by stage so a per-node dump stays readable across five stages.
				let lastStage: string | undefined;
				for (const r of details.results) {
					if (r.stage !== lastStage) {
						lastStage = r.stage;
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", `━━ ${r.stage ?? "stage"}`), 0, 0));
					}
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const durationTag =
						r.durationMs > 0 ? ` ${theme.fg("dim", `[${(r.durationMs / 1000).toFixed(1)}s]`)}` : "";
					const usageStr = formatUsageStats(r.usage);
					container.addChild(
						new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.model)} ${rIcon}${durationTag}${usageStr ? theme.fg("dim", `  ${usageStr}`) : ""}`,
							0,
							0,
						),
					);
					const output = getFinalOutput(r.messages);
					if (r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					else if (output) container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					else container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}

				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
				}
				return container;
			}

			// Collapsed: the rendered verdict already summarises the vote, so show it
			// rather than re-listing nodes.
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("Hive Think "))}${theme.fg("accent", `🐝 ${status}${stageTag}`)}`;
			if (isRunning) {
				const current = details.results[details.results.length - 1]?.stage;
				if (current) text += `\n  ${theme.fg("dim", `${current}...`)}`;
			} else {
				const body = result.content[0];
				const summary = body?.type === "text" ? body.text : "";
				for (const line of summary.split("\n").filter((l) => l.trim()).slice(1, 9)) {
					text += `\n  ${theme.fg("dim", line.slice(0, 140))}`;
				}
			}

			const totalUsage = !isRunning ? formatUsageStats(aggregateUsage(details.results)) : "";
			if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand · hive_read for full output)")}`;
			return new Text(text, 0, 0);
		},
	});
}
