// A small OpenAI-compatible server used by the tests and runnable on its own:
//
//     node test/helpers/mock-server.mjs --port 8099
//
// It exists so the whole tool can be exercised end to end with no model, no GPU
// and no network. It deliberately reproduces the two serving behaviours this
// tool was built around:
//
//   storeOnStream:false  -- a STREAMED generation does not store a prompt-cache
//                           entry, so a harness that primes with a streamed
//                           request never gets a cache hit and must degrade to
//                           cold_only. (Measured on mlx-lm 0.31.3.)
//   templateKwargsBypass -- a request carrying chat_template_kwargs is treated
//                           as a different prefix, so per-request template args
//                           silently destroy the cache.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const approxTokens = (text) => Math.max(1, Math.ceil(String(text).length / 4));

function prefixKey(body) {
  return createHash('sha256').update([
    JSON.stringify(body.messages?.[0] ?? null),
    JSON.stringify(body.tools ?? null),
  ].join('|')).digest('hex');
}

function chunkString(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const DEFAULT_SCRIPT = [{ match: /.*/, content: 'Okay.' }];

export function startMockServer(options = {}) {
  const {
    script = DEFAULT_SCRIPT,
    cacheMode = 'openai',            // 'openai' | 'llamacpp' | 'deepseek' | 'none'
    storeOnStream = false,
    templateKwargsBypass = true,
    chunkSize = 6,
    status = 200,
    statusBody = '{"error":{"message":"mock failure"}}',
    rejectStreamOptions = false,
    deltaMs = 0,
    port: requestedPort = 0,
  } = options;

  const primed = new Set();
  const requests = [];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      let body;
      try { body = JSON.parse(raw); } catch { body = {}; }
      requests.push(body);

      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(statusBody);
        return;
      }
      if (rejectStreamOptions && body.stream_options) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"unrecognized request argument: stream_options"}}');
        return;
      }

      const key = prefixKey(body);
      // A request carrying per-request template kwargs neither reads nor writes
      // the cache: the server launched without the matching flag treats it as
      // an uncacheable request. This is the behaviour that makes
      // `contract.requestOverrides.chat_template_kwargs` a warning.
      const bypassed = templateKwargsBypass && Boolean(body.chat_template_kwargs);
      const systemTokens = approxTokens(body.messages?.[0]?.content ?? '') + approxTokens(JSON.stringify(body.tools ?? []));
      const promptTokens = systemTokens + body.messages.slice(1).reduce((n, m) => n + approxTokens(m.content ?? JSON.stringify(m.tool_calls ?? '')), 0);
      const cachedTokens = !bypassed && primed.has(key) ? systemTokens : 0;

      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const entry = script.find((s) => (s.match instanceof RegExp ? s.match.test(lastUser) : String(lastUser).includes(s.match))) || DEFAULT_SCRIPT[0];

      const think = entry.think ? `<think>${entry.think}</think>` : '';
      const content = `${think}${entry.content ?? ''}`;
      const completionTokens = approxTokens(content) + (entry.toolCalls?.length ? 12 : 0);

      const usage = (() => {
        const base = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
        if (cacheMode === 'openai') return { ...base, prompt_tokens_details: { cached_tokens: cachedTokens } };
        if (cacheMode === 'deepseek') return { ...base, prompt_cache_hit_tokens: cachedTokens, prompt_cache_miss_tokens: promptTokens - cachedTokens };
        return base;
      })();
      const timings = cacheMode === 'llamacpp'
        ? { cache_n: cachedTokens, prompt_n: promptTokens - cachedTokens, predicted_n: completionTokens }
        : undefined;

      if (!body.stream) {
        if (!bypassed) primed.add(key);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: entry.finishReason || 'stop' }],
          usage,
          ...(timings ? { timings } : {}),
        }));
        return;
      }

      if (storeOnStream && !bypassed) primed.add(key);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const frame = (delta, finish = null) => ({
        id: 'mock', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

      const steps = [];
      steps.push(() => send(frame({ role: 'assistant' })));
      if (entry.reasoningContent) {
        for (const piece of chunkString(entry.reasoningContent, chunkSize)) steps.push(() => send(frame({ reasoning_content: piece })));
      }
      for (const piece of chunkString(content, chunkSize)) {
        if (piece) steps.push(() => send(frame({ content: piece })));
      }
      for (const [index, call] of (entry.toolCalls || []).entries()) {
        const args = JSON.stringify(call.arguments ?? {});
        steps.push(() => send(frame({ tool_calls: [{ index, id: call.id || `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] })));
        for (const piece of chunkString(args, Math.max(2, Math.floor(chunkSize / 2)))) {
          steps.push(() => send(frame({ tool_calls: [{ index, function: { arguments: piece } }] })));
        }
      }
      steps.push(() => send(frame({}, entry.finishReason || (entry.toolCalls?.length ? 'tool_calls' : 'stop'))));
      if (body.stream_options?.include_usage) {
        steps.push(() => send({ id: 'mock', object: 'chat.completion.chunk', model: body.model, choices: [], usage, ...(timings ? { timings } : {}) }));
      }
      steps.push(() => { res.write('data: [DONE]\n\n'); res.end(); });

      let i = 0;
      const pump = () => {
        if (i >= steps.length) return;
        steps[i]();
        i += 1;
        if (deltaMs) setTimeout(pump, deltaMs);
        else setImmediate(pump);
      };
      pump();
    });
  });

  return new Promise((resolveServer) => {
    server.listen(requestedPort, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        primed,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Standalone mode, so someone with no model server can still run the example.
//   node test/helpers/mock-server.mjs --port=8099 [--script=weak] [--delta-ms=3]
if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (name, fallback) => {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.split('=')[1] : fallback;
  };
  const port = Number(flag('port', 8099));
  const deltaMs = Number(flag('delta-ms', 0));
  const which = flag('script', 'strong');
  const scripts = await import('./example-script.mjs');
  const script = which === 'weak' ? scripts.TODO_APP_SCRIPT_WEAKER : scripts.TODO_APP_SCRIPT;
  const server = await startMockServer({ script, port, deltaMs });
  console.log(`mock server listening on ${server.url}  (script=${which}, deltaMs=${deltaMs})`);
  console.log('run the example against it:');
  console.log('  node bin/modelbake.mjs run \\');
  console.log('    --contract examples/todo-app/contract.json --cases examples/todo-app/cases.json \\');
  console.log(`    --base-url ${server.url} --model mock-1 --label mock --reps 2`);
}
