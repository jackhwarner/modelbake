import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningSplitter, detectLeak } from '../src/reasoning.mjs';

const drain = (splitter, pieces) => {
  let visible = '';
  let reasoning = '';
  for (const piece of pieces) {
    const out = splitter.feed(piece);
    visible += out.visible;
    reasoning += out.reasoning;
  }
  const tail = splitter.end();
  return { visible: visible + tail.visible, reasoning: reasoning + tail.reasoning, unterminated: tail.unterminated };
};

test('a whole think block in one delta is reasoning, not speech', () => {
  const out = drain(new ReasoningSplitter(), ['<think>planning</think>Hello.']);
  assert.equal(out.visible, 'Hello.');
  assert.equal(out.reasoning, 'planning');
  assert.equal(out.unterminated, false);
});

test('an opening tag split across chunk boundaries is still a tag', () => {
  // The bug this test exists for: indexOf('<think>') per delta misses "<thi" +
  // "nk>" and classifies the entire reasoning block as visible speech.
  const out = drain(new ReasoningSplitter(), ['Hi ', '<thi', 'nk>secret', '</thi', 'nk> there']);
  assert.equal(out.visible, 'Hi  there');
  assert.equal(out.reasoning, 'secret');
});

test('one character at a time survives', () => {
  const text = '<think>abc</think>xyz';
  const out = drain(new ReasoningSplitter(), [...text]);
  assert.equal(out.visible, 'xyz');
  assert.equal(out.reasoning, 'abc');
});

test('a lone angle bracket at the end of the stream is speech, not a held tag', () => {
  const out = drain(new ReasoningSplitter(), ['5 < 6 and <']);
  assert.equal(out.visible, '5 < 6 and <');
  assert.equal(out.reasoning, '');
});

test('a stream that ends inside a think block is reported unterminated', () => {
  const out = drain(new ReasoningSplitter(), ['<think>still going']);
  assert.equal(out.visible, '');
  assert.equal(out.reasoning, 'still going');
  assert.equal(out.unterminated, true);
});

test('multiple configured tag pairs are all recognised', () => {
  const splitter = new ReasoningSplitter([['<think>', '</think>'], ['<reasoning>', '</reasoning>']]);
  const out = drain(splitter, ['a<reasoning>r</reasoning>b<think>t</think>c']);
  assert.equal(out.visible, 'abc');
  assert.equal(out.reasoning, 'rt');
});

test('text with no tags passes through untouched', () => {
  const out = drain(new ReasoningSplitter(), ['just ', 'an ', 'answer']);
  assert.equal(out.visible, 'just an answer');
  assert.equal(out.reasoning, '');
});

test('detectLeak reports which pattern matched, or null', () => {
  const patterns = [{ source: '</?think>', regex: /<\/?think>/i }, { source: '^okay, the user', regex: /^okay, the user/i }];
  assert.equal(detectLeak('Okay, the user wants the answer: 12', patterns), '^okay, the user');
  assert.equal(detectLeak('The answer is 12.', patterns), null);
});
