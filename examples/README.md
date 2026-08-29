# Examples

Two complete, generic apps. Neither is real; both are shaped like real ones.

## `todo-app/`

A todo assistant with four tools, two system variants (`text` and `voice`), and
an output envelope (`<card>`). Its cases cover the shapes that actually decide a
bakeoff:

- a plain answer with no tool (`greeting`, `arithmetic-no-tool`);
- a tool that must fire, with an argument check (`add-item`);
- a tempting tool that must **not** fire (`advice-is-not-a-write`);
- a write that requires a lookup first, because the model has no id
  (`complete-needs-lookup`) — the most valuable case in the file;
- multi-turn continuity with a real tool call and result in the history
  (`continuity-second-item`, `summary-card-envelope`);
- the app's output envelope (`summary-card-envelope`).

`bar.json` is the pre-commitment: what "good enough" means, written down first.

## `support-bot/`

A first-line support assistant with **no tools at all**, two variants of the same
prompt (one adding a required `HANDOFF:` line), and an envelope built from that
line. It exists to show the other shape: an app where every case is about what
the model says and refuses to invent, and where `no_tool` matters precisely
because the contract sends nothing to call.

## Running them without a model

```bash
node test/helpers/mock-server.mjs --port=8099 --delta-ms=2
```

then, in another shell:

```bash
node bin/modelbake.mjs run \
  --contract examples/todo-app/contract.json \
  --cases examples/todo-app/cases.json \
  --base-url http://127.0.0.1:8099/v1 \
  --model mock-1 --label champion --reps 2 --out results/champion.jsonl

node bin/modelbake.mjs report results/champion.jsonl --bar examples/todo-app/bar.json
```

For a champion-vs-challenger table, start a second mock with the deliberately
worse script and run a second lane against it:

```bash
node test/helpers/mock-server.mjs --port=8100 --delta-ms=3 --script=weak
```

## Running them against a real local server

Any OpenAI-compatible endpoint works. Point `--base-url` at it and name a model
it has loaded:

```bash
node bin/modelbake.mjs run \
  --contract examples/todo-app/contract.json \
  --cases examples/todo-app/cases.json \
  --base-url http://127.0.0.1:8080/v1 \
  --model your-model-id --label local --reps 3
```

Expect failures. The contract belongs to an app that does not exist, so the model
has never been asked to hold it. That is the point of the example: it shows you
what a lane looks like, not what a good score looks like.

**Do not point a lane at a production server.** Some servers honour the request's
`model` field and will unload a live checkpoint to fetch the one you named.
