# modelbake: extraction brief for a coding agent

You are being asked to fill in `contract.json` and draft `cases.json` for this
repository. A human will curate what you draft, then run the bakeoff.

modelbake answers one question: **will this model actually run THIS app, and what
will it feel like once the prompt cache is warm?** It can only answer that if the
contract is the app's real contract. Your job is the extraction. The tool
validates shapes; it cannot tell whether you copied the real prompt or wrote a
plausible one. That part is on you.

---

## 1. Find where the request is actually built

Search this codebase for where a chat completion is constructed and sent -- the
place that assembles `messages`, `tools`, and the sampling parameters. Follow it
all the way to the outbound HTTP call. Do not stop at the first prompt-looking
string you find: many apps have several, and only one of them is the one that
ships.

Useful things to grep for: `chat/completions`, `messages:`, `tool_choice`,
`temperature`, `system`, `SYSTEM_PROMPT`, the SDK client name.

## 2. Fill in `contract.json`

### `systemVariants`

One entry per distinct system prompt the app sends. Many apps have exactly one.
Some have several -- a voice variant and a text variant, a with-tools and a
no-tools variant, a free tier and a paid tier. Name them for what they are.

Rules that matter:

- **Copy the final string, not the template.** If the prompt is assembled from
  fragments, or has `{{variables}}` interpolated, reproduce what the model
  receives at runtime. Running the app's own prompt-builder function and dumping
  its output is usually the fastest correct route.
- **Pin anything volatile to a fixed value.** Today's date, the logged-in user's
  name, retrieved memories, a session id. Pick one realistic frozen value and
  keep it. A prompt that changes between runs breaks two things at once: lanes
  stop being comparable, and the prompt cache stops hitting, which silently
  turns every warm measurement into a cold one.
- **Note what you pinned** in the `name` field or a comment in your PR, so the
  human curating this knows what was frozen.
- **Do not tidy it.** Typos, odd capitalisation, a stray trailing newline: keep
  them. They are part of what the model is being asked to handle.

### `tools`

The exact array the model receives, in the same order, in OpenAI function-tool
shape:

```json
{ "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } }
```

If the app builds this array from a registry, serialise the registry's real
output rather than hand-writing it. Order matters -- it is part of the cacheable
prefix. If the app sends no tools, use `[]` and say so.

### `sampling`

The production values, not the defaults you would pick. Read them off the real
request: `temperature`, `top_p`, `max_tokens`, and any penalty the app sets.
Server-specific knobs that are not in modelbake's known list go under
`sampling.extra` and are passed through verbatim.

### `envelopes` (optional)

Does your app parse structured output out of the model's text -- a `<panel>`
block, a fenced JSON tail, a `<correction>` tag? Declare the regex here and
cases can then assert on the captured fields. This is how "did the model emit a
well-formed panel" becomes a machine-checkable claim instead of a vibe.

```json
"envelopes": {
  "panel": {
    "pattern": "<panel\\b([^>]*)>([\\s\\S]*?)</panel>",
    "fields": {
      "attrs": { "group": 1, "parse": "attributes" },
      "body":  { "group": 2 },
      "lead":  { "before": true }
    }
  }
}
```

A field takes exactly one of `group` (a capture index), `before` (text before the
match), `after`, or `match`. `parse` may be `text` (default), `attributes`
(parses `key="value"` pairs into an object) or `json`.

### `reasoning` (optional)

If the model emits inline reasoning, list the tag pairs so it is scored as
reasoning rather than as speech. `leakPatterns` are regexes that mean "planning
voice ended up in the user-visible answer" -- add app-specific ones if you know
them.

---

## 3. Draft `cases.json`

Write **12-20 cases** drawn from what this app actually does. Take them from real
sources in this order of preference: production logs or transcripts, existing
integration tests, the app's own fixtures, the flows described in its README.
Inventing plausible-sounding prompts is the failure mode here -- a bakeoff won on
imaginary traffic tells you nothing about real traffic.

Cover, at minimum:

- the two or three highest-volume happy paths;
- every tool that matters, in the situation that should trigger it;
- at least one case where the right answer is to call **no** tool, and one where
  a tempting-but-wrong tool must **not** fire;
- multi-turn continuity: a follow-up that only makes sense given the history,
  including a case with a prior tool call and its result in `messages`;
- whatever your app's output envelope is, if it has one;
- one case for each way the app has actually embarrassed itself, if you can find
  them in the issue tracker.

A case's `messages` may contain prior `user`, `assistant` and `tool` turns; the
system prompt comes from the contract, so never put a `system` message here.

Assertions available:

| assertion | fields | asserts |
| --- | --- | --- |
| `no_tool` | -- | no tool call was made |
| `tool_called` | `tool` | that tool fired |
| `tool_not_called` | `tool` | that tool did not fire |
| `tool_argument` | `tool`, `key`, `value` | argument at dotted path equals value |
| `tool_argument_matches` | `tool`, `key`, `value` | argument matches regex |
| `content_matches` | `value` | visible answer matches regex |
| `content_not_matches` | `value` | visible answer does not match regex |
| `max_words` | `value` | visible answer is at most N words |
| `envelope_present` / `envelope_absent` | `envelope` | envelope matched or not |
| `envelope_field` | `envelope`, `field`, `value` | captured field equals value |
| `envelope_field_matches` | `envelope`, `field`, `value` | captured field matches regex |
| `envelope_max_words` | `envelope`, `field`, `value` | captured field is at most N words |

Assert only what is genuinely required. `content_matches` on an exact phrasing
turns a style preference into a fake correctness failure; save judgement of
phrasing for blind grading. A good assertion is one where, if it fails, the app
is broken.

Add a `reviewNote` to any case where a human grader needs context to judge it
fairly.

---

## 4. Check your work before handing it back

```bash
npx modelbake run --contract contract.json --cases cases.json \
  --base-url http://localhost:8080/v1 --model any --label check --dry-run
```

`--dry-run` validates both files and prints the plan without sending a request.
Fix everything it reports. Warnings about `TODO:` markers mean the scaffold is
still in place and the extraction has not actually happened yet.

Then tell the human:

- which file and function you took each system prompt from;
- what you pinned to a fixed value, and to what;
- where the cases came from, and which ones you had to invent (say so plainly);
- anything you found that looked wrong in the app itself while you were reading.

## 5. What you should NOT do

- Do not commit `contract.json` to a public repo without asking. It contains your
  production system prompt.
- Do not write a `bar.json` on your own. The bar is a human pre-commitment about
  what "good enough" means, and it only has meaning if it is written before the
  numbers are seen.
- Do not tune the contract until a candidate model passes. That inverts the whole
  exercise: the contract is the fixed thing, the model is the variable.
