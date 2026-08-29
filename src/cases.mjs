import { readFileSync } from 'node:fs';
import { isPlainObject, sha256 } from './util.mjs';

export const CASES_VERSION = 1;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// The assertion vocabulary. Each entry declares its required and optional
// fields so a malformed case fails at load with a precise message instead of
// silently evaluating to false against a live endpoint an hour later.
export const ASSERTION_SPECS = {
  no_tool: { required: [], optional: [] },
  tool_called: { required: ['tool'], optional: [] },
  tool_not_called: { required: ['tool'], optional: [] },
  tool_argument: { required: ['tool', 'key', 'value'], optional: [] },
  tool_argument_matches: { required: ['tool', 'key', 'value'], optional: [], regex: ['value'] },
  content_matches: { required: ['value'], optional: [], regex: ['value'] },
  content_not_matches: { required: ['value'], optional: [], regex: ['value'] },
  max_words: { required: ['value'], optional: [], integer: ['value'] },
  envelope_present: { required: ['envelope'], optional: [] },
  envelope_absent: { required: ['envelope'], optional: [] },
  envelope_field: { required: ['envelope', 'field', 'value'], optional: [] },
  envelope_field_matches: { required: ['envelope', 'field', 'value'], optional: [], regex: ['value'] },
  envelope_max_words: { required: ['envelope', 'field', 'value'], optional: [], integer: ['value'] },
};

const ROLES = new Set(['user', 'assistant', 'tool']);

class CasesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CasesError';
    this.isUsageError = true;
  }
}

function fail(path, message) {
  throw new CasesError(`cases at ${path}: ${message}`);
}

function validateMessage(message, path) {
  if (!isPlainObject(message)) fail(path, 'must be an object');
  if (message.role === 'system') {
    fail(`${path}.role`, 'cases must not carry their own system message -- the system prompt comes from the contract. Set the case\'s "systemVariant" instead.');
  }
  if (!ROLES.has(message.role)) fail(`${path}.role`, `must be one of ${[...ROLES].join(', ')}, got ${JSON.stringify(message.role)}`);
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
      fail(`${path}.tool_call_id`, 'a tool message must carry the tool_call_id it answers');
    }
    if (typeof message.content !== 'string') fail(`${path}.content`, 'a tool message must carry string content');
    return;
  }
  if (message.role === 'assistant' && message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      fail(`${path}.tool_calls`, 'must be a non-empty array when present');
    }
    message.tool_calls.forEach((call, i) => {
      if (!isPlainObject(call) || typeof call.id !== 'string' || !isPlainObject(call.function)) {
        fail(`${path}.tool_calls[${i}]`, 'must be { id, type: "function", function: { name, arguments } }');
      }
      if (typeof call.function.arguments !== 'string') {
        fail(`${path}.tool_calls[${i}].function.arguments`, 'must be a JSON *string*, as the API returns it');
      }
    });
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
      fail(`${path}.content`, 'must be a string or null');
    }
    return;
  }
  if (typeof message.content !== 'string' || !message.content.length) {
    fail(`${path}.content`, 'must be a non-empty string');
  }
}

function validateAssertion(assertion, path, { envelopeNames, toolNames }) {
  if (!isPlainObject(assertion)) fail(path, 'must be an object');
  const spec = ASSERTION_SPECS[assertion.type];
  if (!spec) {
    fail(`${path}.type`, `unknown assertion type ${JSON.stringify(assertion.type)}. Known: ${Object.keys(ASSERTION_SPECS).join(', ')}`);
  }
  const allowed = new Set([...spec.required, ...spec.optional, 'type', 'note']);
  for (const key of Object.keys(assertion)) {
    if (!allowed.has(key)) {
      const hint = key === 'value' && spec.required.includes('tool')
        ? ' -- name the tool with "tool", not "value"'
        : '';
      fail(path, `${JSON.stringify(assertion.type)} does not take "${key}"${hint}. Takes: ${[...allowed].join(', ')}`);
    }
  }
  for (const key of spec.required) {
    if (assertion[key] === undefined) fail(path, `${JSON.stringify(assertion.type)} requires "${key}"`);
  }
  for (const key of spec.integer || []) {
    if (!Number.isInteger(assertion[key]) || assertion[key] < 0) {
      fail(`${path}.${key}`, 'must be a non-negative integer');
    }
  }
  for (const key of spec.regex || []) {
    if (typeof assertion[key] !== 'string') fail(`${path}.${key}`, 'must be a regex string');
    try {
      new RegExp(assertion[key], 'i');
    } catch (caught) {
      fail(`${path}.${key}`, `is not a valid regex: ${caught.message}`);
    }
  }
  if (assertion.envelope !== undefined && envelopeNames && !envelopeNames.has(assertion.envelope)) {
    fail(`${path}.envelope`, `"${assertion.envelope}" is not declared in the contract's envelopes (${envelopeNames.size ? [...envelopeNames].join(', ') : 'none declared'})`);
  }
  if (assertion.tool !== undefined && toolNames && !toolNames.has(assertion.tool)) {
    fail(`${path}.tool`, `"${assertion.tool}" is not a tool in the contract (${toolNames.size ? [...toolNames].join(', ') : 'the contract declares no tools'})`);
  }
}

