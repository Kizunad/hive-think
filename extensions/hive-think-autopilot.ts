/**
 * Hive Think Autopilot
 *
 * Injects hive_think guidance into the main agent's system prompt so the model
 * reaches for multi-model reasoning without being told to each time.
 *
 * The guidance is config-dependent on purpose. Telling an agent it MUST delegate
 * hard questions to a tool that has no model roster produces a loop: it calls,
 * gets a setup error, and calls again. When nothing is configured the injected
 * text says so and tells the agent to work unaided instead.
 *
 * Nothing here names a specific model — the roster is the user's, and hardcoding
 * names would put this file back out of sync the moment they change it.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configSearchPaths, loadConfig } from "./hive-config.js";

const HIVE_GUIDANCE = `

## Hive Think (Multi-Model Deep Reasoning)

You have a \`hive_think\` tool that runs a configured roster of models as
independent nodes, each with **read+bash tools** for real investigation and the
**full conversation context**. It is not a single second opinion — it is a
structured, five-stage process:

1. **解剖 dissect** — nodes independently decompose the question into
   first-principles claims that can actually be checked (≤3 levels deep, each leaf
   verifiable against code, config, data, or a command's output).
2. **归并 merge** — restatements of one problem are collapsed into a single
   candidate list. This step may only merge, never judge.
3. **vote** — every node votes on which claims are real and material.
4. **解法 solve** — solutions are proposed for the claims that passed.
5. **vote** — every node votes on the solutions.

Nodes are peers. There is no designated arbiter, so consensus — not one
privileged model — decides what survives. The fan-out (3-10 nodes) is chosen after
decomposition, from how many distinct problems it found and how deep it had to go.

Unlike subagents, hive nodes see everything and can read code and run tests to
fill context gaps, but **cannot modify anything** (no write, no edit).

### When to use hive_think (proactive — do not ask first)

**Strong triggers — use it:**
- Architecture decisions: "should we use X or Y pattern?"
- Complex refactoring strategy: "how should we restructure this?"
- Technology / library choices: "which approach is better?"
- Multi-faceted problems where you're unsure of the best path
- The user says "think deeply", "analyze from multiple angles", "give me different perspectives"

**Weak triggers — consider it:**
- Non-trivial design decisions with real trade-offs
- Conflicting requirements
- An approach you have been going back and forth on

**Do NOT use for:**
- Simple factual questions
- A single obvious one-line change
- Anything where speed matters more than confidence

### How to call it

\`\`\`
hive_think({
  question: "The exact question to analyze",
  context: "Full relevant context: conversation summary, constraints, code, trade-offs discussed, your current thinking, what you have already tried..."
})
\`\`\`

The \`context\` field drives the quality of the decomposition — include everything
the nodes need. They can read and grep for what you missed, but they cannot read
your mind about constraints that were never written down.

Optional: \`models\` overrides the roster for one call (pass models the user named),
\`maxNodes\` lowers the fan-out ceiling when cost matters more than confidence,
\`thinking\` sets reasoning depth for the dissect and solve stages.

### Reading the result

The output is advisory, not binding. Read it properly:

1. **Look at the vote counts, not just the pass/fail marks.** With at most ten
   ballots the effective threshold drifts from the nominal one — 3 of 4 is 75%
   support at a nominal 60%. Every line shows actual votes, actual percentage, and
   the bar that was really applied.
2. **A low-voter item is weak even at 100%.** Two nodes agreeing is not consensus;
   the output flags these.
3. **An unresolved alternatives group is a real answer.** It means the hive found
   no majority among mutually exclusive options. Break the tie yourself, using the
   split, and say why.
4. **"Nothing carried" is also a real answer.** It means the hive did not confirm a
   problem worth solving. Do not re-run it hoping for a different verdict.

You make the final call. The hive narrows and stress-tests the options; it does not
own the decision.
`;

const BACKGROUND_GUIDANCE = `

## Background Hive Think (Non-Blocking)

\`hive_think\` can run in the background so a long analysis does not block the
conversation:

\`\`\`
hive_think({ question: "...", context: "...", async: true })
\`\`\`

Returns immediately with a \`sessionId\`; you keep working while nodes think.

### Management tools

- \`hive_status({ sessionId })\` — progress and current stage
- \`hive_read({ sessionId })\` — collect results once finished (destructive, one-time)
- \`hive_abort({ sessionId })\` — stop a running hive; finished stages are still collectable
- \`hive_list()\` — list active background hives

### When to use async

**Use \`async: true\` when:** the analysis will take a while, you want two or three
investigations running at once, or you do not need the answer inside this turn.

**Use the default (synchronous) when:** you need the answer to continue, or it is a
single focused question.

### Constraints

- Max 5 concurrent background hives; the oldest running one is retired to make room
- Subprocess slots are shared process-wide across every hive and the foreground call
- Per-node timeout 30 min (\`HIVE_NODE_TIMEOUT_MS\`); per-hive budget 45 min (\`HIVE_BUDGET_MS\`)
- A hive that exceeds its budget returns the stages that finished, not an error
- Results expire 5 minutes after completion if never read
`;

function unconfiguredGuidance(paths: string[]): string {
	return `

## Hive Think (not configured)

A \`hive_think\` tool is installed but has **no model roster configured**, so it
cannot run. Do not call it — it will only return setup instructions.

Analyze complex questions yourself for now. If the user asks about hive_think, or
would benefit from it, tell them to create one of these files:

${paths.map((p) => `- \`${p}\``).join("\n")}

\`\`\`json
{
  "models": ["provider/model-a", "provider/model-b", "provider/model-c"]
}
\`\`\`

hive-think ships no default models on purpose: provider-qualified model ids only
resolve inside a particular pi installation, so any built-in list would be broken
for most people. \`pi models\` lists the ids available here.
`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const cwd = ctx?.cwd ?? process.cwd();
		const base = event.systemPrompt ?? "";

		// Checked per turn rather than cached: a user who writes the config mid-session
		// should get working guidance on their next message, not after a restart.
		const loaded = loadConfig(cwd);
		if (!loaded.ok) {
			return { systemPrompt: base + unconfiguredGuidance(configSearchPaths(cwd)) };
		}

		return { systemPrompt: base + HIVE_GUIDANCE + BACKGROUND_GUIDANCE };
	});
}
