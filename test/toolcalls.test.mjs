import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeToolDelta, finalizeToolCalls, resolveIndex } from '../src/toolcalls.mjs';

const merge = (deltas) => {
  const target = [];
  for (const delta of deltas) mergeToolDelta(target, delta);
  return finalizeToolCalls(target);
};

test('arguments split across many chunks reassemble', () => {
  const calls = merge([
    { index: 0, id: 'call_a', type: 'function', function: { name: 'add_todo', arguments: '' } },
    { index: 0, function: { arguments: '{"ti' } },
    { index: 0, function: { arguments: 'tle":"Buy ' } },
    { index: 0, function: { arguments: 'milk"}' } },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parsedArguments, { title: 'Buy milk' });
  assert.equal(calls[0].argumentError, null);
});

test('a server that repeats the id and name on every delta does not duplicate them', () => {
  const calls = merge([
    { index: 0, id: 'call_a', function: { name: 'list_todos', arguments: '{' } },
    { index: 0, id: 'call_a', function: { name: 'list_todos', arguments: '}' } },
  ]);
  assert.equal(calls[0].id, 'call_a');
  assert.equal(calls[0].name, 'list_todos');
});

test('an id genuinely chunked across deltas is concatenated', () => {
  const calls = merge([
    { index: 0, id: 'call_', function: { name: 'a', arguments: '{}' } },
    { index: 0, id: '99', function: { name: 'b', arguments: '' } },
  ]);
  assert.equal(calls[0].id, 'call_99');
  assert.equal(calls[0].name, 'ab');
});

test('two calls are kept apart', () => {
  const calls = merge([
    { index: 0, id: 'c1', function: { name: 'one', arguments: '{"a":1}' } },
    { index: 1, id: 'c2', function: { name: 'two', arguments: '{"b":2}' } },
  ]);
  assert.deepEqual(calls.map((c) => c.name), ['one', 'two']);
});

test('a second call with no index opens a new slot rather than corrupting the first', () => {
  const calls = merge([
    { id: 'c1', function: { name: 'one', arguments: '{"a":1}' } },
    { id: 'c2', function: { name: 'two', arguments: '{"b":2}' } },
  ]);
  assert.deepEqual(calls.map((c) => c.name), ['one', 'two']);
  assert.deepEqual(calls[1].parsedArguments, { b: 2 });
});

test('resolveIndex continues the open call when the delta carries no id', () => {
  const target = [{ id: 'c1', type: 'function', function: { name: 'one', arguments: '{' } }];
  assert.equal(resolveIndex(target, { function: { arguments: '}' } }), 0);
});

test('truncated JSON arguments are recorded as a parse error, not thrown', () => {
  const calls = merge([{ index: 0, id: 'c1', function: { name: 'one', arguments: '{"a":' } }]);
  assert.equal(calls[0].parsedArguments, null);
  assert.match(calls[0].argumentError, /JSON/i);
});

test('empty arguments mean an empty object, not a failure', () => {
  const calls = merge([{ index: 0, id: 'c1', function: { name: 'ping', arguments: '' } }]);
  assert.deepEqual(calls[0].parsedArguments, {});
  assert.equal(calls[0].argumentError, null);
});

test('arguments that parse to an array are a failure, because tools take objects', () => {
  const calls = merge([{ index: 0, id: 'c1', function: { name: 'one', arguments: '[1,2]' } }]);
  assert.equal(calls[0].parsedArguments, null);
  assert.match(calls[0].argumentError, /array/);
});
