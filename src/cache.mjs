// Reading "how many prompt tokens were served from cache" across servers.
//
// There is no single answer, so every row records WHICH field was read
// (cacheSource). The report prints it. A number whose provenance you cannot
// state is a number this tool will not compare.
//
// VERIFIED against vendor documentation at build time (2026-08):
//  - usage.prompt_tokens_details.cached_tokens
//      OpenAI's documented shape. llama.cpp's server README documents the same
//      object on /v1/chat/completions. mlx_lm.server emits it, and the private
//      harness this tool generalizes measured it live (a non-streamed prime
//      followed by streamed cases reporting 9,939 cached tokens).
//      vLLM: requires --enable-prompt-tokens-details at launch, and has open
//      bugs where the field stays null on the V1 engine even with the flag
//      (vllm-project/vllm#44961, #44377). When it is null this tool degrades to
//      cold_only rather than guessing -- that is the correct outcome, not a
//      workaround.
//  - timings.cache_n
//      llama.cpp's own object, documented as "number of prompt tokens reused
//      from cache", alongside timings.prompt_n, "number of prompt tokens being
//      processed". The README states total context = prompt_n + cache_n +
//      predicted_n, which is where the promptTokens fallback below comes from.
//  - usage.prompt_cache_hit_tokens
//      DeepSeek's documented context-caching field, paired with
//      prompt_cache_miss_tokens, where prompt_tokens = hit + miss.
//  - SGLang exposes cached tokens through the same OpenAI-shaped field, but
//      only when the request asks for it (return_cached_tokens_details in
//      extra_body). Put that in contract.sampling.extra if you serve on SGLang.
//
// ASSUMED, not verified against a live server by this project:
//  - usage.cache_read_input_tokens
//      The Anthropic-style field, seen on OpenAI-compatible proxies that front
//      Anthropic models. Included because it is cheap and unambiguous; treat a
//      run that resolves to this source as unconfirmed methodology.
const SOURCES = [
  {
    id: 'openai.usage.prompt_tokens_details.cached_tokens',
    verified: true,
    read: (usage) => usage?.prompt_tokens_details?.cached_tokens,
  },
  {
    id: 'deepseek.usage.prompt_cache_hit_tokens',
    verified: true,
    read: (usage) => usage?.prompt_cache_hit_tokens,
  },
  {
    id: 'llamacpp.timings.cache_n',
    verified: true,
    read: (usage, timings) => timings?.cache_n,
  },
  {
    id: 'anthropic-compat.usage.cache_read_input_tokens',
    verified: false,
    read: (usage) => usage?.cache_read_input_tokens,
  },
];

export function readCacheUsage(usage, timings) {
  let cachedTokens = null;
  let cacheSource = null;
  let cacheSourceVerified = null;
  for (const source of SOURCES) {
    const value = source.read(usage, timings);
    if (Number.isFinite(value)) {
      cachedTokens = value;
      cacheSource = source.id;
      cacheSourceVerified = source.verified;
      break;
    }
  }

  let promptTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null;
  if (promptTokens === null && Number.isFinite(timings?.prompt_n) && Number.isFinite(timings?.cache_n)) {
    promptTokens = timings.prompt_n + timings.cache_n;
  }
  if (promptTokens === null && Number.isFinite(usage?.prompt_cache_hit_tokens) && Number.isFinite(usage?.prompt_cache_miss_tokens)) {
    promptTokens = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  }

  const completionTokens = Number.isFinite(usage?.completion_tokens)
    ? usage.completion_tokens
    : (Number.isFinite(timings?.predicted_n) ? timings.predicted_n : null);

  return {
    promptTokens,
    cachedTokens,
    cacheSource,
    cacheSourceVerified,
    freshTokens: promptTokens !== null && cachedTokens !== null ? promptTokens - cachedTokens : null,
    completionTokens,
    cacheHitRatio: promptTokens ? Number(((cachedTokens ?? 0) / promptTokens).toFixed(4)) : null,
  };
}

export const CACHE_FIELD_NAMES = SOURCES.map((s) => s.id);
