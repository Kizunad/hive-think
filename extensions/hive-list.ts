/**
 * hive_list — List all background hive_think sessions
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { backgroundManager } from "./background-manager.js";

export const HiveListParams = Type.Object({});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_list",
		label: "Hive List",
		description: "List all active and recently completed background hive_think sessions.",
		parameters: HiveListParams,
		promptSnippet: "List background hive_think sessions",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			backgroundManager.init(pi);
			let hives = backgroundManager.listHives();

			// Fallback: scan session entries for background hives (cross-module compatible)
			if (hives.length === 0) {
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				const seenSessionIds = new Map<string, any>();
				for (const entry of entries) {
					const ct = (entry as any).customType;
					const data = (entry as any).data;
					if (!data?.sessionId) continue;
					if (ct === "hive:result" || ct === "hive:state") {
						seenSessionIds.set(data.sessionId, data);
					}
				}
				if (seenSessionIds.size > 0) {
					hives = [];
					for (const [sid, data] of seenSessionIds) {
						hives.push({
							sessionId: sid,
							status: data.status || "running",
							question: data.question ? data.question.slice(0, 80) : "(background hive)",
							stage: data.stage,
							doneCount: data.doneCount ?? 0,
							// The fan-out is decided at run time, so there is no roster size to
							// assume for a session we are only reading back from disk.
							totalCount: data.totalCount ?? data.doneCount ?? 0,
						});
					}
				}
			}

			if (hives.length === 0) {
				return {
					content: [{ type: "text", text: "No background hive sessions active." }],
				};
			}

			const lines = ["## Background Hives", ""];
			for (const h of hives) {
				const icon =
					h.status === "completed" ? "✅" :
					h.status === "running" || h.status === "launched" ? "⏳" :
					h.status === "timeout" ? "⏱" :
					h.status === "aborted" ? "🛑" : "⚠";
				const stageTag = h.stage ? ` · ${h.stage}` : "";
				lines.push(`${icon} \`${h.sessionId}\` **${h.status}** — ${h.doneCount}/${h.totalCount} nodes${stageTag}`);
				lines.push(`  > ${h.question.slice(0, 100)}${h.question.length > 100 ? "..." : ""}`);
				if (h.status === "completed") {
					lines.push(`  Ready: \`hive_read({ sessionId: "${h.sessionId}" })\``);
				}
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { hives },
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("hive_list"))}`,
				0, 0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
