# DESIGN.md

Every decision in modelbake v1, why it was made, and — for the things left out —
the condition under which they go in.

The tool has one claim: **it does not print numbers it cannot verify.** Most of
what follows is that claim applied to a specific question.

---

## 1. Why this exists

Eval frameworks answer "how good is this model?" Nobody answers "will this model
hold *my* contract, at *my* serving shape?" Those are different questions, and
the second one is the one that decides whether you can ship a checkpoint.

A bakeoff that changes the prompt, drops the tools, or measures a cold prefill is
not measuring your app. modelbake's job is to make the contract the fixed thing
and the model the variable.

## 2. The contract is the unit of comparison

**Decision.** A run is defined by a `contract.json` holding 1..N named system
prompts, the exact tool array, sampling, tool choice, and optional output
envelopes. Every result file stamps a SHA of it.

**Why 1..N variants, not two.** The private harness this generalizes hardcoded
`text` and `voice`. Real apps have other splits: with-tools and without, free
tier and paid, one prompt per locale. Variants are a map, cases name one, and
warm mode primes each variant that the selected cases actually use.

**Why two SHAs.** `contractSha` covers only what the model receives —
systemVariants, tools, sampling, toolChoice, requestOverrides — canonicalised
with sorted keys so reformatting does not change it. `contractFileSha` covers the
raw bytes. Two lanes are comparable if and only if `contractSha` matches;
`contractFileSha` lets a report say "same contract, edited notes". Hashing the
whole file for comparability would make a typo fix in a description invalidate a
week of runs.

**Why validation is strict.** The agent does the extraction; the tool is the only
thing that can catch a malformed extraction before an hour of GPU time is spent
on it. A misspelled `temprature` that silently does nothing is exactly the class
of bug that makes a bakeoff lie, so unknown sampling keys are an error, not a
pass-through. Server-specific knobs go in `sampling.extra`, which is explicit.

## 3. Agent-operated by design

**Decision.** `init` scaffolds `contract.json`, `cases.json` and an `AGENTS.md`
written for the user's coding agent, not for the user. The private version had
a `capture.mjs` that imported the app's own prompt builder; that cannot
generalize, because every app assembles its request differently.

**Why this is better than a capture script.** An agent with the repo in context
can follow the request all the way to the outbound HTTP call, which is the only
place the truth lives. A generic capture script would have to guess.

**What AGENTS.md insists on**, because these are the ways extraction goes wrong:

- copy the *final interpolated* string, not the template;
- pin volatile parts (dates, user names, retrieved memories) to a fixed value,
  because a changing prefix breaks comparability *and* silently turns every warm
  measurement into a cold one;
