/**
 * hive_abort — Kill a running background hive_think session
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { backgroundManager } from "./background-manager.js";

export const HiveAbortParams = Type.Object({
	sessionId: Type.String({ description: "Session ID of the background hive to abort" }),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hive_abort",
		label: "Hive Abort",
		description: "Kill a running background hive_think session. Aborted hives cannot be resumed.",
		parameters: HiveAbortParams,
		promptSnippet: "Abort a running background hive_think session",

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			backgroundManager.init(pi);
			const sessionId = params.sessionId as string;
			const ok = backgroundManager.abortHive(sessionId);

			return {
				content: [{
					type: "text",
					text: ok
						? `🛑 Hive \`${sessionId}\` aborted.`
						: `Hive \`${sessionId}\` not found or already finished.`,
				}],
			};
		},

		renderCall(args, theme, _context) {
			const id = (args.sessionId as string) || "...";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("hive_abort "))}${theme.fg("error", id.slice(0, 12))}`,
				0, 0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
