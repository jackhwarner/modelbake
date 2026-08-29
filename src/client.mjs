import { ReasoningSplitter, detectLeak } from './reasoning.mjs';
import { mergeToolDelta, finalizeToolCalls } from './toolcalls.mjs';
import { readCacheUsage } from './cache.mjs';

// Everything that talks to the endpoint. One OpenAI-compatible request shape,
// built identically for primes and for cases, because a prime that differs from
// a case in any byte of the prefix primes the wrong thing.

export function buildRequestBody({ contract, model, systemPrompt, messages, stream, maxTokens, temperature, seed }) {
  const sampling = contract.sampling || {};
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream: Boolean(stream),
  };
  if (contract.tools?.length) {
    body.tools = contract.tools;
    body.tool_choice = contract.toolChoice;
  }
  for (const key of ['temperature', 'top_p', 'top_k', 'min_p', 'repetition_penalty', 'presence_penalty', 'frequency_penalty', 'stop', 'seed']) {
    if (sampling[key] !== undefined && sampling[key] !== null) body[key] = sampling[key];
  }
  body.max_tokens = sampling.max_tokens;
  if (sampling.extra) Object.assign(body, sampling.extra);
  if (contract.requestOverrides) Object.assign(body, contract.requestOverrides);
  // Explicit per-call overrides win over the contract: a prime is deliberately
  // max_tokens 1 / temperature 0, and a seed is set per rep.
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (temperature !== undefined) body.temperature = temperature;
  if (seed !== undefined) body.seed = seed;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function headersFor(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  // Many local servers ignore auth entirely; some (vLLM with --api-key, hosted
  // gateways) require it. Sent only when the operator supplied one.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function post(url, body, { apiKey, timeoutMs, fetchImpl = fetch }) {
  return fetchImpl(url, {
    method: 'POST',
    headers: headersFor(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// Some servers reject the (optional) stream_options field with a 400. Rather
// than making every user discover that, retry once without it and record that
// we did -- the alternative is a tool that appears broken against a perfectly
// good endpoint.
async function postWithStreamOptionsFallback(url, body, options) {
  let response = await post(url, body, options);
  if (response.status === 400 && body.stream_options) {
    const text = await response.text();
    if (/stream_options|include_usage/i.test(text)) {
      const retryBody = { ...body };
      delete retryBody.stream_options;
      response = await post(url, retryBody, options);
      return { response, droppedStreamOptions: true, firstErrorBody: text };
    }
    return { response, droppedStreamOptions: false, preReadBody: text };
  }
  return { response, droppedStreamOptions: false };
}

export async function streamCompletion({
  baseUrl, apiKey, model, contract, systemPrompt, messages,
  maxTokens, temperature, seed, timeoutMs = 300000, purpose = 'case', fetchImpl,
}) {
  const started = performance.now();
  const timings = { firstEventMs: null, firstReasoningMs: null, firstVisibleMs: null, firstToolMs: null };
  const splitter = new ReasoningSplitter(contract.reasoning.inlineTags);
  const rawToolCalls = [];
  let content = '';
  let reasoning = '';
  let rawContentChars = 0;
  let usage = null;
  let timingsObject = null;
  let finishReason = null;
  let transportError = null;
  let droppedStreamOptions = false;

  const body = buildRequestBody({ contract, model, systemPrompt, messages, stream: true, maxTokens, temperature, seed });

  const markVisible = (text, at) => {
    if (text && text.trim() && timings.firstVisibleMs === null) timings.firstVisibleMs = at;
  };
  const markReasoning = (text, at) => {
    if (text && text.trim() && timings.firstReasoningMs === null) timings.firstReasoningMs = at;
  };

  try {
    const attempt = await postWithStreamOptionsFallback(`${baseUrl}/chat/completions`, body, { apiKey, timeoutMs, fetchImpl });
    droppedStreamOptions = attempt.droppedStreamOptions;
    const response = attempt.response;
    if (!response.ok) {
      const text = attempt.preReadBody ?? await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
    }
    if (!response.body) throw new Error('response had no body to stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
        buffer = buffer.slice(newline + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }
        let event;
        try { event = JSON.parse(payload); } catch { continue; }

        const at = performance.now() - started;
        if (timings.firstEventMs === null && Array.isArray(event.choices) && event.choices.length) {
          timings.firstEventMs = at;
        }
        if (event.usage) usage = event.usage;
        if (event.timings) timingsObject = event.timings;

        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        const explicitReasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof explicitReasoning === 'string' && explicitReasoning.length) {
          reasoning += explicitReasoning;
          rawContentChars += explicitReasoning.length;
          markReasoning(explicitReasoning, at);
        }
        if (typeof delta.content === 'string' && delta.content.length) {
          rawContentChars += delta.content.length;
          const split = splitter.feed(delta.content);
          if (split.reasoning) { reasoning += split.reasoning; markReasoning(split.reasoning, at); }
          if (split.visible) { markVisible(split.visible, at); content += split.visible; }
        }
        for (const toolDelta of delta.tool_calls || []) {
          if (timings.firstToolMs === null) timings.firstToolMs = at;
          mergeToolDelta(rawToolCalls, toolDelta);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (caught) {
    transportError = String(caught?.message || caught);
  }

  const tail = splitter.end();
  const tailAt = performance.now() - started;
  if (tail.reasoning) { reasoning += tail.reasoning; markReasoning(tail.reasoning, tailAt); }
  if (tail.visible) { markVisible(tail.visible, tailAt); content += tail.visible; }

  const totalMs = Math.round(performance.now() - started);
  const toolCalls = finalizeToolCalls(rawToolCalls);
  const cache = readCacheUsage(usage, timingsObject);
  const round = (value) => (value === null ? null : Math.round(value));

  return {
    purpose,
    transportError,
    droppedStreamOptions,
    finishReason,
    truncated: finishReason === 'length',
    content,
    reasoning,
    reasoningChars: reasoning.length,
    reasoningPresent: Boolean(reasoning.trim()),
    reasoningUnterminated: tail.unterminated,
    reasoningLeak: detectLeak(content, contract.reasoning.leakPatterns),
    rawContentChars,
    toolCalls,
    usage,
    serverTimings: timingsObject,
    ...cache,
    firstEventMs: round(timings.firstEventMs),
    firstReasoningMs: round(timings.firstReasoningMs),
    firstVisibleMs: round(timings.firstVisibleMs),
    firstToolMs: round(timings.firstToolMs),
    totalMs,
  };
}

// Primes are NON-STREAMING on purpose. Hard-won serving fact #1 (DESIGN.md):
// on some servers a streamed generation never STORES a prompt-cache entry --
// measured on mlx-lm 0.31.3, where an all-streaming lane reported
// cached_tokens=0 on every single request, and one stream:false request made
// every later streamed request hit the cache. If your prime streams, you are
// not measuring warm; you are measuring cold and calling it warm.
export async function primeCompletion({
  baseUrl, apiKey, model, contract, systemPrompt, timeoutMs = 300000, purpose = 'prime', fetchImpl,
}) {
  const started = performance.now();
  const body = buildRequestBody({
    contract,
    model,
    systemPrompt,
    messages: [{ role: 'user', content: contract.primeUserMessage }],
    stream: false,
    maxTokens: 1,
    temperature: 0,
  });
  try {
    const response = await post(`${baseUrl}/chat/completions`, body, { apiKey, timeoutMs, fetchImpl });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch (caught) { throw new Error(`prime response was not JSON: ${caught.message}`); }
    const cache = readCacheUsage(parsed.usage, parsed.timings);
    return {
      purpose,
      transportError: null,
      usage: parsed.usage ?? null,
      ...cache,
      totalMs: Math.round(performance.now() - started),
    };
  } catch (caught) {
    return {
      purpose,
      transportError: String(caught?.message || caught),
      usage: null,
      promptTokens: null,
      cachedTokens: null,
      cacheSource: null,
      cacheSourceVerified: null,
      freshTokens: null,
      completionTokens: null,
      cacheHitRatio: null,
      totalMs: Math.round(performance.now() - started),
    };
  }
}