- do not tidy the prompt — typos are part of what the model must handle;
- draw cases from logs, tests and fixtures, not from imagination;
- do not write `bar.json` (that is the human's pre-commitment);
- do not tune the contract until a model passes, which inverts the exercise.

**The scaffold validates but fails loudly.** `contract.json` ships with `TODO:`
markers that trip a warning, and `cases.json` asserts on a tool name the empty
contract does not declare, so `run --dry-run` exits 2 until real extraction has
happened. A scaffold that quietly ran would be worse than one that refuses.

## 4. Split timings, and what counts as speech

**Decision.** Five timings per row: `firstEventMs`, `firstReasoningMs`,
`firstVisibleMs`, `firstToolMs`, `totalMs`.

**Why `firstVisibleMs` is separate from `firstEventMs`.** A single "TTFT" number
is the easiest thing in this whole tool to get wrong. An empty SSE choice
arrives before any text. A reasoning block arrives before any speech. Both look
like "first token" to a naive timer, and both would let a model that thinks for
four seconds report a 200ms TTFT. `firstVisibleMs` is the number a user feels.

**Why the reasoning splitter is its own module with its own tests.** Inline
`<think>` tags can split across chunk boundaries — `<thi` at the end of one
delta, `nk>` at the start of the next. A per-delta `indexOf('<think>')` misses
that, classifies the whole reasoning block as speech, and reports a
first-token latency that is real but measures the wrong thing. The splitter
holds back any suffix that could be a partial tag, which costs at most one chunk
of delay and is the only correct answer. Tag pairs are configurable; a stream
that ends mid-block is reported `reasoningUnterminated` rather than being
silently assigned to either channel.

**Why leak detection is regex-based and configurable.** Once balanced tags are
split out, the visible channel by construction contains no tags — so a
tag-scanning leak check would always pass. The real failure is planning prose
arriving *untagged* in the visible stream, which only the app knows how to
recognise. `reasoning.leakPatterns` defaults to unbalanced tag literals and apps
add their own.

## 5. Tool-call delta merging

**Decision.** `id` and `name` are set-once-then-idempotent; `arguments` always
append; a delta with no `index` continues the last open call unless it carries a
different id.

**Why.** Servers disagree on things the OpenAI spec does not pin down. Some send
id and name once and chunk only the arguments; some repeat the identical id and
name on every delta. Blind concatenation turns the second group into
`call_1call_1call_1`. Defaulting a missing `index` to 0 merges a second tool call
into the first. Both are silent corruption that would show up as a fake
tool-argument failure.

**Arguments that parse to an array or a scalar are a failure**, not a success,
because a tool takes an object. This is recorded as `argumentError` and fails the
structural gate.

## 6. Warm mode

**Decision.** Non-streaming prime per variant → verification probe → mode. If
verified coverage ≥ 90% (configurable) of the primed prefix, run warm with a
per-row `warmValid`; otherwise run `cold_only` and refuse warm output.

**Why primes are non-streaming.** Measured on mlx-lm 0.31.3: streamed
generations never stored a prompt-cache entry, so an all-streaming lane reported
`cached_tokens: 0` on every request, while one `stream: false` request made every
later streamed request hit 9,939 tokens. A harness that primes with a streamed
request is measuring cold and calling it warm. The mock server reproduces this
(`storeOnStream: false`) and a test asserts it, so the warm test is not circular.

**Why per-request `chat_template_kwargs` is a warning.** Same server: the kwarg
per request produced `cached_tokens: 0` and a full 23s prefill every turn; the
identical request against a server launched *with* the corresponding flag reused
the prefix in ~400ms. Template configuration belongs in the server launch, and
production sends no per-request kwargs — so a lane that does is not measuring
production. Modelled in the mock as `templateKwargsBypass` and tested.

**Why `warmValid` is per row, not per lane.** Prompt caches evict. A lane that
verified at the start can lose the prefix halfway through, and a lane-level flag
would launder those rows into the warm percentiles. Each row proves its own
coverage from its own usage, and rows that fail are excluded and counted
visibly. Re-priming every 8 cases (configurable) reduces how often this happens
without pretending it cannot.

**Why degrade rather than abort.** The private version hard-stopped with a
`METHODOLOGY-STOP` record and exit 3. That is right for a known lab; it is wrong
for a stranger's first run against an unfamiliar server. Correctness numbers are
still worth having when latency numbers are not, so v1 proceeds, labels the file
`cold_only`, records the reason, and makes `report` refuse the warm section. The
refusal is louder than an abort, because it appears every time anyone reads the
file.

**Why the cold diagnostic carries a caveat string.** It is only truly cold if the
server had not served that prefix before the run started. Rather than either
dropping it or overclaiming, the row and the report both say so.

## 7. The structural gate is exactly three things

**Decision.** Transport error, tool-argument parse failure, reasoning leaked into
visible content. Truncation (`finish_reason: length`) and unterminated reasoning
are reported in a diagnostics line but are **not** in the gate.

**Why.** The gate means "the app could not have used this output at all". A
truncated answer is often a `max_tokens` decision, not a model defect, and
folding it in would quietly move the bar between versions of this tool. Reported
separately, it is visible without being conflated.

## 8. Assertions, and one thing deliberately dropped

The vocabulary carried over from the private version generalizes as-is, with
`panel_type`, `max_lead_words` and `promote_target` replaced by the envelope
family. Envelopes let an app declare its own output format once in the contract
and assert on captured fields everywhere.

**`no_tool_prose` was dropped.** It hardcoded an English narration regex
(`let me|i'll|one moment|checking`). It decomposes exactly into `tool_called` +
`content_not_matches` with the app's *own* phrases, which is strictly better:
the failure is named precisely, and it works in a language other than English.

**Tool and envelope names in assertions are validated against the contract.**
A typo in a tool name would otherwise produce a permanent, silent, honest-looking
failure.

## 9. Report

**Grouped by label, one label per lane.** Two files sharing a label is an error,
because a label is the name of a thing being compared.

**The comparison refuses on contract or cases mismatch.** Two lanes that did not
answer the same question do not have comparable answers. Latency rows are omitted
if any lane never proved warm, while correctness comparison continues, because
correctness *is* still comparable across warm and cold.

**Nearest-rank percentiles, not interpolated.** With samples of 20–60, an
interpolated p90 invents a number no run produced. Nearest-rank always reports a
value the endpoint really returned.

**A noise window, not a bare sign check.** A delta inside 0.5pp (rates) or 3%
(times) prints `~same` rather than `REGRESSION`. Both are configurable, and the
window is printed under the table so nobody has to guess what it is.

**`--json` exists because the operator is usually an agent.** The same analysis
as structured data.

## 10. The bar

**Decision.** A separate file, written before the run, whose SHA-256 is stamped
into the report. Criteria resolve to PASS, FAIL or NOT EVALUATED — never a
default to pass. Any NOT EVALUATED makes the verdict INCOMPLETE. `report` exits 1
on FAIL, so it works in CI.

**Why a file rather than flags.** Flags are typed at the moment you look at the
results, which is exactly when the temptation to move the bar arrives. A file
with a stamped hash makes moving it visible.

**`minSemanticDelta` is always NOT EVALUATED in v1** and says so, pointing at
`blind`. Silently ignoring a criterion the tool cannot judge would be the single
most dishonest thing this tool could do.

## 11. Blind grading

**Decision.** v1 emits packets and a key. It does not grade.

**Why the format is the product.** An automated judge is a model, with its own
failure modes, its own position bias, and its own verbosity preference. Wiring
one in would make those failure modes indistinguishable from the candidate's —
in a tool whose entire claim is that it does not print numbers it cannot stand
behind.

Consistent masking across packets (M1 is the same lane everywhere) is required
for a per-model score. The mapping is a seeded shuffle, deterministic from the
contract/cases/label hashes so a grading run is reproducible, and overridable
with `--seed`. `Math.random` would make it unreproducible.

The packet README states the limit rather than overclaiming: masking removes the
label, not every clue. A model that names itself, or one dramatically faster than
the rest, can still be identifiable. `--no-timings` exists for when speed would
bias a quality read.

## 12. Engineering constraints

**Zero runtime dependencies.** Node 20 has `fetch`, `ReadableStream`,
`node:test`, `node:crypto` and `AbortSignal.timeout`. Everything here is a few
hundred lines of parsing and arithmetic. A benchmarking tool that drags in a
dependency tree is a tool nobody will run inside their own repo, and a supply
chain is a strange thing to accept in exchange for an argument parser.

**One request per case, no tool execution loop.** modelbake sends one request and
records what comes back. Executing tools would require the app's own tool
implementations, which is a different and much larger tool. To test behaviour
after a tool result, put the assistant tool call and the tool result in the
case's `messages` — which is byte-identical to what the model would see anyway.

**A `stream_options` retry.** Some servers 400 on the field. Rather than
appearing broken against a perfectly good endpoint, the runner retries once
without it and records `droppedStreamOptions` on the row.

**Errors are values.** A transport failure becomes a recorded row, not a thrown
exception, everywhere except argument validation. A lane that dies on case 14 of
60 is worth less than a lane that records 60 rows, 3 of which failed.

## 13. What is deliberately missing, and what would bring it in

| Left out | Why | Goes in when |
| --- | --- | --- |
| **Judge automation** (LLM grading of the blind packets) | A judge model's failure modes would become the bakeoff's, silently, in a tool that promises not to print unverifiable numbers. | There is a way to *validate the judge itself* — a labelled set of human-graded packets where a judge's agreement rate can be measured and printed alongside every score it produces. Without that number, no judge ships. |
| **Server supervision / model swapping** (start, stop, download, swap checkpoints between lanes) | It is a second product — an orchestrator — and it is where the real damage lives: some servers honour the request's `model` field and will unload a live checkpoint to fetch a named one. A benchmark tool that can take production down is not a benchmark tool. | Never in this package. If it happens it is a separate binary that modelbake shells out to, with its own confirmation prompts. |
| **macOS / unified-memory guards** (checking a checkpoint fits before loading) | Platform-specific, and the honest measurement is non-obvious: RSS does not count Metal unified memory, so the naive check reports 0.36 GB for a 31 GB resident model and would "prove" a model had been evicted while it answers in under a second. | It ships with a measurement that is right on the platform in question (`footprint`-style `phys_footprint`, or a timed warm inference), never with an RSS reading. |
| **Multi-round tool execution** | Needs the app's real tool implementations; the results would be as fake as the stubs. | Never here. Put the tool result in the case's `messages` instead. |
| **Cost accounting** | Needs a price table per model per provider that is stale the week it is written. | A provider returns cost in the usage object, or the user supplies a price file and the report stamps its SHA the way it stamps the bar's. |
| **Statistical significance testing** | With 3 reps per case, a p-value would be theatre. The noise window is the honest version of the same idea. | Reps are high enough that a paired test over per-case medians means something, and the report can print the sample size next to it. |
| **A hosted dashboard / telemetry** | The tool reads your production system prompt and your real user flows. It sends them nowhere. | Never. |

## 14. Known limits

- Masking hides the label, not identity: a model that names itself is not blind.
- The cold diagnostic is only cold if the server was cold. The row says so.
- `warmValid` trusts the server's own cached-token accounting. If a server
  reports the field and lies, modelbake believes it — but it records which field
  it read, so the claim is at least auditable.
- `usage.cache_read_input_tokens` is supported but has not been verified against
  a live server by this project. A run resolving to it is flagged as unconfirmed.
- Percentiles from a handful of reps are indicative, not conclusive. The report
  prints `n` next to every one so nobody has to assume.
