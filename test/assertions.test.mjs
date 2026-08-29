import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssertion, structuralGate } from '../src/assertions.mjs';
import { extractEnvelopes } from '../src/envelopes.mjs';
import { validateContract } from '../src/contract.mjs';

const { contract } = validateContract({
  version: 1,
  systemVariants: { text: 'a' },
  envelopes: {
    card: {
      pattern: '<card\\b([^>]*)>([\\s\\S]*?)</card>',
      fields: { attrs: { group: 1, parse: 'attributes' }, body: { group: 2 }, lead: { before: true } },
    },
    tail: {
      pattern: '```json\\s*([\\s\\S]*?)```',
      fields: { data: { group: 1, parse: 'json' } },
    },
  },
});

const row = ({ content = '', toolCalls = [], transportError = null, reasoningLeak = null } = {}) => ({
  content,
  contentWords: content.trim() ? content.trim().split(/\s+/).length : 0,
  toolCalls,
  transportError,
  reasoningLeak,
  envelopes: extractEnvelopes(content, contract.envelopes),
});

const call = (name, args, argumentError = null) => ({ name, parsedArguments: args, argumentError, argumentsRaw: JSON.stringify(args) });

test('no_tool', () => {
  assert.equal(evaluateAssertion(row(), { type: 'no_tool' }).pass, true);
  assert.equal(evaluateAssertion(row({ toolCalls: [call('a', {})] }), { type: 'no_tool' }).pass, false);
});

test('tool_called and tool_not_called', () => {
  const r = row({ toolCalls: [call('list_todos', { filter: 'open' })] });
  assert.equal(evaluateAssertion(r, { type: 'tool_called', tool: 'list_todos' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'tool_called', tool: 'add_todo' }).pass, false);
  assert.equal(evaluateAssertion(r, { type: 'tool_not_called', tool: 'add_todo' }).pass, true);
});

test('tool_argument compares strictly, including type', () => {
  const r = row({ toolCalls: [call('complete_todo', { id: 52 })] });
  assert.equal(evaluateAssertion(r, { type: 'tool_argument', tool: 'complete_todo', key: 'id', value: 52 }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'tool_argument', tool: 'complete_todo', key: 'id', value: '52' }).pass, false);
});

test('tool_argument reads a dotted path', () => {
  const r = row({ toolCalls: [call('f', { filter: { status: 'open' } })] });
  assert.equal(evaluateAssertion(r, { type: 'tool_argument', tool: 'f', key: 'filter.status', value: 'open' }).pass, true);
});

test('tool_argument on a tool that never fired fails with a useful actual', () => {
  const outcome = evaluateAssertion(row(), { type: 'tool_argument', tool: 'f', key: 'a', value: 1 });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.actual, 'tool not called');
});

test('tool_argument_matches is case-insensitive regex over the stringified value', () => {
  const r = row({ toolCalls: [call('add_todo', { title: 'Buy Milk' })] });
  assert.equal(evaluateAssertion(r, { type: 'tool_argument_matches', tool: 'add_todo', key: 'title', value: 'milk' }).pass, true);
});

test('content_matches, content_not_matches and max_words', () => {
  const r = row({ content: 'The answer is 144.' });
  assert.equal(evaluateAssertion(r, { type: 'content_matches', value: '\\b144\\b' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'content_not_matches', value: 'sorry' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'max_words', value: 4 }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'max_words', value: 3 }).pass, false);
});

test('envelope_present, absent, and captured attribute fields', () => {
  const r = row({ content: 'Here.\n<card title="This week">line one</card>' });
  assert.equal(evaluateAssertion(r, { type: 'envelope_present', envelope: 'card' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'envelope_absent', envelope: 'card' }).pass, false);
  assert.equal(evaluateAssertion(r, { type: 'envelope_field', envelope: 'card', field: 'attrs.title', value: 'This week' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'envelope_field_matches', envelope: 'card', field: 'body', value: 'line' }).pass, true);
  assert.equal(evaluateAssertion(r, { type: 'envelope_max_words', envelope: 'card', field: 'lead', value: 1 }).pass, true);
});

test('an envelope assertion on a missing envelope fails rather than throwing', () => {
  const outcome = evaluateAssertion(row({ content: 'no card here' }), { type: 'envelope_field', envelope: 'card', field: 'attrs.title', value: 'x' });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.actual, 'envelope not present');
});

test('a json-parsed envelope field records its parse error instead of throwing', () => {
  const r = row({ content: '```json\n{"a": }\n```' });
  assert.equal(r.envelopes.tail.matched, true);
  assert.equal(r.envelopes.tail.fields.data, null);
  assert.ok(r.envelopes.tail.parseErrors.data);
});

test('the structural gate catches transport, argument and leak failures', () => {
  assert.equal(structuralGate(row()).pass, true);
  assert.match(structuralGate(row({ transportError: 'HTTP 500' })).failures[0], /transport/);
  assert.match(structuralGate(row({ toolCalls: [call('f', null, 'Unexpected end of JSON input')] })).failures[0], /unparseable/);
  assert.match(structuralGate(row({ reasoningLeak: '</?think>' })).failures[0], /leaked/);
});

test('the structural gate reports every failure on a row, not just the first', () => {
  const gate = structuralGate(row({ transportError: 'boom', reasoningLeak: 'x' }));
  assert.equal(gate.failures.length, 2);
});
