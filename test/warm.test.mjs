import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './helpers/mock-server.mjs';
import { TODO_APP_SCRIPT } from './helpers/example-script.mjs';
import { readJsonl } from '../src/jsonl.mjs';
import { runCommand } from '../src/commands/run.mjs';
import { quietly } from './helpers/quiet.mjs';

const CONTRACT = 'examples/todo-app/contract.json';
const CASES = 'examples/todo-app/cases.json';

async function runAgainst(serverOptions, flagOverrides = {}, { contract = CONTRACT } = {}) {
  const server = await startMockServer({ script: TODO_APP_SCRIPT, ...serverOptions });
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-'));
  const out = join(dir, 'run.jsonl');
  try {
    const { value: code, output } = await quietly(() => runCommand({
      contract,
      cases: CASES,
      'base-url': server.url,
      model: 'mock',
      label: 'lane',
      reps: '1',
      only: 'greeting,add-item,summary-card-envelope',
      out,
      ...flagOverrides,
    }));
    return { code, output, rows: readJsonl(out), server };
  } finally {
    await server.close();
  }
}

test('a verified prime puts the lane in warm mode and marks every row warmValid', async () => {
  const { rows } = await runAgainst({ cacheMode: 'openai' });
  const mode = rows.find((r) => r.kind === 'mode');
  assert.equal(mode.mode, 'warm');
  assert.equal(mode.reason, null);
  const warm = rows.filter((r) => r.kind === 'result' && r.phase === 'warm');
  assert.ok(warm.length > 0);
  assert.ok(warm.every((r) => r.warmValid === true), 'every warm row proved its own cache coverage');
});

test('the prime is sent non-streaming, which is what makes the cache store at all', async () => {
  const { server, rows } = await runAgainst({ cacheMode: 'openai' });
  const primes = server.requests.filter((r) => r.max_tokens === 1);
  assert.ok(primes.length >= 2, 'one prime per system variant in use');
  assert.ok(primes.every((r) => r.stream === false));
  assert.ok(rows.some((r) => r.kind === 'prime'));
});

test('a server that reports no cached-token field degrades to cold_only and says why', async () => {
  const { rows } = await runAgainst({ cacheMode: 'none' });
  const mode = rows.find((r) => r.kind === 'mode');
  assert.equal(mode.mode, 'cold_only');
  assert.match(mode.reason, /no cached-token field/);
  const results = rows.filter((r) => r.kind === 'result' && r.phase === 'cold');
  assert.ok(results.length > 0, 'the run still produced correctness rows');
  assert.ok(results.every((r) => r.warmValid === false));
});

test("llama.cpp's timings.cache_n is enough to prove warm", async () => {
  const { rows } = await runAgainst({ cacheMode: 'llamacpp' });
  assert.equal(rows.find((r) => r.kind === 'mode').mode, 'warm');
  const verify = rows.find((r) => r.kind === 'verify');
  assert.equal(verify.cacheSource, 'llamacpp.timings.cache_n');
});

test('--no-warm is honest about being a choice, not a failure', async () => {
  const { rows } = await runAgainst({ cacheMode: 'openai' }, { 'no-warm': true });
  const mode = rows.find((r) => r.kind === 'mode');
  assert.equal(mode.mode, 'cold_only');
  assert.match(mode.reason, /--no-warm/);
  assert.equal(rows.some((r) => r.kind === 'prime'), false, 'nothing was primed');
});

test('a streamed request does not store a cache entry on servers that behave like mlx-lm', async () => {
  // The mock reproduces the measured behaviour; this asserts the mock, which is
  // what makes the warm test above meaningful rather than circular.
  const server = await startMockServer({ script: TODO_APP_SCRIPT, storeOnStream: false });
  try {
    const body = {
      model: 'm', stream: true, stream_options: { include_usage: true }, max_tokens: 8,
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hey' }],
    };
    await fetch(`${server.url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.text());
    assert.equal(server.primed.size, 0, 'a streamed generation stored nothing');
    await fetch(`${server.url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: false, max_tokens: 1 }) })
      .then((r) => r.json());
    assert.equal(server.primed.size, 1, 'a non-streamed generation stored the prefix');
  } finally {
    await server.close();
  }
});

test('per-request chat_template_kwargs bypasses the cache, so the lane degrades', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-'));
  const contractPath = join(dir, 'contract.json');
  const raw = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(CONTRACT, 'utf8')));
  raw.requestOverrides = { chat_template_kwargs: { enable_thinking: false } };
  writeFileSync(contractPath, JSON.stringify(raw));
  const { rows, output } = await runAgainst({ cacheMode: 'openai', templateKwargsBypass: true }, {}, { contract: contractPath });
  assert.match(output, /bypasses the prompt cache|chat_template_kwargs/);
  assert.equal(rows.find((r) => r.kind === 'mode').mode, 'cold_only');
});

test('an unreachable endpoint aborts before burning a whole run', async () => {
  const server = await startMockServer({ status: 500 });
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-'));
  const out = join(dir, 'run.jsonl');
  try {
    const { value: code } = await quietly(() => runCommand({
      contract: CONTRACT, cases: CASES, 'base-url': server.url, model: 'mock', label: 'lane', reps: '1', out,
    }));
    assert.equal(code, 2);
    const rows = readJsonl(out);
    const end = rows.find((r) => r.kind === 'end');
    assert.equal(end.completed, false);
    assert.match(end.reason, /HTTP 500/);
    assert.equal(rows.filter((r) => r.kind === 'result').length, 1, 'only the cold diagnostic was attempted');
  } finally {
    await server.close();
  }
});
