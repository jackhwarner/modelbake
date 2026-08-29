// Builds a fetch stand-in that replays a fixed list of SSE chunks. Lets the
// stream parser be tested against byte layouts a real server would only produce
// occasionally: a tag split mid-word, a tool argument split every two
// characters, a usage frame that never arrives.
export function sseFetch(chunks, { status = 200, body = '', headers = {} } = {}) {
  return async () => {
    if (status !== 200) {
      return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...headers } });
    }
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
  };
}

export function frame(delta, finish = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

export function usageFrame(usage, extra = {}) {
  return `data: ${JSON.stringify({ choices: [], usage, ...extra })}\n\n`;
}

export const DONE = 'data: [DONE]\n\n';

export const TEST_CONTRACT = {
  sampling: { temperature: 0.5, max_tokens: 128 },
  tools: [],
  toolChoice: 'auto',
  requestOverrides: {},
  envelopes: {},
  reasoning: { inlineTags: [['<think>', '</think>']], leakPatterns: [{ source: '</?think>', regex: /<\/?think>/i }] },
  primeUserMessage: 'ok',
};
