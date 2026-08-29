# modelbake

modelbake is a command-line tool that tests language models against your
application's real prompt, tool schemas, and serving setup. You freeze the
app's contract into a file, write test cases from the app's actual flows, and
run the same cases against any OpenAI-compatible endpoint: a new checkpoint,
a different quantization, a config change. The report shows structural pass
rates with each failure named, latency split into stages, and token-level
cache accounting.

Generic benchmarks measure a model against someone else's questions. modelbake
measures whether a candidate holds up under your system prompt, your tools,
and your sampling parameters, at the latency you would actually get with the
prompt cache warm. When an endpoint can't prove its cache was hit, the run is
labelled `cold_only` and the report omits warm latency for that file rather
than printing a number it can't back.

Node ≥ 20, zero runtime dependencies, ESM, MIT. Tested against mlx_lm and the
mock server in this repo; speaks to llama.cpp, vLLM, SGLang, LM Studio,
Ollama's OpenAI shim, or any OpenAI-compatible gateway.

## Example report

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

Failures are named per case, so you can see which behavior broke and how. The
`warm` label above means all 20 rows proved their cache coverage from their
own usage payloads. `report` can also diff two lanes (champion vs challenger)
and check results against a bar file you wrote before running.

## Setup

The hard part of a bakeoff is extracting your app's real contract: the final
interpolated system prompt, the exact tool array, the production sampling
values. If you work with a coding agent (Claude Code, Codex, Cursor),
that extraction is a job it can do with the repo in context:

```bash
cd your-app
npx modelbake init
```

This writes `contract.json`, `cases.json`, and `AGENTS.md`. Then tell your
agent:

> Read AGENTS.md and follow it.

`AGENTS.md` instructs the agent to find where your app builds its model
request, copy the real system prompt (not a paraphrase, with volatile parts
pinned), serialize the exact tool array, read the production sampling values,
and draft 12–20 cases from your app's real flows.

modelbake validates the file shapes strictly. It can tell your agent that a
tool schema is malformed; it cannot tell whether the pasted prompt is the one
that ships. Review the contract and curate the cases yourself.

## Usage

```bash
# Run a lane per candidate. Same contract, same cases, one endpoint each.
npx modelbake run \
  --contract contract.json --cases cases.json \
  --base-url http://localhost:8081/v1 --model my-org/model-a --label champion --reps 3

npx modelbake run \
  --contract contract.json --cases cases.json \
  --base-url http://localhost:8081/v1 --model my-org/model-b --label challenger --reps 3

# Compare, optionally against a pre-written bar.
npx modelbake report results/champion.jsonl results/challenger.jsonl --bar bar.json

# Emit label-stripped packets for human or LLM grading.
npx modelbake blind out/ results/champion.jsonl results/challenger.jsonl --rubric rubric.md
```

### What `run` records

One JSONL row per case × rep, plus a meta row stamping the contract SHA, cases
SHA, model, sampling, and timestamp. Each row carries:

- visible content, with inline `<think>` blocks separated out as reasoning
- reasoning, from `reasoning_content` deltas and inline tags
- merged tool-call deltas, with a per-call parse error if the arguments did
  not survive the stream
- finish reason, usage, and cached-token accounting
- five timings: `firstEventMs`, `firstReasoningMs`, `firstVisibleMs`,
  `firstToolMs`, `totalMs`

The timing split exists because time-to-first-byte overstates responsiveness:
a model can emit an empty SSE choice or several seconds of `<think>` tokens
before a user sees anything. `firstVisibleMs` counts only non-reasoning
content, and the parser handles a `<think>` tag split across chunk
boundaries, which a per-delta `indexOf` misses.

Case order rotates per rep so no case always runs first.

### Warm mode

Before the cases, modelbake sends a non-streaming prime per system variant
(your exact prefix plus a trivial user turn, `max_tokens: 1`), then a
verification probe. It reads cached tokens from whichever usage field your
server exposes and records which field it read.

If verified coverage is ≥ 90% of the primed prefix, the lane runs warm, and
each row is stamped `warmValid` from its own usage rather than the lane's —
so a mid-run cache eviction shows up as cold rows instead of skewing the warm
percentiles. If the endpoint can't prove caching, the run proceeds as
`cold_only` and `report` omits the warm section for that file.

Cached-token fields modelbake understands:

| field | servers | status |
| --- | --- | --- |
| `usage.prompt_tokens_details.cached_tokens` | OpenAI, mlx_lm, llama.cpp, vLLM (needs `--enable-prompt-tokens-details`), SGLang (needs `return_cached_tokens_details`) | documented; measured on mlx_lm |
| `timings.cache_n` | llama.cpp | documented |
| `usage.prompt_cache_hit_tokens` | DeepSeek | documented |
| `usage.cache_read_input_tokens` | Anthropic-shaped proxies | assumed, not verified — a run resolving here is flagged |

