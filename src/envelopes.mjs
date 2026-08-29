// App-defined output envelopes.
//
// Real apps do not just stream prose: they stream prose wrapped around
// something their client parses -- a <panel> block, a ```sql fence, a
// <correction> tag, a JSON tail. Whether that envelope arrives WELL-FORMED is
// a structural property of the model, not a taste question, so it belongs in
// the objective half of a bakeoff. A contract declares the regex; cases assert
// against the named fields it captures.

function parseAttributes(text) {
  const attrs = {};
  for (const match of String(text ?? '').matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  for (const match of String(text ?? '').matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) {
    if (!(match[1] in attrs)) attrs[match[1]] = match[2];
  }
  return attrs;
}

export function extractEnvelopes(content, envelopes) {
  const out = {};
  for (const [name, spec] of Object.entries(envelopes || {})) {
    const text = String(content ?? '');
    const match = text.match(spec.regex);
    if (!match) {
      out[name] = { matched: false, fields: {}, parseErrors: {} };
      continue;
    }
    const fields = {};
    const parseErrors = {};
    for (const [field, descriptor] of Object.entries(spec.fields)) {
      let value;
      if (descriptor.before) value = text.slice(0, match.index);
      else if (descriptor.after) value = text.slice(match.index + match[0].length);
      else if (descriptor.match) value = match[0];
      else value = match[descriptor.group];

      if (value === undefined) {
        fields[field] = null;
        parseErrors[field] = `capture group ${descriptor.group} did not participate in the match`;
        continue;
      }
      if (descriptor.parse === 'attributes') {
        fields[field] = parseAttributes(value);
      } else if (descriptor.parse === 'json') {
        try {
          fields[field] = JSON.parse(String(value).trim());
        } catch (caught) {
          fields[field] = null;
          parseErrors[field] = String(caught?.message || caught);
        }
      } else {
        fields[field] = String(value).trim();
      }
    }
    out[name] = { matched: true, fields, parseErrors };
  }
  return out;
}
