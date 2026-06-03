# 🐝 hive-think

Deep multi-model parallel reasoning for [pi coding agent](https://pi.dev).

Spawns **8 models in parallel** (4× **deepseek-v4-pro** + 4× **deepseek-v4-flash** by default), all with `--thinking xhigh` and read+bash tools. Each model receives the full conversation context and thinks independently. All responses are collected side-by-side for comparison.

**6 biologically-inspired thinking modes** — from simple parallel to multi-round consensus with bidirectional feedback. Ideal for architecture decisions, complex refactoring, technology choices, or any problem where multiple perspectives reduce blind spots.

---

## Install

```bash
pi install git:github.com/Kizunad/hive-think
```

The package registers 3 extensions (`hive-think`, `hive-read`, `hive-think-autopilot`) and a `/hive` slash command. The autopilot injects usage guidance into every system prompt so the model knows when to use `hive_think` proactively — no manual configuration needed.

---

## Quick Start

```typescript
// The model calls this automatically for complex decisions.
// You can also invoke it manually:
hive_think({
  question: "Should we use Redis or Kafka for this use case?",
  context: "We need a message queue for 10k msg/s with at-least-once delivery..."
})
```

### Read results

```typescript
hive_read({})                                          // ANSWER sections from all models (default)
hive_read({ model: "deepseek-v4-pro" })                // filter by model name
hive_read({ model: "3" })                              // filter by index (0-based)
hive_read({ extract_answer: false, offset: 0, limit: 200 })  // full output, paginated
```

### Opt out of autopilot

```bash
pi config
# Disable "hive-think-autopilot" in the extensions panel
```

---

## Thinking Modes

This is the centerpiece of hive-think — **6 biologically-inspired paradigms** that determine how the models collaborate. Pick based on your problem type.

### Mode Decision Matrix

| Mode | Emoji | Calls | Speed | Depth | Breadth | **Trigger when…** | **Avoid when…** |
|------|-------|-------|-------|-------|---------|-------------------|-----------------|
| `parallel` | 🐝 | 8 | ★★★★★ | ★★★ | ★★★★★ | Comparing well-scoped options; "X vs Y" decisions | You need deep, layered analysis |
| `global_workspace` | 🧠 | 12 | ★★★ | ★★★★ | ★★★★ | The team is split; you need consensus across competing concerns | The decision is straightforward |
| `cortical_column` | 🧱 | 7 | ★★ | ★★★★★ | ★★ | Layered architecture design; system decomposition | The problem doesn't have hierarchy |
| `waggle_dance` | 💃 | 9 | ★★★★ | ★★★ | ★★★★★ | Creative brainstorming; exploring the full solution space | You already have a specific approach in mind |
| `integrate_fire` | ⚡ | 13 | ★ | ★★★★★ | ★★★ | Safety-critical decisions; risk/quality assessment | Budget or time is tight |
| `dmn_tpn` | 🌊 | 11 | ★★ | ★★★★ | ★★★★ | Open-ended exploration; "what am I missing?" | The problem framing is already clear |

> Call counts from `MODE_META` in `extensions/hive-think.ts`. Cost estimates assume ~80-95% prompt cache hit rate — see [Cost](#cost).

### Mode Details

<details>
<summary><b>🐝 parallel</b> — Simple parallel, all models think independently (default)</summary>

All 8 models receive the same question and context, think independently, and return their outputs. The main agent compares all perspectives and makes the final call.

- **How it works**: 8× `runModel()` in parallel (max 4 concurrent), each with full context. No orchestration between models.
- **Best for**: Quick multi-perspective on well-framed problems — tech choices, library evaluations, design decisions.
- **Trade-off**: Fastest mode but no cross-pollination — models work in isolation, so shared blind spots persist.
</details>

<details>
<summary><b>🧠 global_workspace</b> — 2-round competition + broadcast, iterative convergence</summary>

Inspired by Global Workspace Theory of consciousness. Specialists compete to get their insights into a shared workspace, then all specialists refine based on what was broadcast.

- **How it works**:
  - **Round 1**: 5 specialists (Architecture, Performance, Security, DX, Risk) produce analyses in parallel
  - **Arbiter**: A strong model identifies the 2-3 most critical, non-obvious insights
  - **Round 2**: All 5 specialists refine their analyses, building on the broadcast insights
  - **Synthesis**: Final arbiter produces the definitive recommendation
- **Best for**: Contentious decisions where you need to surface the *most important* insight from noise, and get alignment across competing concerns.
- **Trade-off**: More calls (12 vs 8) and slower than parallel, but produces higher-confidence consensus.
</details>

<details>
<summary><b>🧱 cortical_column</b> — Hierarchical layers with bidirectional feedback</summary>

Models the brain's cortical hierarchy: bottom-up feed-forward through abstraction layers, then top-down feedback to revise lower layers.

- **How it works**:
  - **Feed-forward** (4 layers): Concrete (code-level facts) → Tactical (API design, data flow) → Architectural (module boundaries, patterns) → Strategic (long-term maintainability, business alignment)
  - **Feedback** (2 layers): Strategic/Architectural constraints feed back down to revise Concrete and Tactical analyses
  - **Synthesis**: Final model combines all layers into one recommendation
- **Best for**: Deep architecture analysis where high-level strategy should constrain low-level implementation (or vice versa). System decomposition, API design, migration planning.
- **Trade-off**: Deepest mode but narrowest breadth — excellent for architectural decisions, poor for comparing disparate options.
</details>

<details>
<summary><b>💃 waggle_dance</b> — Scout diverse directions, converge on best</summary>

Inspired by honeybee foraging: scouts explore many directions, return with findings, then the best direction is chosen and refined.

- **How it works**:
  - **Scout** (8 models): Each explores a distinct creative direction — radical, simple, robust, scalable, developer-friendly, cost-effective, hybrid, future-proof
  - **Converge** (1 model): Evaluates all approaches, ranks them, and synthesizes a recommendation combining the best elements
- **Best for**: Creative brainstorming, greenfield design, "what are all our options?" questions. Prevents anchoring on the first idea.
- **Trade-off**: Great for breadth of ideas, but the converger must distill 8 diverse outputs — can miss nuance from individual scouts.
</details>

<details>
<summary><b>⚡ integrate_fire</b> — All specialists think twice, second pass builds on first</summary>

6 specialists each produce an initial analysis, then all refine based on *everyone else's* first-pass findings. Cross-pollination between specialties leads to more robust conclusions.

- **How it works**:
  - **Pass 1**: 6 specialists (Architecture, Performance, Security, DX, Risk, Cost & Maintenance) produce independent analyses
  - **Pass 2**: All 6 refine their analyses after seeing the complete first-pass output — each specialist now considers perspectives they might have missed
  - **Synthesis**: Final arbiter produces the recommendation, addressing points of consensus and disagreement
- **Best for**: Risk/quality assessment, security reviews, decisions where every angle must be double-checked. High-stakes choices.
- **Trade-off**: Most thorough mode but most expensive (13 calls). Use when the cost of a wrong decision exceeds the analysis cost.
</details>

<details>
<summary><b>🌊 dmn_tpn</b> — Free association ↔ focused analysis cycles</summary>

Inspired by neuroscience: alternates between Default Mode Network (free association, no filtering) and Task Positive Network (focused analytical evaluation). Each cycle refines the output.

- **How it works**:
  - **Phase 1 (DMN)**: 3 models brainstorm freely — no judgment, no filtering, stream-of-consciousness
  - **Phase 2 (TPN)**: 5 models rigorously evaluate the free associations — rank by feasibility/impact, cross-reference, identify gaps
  - **Phase 3 (DMN)**: 2 models diverge again — what was missed? What synthesis ideas emerge?
  - **Phase 4 (TPN)**: Final arbiter produces the definitive recommendation
- **Best for**: Open-ended exploration where you don't know what you don't know. "What should we build?", "What's the real problem here?"
- **Trade-off**: Creative but less structured — the output may meander. Best when the problem isn't clearly framed yet.
</details>

---

## API Reference

### `hive_think` parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | `string` | ✅ | — | The exact question to analyze |
| `context` | `string` | | `""` | Full context: conversation summary, constraints, code, trade-offs discussed, your current thinking |
| `models` | `string[]` | | 4×pro + 4×flash | Custom model list. Pass user-specified models here (e.g. `["claude-opus-4-6-thinking"]`). Any pi-compatible provider supported. |
| `mode` | `string` | | `"parallel"` | Thinking paradigm. One of: `parallel`, `global_workspace`, `cortical_column`, `waggle_dance`, `integrate_fire`, `dmn_tpn` |
| `cwd` | `string` | | current directory | Working directory for subprocesses |

### `hive_read` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | `string` | all models | Model name filter (e.g. `"deepseek-v4-pro"`) or index (`"0"`–`"7"`) |
| `extract_answer` | `boolean` | `true` | Extract only the `<ANSWER>...</ANSWER>` section. Set `false` for full output. |
| `offset` | `number` | `0` | Line offset for pagination (only when `extract_answer: false`) |
| `limit` | `number` | `150` | Max lines per model (only when `extract_answer: false`) |

### `/hive` slash command

```
/hive Should we migrate to a monorepo?
```

Invokes `hive_think` with the full input as the question. Use for quick manual brainstorming without typing the full function call.

---

## Architecture

### Subprocess lifecycle

Each model runs as an independent `pi --mode json -p --no-session` subprocess with `--thinking xhigh` and `read,grep,find,ls,bash` tools:

```
spawn → monitor stdout (JSON lines) → detect </ANSWER> → SIGTERM → collect results
```

- **ANSWER early-exit**: The system prompt instructs models to wrap final output in `<ANSWER>...</ANSWER>`. When the orchestrator detects the closing tag, it kills the subprocess immediately — saving expensive thinking tokens that would otherwise be spent on post-recommendation rambling.
- **Per-node timeout**: A node that never emits `</ANSWER>` and never exits is killed after `HIVE_NODE_TIMEOUT_MS` (default **30 min**; SIGTERM → 5s grace → SIGKILL). It becomes a failed result (non-zero exit) rather than hanging the hive — so one stuck DeepSeek subprocess can't block the others.
- **Overall budget**: If the whole `hive_think` call exceeds `HIVE_BUDGET_MS` (default **45 min**), still-running nodes are aborted and whatever completed is returned as a **partial result**. The hive never hangs to the caller's outer timeout (e.g. a CI job limit) with zero output. If nothing finished, the result explicitly tells the agent to proceed on its own.
- **Kill grace**: After any SIGTERM (early-exit, per-node timeout, budget abort, or external cancel), SIGKILL after 5s if the process hasn't exited.
- **Concurrency**: Maximum 4 subprocesses running at once (`mapWithConcurrencyLimit`), respecting API rate limits. Remaining models are queued.

### Timeout configuration

Both timeouts are set via environment variables (read once at load). Set `0` to disable either.

| Env var | Default | Purpose |
|---------|---------|---------|
| `HIVE_NODE_TIMEOUT_MS` | `1800000` (30 min) | Hard cap per node; kills a single stuck subprocess. |
| `HIVE_BUDGET_MS` | `2700000` (45 min) | Hard cap for the whole hive; aborts remaining nodes and returns partial. |

**Invariant**: keep `HIVE_NODE_TIMEOUT_MS < HIVE_BUDGET_MS < your outer (job) timeout`, so a single stuck node is killed first, the budget catches pathological/serial stacking (sequential modes like `cortical_column` run nodes one after another), and the outer timeout never has to fire. Example for a CI job with a 60-min limit: node 30 min / budget 45 min / job 60 min.

### Prompt cache strategy

All models share the same **DeepSeek** provider. The HIVE_SYSTEM_PROMPT (~2.5KB of identical instructions) is sent as the first message to every model — resulting in ~80-95% cache hit rate on the system prompt and shared context. **Using mixed providers breaks this optimization** and increases costs 5-10×.

### Error handling

| Condition | How it manifests |
|-----------|-----------------|
| Model crash (non-zero exit) | `exitCode > 0`, `errorMessage` populated with last stderr line |
| Missing ANSWER tag | Model terminated normally but output has no `<ANSWER>` block — use `hive_read({ extract_answer: false })` to inspect |
| Per-node timeout | `exitCode 124`, `errorMessage: "node timeout after Ns"` — node killed, hive continues |
| Overall budget reached | Remaining nodes aborted; `hive_think` returns a partial result listing the nodes that finished |
| Aborted by user / budget | `exitCode 130`, `errorMessage: "aborted ..."`; parent signal propagated to all child processes |

---

## Cost

| Model | Input ($/M tokens) | Output ($/M) | Cache read ($/M) |
|-------|-------------------|--------------|------------------|
| deepseek-v4-pro | $12.00 | $24.00 | $1.20 |
| deepseek-v4-flash | $1.00 | $2.00 | $0.20 |

With prompt cache active (~80-95% hit rate on shared system prompt and context), a typical `parallel` call (8 models) costs **~$2-3**. Modes with more calls scale roughly linearly:

| Mode | Calls | Typical cost (cached) |
|------|-------|----------------------|
| `parallel` | 8 | ~$2-3 |
| `waggle_dance` | 9 | ~$2-3 |
| `cortical_column` | 7 | ~$2-3 |
| `global_workspace` | 12 | ~$3-5 |
| `dmn_tpn` | 11 | ~$3-5 |
| `integrate_fire` | 13 | ~$4-6 |

> Without cache (e.g., mixed providers or very long contexts), costs are ~5-10× higher. Stick to DeepSeek.

---

## System Prompt Philosophy

Each model receives the `HIVE_SYSTEM_PROMPT`, a structured reasoning framework built on five principles:

1. **First Principles**: Strip assumptions. Reason from fundamentals. Question whether the presented problem is the real problem.
2. **Active Investigation**: Use `read`, `grep`, `find`, `ls`, and `bash` to look up actual code and run tests. Don't guess — verify.
3. **Multi-Perspective**: Examine every problem from at least these angles: user/developer experience, system architecture & maintainability, performance & scalability, security & correctness.
4. **Trade-off Analysis**: Every choice has costs — surface them explicitly with a decision matrix.
5. **Actionable Output**: End with a clear recommendation. No hedging — commit to a position.

The structured output format requires: Problem Restatement → Investigation → Constraints → Approaches (with decision matrix) → Recommendation → Risks & Mitigations, all wrapped in `<ANSWER>...</ANSWER>` for early exit.

---

## Components

| Component | File | Description |
|-----------|------|-------------|
| Main extension | `extensions/hive-think.ts` | Registers `hive_think` tool, 6 mode executors, subprocess orchestration |
| Autopilot | `extensions/hive-think-autopilot.ts` | Injects usage guidance into system prompt via `before_agent_start` hook |
| Result reader | `extensions/hive-read.ts` | Reads model outputs from session with ANSWER extraction + pagination |
| Prompt template | `prompts/hive.md` | `/hive` slash command for manual invocation |

---

## Tests

```bash
node --test test/index.test.js
```

Test suites covering: `formatTokens`, `formatUsageStats`, `getFinalOutput`, `mapWithConcurrencyLimit`, `DEFAULT_MODELS` validation, `ANSWER_END`, parameter validation, `extractAnswer`, `findLastHiveResult`, `modelOutputsFromDetails`, `resolvePositiveMs` (timeout env parsing), `buildPartialOutput` (budget partial-result rendering).

---

## License

MIT
