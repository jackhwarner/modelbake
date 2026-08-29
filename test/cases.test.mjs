import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCases } from '../src/cases.mjs';
import { validateContract } from '../src/contract.mjs';

const contract = validateContract({
  version: 1,
  systemVariants: { text: 'a', voice: 'b' },
  tools: [{ type: 'function', function: { name: 'add_todo', parameters: { type: 'object' } } }],
  envelopes: { card: { pattern: '<card>(.*)</card>', fields: { body: { group: 1 } } } },
}).contract;

const cases = (list) => ({ version: 1, cases: list });

test('a valid file loads and defaults the system variant to the first', () => {
  const { cases: out } = validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'hi' }], assertions: [{ type: 'no_tool' }] },
  ]), { contract });
  assert.equal(out[0].systemVariant, 'text');
  assert.equal(out[0].category, 'uncategorized');
});

test('a bare array is rejected with the right shape in the message', () => {
  assert.throws(() => validateCases([{ id: 'a' }]), /"version": 1, "cases"/);
});

test('duplicate case ids are rejected', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }] },
    { id: 'a', messages: [{ role: 'user', content: 'y' }] },
  ])), /duplicate case id/);
});

test('a case carrying its own system message is rejected and told where the prompt lives', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'system', content: 'you are...' }, { role: 'user', content: 'x' }] },
  ])), /systemVariant/);
});

test('a system variant the contract does not declare is rejected', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', systemVariant: 'braille', messages: [{ role: 'user', content: 'x' }] },
  ]), { contract }), /not declared in the contract/);
});

test('an unknown assertion type is rejected and lists the known ones', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }], assertions: [{ type: 'vibes_good' }] },
  ])), /unknown assertion type.*tool_called/s);
});

test('naming a tool with "value" instead of "tool" gets a pointed error', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }], assertions: [{ type: 'tool_called', value: 'add_todo' }] },
  ])), /name the tool with "tool", not "value"/);
});

test('asserting on a tool the contract does not send is rejected', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }], assertions: [{ type: 'tool_called', tool: 'launch_missile' }] },
  ]), { contract }), /is not a tool in the contract/);
});

test('asserting on an envelope the contract does not declare is rejected', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }], assertions: [{ type: 'envelope_present', envelope: 'panel' }] },
  ]), { contract }), /not declared in the contract's envelopes/);
});

test('an invalid regex in an assertion is caught at load', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }], assertions: [{ type: 'content_matches', value: '(' }] },
  ])), /not a valid regex/);
});

test('a tool message must carry the id it answers', () => {
  assert.throws(() => validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: '{}' }] },
  ])), /tool_call_id/);
});

test('assistant tool_calls arguments must be a JSON string, as the API returns them', () => {
  assert.throws(() => validateCases(cases([
    {
      id: 'a',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'add_todo', arguments: { a: 1 } } }] },
      ],
    },
  ])), /must be a JSON \*string\*/);
});

test('a case with no assertions warns but is kept, because blind grading still uses it', () => {
  const { cases: out, warnings } = validateCases(cases([{ id: 'a', messages: [{ role: 'user', content: 'x' }] }]));
  assert.equal(out.length, 1);
  assert.ok(warnings.some((w) => /no assertions/.test(w)));
});

test('a case that does not end on a user turn warns', () => {
  const { warnings } = validateCases(cases([
    { id: 'a', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] },
  ]));
  assert.ok(warnings.some((w) => /last message is role "assistant"/.test(w)));
});
