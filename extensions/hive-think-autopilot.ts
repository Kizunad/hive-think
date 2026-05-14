/**
 * Hive Think Autopilot
 *
 * Injects hive_think guidance into the main agent's system prompt so
 * the model knows when to use multi-model deep thinking proactively.
 *
 * Hive Think spawns 8 models in parallel (4× deepseek-v4-pro +
 * 4× deepseek-v4-flash), all with --thinking xhigh and read+bash
 * tools. Each model sees the full context and thinks independently.
 * Results are returned side-by-side for comparison.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIVE_GUIDANCE = `

## Hive Think (Multi-Model Deep Reasoning)

You have a \`hive_think\` tool that spawns **8 models in parallel** (4× deepseek-v4-pro + 4× deepseek-v4-flash), all running with **--thinking xhigh** and **read+bash tools** for active investigation. All models share the same DeepSeek provider for consistent prompt cache prefix matching. Each model receives the **full conversation context** and thinks independently. All responses are collected side-by-side for comparison.

This is different from subagents — hive models see everything, can read code and run tests to fill context gaps, but **cannot modify code** (no write/edit). Use it for decisions where multiple perspectives reduce blind spots.

### When to use hive_think (proactive — do not ask first)

**Strong triggers — use it:**
- Architecture decisions: "should we use X or Y pattern?"
- Complex refactoring strategy: "how should we restructure this?"
- Technology / library choices: "which approach is better?"
- Multi-faceted problems where you're unsure of the best path
- User says "think deeply about this", "analyze this from multiple angles", "give me different perspectives"

**Weak triggers — consider it:**
- Non-trivial design decisions with trade-offs
- The problem has conflicting requirements
- You've been going back and forth on an approach

**Do NOT use for:**
- Simple factual questions
- Single obvious one-line changes
- Tasks where speed matters more than thoroughness

### How to call it

\`\`\`
hive_think({
  question: "The exact question to analyze",
  context: "Full relevant context: conversation summary, constraints, code, trade-offs discussed, your current thinking, what you've already tried..."
})
\`\`\`

The \`context\` field is critical — include **everything** the models need. Conversation history, code snippets, constraints, your current thinking, what you've already tried. More context = better analysis. The models can also use read/grep/bash to look up anything you missed.

### After hive_think returns

1. Read ALL model responses — every perspective matters
2. Note where they **agree** (consensus = high confidence) and where they **diverge**
3. Make your own synthesis — you make the final call, the hive provides perspective and reduces blind spots
4. Act on the decision
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: (event.systemPrompt ?? "") + HIVE_GUIDANCE,
		};
	});
}
