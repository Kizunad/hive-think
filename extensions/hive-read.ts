/**
 * hive-read — Read and paginate hive_think results
 *
 * Companion tool for hive-think. Reads model outputs from the most recent
 * hive_think result in the current session.
 *
 * Two modes:
 *   extract_answer=true  — extract only the <ANSWER>...</ANSWER> section
 *   extract_answer=false — show full output with pagination
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractAnswer(text: string): string | null {
	const start = text.indexOf("<ANSWER>");
	if (start === -1) return null;
	const end = text.indexOf("</ANSWER>", start + 8);
	if (end === -1) return text.slice(start); // unclosed — return from <ANSWER> to end
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

function findLastHiveResult(sessionPath: string): ModelOutput[] | null {
	if (!fs.existsSync(sessionPath)) return null;

	const raw = fs.readFileSync(sessionPath, "utf-8");
	const lines = raw.split("\n");

	// Walk backwards to find the most recent hive_think result
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;

		let msg: any;
		try { msg = JSON.parse(line); } catch { continue; }

		const details = msg?.message?.details;
		if (!details) continue;
		if (!details.question || !details.models || !details.results) continue;

		// Found a hive_think result
		const outputs: ModelOutput[] = [];
		for (const r of details.results) {
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
			outputs.push({
				model: r.model,
				exitCode: r.exitCode,
				durationMs: r.durationMs,
				turns: r.usage?.turns ?? 0,
				text,
				errorMessage: r.errorMessage,
			});
		}
		return outputs;
	}

	return null;
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
			description: "Max lines to return (default 150, only when extract_answer=false).",
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
			"Read model outputs from the most recent hive_think result.",
			"Two modes: extract_answer=true (default) returns only the ANSWER section;",
			"extract_answer=false returns full output with line-based pagination.",
			"Use this instead of reading the raw session file (1.4MB+ per hive call).",
		].join(" "),
		parameters: HiveReadParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const targetModel = (params.model as string) ?? "";
			const extract = params.extract_answer !== false;
			const offset = (params.offset as number) ?? 0;
			const limit = (params.limit as number) ?? 150;

			// Find current session file
			const sessionPath = ctx.sessionPath;
			if (!sessionPath) {
				return { content: [{ type: "text", text: "No active session found." }], isError: true };
			}

			const outputs = findLastHiveResult(sessionPath);
			if (!outputs || outputs.length === 0) {
				return { content: [{ type: "text", text: "No hive_think result found in this session." }] };
			}

			// Filter by model
			let filtered = outputs;
			if (targetModel) {
				// Try index first
				const idx = parseInt(targetModel, 10);
				if (!isNaN(idx) && idx >= 0 && idx < outputs.length) {
					filtered = [outputs[idx]];
				} else {
					filtered = outputs.filter(
						(o) => o.model.includes(targetModel),
					);
				}
			}

			if (filtered.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Model "${targetModel}" not found. Available: ${outputs.map((o) => o.model).join(", ")}`,
						},
					],
				};
			}

			// Build output
			const parts: string[] = [];
			parts.push(
				`${filtered.length === outputs.length ? `All ${outputs.length} models` : `Model: ${targetModel}`} from last hive_think`,
			);

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
						parts.push("(no ANSWER section found — try extract_answer=false)");
					}
				} else {
					// Full output with pagination
					const lines = o.text.split("\n");
					const page = lines.slice(offset, offset + limit);
					parts.push(`\n### ${o.model} ${status} ${duration}`);
					if (o.errorMessage) parts.push(`Error: ${o.errorMessage}`);
					parts.push(`(lines ${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length})`);
					parts.push(page.join("\n") || "(no output)");
				}
			}

			// Summary footer
			if (extract && filtered.length > 1) {
				const answered = filtered.filter((o) => extractAnswer(o.text) !== null).length;
				parts.push(
					`\n---\n${answered}/${filtered.length} models produced ANSWER section. Use extract_answer=false + offset/limit for full output.`,
				);
			}

			return { content: [{ type: "text", text: parts.join("\n") }] };
		},
	});
}
