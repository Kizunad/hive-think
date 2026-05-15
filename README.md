# hive-think

Deep multi-model parallel reasoning for [pi coding agent](https://pi.dev).

Spawns 8 models in parallel (4× **deepseek-v4-pro** + 4× **deepseek-v4-flash**), all with `--thinking xhigh` and read+bash tools. Each model sees the full conversation context and thinks independently. All responses are collected side-by-side for comparison.

Ideal for architecture decisions, complex refactoring, technology choices, or any problem where multiple perspectives reduce blind spots.

## Install

```bash
pi install git:github.com/YOUR_USERNAME/hive-think
```

## Usage

The `hive_think` tool is registered automatically. The autopilot extension injects guidance into every system prompt so the model knows when to use it proactively — no need to ask.

```typescript
// The model will call this automatically when it detects a complex decision:
hive_think({
  question: "Should we use Redis or Kafka for this use case?",
  context: "We need message queue for 10k msg/s with at-least-once delivery..."
})
```

### Opt out of autopilot

If you only want the tool without system prompt injection:

```bash
pi config
# Disable "hive-think-autopilot" in the extensions panel
```

### Read results

After a hive_think call, use `hive_read` to inspect individual model outputs without digging through the raw session file:

```
# Read ANSWER sections from all 8 models
hive_read({})

# Read just the deepseek-v4-pro models' ANSWER
hive_read({ model: "deepseek-v4-pro" })

# Read model at index 3 (0-based)
hive_read({ model: "3" })

# Full output with pagination (instead of ANSWER extraction)
hive_read({ extract_answer: false, offset: 0, limit: 200 })
```

## What's included

| Component | File | Description |
|-----------|------|-------------|
| Main extension | `extensions/hive-think.ts` | Registers `hive_think` tool, spawns 8 parallel pi subprocesses |
| Autopilot | `extensions/hive-think-autopilot.ts` | Injects usage guidance into system prompt |
| Result reader | `extensions/hive-read.ts` | Reads model outputs from session with ANSWER extraction + pagination |
| Prompt template | `prompts/hive.md` | `/hive` slash command for manual invocation |

## Architecture

Each model runs as an independent `pi --mode json -p --no-session` subprocess with:
- `--thinking xhigh` for deep reasoning
- `read, grep, find, ls, bash` tools (read-only investigation)
- Structured output format with `<ANSWER>` delimiter for early exit
- Max 4 concurrent subprocesses to avoid API rate limiting

All models share the DeepSeek provider for consistent prompt cache prefix matching.

## Cost

| Model | Input ($/M) | Output ($/M) | Cache read |
|-------|-------------|--------------|------------|
| deepseek-v4-pro | $12 | $24 | $1 |
| deepseek-v4-flash | $1 | $2 | $0.20 |

With prompt cache active (~80-95% hit rate), typical hive_think call: **~$2-3**.

## Run tests

```bash
node --test test/index.test.js
```
