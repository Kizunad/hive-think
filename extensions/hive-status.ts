/**
 * hive_status — Check progress of background hive_think sessions
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { backgroundManager } from "./background-manager.js";

export const HiveStatusParams = Type.Object({
	sessionId: Type.String({ description: "Session ID returned by hive_think({ async: true })" }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_status",
		label: "Hive Status",
		description: "Check progress of a background hive_think session. Returns status, model completion count, and duration.",
		parameters: HiveStatusParams,
		promptSnippet: "Check background hive_think progress",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			backgroundManager.init(pi);
			const sessionId = params.sessionId as string;
			let status = backgroundManager.getStatus(sessionId);

			// Fallback: scan session entries
			if (!status) {
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				for (const entry of entries) {
					const data = (entry as any).data;
					if (data?.sessionId === sessionId) {
						status = {
							sessionId,
							status: data.status || "completed",
							question: data.question || "",
							mode: data.mode || "",
							models: data.models || [],
							doneCount: data.doneCount ?? 0,
							totalCount: data.totalCount ?? 14,
							durationMs: Date.now() - (data.startTime || Date.now()),
						};
						break;
					}
				}
			}

			if (!status) {
				return {
					content: [{ type: "text", text: `Hive \`${sessionId}\` not found. It may have been read (consumed), expired, or never existed. Use \`hive_list()\` to see active sessions.` }],
				};
			}

			const progressBar = (done: number, total: number) => {
				const width = 10;
				const filled = Math.round((done / total) * width);
				return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
			};

			const durationS = (status.durationMs / 1000).toFixed(1);
			const lines = [
				`🐝 Hive \`${status.sessionId}\` — **${status.status}**`,
				`Mode: ${status.mode} · Models: ${status.totalCount} · Elapsed: ${durationS}s`,
				`Progress: ${progressBar(status.doneCount, status.totalCount)} ${status.doneCount}/${status.totalCount} nodes`,
				"",
				status.status === "completed"
					? `✅ Complete! Use \`hive_read({ sessionId: "${sessionId}" })\` to get results.`
					: status.status === "running" || status.status === "launched"
						? `⏳ Still running... ${status.totalCount - status.doneCount} nodes remaining.`
						: status.status === "timeout"
							? `⏱ Budget exceeded. Results may be partial. Use \`hive_read({ sessionId: "${sessionId}" })\` to get what's available.`
							: `⚠ Status: ${status.status}`,
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: status,
			};
		},

		renderCall(args, theme, _context) {
			const id = (args.sessionId as string) || "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("hive_status "))}${theme.fg("accent", id.slice(0, 12))}`,
				0, 0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