vLLM has open bugs where `prompt_tokens_details` stays null even with the
flag enabled ([#44961](https://github.com/vllm-project/vllm/issues/44961),
[#44377](https://github.com/vllm-project/vllm/issues/44377)). A lane hitting
that reports `cold_only`.

### Two server behaviors worth knowing

Both were found by measurement while building this, and both shaped the
design:

1. Some servers do not store a cache entry for a streamed generation. On
   mlx-lm 0.31.3, an all-streaming lane reported `cached_tokens: 0` on every
   request; a single `stream: false` request made every later streamed
   request hit 9,939 cached tokens. This is why primes are non-streaming.
2. Some servers treat per-request `chat_template_kwargs` as a cache bypass.
   On the same server, sending the kwarg per request produced
   `cached_tokens: 0` and a full 23-second prefill on every turn; setting the
   same template configuration in the server's launch flags reused the prefix
   in about 400 ms. modelbake warns if your contract carries per-request
   template kwargs.

### Assertions

Cases assert claims a machine can settle without judgment:

`no_tool` · `tool_called` · `tool_not_called` · `tool_argument` ·
`tool_argument_matches` · `content_matches` · `content_not_matches` ·
`max_words` · `envelope_present` · `envelope_absent` · `envelope_field` ·
`envelope_field_matches` · `envelope_max_words`

Envelopes let you check your app's own output format. Declare a regex in the
contract, then assert on its captured fields:

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

Separately from assertions, every row passes or fails a structural gate: no
transport error, no tool-argument parse failure, no reasoning leaked into
visible content. A structural failure means the app could not have used the
output at all, which is a different problem from the output being wrong.

### `report`

Per lane: pass rates with each failure named, p50/p90 for all five timings,
tokens per second, cache-hit stats, and a diagnostics line for truncation and
transport errors. Given two or more files, it adds a champion-vs-challenger
table with per-metric deltas and flags regressions.

The comparison refuses to run if the lanes used different contracts or
different cases, and it omits latency comparison rows if any lane never
proved warm. `--json` emits the full analysis as structured data for an agent
or a script to consume.

### Bars

A bar file records what "good enough" means, written before you see results:

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

`report --bar bar.json` stamps the bar file's SHA-256 into the output and
declares PASS, FAIL, or INCOMPLETE per criterion. A criterion this version
cannot judge (`minSemanticDelta` needs human grading) returns NOT EVALUATED
and makes the verdict INCOMPLETE rather than defaulting to pass. `report`
exits 1 on any FAIL, so a bar works as a CI gate.

### `blind`

```bash
npx modelbake blind out/ results/champion.jsonl results/challenger.jsonl --rubric rubric.md
```

Writes label-stripped transcript packets (`M1`, `M2`, …) as Markdown for
human grading and JSON for LLM grading, plus a `key.json` mapping masks back
to lanes. Masking is deterministic; one mask means the same lane in every
packet.

This version does not grade. An automated judge inherits the judge model's
failure modes, and shipping one without a measured agreement rate against
human-graded packets would undercut the accounting the rest of the tool does.
DESIGN.md records the condition for adding one.

## Trying it without a model

```bash
git clone https://github.com/jackhwarner/modelbake && cd modelbake
node test/helpers/mock-server.mjs --port=8099 --delta-ms=2
```

In another shell:

```bash
node bin/modelbake.mjs run --contract examples/todo-app/contract.json --cases examples/todo-app/cases.json --base-url http://127.0.0.1:8099/v1 --model mock-1 --label champion --reps 2 --out results/champion.jsonl
node bin/modelbake.mjs report results/champion.jsonl --bar examples/todo-app/bar.json
```

`examples/` contains two complete generic apps: a todo app with tools and an
output envelope, and a support bot with no tools. See
[examples/README.md](examples/README.md).

## Limitations

- One round per case, no tool execution. modelbake sends one request and
  records the response; it does not run your tools and continue the loop. To
  test behavior after a tool result, put the assistant tool call and the tool
  result into the case's `messages` — that matches what the model would see
  in the real loop.
- Run lanes against a dedicated offline server. Some servers honor the
  `model` field per request and will unload a live checkpoint to fetch the
  one named. Don't point a bakeoff at production.
- A passing structural score means the output was usable, not that it was
  good. Semantic quality is what `blind` grading is for.
- `contract.json` contains your production system prompt. The default
  `.gitignore` excludes result files; whether to commit the contract is your
  call.

## Commands

`npx modelbake help` prints the full flag list.

## Development

```bash
npm test
```

120 tests, no dependencies, no network: fixture-driven SSE streams (think
blocks, tool deltas split across chunks, missing usage, a 4xx endpoint) and a
mock OpenAI-compatible server that reproduces both cache behaviors described
above.

[DESIGN.md](DESIGN.md) records the design decisions, what was deliberately
left out, and the condition under which each omission goes in.

## License

MIT © Jack Warner
