/**
 * hive-read — Read and paginate hive_think results
 *
 * Companion tool for hive-think. Reads model outputs from the most recent
 * hive_think result directly from ctx.messages — no file I/O needed.
 *
 * Two modes:
 *   extract_answer=true  — extract only the <ANSWER>...</ANSWER> section
 *   extract_answer=false — show full output with per-model pagination
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { backgroundManager } from "./background-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAnswer(text: string): string | null {
	const start = text.lastIndexOf("<ANSWER>");
	if (start === -1) return null;
	const end = text.lastIndexOf("</ANSWER>");
	if (end === -1) return text.slice(start + 8).trim();
	return text.slice(start + 8, end).trim();
}

interface ModelOutput {
	model: string;
	exitCode: number;
	durationMs: number;
	turns: number;
	text: string;
	errorMessage?: string;
}

interface HiveDetails {
	question: string;
	models: string[];
	results: Array<{
		model: string;
		exitCode: number;
		durationMs: number;
		messages: Array<any>;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; totalTokens?: number; turns?: number };
		errorMessage?: string;
	}>;
}

function findLastHiveResult(entries: any[]): HiveDetails | null {
	// Search entries bottom-up for hive_think results
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		// Check top-level details (toolResult messages)
		if (msg.details?.question && msg.details?.models && msg.details?.results) {
			return msg.details as HiveDetails;
		}
		// Check content blocks (extension tool results embedded in assistant messages)
		const content = msg.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.details?.question && block?.details?.models && block?.details?.results) {
					return block.details as HiveDetails;
				}
			}
		}
	}
	return null;
}

function modelOutputsFromDetails(details: HiveDetails): ModelOutput[] {
	return details.results.map((r) => {
		let text = extractTextFromMessages(r.messages);
		return {
			model: r.model,
			exitCode: r.exitCode,
			durationMs: r.durationMs,
			turns: r.usage?.turns ?? 0,
			text,
			errorMessage: r.errorMessage,
		};
	});
}

function extractTextFromMessages(messages: any[]): string {
	for (let j = messages.length - 1; j >= 0; j--) {
		const m = messages[j];
		if (m.role === "assistant") {
			for (const c of m.content ?? []) {
				if (c.type === "text") return c.text;
			}
		}
	}
	return "";
}

function formatOutput(
	allOutputs: ModelOutput[],
	targetModel: string,
	extract: boolean,
	offset: number,
	limit: number,
	source: string,
): { content: { type: "text"; text: string }[] } {
	let filtered = allOutputs;
	if (targetModel) {
		const idx = Number(targetModel);
		if (Number.isInteger(idx) && idx >= 0 && idx < allOutputs.length) {
			filtered = [allOutputs[idx]];
		} else {
			filtered = allOutputs.filter((o) => o.model.includes(targetModel));
		}
	}

	if (filtered.length === 0) {
		return {
			content: [{
				type: "text",
				text: `Model "${targetModel}" not found. Available: ${allOutputs.map((o) => o.model).join(", ")}`,
			}],
		};
	}

	const parts: string[] = [];
	const scope = filtered.length === allOutputs.length
		? `All ${allOutputs.length} models`
		: `Model${filtered.length > 1 ? "s" : ""}: ${targetModel}`;
	parts.push(`${scope} from ${source}`);

	for (const o of filtered) {
		const status = o.exitCode === 0 ? "✓" : "✗";
		const duration = `[${(o.durationMs / 1000).toFixed(1)}s, ${o.turns} turns]`;

		if (extract) {
			const answer = extractAnswer(o.text);
			parts.push(`\n### ${o.model} ${status} ${duration}`);
			if (o.errorMessage) {
				parts.push(`Error: ${o.errorMessage}`);
			} else if (answer) {
				parts.push(answer);
			} else {
				parts.push("(no ANSWER section — try extract_answer=false)");
			}
		} else {
			const lines = o.text.split("\n");
			const page = lines.slice(offset, offset + limit);
			parts.push(`\n### ${o.model} ${status} ${duration}`);
			if (o.errorMessage) parts.push(`Error: ${o.errorMessage}`);
			parts.push(`(lines ${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length}${offset + limit < lines.length ? `, use offset=${offset + limit} for next page` : ""})`);
			parts.push(page.join("\n") || "(no output)");
		}
	}

	if (extract && filtered.length > 1) {
		const answered = filtered.filter((o) => extractAnswer(o.text) !== null).length;
		parts.push(`\n---\n${answered}/${filtered.length} models produced ANSWER section. Use extract_answer=false for full output.`);
	}

	return { content: [{ type: "text", text: parts.join("\n") }] };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HiveReadParams = Type.Object({
	sessionId: Type.Optional(
		Type.String({
			description: "Session ID of a background hive_think. If provided, reads from background hive instead of session history.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: 'Model name filter (e.g., "deepseek-v4-pro") or index (0-7). Omit for all models.',
		}),
	),
	extract_answer: Type.Optional(
		Type.Boolean({
			default: true,
			description: "Extract only the <ANSWER>...</ANSWER> section (default true). Set false for full output.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Line offset for pagination (0-based, only when extract_answer=false).",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			default: 150,
			description: "Max lines to return per model (default 150, only when extract_answer=false).",
		}),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_read",
		label: "Hive Read",
		description: [
			"Read model outputs from the most recent hive_think result in the session.",
			"Two modes: extract_answer=true (default) returns only the ANSWER section;",
			"extract_answer=false returns full output with per-model line-based pagination.",
		].join(" "),
		parameters: HiveReadParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = (params.sessionId as string) ?? "";
			const targetModel = (params.model as string) ?? "";
			const extract = params.extract_answer !== false;
			const offset = (params.offset as number) ?? 0;
			const limit = (params.limit as number) ?? 150;

			// ── Background hive path ──
			if (sessionId) {
				// Try session entries first (cross-module compatible)
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				for (const entry of entries) {
					if ((entry as any).customType === "hive:result" && (entry as any).data?.sessionId === sessionId) {
						const modelResults = (entry as any).data.results as ModelResult[] | undefined;
						if (modelResults && modelResults.length > 0) {
							const allOutputs = modelResults.map((r: any) => ({
								model: r.model,
								exitCode: r.exitCode,
								durationMs: r.durationMs || 0,
								turns: r.usage?.turns ?? r.turns ?? 0,
								text: typeof r.text === "string" ? r.text : extractTextFromMessages(r.messages ?? []),
								errorMessage: r.errorMessage,
							}));
							return formatOutput(allOutputs, targetModel, extract, offset, limit, `Background hive \`${sessionId}\``);
						}
					}
				}

				// Fallback: try backgroundManager (same-module only)
				backgroundManager.init(pi);
				const results = backgroundManager.readResults(sessionId);
				if (!results) {
					const status = backgroundManager.getStatus(sessionId);
					if (status) {
						return {
							content: [{
								type: "text",
								text: `Hive \`${sessionId}\` is still **${status.status}** (${status.doneCount}/${status.totalCount} nodes). Wait for it to complete, then try again.`,
							}],
						};
					}
					return {
						content: [{ type: "text", text: `Hive \`${sessionId}\` not found. It may have already been read (consumed) or expired. Try \`hive_list()\` to see available sessions.` }],
					};
				}

				const allOutputs = results.map((r) => ({
					model: r.model,
					exitCode: r.exitCode,
					durationMs: r.durationMs,
					turns: r.usage?.turns ?? 0,
					text: extractTextFromMessages(r.messages),
					errorMessage: r.errorMessage,
				}));

				return formatOutput(allOutputs, targetModel, extract, offset, limit, `Background hive \`${sessionId}\``);
			}

			// ── Session history path (existing) ──

			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "No entries in this session. Try running hive_think first." }] };
			}

			const details = findLastHiveResult(entries);
			if (!details) {
				const messageEntries = entries.filter((e: any) => e.type === "message").length;
				return {
					content: [{
						type: "text",
						text: `No hive_think result found in session. Found ${entries.length} entries (${messageEntries} messages). Try running hive_think first.`,
					}],
				};
			}

			const allOutputs = modelOutputsFromDetails(details);
			return formatOutput(allOutputs, targetModel, extract, offset, limit, `last hive_think ("${details.question.slice(0, 80)}...")`);
		},
	});
}