export function validateCases(raw, { contract = null } = {}) {
  const warnings = [];
  if (Array.isArray(raw)) {
    fail('', 'must be an object like { "version": 1, "cases": [ ... ] }, not a bare array');
  }
  if (!isPlainObject(raw)) fail('', 'must be a JSON object');
  if (raw.version !== CASES_VERSION) fail('version', `must be ${CASES_VERSION}, got ${JSON.stringify(raw.version)}`);
  if (!Array.isArray(raw.cases) || !raw.cases.length) fail('cases', 'must be a non-empty array');

  const envelopeNames = contract ? new Set(Object.keys(contract.envelopes || {})) : null;
  const toolNames = contract ? new Set((contract.tools || []).map((t) => t.function.name)) : null;
  const variantNames = contract ? new Set(Object.keys(contract.systemVariants)) : null;
  const defaultVariant = variantNames ? [...variantNames][0] : null;

  const ids = new Set();
  const cases = raw.cases.map((testCase, index) => {
    const path = `cases[${index}]`;
    if (!isPlainObject(testCase)) fail(path, 'must be an object');
    if (typeof testCase.id !== 'string' || !ID_RE.test(testCase.id)) {
      fail(`${path}.id`, `must match ${ID_RE}, got ${JSON.stringify(testCase.id)}`);
    }
    if (ids.has(testCase.id)) fail(`${path}.id`, `duplicate case id "${testCase.id}"`);
    ids.add(testCase.id);

    if (testCase.category !== undefined && typeof testCase.category !== 'string') {
      fail(`${path}.category`, 'must be a string when present');
    }
    const systemVariant = testCase.systemVariant === undefined ? defaultVariant : testCase.systemVariant;
    if (variantNames && !variantNames.has(systemVariant)) {
      fail(`${path}.systemVariant`, `"${systemVariant}" is not declared in the contract (${[...variantNames].join(', ')})`);
    }

    if (!Array.isArray(testCase.messages) || !testCase.messages.length) {
      fail(`${path}.messages`, 'must be a non-empty array');
    }
    testCase.messages.forEach((message, i) => validateMessage(message, `${path}.messages[${i}]`));
    const last = testCase.messages[testCase.messages.length - 1];
    if (last.role !== 'user') {
      warnings.push(`${testCase.id}: last message is role "${last.role}". The model will be asked to continue rather than to answer a user turn -- intended?`);
    }

    if (testCase.assertions !== undefined && !Array.isArray(testCase.assertions)) {
      fail(`${path}.assertions`, 'must be an array when present');
    }
    const assertions = testCase.assertions || [];
    assertions.forEach((assertion, i) => validateAssertion(assertion, `${path}.assertions[${i}]`, { envelopeNames, toolNames }));
    if (!assertions.length) {
      warnings.push(`${testCase.id}: has no assertions. It will still be recorded and can still be graded blind, but it contributes nothing to the objective pass rate.`);
    }

    if (testCase.reviewNote !== undefined && typeof testCase.reviewNote !== 'string') {
      fail(`${path}.reviewNote`, 'must be a string when present');
    }

    return {
      id: testCase.id,
      category: testCase.category || 'uncategorized',
      systemVariant,
      messages: testCase.messages,
      assertions,
      reviewNote: testCase.reviewNote || null,
    };
  });

  return { cases, warnings };
}

export function loadCases(path, contract) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (caught) {
    throw new CasesError(`cannot read cases ${path}: ${caught.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (caught) {
    throw new CasesError(`cases ${path} is not valid JSON: ${caught.message}`);
  }
  const result = validateCases(raw, { contract });
  result.fileSha = sha256(text);
  result.path = path;
  return result;
}

export { CasesError };
