import { getPath, words } from './util.mjs';

// The objective half of the score. Each assertion is a single structural claim
// about one row that a machine can settle without an opinion. Anything that
// needs an opinion belongs in `modelbake blind`, not here.

function toolNamed(row, name) {
  return row.toolCalls.find((call) => call.name === name) || null;
}

function envelope(row, name) {
  return row.envelopes?.[name] || { matched: false, fields: {}, parseErrors: {} };
}

export function describeAssertion(assertion) {
  switch (assertion.type) {
    case 'no_tool': return 'no_tool';
    case 'tool_called': return `tool_called(${assertion.tool})`;
    case 'tool_not_called': return `tool_not_called(${assertion.tool})`;
    case 'tool_argument': return `tool_argument(${assertion.tool}.${assertion.key} === ${JSON.stringify(assertion.value)})`;
    case 'tool_argument_matches': return `tool_argument_matches(${assertion.tool}.${assertion.key} =~ /${assertion.value}/)`;
    case 'content_matches': return `content_matches(/${assertion.value}/)`;
    case 'content_not_matches': return `content_not_matches(/${assertion.value}/)`;
    case 'max_words': return `max_words(${assertion.value})`;
    case 'envelope_present': return `envelope_present(${assertion.envelope})`;
    case 'envelope_absent': return `envelope_absent(${assertion.envelope})`;
    case 'envelope_field': return `envelope_field(${assertion.envelope}.${assertion.field} === ${JSON.stringify(assertion.value)})`;
    case 'envelope_field_matches': return `envelope_field_matches(${assertion.envelope}.${assertion.field} =~ /${assertion.value}/)`;
    case 'envelope_max_words': return `envelope_max_words(${assertion.envelope}.${assertion.field} <= ${assertion.value})`;
    default: return `unknown(${assertion.type})`;
  }
}

export function evaluateAssertion(row, assertion) {
  switch (assertion.type) {
    case 'no_tool':
      return { pass: row.toolCalls.length === 0, actual: row.toolCalls.map((c) => c.name).join(',') || 'none' };
    case 'tool_called':
      return { pass: Boolean(toolNamed(row, assertion.tool)), actual: row.toolCalls.map((c) => c.name).join(',') || 'none' };
    case 'tool_not_called':
      return { pass: !toolNamed(row, assertion.tool), actual: row.toolCalls.map((c) => c.name).join(',') || 'none' };
    case 'tool_argument': {
      const call = toolNamed(row, assertion.tool);
      const actual = call ? getPath(call.parsedArguments, assertion.key) : undefined;
      return { pass: actual === assertion.value, actual: call ? JSON.stringify(actual) : 'tool not called' };
    }
    case 'tool_argument_matches': {
      const call = toolNamed(row, assertion.tool);
      if (!call) return { pass: false, actual: 'tool not called' };
      const actual = getPath(call.parsedArguments, assertion.key);
      const text = actual === undefined || actual === null ? '' : String(actual);
      return { pass: new RegExp(assertion.value, 'i').test(text), actual: JSON.stringify(actual) };
    }
    case 'content_matches':
      return { pass: new RegExp(assertion.value, 'i').test(row.content), actual: null };
    case 'content_not_matches':
      return { pass: !new RegExp(assertion.value, 'i').test(row.content), actual: null };
    case 'max_words':
      return { pass: row.contentWords <= assertion.value, actual: `${row.contentWords} words` };
    case 'envelope_present':
      return { pass: envelope(row, assertion.envelope).matched, actual: null };
    case 'envelope_absent':
      return { pass: !envelope(row, assertion.envelope).matched, actual: null };
    case 'envelope_field': {
      const env = envelope(row, assertion.envelope);
      if (!env.matched) return { pass: false, actual: 'envelope not present' };
      const actual = getPath(env.fields, assertion.field);
      return { pass: actual === assertion.value, actual: JSON.stringify(actual) };
    }
    case 'envelope_field_matches': {
      const env = envelope(row, assertion.envelope);
      if (!env.matched) return { pass: false, actual: 'envelope not present' };
      const actual = getPath(env.fields, assertion.field);
      const text = actual === undefined || actual === null ? '' : String(actual);
      return { pass: new RegExp(assertion.value, 'i').test(text), actual: JSON.stringify(actual).slice(0, 120) };
    }
    case 'envelope_max_words': {
      const env = envelope(row, assertion.envelope);
      if (!env.matched) return { pass: false, actual: 'envelope not present' };
      const count = words(getPath(env.fields, assertion.field));
      return { pass: count <= assertion.value, actual: `${count} words` };
    }
    default:
      return { pass: false, actual: `unknown assertion type ${assertion.type}` };
  }
}

// The structural gate. Exactly three conditions, and they are deliberately the
// three that mean "this output could not be used by the app at all", rather
// than "this output was not what we hoped". Truncation and unterminated
// reasoning are REPORTED separately (see report diagnostics) because they are
// real but are a budget/config signal as often as a model signal, and folding
// them in here would quietly move the bar between versions.
export function structuralGate(row) {
  const failures = [];
  if (row.transportError) failures.push(`transport: ${row.transportError}`);
  const bad = row.toolCalls.filter((call) => call.argumentError);
  for (const call of bad) failures.push(`tool arguments unparseable (${call.name}): ${call.argumentError}`);
  if (row.reasoningLeak) failures.push(`reasoning leaked into visible content (matched /${row.reasoningLeak}/)`);
  return { pass: failures.length === 0, failures };
}
