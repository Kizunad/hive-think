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
							models: data.models || [],
							stage: data.stage,
							doneCount: data.doneCount ?? 0,
							// No fixed roster size to fall back on — the fan-out is decided at
							// run time — so an unknown total reads as however many are done.
							totalCount: data.totalCount ?? data.doneCount ?? 0,
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
				// total is 0 until the first stage reports, and the fan-out grows
				// mid-run, so clamp instead of trusting the ratio.
				const ratio = total > 0 ? Math.min(1, done / total) : 0;
				const filled = Math.round(ratio * width);
				return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
			};

			const durationS = (status.durationMs / 1000).toFixed(1);
			const remaining = Math.max(0, status.totalCount - status.doneCount);
			const lines = [
				`🐝 Hive \`${status.sessionId}\` — **${status.status}**`,
				`Stage: ${status.stage ?? "(starting)"} · Elapsed: ${durationS}s`,
				`Progress: ${progressBar(status.doneCount, status.totalCount)} ${status.doneCount}/${status.totalCount} nodes`,
				"",
				status.status === "completed"
					? `✅ Complete! Use \`hive_read({ sessionId: "${sessionId}" })\` to get results.`
					: status.status === "running" || status.status === "launched"
						? // The node count is decided after decomposition and grows per stage,
							// so this is the current stage's remainder, not the whole run's.
							`⏳ Still running — ${remaining} node${remaining === 1 ? "" : "s"} left in this stage.`
						: status.status === "timeout"
							? `⏱ Budget exceeded. Results may be partial. Use \`hive_read({ sessionId: "${sessionId}" })\` to get what's available.`
							: status.status === "aborted"
								? `⚠ Aborted. Whatever finished is still collectable with \`hive_read({ sessionId: "${sessionId}" })\`.`
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
