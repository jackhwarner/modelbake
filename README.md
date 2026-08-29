# modelbake

**Will this model actually run *my* app — and what will it feel like, warm?**

Every eval framework will tell you how a model scores on somebody else's
questions. None of them will tell you whether it will hold your app's contract:
your real system prompt, your exact tool schemas, your production sampling, your
output envelope, at your serving shape, with the prompt cache warm the way it is
in production.

modelbake freezes that contract, runs your app's own cases against any
OpenAI-compatible endpoint, and reports structural correctness plus honest
serving latency.

Its one brand promise: **it refuses to print numbers it cannot verify.** If your
endpoint cannot prove its prompt cache is being hit, the run is labelled
`cold_only` and the report will not show you a warm latency section at all.

- Node ≥ 20, **zero runtime dependencies**, ESM, MIT.
- Works with mlx_lm, llama.cpp, vLLM, SGLang, LM Studio, Ollama's OpenAI shim,
  or any hosted OpenAI-compatible gateway.

---

## What a report looks like

```
  STRUCTURAL   18/20  90.0%
     x arithmetic-no-tool.1  reasoning leaked into visible content
  OBJECTIVE    38/44 checks  86.4%
     x complete-needs-lookup.1  tool_called(list_todos)  actual complete_todo
     x greeting.1  max_words(25)  actual 42 words
  by category
     tools               10/10     100.0%
     restraint           8/12      66.7%
  LATENCY  warm  (20 rows with verified cache coverage)
```

Named failures, not scores — you see *which case* broke and *how*. And the warm
section only prints because every one of those 20 rows proved its cache
coverage from its own usage payload. A champion-vs-challenger diff and a
pre-committed `--bar` verdict sit on top of this.

---

## Point your agent at this

modelbake is agent-operated by design. You are probably reading this inside
Claude Code, Codex, Cursor or similar, and the hard part of a bakeoff is not
running it — it is extracting your app's real contract out of your codebase.
That is a job for an agent with the repo in context.

```bash
cd your-app
npx modelbake init
```

That writes `contract.json`, `cases.json` and **`AGENTS.md`**. Then say to your
agent:

> Read AGENTS.md and follow it.

`AGENTS.md` is a brief written for the agent, not for you. It tells it to find
where your app builds its model request, copy the real system prompt (not a
paraphrase, and with the volatile parts pinned), serialise the exact tool array,
read the production sampling values, and draft 12–20 cases from your app's real
flows for you to curate.

The division of labour matters: **the tool validates shapes strictly, the agent
does the extraction, and you curate the cases.** modelbake can tell your agent
that a tool schema is malformed. It cannot tell whether the prompt it pasted is
the one that ships. That part stays with people.

---

## The loop

```bash
# 1. Freeze the contract and write the cases (see above).

# 2. Run a lane per candidate. Same contract, same cases, one endpoint each.
npx modelbake run \
  --contract contract.json --cases cases.json \
  --base-url http://localhost:8081/v1 --model my-org/model-a --label champion --reps 3

npx modelbake run \
  --contract contract.json --cases cases.json \
  --base-url http://localhost:8081/v1 --model my-org/model-b --label challenger --reps 3

# 3. Compare.
npx modelbake report results/champion.jsonl results/challenger.jsonl --bar bar.json

# 4. Grade what a machine cannot.
npx modelbake blind out/ results/champion.jsonl results/challenger.jsonl --rubric rubric.md
```

### What `run` records

One JSONL row per case × rep, plus a meta row stamping the contract SHA, the
cases SHA, the model, the sampling and the timestamp. Each result row carries:

- **visible content**, with inline `<think>` blocks split out as reasoning;
- **reasoning**, from both `reasoning_content` deltas and inline tags;
- **merged tool-call deltas**, with a per-call JSON parse error if the arguments
  did not survive the stream;
- **finish reason**, usage, and cached-token accounting;
- **split timings** — `firstEventMs`, `firstReasoningMs`, `firstVisibleMs`,
  `firstToolMs`, `totalMs`.

`firstVisibleMs` is the one that matters and the one that is easy to fake. An
empty SSE choice is not speech. A think block is not speech. modelbake counts
neither, and it handles a `<think>` tag split across chunk boundaries, which a
naive per-delta `indexOf` silently misses.

Case order rotates per rep, so no case always sits first.

### Warm mode — the differentiator

Before the cases, modelbake sends a **non-streaming** prime per system variant
(your exact prefix + a trivial user turn, `max_tokens: 1`), then a verification
probe. It reads cached tokens from whichever field your server actually exposes
and records which one it read.

If verified coverage ≥ 90% of the primed prefix, the lane runs warm and every
row is stamped `warmValid` from **its own** usage — not from the lane's. If the
endpoint cannot prove caching, the run proceeds and is labelled `cold_only`, and
`report` refuses to print a warm-latency section for that file. Warm and cold
are never mixed, and a warm number is never inferred.

Cached-token fields modelbake understands:

| field | servers | status |
| --- | --- | --- |
| `usage.prompt_tokens_details.cached_tokens` | OpenAI, mlx_lm, llama.cpp, vLLM (needs `--enable-prompt-tokens-details`), SGLang (needs `return_cached_tokens_details`) | documented, and measured on mlx_lm |
| `timings.cache_n` | llama.cpp | documented |
| `usage.prompt_cache_hit_tokens` | DeepSeek | documented |
| `usage.cache_read_input_tokens` | Anthropic-shaped proxies | **assumed, not verified** — a run resolving here is flagged |

