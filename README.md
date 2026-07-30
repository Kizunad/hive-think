# 🐝 hive-think

Deep multi-model reasoning for [pi coding agent](https://pi.dev).

One tool, one workflow: **take the question apart to first principles, vote on which problems are real, propose solutions, vote again.** Every node is a peer — consensus does the arbitrating, so no single model's opinion decides the outcome.

Built for architecture decisions, refactoring strategy, technology choices, and anything where a confident wrong answer is expensive.

---

## Install

```bash
pi install git:github.com/Kizunad/hive-think
```

Then **configure a model roster** — hive-think ships no defaults:

```bash
# project-local (wins, and can be committed for a team)
cat > .hive-think.json <<'EOF'
{
  "models": ["provider/model-a", "provider/model-b", "provider/model-c"]
}
EOF
```

Run `pi models` to see the ids your installation resolves.

### Why there are no default models

A node is spawned as `pi --model <id>`. Provider-qualified ids like `cliproxy/deepseek-v4-flash` only resolve inside the pi installation that has that provider configured — so any roster shipped in the package is one person's setup and a hard error for everyone else. An unconfigured hive tells you how to configure it and tells the agent to stop calling it; it never guesses a model.

---

## The workflow

```
0  解剖 dissect        3 nodes, full thinking
   Each node independently decomposes the question into claims that can
   actually be checked. ≤3 levels deep; every leaf must be verifiable
   against code, config, data, or a command's output.
   Nodes read, grep, and run tests — they do not decompose from imagination.

1  归并 merge          1 node, cheap
   Restatements of one problem collapse into a single candidate list.
   This step may ONLY merge. It cannot drop a proposition it disagrees
   with, because that would remove it from the vote — a decision this
   step is not allowed to make.

   ── fan-out decided here: 3-10 nodes, from how many distinct problems
      decomposition found and how deep it had to go ──

2  vote                N nodes, cheap
   Every node votes yes/no on that same list. Real and material, or not.

3  解法 solve           N nodes, full thinking
   Solutions for the problems that passed. Each solution declares which
   propositions it addresses, and whether it is an alternative to another
   (a shared `mutexGroup`) or an independent improvement.

4  vote                N nodes, cheap
   Independent solutions each face the threshold.
   Alternatives are decided by relative majority, with the split shown.
```

### Why the fan-out is decided in the middle

Any node count chosen before decomposition is a guess. After stage 1 the hive knows how many distinct problems exist and how far it had to dig, which is exactly what determines how many independent judgements are worth paying for. Stage 0 therefore runs at the floor (3 nodes) — the cheapest way to learn how wide the rest should be.

### Why consensus instead of an arbiter

Earlier designs designated one node as arbiter or synthesizer. That silently downgrades the entire result whenever that slot draws a weak model, and it forces the roster to be tiered (which models are "strong" enough to arbitrate?). Voting removes the privileged slot, which is why the roster is a **flat list** — and why a 2-model roster works fine: nodes are drawn round-robin.

---

## Reading the output

```
🐝 Hive Think — 23/24 nodes over 5 stages in 412.3s
Fan-out: 5 propositions at depth 3 → 6 nodes
Threshold: 60% (actual support shown per item)

## Problems (2/4 confirmed)

✅ `token-file-reread` — handleAuth() re-reads /etc/token on every request — 5/6 (83%, needed 4 = 67%)
    evidence: src/auth.ts:88
✅ `no-expiry-test` — No test exercises the expired-token path — 4/6 (67%, needed 4 = 67%)
❌ `logging-too-verbose` — Debug logs dominate output — 2/6 (33%, needed 4 = 67%)
❌ `db-pool-undersized` — Pool of 4 is too small — 2/3 (67%, needed 2 = 67%, 3 abstained)

## Solutions — independent

✅ `add-expiry-test` — Add test/auth.expiry.test.ts covering the expired-token branch — 6/6 (100%, needed 4 = 67%)

## Solutions — alternatives: token-strategy

1. `cache-token-in-memory` — 3/6 (50%) ◀ relative majority
    Read /etc/token once into a module-level cache, invalidate on SIGHUP
2. `mmap-token-file` — 2/6 (33%)
3. `reread-but-stat-first` — 1/6 (17%)

---
**Carried by the hive**: add-expiry-test, cache-token-in-memory
**Cost**: 47 turns ↑1.2M ↓89k R980k $2.1400
```

Three things worth reading carefully:

**Actual support, not just the pass mark.** With at most ten ballots the *effective* threshold drifts from the nominal one, so every line shows the real count, the real percentage, and the bar that was actually applied. At a nominal 60%:

| Nodes voting | Votes needed | Effective threshold |
|---|---|---|
| 3 | 2 | 67% |
| 4 | 3 | **75%** |
| 5 | 3 | 60% |
| 6 | 4 | 67% |
| 7 | 5 | 71% |
| 8 | 5 | 63% |
| 9 | 6 | 67% |
| 10 | 6 | 60% |

N=4 needing 75% is inherent to small integer ballots — it cannot be tuned away, only disclosed.

**Abstentions and thin samples.** A node that crashed is excluded from the denominator rather than counted as a "no" — a dead node is not a dissenting opinion. But an item cannot pass on fewer than 3 actual voters no matter the percentage (2/2 is 100% and means nothing), and that floor is measured against the nodes *dispatched*, not the ones that survived. The `db-pool-undersized` line above shows the shape: 67% support, still rejected, because 3 nodes never voted on it.

**An unresolved group is a real answer.** A 3:2:1 split means the hive genuinely found no majority among mutually exclusive options. The split is the useful output; breaking the tie is the calling agent's job.

---

## API

### `hive_think`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `question` | `string` | required | The question to analyze |
| `context` | `string` | `""` | Conversation background, constraints, code, what you already tried, your current thinking. Drives decomposition quality — nodes can grep for what you missed, but not for constraints never written down. |
| `models` | `string[]` | configured roster | Override the roster for this call. Pass models the user named. |
| `thinking` | `"low"｜"medium"｜"high"｜"xhigh"` | configured | Depth for the dissect and solve stages. Voting stages always run cheap. |
| `maxNodes` | `number` | configured max | Lower the fan-out ceiling when cost matters more than confidence. |
| `cwd` | `string` | current directory | Working directory for node subprocesses |
| `async` | `boolean` | `false` | Run in background; returns a sessionId immediately |

### `hive_read`

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sessionId` | `string` | — | Read a background hive instead of session history |
| `model` | `string` | all nodes | Model-name substring, or node index as shown in `[n]`. A roster repeats models across stages, so a name match returns every node that ran it. |
| `extract_answer` | `boolean` | `true` | Only the `<ANSWER>` section. `false` for full paginated output. |
| `offset` / `limit` | `number` | `0` / `150` | Line pagination, when `extract_answer: false` |

### Background hives

`hive_status({ sessionId })`, `hive_list()`, `hive_abort({ sessionId })`.

Max 5 concurrent hives; launching a sixth retires the oldest running one. Subprocess slots are shared process-wide, so background hives and a foreground call cannot multiply past the cap. Results expire 5 minutes after completion if never collected — and collecting is destructive.

### `/hive` slash command

```
/hive Should we migrate to a monorepo?
```

---

## Configuration

JSON only — there are no environment variables for the roster. Searched most-specific first; the first file found is used, and a file that exists but is broken is reported rather than skipped.

1. `<cwd>/.hive-think.json`
2. `$XDG_CONFIG_HOME/pi/hive-think.json` (or `~/.config/pi/hive-think.json`)

```json
{
  "models": ["provider/model-a", "provider/model-b", "provider/model-c"],
  "nodes": { "min": 3, "max": 10 },
  "threshold": 0.6,
  "thinking": "xhigh"
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `models` | ✅ | — | Flat list of pi model ids. No tiers. Nodes drawn round-robin, so fewer entries than nodes is fine. |
| `nodes.min` / `nodes.max` | | `3` / `10` | Fan-out bounds, each 3-10 |
| `threshold` | | `0.6` | A **fraction**, not a percentage — `0.6`, not `60`. See the effective-threshold table above for why 0.6 rather than 0.65. |
| `thinking` | | `"xhigh"` | Depth for dissect and solve |

---

## Timeouts

| Env var | Default | Purpose |
|---|---|---|
| `HIVE_NODE_TIMEOUT_MS` | `1800000` (30 min) | Kills one stuck node; the hive continues |
| `HIVE_BUDGET_MS` | `2700000` (45 min) | Aborts remaining nodes, returns the stages that finished |

Set either to `0` to disable. Keep `HIVE_NODE_TIMEOUT_MS < HIVE_BUDGET_MS < your outer job timeout`, so a single stuck node is killed first, the budget catches pathological stacking across five sequential stages, and the job timeout never has to fire.

A budget abort is not an error: the hive returns whatever the completed stages produced, labelled with where it stopped. If nothing finished, it says so explicitly and tells the agent to proceed unaided rather than retry.

---

## Architecture

| File | Role |
|---|---|
| `extensions/hive-config.ts` | Config discovery, validation, and the unconfigured-state message. No pi deps. |
| `extensions/hive-util.ts` | Pure helpers: ANSWER extraction, formatting, concurrency, semaphore. No pi deps. |
| `extensions/aggregation-engine.ts` | Parsing, merging, and all vote math. No pi deps. |
| `extensions/hive-runner.ts` | One node = one `pi` subprocess. Spawn, early exit, timeouts, kill escalation. |
| `extensions/hive-pipeline.ts` | The five stages, plus outcome rendering. Driven by both the sync and background paths. |
| `extensions/hive-think.ts` | Tool registration, parameters, TUI rendering |
| `extensions/background-manager.ts` | Background sessions: budgets, TTL, crash recovery, notifications |
| `extensions/hive-read.ts` | Per-node output with ANSWER extraction and pagination |
| `extensions/hive-think-autopilot.ts` | Injects usage guidance — degrades to setup instructions when unconfigured |

### Node lifecycle

```
spawn → stream JSON lines → detect </ANSWER> → SIGTERM → 5s grace → SIGKILL
```

**ANSWER early exit.** Nodes wrap their output in `<ANSWER>...</ANSWER>`. The moment the closing tag lands, the subprocess is killed — everything after a node's conclusion is thinking tokens paid for and thrown away.

**Task payload over stdin.** A long context as an argv entry trips `E2BIG` (`MAX_ARG_STRLEN` is 128KB), so the prompt goes over stdin.

**Process-wide concurrency.** All nodes pass through one FIFO semaphore (4 slots), so concurrent hives share the cap instead of each enforcing their own.

### Failure modes

| Condition | How it surfaces |
|---|---|
| Node crash | `exitCode > 0`, `errorMessage` from the last stderr line |
| Per-node timeout | `exitCode 124`, `errorMessage: "node timeout after Ns"` — hive continues |
| Budget reached | Remaining nodes aborted; stages that finished are returned, labelled partial |
| Aborted | `exitCode 130`; signal propagated to every child |
| No parseable decomposition | Halts at stage 0 and says to inspect raw output with `hive_read({ extract_answer: false })` |
| Nothing passes the problem vote | A real result: the hive does not agree there is a confirmed problem |
| No parseable solutions | Confirmed problems are still returned |

---

## Tests

```bash
node --test test/index.test.js    # requires Node >= 22.18 (native TS type stripping)
```

103 tests over `hive-util`, `hive-config`, and `aggregation-engine`, importing the real modules.

Note for contributors: this package is loaded as TypeScript at runtime and never compiled, so it must stay compatible with Node's **strip-only** type removal — no `enum`, no `namespace`, no constructor parameter properties (`constructor(private x: T)`).

---

## License

MIT
