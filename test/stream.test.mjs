import test from 'node:test';
import assert from 'node:assert/strict';
import { streamCompletion, primeCompletion, buildRequestBody } from '../src/client.mjs';
import { sseFetch, frame, usageFrame, DONE, TEST_CONTRACT } from './helpers/fake-fetch.mjs';

const run = (chunks, options = {}) => streamCompletion({
  baseUrl: 'http://test/v1',
  model: 'm',
  contract: TEST_CONTRACT,
  systemPrompt: 'S',
  messages: [{ role: 'user', content: 'hi' }],
  fetchImpl: sseFetch(chunks, options),
  timeoutMs: 5000,
});

test('a think block never counts as first visible output', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    frame({ content: '<think>weighing it up</think>' }),
    frame({ content: 'The answer is 12.' }),
    frame({}, 'stop'),
    DONE,
  ]);
  assert.equal(result.content, 'The answer is 12.');
  assert.equal(result.reasoningPresent, true);
  assert.equal(result.reasoningLeak, null);
  assert.ok(result.firstVisibleMs >= result.firstReasoningMs);
});

test('an empty SSE choice does not masquerade as speech', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    frame({}),
    frame({ content: 'Hello.' }),
    frame({}, 'stop'),
    DONE,
  ]);
  // firstEvent fires on the first frame that has a choices array at all;
  // firstVisible waits for actual text.
  assert.ok(Number.isFinite(result.firstEventMs));
  assert.ok(Number.isFinite(result.firstVisibleMs));
  assert.equal(result.content, 'Hello.');
});

test('reasoning_content deltas are reasoning, and never appear in content', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    frame({ reasoning_content: 'thinking out loud' }),
    frame({ content: 'Done.' }),
    frame({}, 'stop'),
    DONE,
  ]);
  assert.equal(result.content, 'Done.');
  assert.equal(result.reasoning, 'thinking out loud');
  assert.ok(result.firstReasoningMs !== null);
});

test('tool-call deltas split across chunks arrive parsed', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    frame({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'add_todo', arguments: '' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '{"title":' } }] }),
    frame({ tool_calls: [{ index: 0, function: { arguments: '"Buy milk"}' } }] }),
    frame({}, 'tool_calls'),
    DONE,
  ]);
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].parsedArguments, { title: 'Buy milk' });
  assert.ok(Number.isFinite(result.firstToolMs));
});

test('a missing usage frame leaves token counts null rather than zero', async () => {
  const result = await run([frame({ role: 'assistant' }), frame({ content: 'Hi.' }), frame({}, 'stop'), DONE]);
  assert.equal(result.usage, null);
  assert.equal(result.promptTokens, null);
  assert.equal(result.cachedTokens, null);
  assert.equal(result.completionTokens, null);
  assert.equal(result.cacheSource, null);
});

test('usage arriving on a choice-less final frame is captured', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    frame({ content: 'Hi.' }),
    frame({}, 'stop'),
    usageFrame({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 96 } }),
    DONE,
  ]);
  assert.equal(result.promptTokens, 100);
  assert.equal(result.cachedTokens, 96);
  assert.equal(result.freshTokens, 4);
  assert.equal(result.cacheHitRatio, 0.96);
});

test('a 4xx endpoint becomes a transport error, not a crash', async () => {
  const result = await run([], { status: 404, body: '{"error":{"message":"model not found"}}' });
  assert.match(result.transportError, /HTTP 404/);
  assert.match(result.transportError, /model not found/);
  assert.equal(result.content, '');
  assert.equal(result.toolCalls.length, 0);
});

test('malformed SSE lines are skipped rather than aborting the stream', async () => {
  const result = await run([
    frame({ role: 'assistant' }),
    'data: {not json at all\n\n',
    ': a comment line\n\n',
    frame({ content: 'Still here.' }),
    frame({}, 'stop'),
    DONE,
  ]);
  assert.equal(result.content, 'Still here.');
  assert.equal(result.transportError, null);
});

test('finish_reason length is recorded as truncation', async () => {
  const result = await run([frame({ role: 'assistant' }), frame({ content: 'cut off here' }), frame({}, 'length'), DONE]);
  assert.equal(result.finishReason, 'length');
  assert.equal(result.truncated, true);
});

test('an unterminated think block is flagged and does not become speech', async () => {
  const result = await run([frame({ role: 'assistant' }), frame({ content: '<think>never closed' }), frame({}, 'length'), DONE]);
  assert.equal(result.content, '');
  assert.equal(result.reasoningUnterminated, true);
});

test('a server that rejects stream_options is retried once without it', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.stream_options) {
      return new Response('{"error":{"message":"unrecognized request argument: stream_options"}}', { status: 400 });
    }
    return sseFetch([frame({ role: 'assistant' }), frame({ content: 'ok' }), frame({}, 'stop'), DONE])();
  };
  const result = await streamCompletion({
    baseUrl: 'http://test/v1', model: 'm', contract: TEST_CONTRACT, systemPrompt: 'S',
    messages: [{ role: 'user', content: 'hi' }], fetchImpl, timeoutMs: 5000,
  });
  assert.equal(calls, 2);
  assert.equal(result.droppedStreamOptions, true);
  assert.equal(result.content, 'ok');
});

test('a prime is non-streaming, max_tokens 1, temperature 0', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200 });
  };
  const primed = await primeCompletion({
    baseUrl: 'http://test/v1', model: 'm', contract: TEST_CONTRACT, systemPrompt: 'S', fetchImpl, timeoutMs: 5000,
  });
  assert.equal(seen.stream, false);
  assert.equal(seen.max_tokens, 1);
  assert.equal(seen.temperature, 0);
  assert.equal(seen.messages[0].content, 'S');
  assert.equal(seen.messages[1].content, 'ok');
  assert.equal(primed.promptTokens, 900);
});

test('the prime and a case share a byte-identical system+tools prefix', () => {
  const contract = { ...TEST_CONTRACT, tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object' } } }] };
  const primeBody = buildRequestBody({ contract, model: 'm', systemPrompt: 'S', messages: [{ role: 'user', content: 'ok' }], stream: false, maxTokens: 1, temperature: 0 });
  const caseBody = buildRequestBody({ contract, model: 'm', systemPrompt: 'S', messages: [{ role: 'user', content: 'anything' }], stream: true });
  assert.deepEqual(primeBody.messages[0], caseBody.messages[0]);
  assert.deepEqual(primeBody.tools, caseBody.tools);
  assert.equal(primeBody.tool_choice, caseBody.tool_choice);
});
