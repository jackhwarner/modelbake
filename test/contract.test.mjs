import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract } from '../src/contract.mjs';

const base = () => ({
  version: 1,
  systemVariants: { text: 'You are a helpful assistant.' },
  tools: [{ type: 'function', function: { name: 'add_todo', parameters: { type: 'object', properties: {} } } }],
  sampling: { temperature: 0.7, max_tokens: 512 },
});

test('a minimal valid contract loads and gets a model-facing sha', () => {
  const { contract, warnings } = validateContract(base());
  assert.match(contract.modelFacingSha, /^[0-9a-f]{64}$/);
  assert.deepEqual(warnings, []);
  assert.equal(contract.toolChoice, 'auto');
  assert.equal(contract.primeUserMessage, 'ok');
});

test('the sha ignores key order and whitespace but not content', () => {
  const a = validateContract(base()).contract.modelFacingSha;
  const reordered = { sampling: { max_tokens: 512, temperature: 0.7 }, tools: base().tools, systemVariants: { text: 'You are a helpful assistant.' }, version: 1 };
  assert.equal(validateContract(reordered).contract.modelFacingSha, a);
  const changed = base();
  changed.systemVariants.text += ' ';
  assert.notEqual(validateContract(changed).contract.modelFacingSha, a);
});

test('a wrong version is rejected', () => {
  assert.throws(() => validateContract({ ...base(), version: 2 }), /version.*must be 1/);
});

test('an empty systemVariants object is rejected', () => {
  assert.throws(() => validateContract({ ...base(), systemVariants: {} }), /at least one variant/);
});

test('more than two system variants are fine', () => {
  const { contract } = validateContract({
    ...base(),
    systemVariants: { text: 'a', voice: 'b', tool_free: 'c', trial: 'd' },
  });
  assert.equal(Object.keys(contract.systemVariants).length, 4);
});

test('a misspelled sampling key is an error, not a silent no-op', () => {
  assert.throws(() => validateContract({ ...base(), sampling: { temprature: 0.7 } }), /not a recognized sampling key/);
});

test('server-specific sampling knobs are allowed through sampling.extra', () => {
  const { contract } = validateContract({ ...base(), sampling: { temperature: 0.7, extra: { top_a: 0.2 } } });
  assert.deepEqual(contract.sampling.extra, { top_a: 0.2 });
});

test('a duplicate tool name is rejected', () => {
  const contract = base();
  contract.tools.push(contract.tools[0]);
  assert.throws(() => validateContract(contract), /duplicate tool name/);
});

test('a tool missing type: function is rejected', () => {
  assert.throws(
    () => validateContract({ ...base(), tools: [{ function: { name: 'x' } }] }),
    /type must be "function"/,
  );
});

test('a broken envelope regex is caught at load, not at assertion time', () => {
  assert.throws(
    () => validateContract({ ...base(), envelopes: { p: { pattern: '<panel(', fields: { a: { group: 1 } } } } }),
    /not a valid regex/,
  );
});

test('an envelope field must pick exactly one source', () => {
  assert.throws(
    () => validateContract({ ...base(), envelopes: { p: { pattern: 'x', fields: { a: { group: 1, before: true } } } } }),
    /exactly one of/,
  );
});

test('per-request chat_template_kwargs warns about the cache bypass', () => {
  const { warnings } = validateContract({ ...base(), requestOverrides: { chat_template_kwargs: { enable_thinking: false } } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bypasses the prompt cache|cache/i);
  assert.match(warnings[0], /server launch/);
});

test('requestOverrides cannot hijack a field the runner owns', () => {
  assert.throws(() => validateContract({ ...base(), requestOverrides: { messages: [] } }), /owned by the runner/);
});

test('a scaffold left un-extracted warns about its TODO marker', () => {
  const { warnings } = validateContract({ ...base(), systemVariants: { text: 'TODO: paste the real prompt' } });
  assert.ok(warnings.some((w) => /TODO|extraction/.test(w)));
});

test('an empty tool array warns rather than failing', () => {
  const { warnings, contract } = validateContract({ ...base(), tools: [] });
  assert.equal(contract.tools.length, 0);
  assert.ok(warnings.some((w) => /tool_called assertions can never pass/.test(w)));
});
