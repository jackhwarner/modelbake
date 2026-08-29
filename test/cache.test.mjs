import test from 'node:test';
import assert from 'node:assert/strict';
import { readCacheUsage } from '../src/cache.mjs';

test('the OpenAI shape (mlx_lm, llama.cpp, vLLM with the flag)', () => {
  const out = readCacheUsage({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 950 } });
  assert.equal(out.cachedTokens, 950);
  assert.equal(out.freshTokens, 50);
  assert.equal(out.completionTokens, 20);
  assert.equal(out.cacheSource, 'openai.usage.prompt_tokens_details.cached_tokens');
  assert.equal(out.cacheSourceVerified, true);
});

test('the DeepSeek shape, including its prompt-token fallback', () => {
  const out = readCacheUsage({ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 9 });
  assert.equal(out.cachedTokens, 800);
  assert.equal(out.promptTokens, 1000);
  assert.equal(out.cacheSource, 'deepseek.usage.prompt_cache_hit_tokens');
});

test("llama.cpp's timings object, where prompt_n is what was actually processed", () => {
  const out = readCacheUsage(undefined, { cache_n: 900, prompt_n: 100, predicted_n: 12 });
  assert.equal(out.cachedTokens, 900);
  assert.equal(out.promptTokens, 1000);
  assert.equal(out.completionTokens, 12);
  assert.equal(out.cacheSource, 'llamacpp.timings.cache_n');
});

test('the OpenAI field wins when a server reports both', () => {
  const out = readCacheUsage({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } }, { cache_n: 111, prompt_n: 389 });
  assert.equal(out.cachedTokens, 400);
  assert.equal(out.cacheSource, 'openai.usage.prompt_tokens_details.cached_tokens');
});

test('an unverified field is reported as unverified rather than silently trusted', () => {
  const out = readCacheUsage({ prompt_tokens: 100, cache_read_input_tokens: 90 });
  assert.equal(out.cachedTokens, 90);
  assert.equal(out.cacheSourceVerified, false);
});

test('no cache field at all yields null, never zero', () => {
  // This distinction is the whole degrade-honestly path: zero means "measured
  // and nothing was cached", null means "this server cannot tell us".
  const out = readCacheUsage({ prompt_tokens: 100, completion_tokens: 5 });
  assert.equal(out.cachedTokens, null);
  assert.equal(out.cacheSource, null);
  assert.equal(out.freshTokens, null);
  assert.equal(out.promptTokens, 100);
});

test('an explicit zero is kept as zero', () => {
  const out = readCacheUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(out.cachedTokens, 0);
  assert.equal(out.cacheHitRatio, 0);
});

test('no usage at all is all-null, not a crash', () => {
  const out = readCacheUsage(undefined, undefined);
  assert.equal(out.promptTokens, null);
  assert.equal(out.cachedTokens, null);
  assert.equal(out.cacheHitRatio, null);
});
