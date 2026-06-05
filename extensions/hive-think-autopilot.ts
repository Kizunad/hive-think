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

You have a \`hive_think\` tool that spawns **12 models in parallel** (4× deepseek-v4-pro + 4× deepseek-v4-flash + 4× sensenova-6.7-flash-lite), all running with **--thinking xhigh** and **read+bash tools** for active investigation. Strong models share the DeepSeek provider for prompt cache prefix matching. Each model receives the **full conversation context** and thinks independently. All responses are collected side-by-side for comparison.

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

const SWARM_GUIDANCE = `

## Swarm Review (Parallel Bug & Vulnerability Hunting)

You have a \`swarm_review\` tool for code security scanning. It spawns **15 cheap flash models** (sensenova-6.7-flash-lite, deepseek-v4-flash, minimax-m3, gemma-4-31b-it) in parallel, uses **consensus voting (≥80%)** to filter false positives, then validates with a **pro-model jury** (deepseek-v4-pro).

This is for bug hunting, not deep reasoning. Quantity over quality — cheap models find needles in haystacks.

### When to use swarm_review (proactive)

**Strong triggers — use it:**
- Security audit: "find vulnerabilities in this codebase"
- Bug hunting: "scan for bugs", "look for issues"
- Pre-merge check: "review this PR for security issues"
- The user mentions vulnerabilities, exploits, or security scanning

**Do NOT use for:**
- Architecture decisions → use hive_think
- Complex refactoring → use hive_think
- Understanding code logic → read files yourself

### How to call it

\`\`\`
swarm_review({
  targetDir: "./src",
  excludePatterns: ["tests"],
  minVoteThreshold: 0.8
})
\`\`\`

All parameters optional — by default scans the current working directory with 80% vote threshold.
`;

const BACK_HIVE_GUIDANCE = `

## Background Hive Think (Non-Blocking)

You can run \`hive_think\` in **background mode** to avoid blocking the conversation:

\`\`\`
hive_think({ question: "...", context: "...", async: true })
\`\`\`

Returns immediately with a \`sessionId\`. The agent continues working while models think in parallel.

### Management Tools

- \`hive_status({ sessionId })\` — check progress (launched/running/completed)
- \`hive_read({ sessionId })\` — consume results when complete (destructive, one-time)
- \`hive_abort({ sessionId })\` — kill a running hive
- \`hive_list()\` — list all active background hives

### When to use async (proactive)

**Use async: true when:**
- Long-running analysis (30s+ expected)
- Multiple parallel investigations (launch 2-3 hives simultaneously)
- You don't need results immediately in this turn
- You want to explore different questions concurrently

**Use sync (default) when:**
- Quick decision (<30s)
- Results needed in the same turn
- Single focused question

### Key constraints
- Max 5 concurrent background hives
- 4 subprocess slots shared across all hives (FIFO queue)
- Per-node timeout: 30 minutes
- Per-hive budget: 45 minutes (nodes aborted after)
- Results auto-expire after 5 minutes if not read
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: (event.systemPrompt ?? "") + HIVE_GUIDANCE + SWARM_GUIDANCE + BACK_HIVE_GUIDANCE,
		};
	});
}
