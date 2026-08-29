// runCommand talks to the operator on stdout. Tests care about the JSONL it
// writes, not the narration, so this swallows it and hands it back on request.
export async function quietly(fn) {
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const value = await fn();
    return { value, output: lines.join('\n') };
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}