vLLM has open bugs where `prompt_tokens_details` stays null even with the flag
([#44961](https://github.com/vllm-project/vllm/issues/44961),
[#44377](https://github.com/vllm-project/vllm/issues/44377)). When that happens
you get an honest `cold_only` run, not a fabricated warm one.

### Two serving facts, encoded as behaviour

These were discovered by measurement, not by reading docs, and they are the
reason warm mode is built the way it is:

1. **Some servers do not store a cache entry for a streamed generation.**
   Measured on mlx-lm 0.31.3: an all-streaming lane reported `cached_tokens: 0`
   on every request; one `stream: false` request made every later streamed
   request hit 9,939 cached tokens. So **primes are non-streaming**, always.
2. **Some servers treat per-request `chat_template_kwargs` as a cache bypass.**
   Same server: with the kwarg per request, `cached_tokens: 0` and a full 23s
   prefill every turn; with the template configured at server launch instead,
   the same prefix reused in ~400ms. So template configuration belongs in your
   **server launch flags**, and modelbake warns if your contract carries
   per-request template kwargs.

### Assertions

Cases assert structural claims a machine can settle without an opinion:

`no_tool` · `tool_called` · `tool_not_called` · `tool_argument` ·
`tool_argument_matches` · `content_matches` · `content_not_matches` ·
`max_words` · `envelope_present` · `envelope_absent` · `envelope_field` ·
`envelope_field_matches` · `envelope_max_words`

**Envelopes** are how your app's own output format becomes checkable. Declare a
regex in the contract, then assert on its captured fields:

```json
"envelopes": {
  "card": {
    "pattern": "<card\\b([^>]*)>([\\s\\S]*?)</card>",
    "fields": {
      "attrs": { "group": 1, "parse": "attributes" },
      "body":  { "group": 2 },
      "lead":  { "before": true }
    }
  }
}
```

```json
{ "type": "envelope_field", "envelope": "card", "field": "attrs.title", "value": "This week" }
```

Every row also passes or fails a **structural gate**: no transport error, no
tool-argument parse failure, no reasoning leaked into visible content. Those
three mean "the app could not have used this output at all", which is a
different thing from "this output was not what I hoped".

### `report`

Per lane: pass rates with every failure named, p50/p90 for all five split
timings, tok/s, cache-hit stats, warm and cold kept apart, and a diagnostics
line for truncation and transport errors. Two or more files add a
champion-vs-challenger table with per-metric deltas and regressions flagged.

The comparison **refuses** to run if the lanes used different contracts or
different cases — different questions do not have comparable answers. It omits
latency rows if any lane never proved warm.

`--json` emits the whole analysis as structured data, which is what your agent
should read.

### `--bar`: pre-commitment as a feature

Write down what "good enough" means *before* you see any numbers:

```json
{
  "version": 1,
  "phase": "warm",
  "structuralPassRate": 0.98,
  "objectivePassRate": 0.9,
  "latency": {
    "firstVisibleMs": { "p50": 1500, "p90": 3000 },
    "totalMs": { "p90": 20000 }
  },
  "requiredCases": ["checkout-happy-path"],
  "minSemanticDelta": 0.1
}
```

`report --bar bar.json` stamps the file's SHA-256 and declares PASS / FAIL /
INCOMPLETE per criterion. A criterion this version cannot judge — like
`minSemanticDelta`, which needs human grading — comes back **NOT EVALUATED** and
makes the verdict INCOMPLETE. It never defaults to pass. `report` exits 1 if any
lane FAILs, so a bar works in CI.

### `blind`

```bash
npx modelbake blind out/ results/champion.jsonl results/challenger.jsonl --rubric rubric.md
```

Writes label-stripped packets (`M1`, `M2`, …) as Markdown for a human and JSON
for an LLM, plus `key.json` you do not open until your scores are written down.
Masking is deterministic and one mask means the same lane in every packet.

**v1 does not grade.** The packet is the product. An automated judge is a model
whose failure modes would silently become the bakeoff's failure modes, and this
tool's whole claim is that it does not print numbers it cannot stand behind.

---

## Try it with no model at all

```bash
git clone <this repo> && cd modelbake
node test/helpers/mock-server.mjs --port=8099 --delta-ms=2
```

In another shell:

```bash
node bin/modelbake.mjs run --contract examples/todo-app/contract.json --cases examples/todo-app/cases.json --base-url http://127.0.0.1:8099/v1 --model mock-1 --label champion --reps 2 --out results/champion.jsonl
node bin/modelbake.mjs report results/champion.jsonl --bar examples/todo-app/bar.json
```

`examples/` has two complete generic apps — a todo app with tools and an output
envelope, and a support bot with no tools at all. See
[examples/README.md](examples/README.md).

---

## Things worth knowing before you trust a number

- **One round per case, no tool execution.** modelbake sends one request and
  records what comes back. It does not run your tools and continue the loop. To
  test behaviour *after* a tool result, put the assistant tool call and the tool
  result in the case's `messages` — that is exactly what the model would see.
- **Point lanes at an offline server.** Some servers honour the `model` field
  per request and will unload a live checkpoint to fetch the one you named. Do
  not aim a bakeoff at production.
- **A green structural score is not a good model.** It means the output was
  usable. Whether it was *right* is what `blind` is for.
- **`contract.json` contains your production system prompt.** The default
  `.gitignore` keeps result files out of git; the contract is your call.

## Commands

Run `npx modelbake help` for the full flag list.

## Development

```bash
npm test
```

120 tests, no dependencies, no network: fixture-driven SSE streams (think blocks,
tool deltas split across chunks, missing usage, a 4xx endpoint) plus a mock
OpenAI server that reproduces both serving facts above.

[DESIGN.md](DESIGN.md) records every decision and, for each thing deliberately
left out, the condition under which it goes in.

## License

MIT © Jack Warner
