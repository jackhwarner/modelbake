// Splits a content stream into visible speech and inline reasoning.
//
// Why this is its own module with its own tests: firstVisibleMs is the number a
// user actually feels, and the two easy ways to get it wrong are (1) counting an
// empty SSE choice as speech and (2) counting a <think> block as speech. This
// class owns (2). It must also survive a tag split across chunk boundaries --
// "<thi" arriving at the end of one delta and "nk>" at the start of the next --
// which a naive indexOf('<think>') per delta silently misses, classifying the
// whole reasoning block as speech and reporting a first-token latency that is
// real but measures the wrong thing.

function longestPartialSuffix(buffer, tags) {
  let best = 0;
  for (const tag of tags) {
    const max = Math.min(tag.length - 1, buffer.length);
    for (let len = max; len > best; len -= 1) {
      if (buffer.endsWith(tag.slice(0, len))) {
        best = len;
        break;
      }
    }
  }
  return best;
}

export class ReasoningSplitter {
  constructor(tagPairs = [['<think>', '</think>']]) {
    this.pairs = tagPairs;
    this.openTags = tagPairs.map((pair) => pair[0]);
    this.active = -1;
    this.pending = '';
  }

  feed(text) {
    let buffer = this.pending + (text ?? '');
    this.pending = '';
    let visible = '';
    let reasoning = '';

    for (;;) {
      if (this.active >= 0) {
        const close = this.pairs[this.active][1];
        const at = buffer.indexOf(close);
        if (at !== -1) {
          reasoning += buffer.slice(0, at);
          buffer = buffer.slice(at + close.length);
          this.active = -1;
          continue;
        }
        const hold = longestPartialSuffix(buffer, [close]);
        reasoning += buffer.slice(0, buffer.length - hold);
        this.pending = buffer.slice(buffer.length - hold);
        break;
      }

      let bestAt = -1;
      let bestPair = -1;
      for (const [index, open] of this.openTags.entries()) {
        const at = buffer.indexOf(open);
        if (at !== -1 && (bestAt === -1 || at < bestAt)) {
          bestAt = at;
          bestPair = index;
        }
      }
      if (bestAt !== -1) {
        visible += buffer.slice(0, bestAt);
        buffer = buffer.slice(bestAt + this.openTags[bestPair].length);
        this.active = bestPair;
        continue;
      }
      const hold = longestPartialSuffix(buffer, this.openTags);
      visible += buffer.slice(0, buffer.length - hold);
      this.pending = buffer.slice(buffer.length - hold);
      break;
    }

    return { visible, reasoning };
  }

  // Flush whatever was held back waiting to see if it was a tag. A stream that
  // ends inside a reasoning block is reported as unterminated: the model never
  // spoke, which is a different failure from leaking, and is recorded as such
  // rather than being folded into either channel silently.
  end() {
    const held = this.pending;
    this.pending = '';
    const unterminated = this.active >= 0;
    return {
      visible: unterminated ? '' : held,
      reasoning: unterminated ? held : '',
      unterminated,
    };
  }
}

export function detectLeak(visibleContent, leakPatterns) {
  for (const { source, regex } of leakPatterns) {
    if (regex.test(visibleContent)) return source;
  }
  return null;
}
