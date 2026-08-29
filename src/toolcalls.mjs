// Merging streamed tool-call deltas.
//
// Servers disagree in two ways the OpenAI spec does not pin down:
//  - some send the call id and function name once, in the first delta for that
//    index, and chunk only the arguments (the common case);
//  - some repeat the identical id and name on every delta for that index.
// Blind concatenation corrupts the second group into "call_1call_1call_1", so
// id and name are set-once-then-idempotent while arguments always append.
//
// A delta may also omit `index`. Defaulting to 0 merges a second tool call into
// the first; resolveIndex instead continues the last open call unless the delta
// carries a different id, in which case it opens a new one.
export function resolveIndex(target, delta) {
  if (Number.isInteger(delta.index)) return delta.index;
  if (!target.length) return 0;
  const last = target.length - 1;
  const current = target[last];
  if (delta.id && current && current.id && current.id !== delta.id) return target.length;
  return last;
}

export function mergeToolDelta(target, delta) {
  const index = resolveIndex(target, delta);
  if (!target[index]) target[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
  const call = target[index];
  if (delta.type) call.type = delta.type;
  if (delta.id) {
    if (!call.id) call.id = delta.id;
    else if (call.id !== delta.id && !call.id.endsWith(delta.id)) call.id += delta.id;
  }
  const fn = delta.function || {};
  if (fn.name) {
    if (!call.function.name) call.function.name = fn.name;
    else if (call.function.name !== fn.name && !call.function.name.endsWith(fn.name)) call.function.name += fn.name;
  }
  if (typeof fn.arguments === 'string' && fn.arguments.length) call.function.arguments += fn.arguments;
  return target;
}

export function finalizeToolCalls(raw) {
  return raw.filter(Boolean).map((call, index) => {
    let parsedArguments = null;
    let argumentError = null;
    const text = call.function?.arguments ?? '';
    try {
      parsedArguments = text.trim() === '' ? {} : JSON.parse(text);
      if (parsedArguments === null || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
        argumentError = `arguments parsed to ${Array.isArray(parsedArguments) ? 'an array' : typeof parsedArguments}, expected a JSON object`;
        parsedArguments = null;
      }
    } catch (caught) {
      argumentError = String(caught?.message || caught);
    }
    return {
      index,
      id: call.id || null,
      name: call.function?.name || null,
      argumentsRaw: text,
      parsedArguments,
      argumentError,
    };
  });
}
