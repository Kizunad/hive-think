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

function findLastHiveResult(messages: any[]): HiveDetails | null {
	// Search messages bottom-up — check both top-level details and nested content blocks
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		// Check top-level details (toolResult messages from built-in tools)
		if (msg.details?.question && msg.details?.models && msg.details?.results) {
			return msg.details as HiveDetails;
		}
		// Check content blocks (extension tool results embedded in assistant/user messages)
		const content = msg.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block?.details?.question && block?.details?.models && block?.details?.results) {
					return block.details as HiveDetails;
				}
				// Check nested text content that might contain serialized details
				if (block?.content && Array.isArray(block.content)) {
					for (const inner of block.content) {
						if (inner?.details?.question && inner?.details?.models && inner?.details?.results) {
							return inner.details as HiveDetails;
						}
					}
				}
			}
		}
	}
	return null;
}

function modelOutputsFromDetails(details: HiveDetails): ModelOutput[] {
	return details.results.map((r) => {
		let text = "";
		for (let j = r.messages.length - 1; j >= 0; j--) {
			const m = r.messages[j];
			if (m.role === "assistant") {
				for (const c of m.content ?? []) {
					if (c.type === "text") {
						text = c.text;
						break;
					}
				}
				if (text) break;
			}
		}
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HiveReadParams = Type.Object({
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
			"Read model outputs from the most recent hive_think result in ctx.messages.",
			"Two modes: extract_answer=true (default) returns only the ANSWER section;",
			"extract_answer=false returns full output with per-model line-based pagination.",
			"Use this instead of reading the raw session file (1.4MB+ per hive call).",
		].join(" "),
		parameters: HiveReadParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const targetModel = (params.model as string) ?? "";
			const extract = params.extract_answer !== false;
			const offset = (params.offset as number) ?? 0;
			const limit = (params.limit as number) ?? 150;

			const messages = ctx.messages ?? [];
			if (messages.length === 0) {
				return { content: [{ type: "text", text: "No messages in this session." }] };
			}

			const details = findLastHiveResult(messages);
			if (!details) {
				// Show what we found for debugging
				const counts = { total: messages.length, withDetails: 0, withContent: 0 };
				for (const m of messages) {
					if (m.details) counts.withDetails++;
					if (Array.isArray(m.content)) counts.withContent++;
				}
				return {
					content: [{
						type: "text",
						text: `No hive_think result found in current session. Messages: ${counts.total} total, ${counts.withDetails} with details, ${counts.withContent} with content array. Try running hive_think first, then hive_read in the same session.`,
					}],
				};
			}

			const allOutputs = modelOutputsFromDetails(details);

			// Filter by model
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

			// Build output
			const parts: string[] = [];
			const scope = filtered.length === allOutputs.length
				? `All ${allOutputs.length} models`
				: `Model${filtered.length > 1 ? "s" : ""}: ${targetModel}`;
			parts.push(`${scope} from last hive_think (question: "${details.question.slice(0, 80)}...")`);

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

			// Summary footer
			if (extract && filtered.length > 1) {
				const answered = filtered.filter((o) => extractAnswer(o.text) !== null).length;
				parts.push(`\n---\n${answered}/${filtered.length} models produced ANSWER section. Use extract_answer=false for full output.`);
			}

			return { content: [{ type: "text", text: parts.join("\n") }] };
		},
	});
}
