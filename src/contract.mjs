import { readFileSync } from 'node:fs';
import { isPlainObject, sha256, sha256Json } from './util.mjs';

export const CONTRACT_VERSION = 1;

// Sampling keys this tool will forward. The list is closed on purpose: a typo
// like "temprature" silently changing nothing is exactly the class of bug that
// makes a bakeoff lie. Anything else goes in sampling.extra, which is passed
// through verbatim and recorded on every row.
const SAMPLING_KEYS = new Set([
  'temperature', 'top_p', 'top_k', 'min_p', 'max_tokens',
  'repetition_penalty', 'presence_penalty', 'frequency_penalty', 'stop', 'seed',
]);

const TOOL_CHOICE_STRINGS = new Set(['auto', 'none', 'required']);
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
    this.isUsageError = true;
  }
}

function fail(path, message) {
  throw new ContractError(`contract${path ? ` at ${path}` : ''}: ${message}`);
}

function validateTool(tool, index) {
  const path = `tools[${index}]`;
  if (!isPlainObject(tool)) fail(path, 'must be an object');
  if (tool.type !== 'function') fail(path, `type must be "function", got ${JSON.stringify(tool.type)}`);
  const fn = tool.function;
  if (!isPlainObject(fn)) fail(`${path}.function`, 'must be an object');
  if (typeof fn.name !== 'string' || !NAME_RE.test(fn.name)) {
    fail(`${path}.function.name`, `must match ${NAME_RE}, got ${JSON.stringify(fn.name)}`);
  }
  if (fn.description !== undefined && typeof fn.description !== 'string') {
    fail(`${path}.function.description`, 'must be a string when present');
  }
  // parameters is optional in the OpenAI spec (a no-argument tool), but if it
  // is present it must be a JSON Schema object -- servers reject anything else.
  if (fn.parameters !== undefined && !isPlainObject(fn.parameters)) {
    fail(`${path}.function.parameters`, 'must be a JSON Schema object when present');
  }
  return fn.name;
}

function validateEnvelope(name, spec) {
  const path = `envelopes.${name}`;
  if (!NAME_RE.test(name)) fail(path, `envelope name must match ${NAME_RE}`);
  if (!isPlainObject(spec)) fail(path, 'must be an object');
  if (typeof spec.pattern !== 'string' || !spec.pattern) fail(`${path}.pattern`, 'must be a non-empty regex string');
  const flags = spec.flags === undefined ? 'i' : spec.flags;
  if (typeof flags !== 'string' || /[^gimsuy]/.test(flags)) fail(`${path}.flags`, 'must be a string of regex flags');
  let regex;
  try {
    regex = new RegExp(spec.pattern, flags.replace('g', ''));
  } catch (caught) {
    fail(`${path}.pattern`, `is not a valid regex: ${caught.message}`);
  }
  if (!isPlainObject(spec.fields) || !Object.keys(spec.fields).length) {
    fail(`${path}.fields`, 'must be a non-empty object of field descriptors');
  }
  const fields = {};
  for (const [field, descriptor] of Object.entries(spec.fields)) {
    const fieldPath = `${path}.fields.${field}`;
    if (!isPlainObject(descriptor)) fail(fieldPath, 'must be an object');
    const keys = ['group', 'before', 'after', 'match'].filter((k) => descriptor[k] !== undefined);
    if (keys.length !== 1) fail(fieldPath, 'must set exactly one of: group, before, after, match');
    if (descriptor.group !== undefined && !Number.isInteger(descriptor.group)) {
      fail(`${fieldPath}.group`, 'must be an integer capture-group index');
    }
    if (descriptor.parse !== undefined && !['attributes', 'json', 'text'].includes(descriptor.parse)) {
      fail(`${fieldPath}.parse`, 'must be one of: attributes, json, text');
    }
    fields[field] = { ...descriptor, parse: descriptor.parse || 'text' };
  }
  return { name, pattern: spec.pattern, flags, regex, fields };
}

function validateReasoning(raw) {
  const path = 'reasoning';
  const spec = raw === undefined ? {} : raw;
  if (!isPlainObject(spec)) fail(path, 'must be an object');
  const inlineTags = spec.inlineTags === undefined ? [['<think>', '</think>']] : spec.inlineTags;
  if (!Array.isArray(inlineTags)) fail(`${path}.inlineTags`, 'must be an array of [open, close] pairs');
  for (const [i, pair] of inlineTags.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((t) => typeof t !== 'string' || !t)) {
      fail(`${path}.inlineTags[${i}]`, 'must be a [open, close] pair of non-empty strings');
    }
  }
  const rawLeaks = spec.leakPatterns === undefined ? ['</?think>', '</?reasoning>'] : spec.leakPatterns;
  if (!Array.isArray(rawLeaks)) fail(`${path}.leakPatterns`, 'must be an array of regex strings');
  const leakPatterns = rawLeaks.map((pattern, i) => {
    if (typeof pattern !== 'string') fail(`${path}.leakPatterns[${i}]`, 'must be a regex string');
    try {
      return { source: pattern, regex: new RegExp(pattern, 'i') };
    } catch (caught) {
      return fail(`${path}.leakPatterns[${i}]`, `is not a valid regex: ${caught.message}`);
    }
  });
  return { inlineTags, leakPatterns };
}

export function validateContract(raw, { sourceLabel = 'contract' } = {}) {
  const warnings = [];
  if (!isPlainObject(raw)) fail('', 'must be a JSON object');
  if (raw.version !== CONTRACT_VERSION) {
    fail('version', `must be ${CONTRACT_VERSION}, got ${JSON.stringify(raw.version)}`);
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') fail('name', 'must be a string when present');

  if (!isPlainObject(raw.systemVariants)) {
    fail('systemVariants', 'must be an object of { variantName: systemPromptString } with at least one entry');
  }
  const variantNames = Object.keys(raw.systemVariants);
  if (!variantNames.length) fail('systemVariants', 'must declare at least one variant');
  for (const variant of variantNames) {
    if (!NAME_RE.test(variant)) fail(`systemVariants.${variant}`, `variant name must match ${NAME_RE}`);
    const text = raw.systemVariants[variant];
    if (typeof text !== 'string' || !text.trim()) {
      fail(`systemVariants.${variant}`, 'must be a non-empty system prompt string');
    }
    if (/\{\{|\$\{|<PASTE|TODO:/i.test(text)) {
      warnings.push(`systemVariants.${variant} still contains template markers or a TODO -- did the extraction actually run?`);
    }
  }

  if (raw.tools !== undefined && !Array.isArray(raw.tools)) fail('tools', 'must be an array when present');
  const tools = raw.tools || [];
  const seen = new Set();
  tools.forEach((tool, index) => {
    const name = validateTool(tool, index);
    if (seen.has(name)) fail(`tools[${index}].function.name`, `duplicate tool name "${name}"`);
    seen.add(name);
  });
  if (!tools.length) {
    warnings.push('tools is empty -- tool_called assertions can never pass. That is fine for a tool-free app, and a mistake otherwise.');
  }

  if (raw.sampling !== undefined && !isPlainObject(raw.sampling)) fail('sampling', 'must be an object when present');
  const samplingRaw = raw.sampling || {};
  const sampling = {};
  for (const [key, value] of Object.entries(samplingRaw)) {
    if (key === 'extra') {
      if (!isPlainObject(value)) fail('sampling.extra', 'must be an object when present');
      sampling.extra = value;
      continue;
    }
    if (!SAMPLING_KEYS.has(key)) {
      fail(`sampling.${key}`, `is not a recognized sampling key. Known: ${[...SAMPLING_KEYS].join(', ')}. Put server-specific knobs in sampling.extra.`);
    }
    if (value === null) continue;
    if (key === 'stop') {
      if (!Array.isArray(value) && typeof value !== 'string') fail('sampling.stop', 'must be a string or array of strings');
    } else if (typeof value !== 'number') {
      fail(`sampling.${key}`, `must be a number or null, got ${JSON.stringify(value)}`);
    }
    sampling[key] = value;
  }
  if (sampling.max_tokens === undefined) sampling.max_tokens = 1024;

  let toolChoice = raw.toolChoice === undefined ? 'auto' : raw.toolChoice;
  if (typeof toolChoice === 'string') {
    if (!TOOL_CHOICE_STRINGS.has(toolChoice)) {
      fail('toolChoice', `must be one of ${[...TOOL_CHOICE_STRINGS].join(', ')} or a tool-choice object`);
    }
  } else if (!isPlainObject(toolChoice)) {
    fail('toolChoice', 'must be a string or an object');
  }

  const envelopes = {};
  if (raw.envelopes !== undefined) {
    if (!isPlainObject(raw.envelopes)) fail('envelopes', 'must be an object when present');
    for (const [name, spec] of Object.entries(raw.envelopes)) envelopes[name] = validateEnvelope(name, spec);
  }

  const reasoning = validateReasoning(raw.reasoning);

  if (raw.requestOverrides !== undefined && !isPlainObject(raw.requestOverrides)) {
    fail('requestOverrides', 'must be an object when present');
  }
  const requestOverrides = raw.requestOverrides || {};
  for (const reserved of ['model', 'messages', 'tools', 'stream']) {
    if (reserved in requestOverrides) {
      fail(`requestOverrides.${reserved}`, 'is owned by the runner and cannot be overridden');
    }
  }
  // Hard-won serving fact #2 (see DESIGN.md "Two serving facts"): on some
  // servers a per-request chat_template_kwargs is a prompt-cache BYPASS. The
  // template belongs in the server launch flags so that every request -- prime
  // and case alike -- shares one cacheable prefix.
  if ('chat_template_kwargs' in requestOverrides) {
    warnings.push(
      'requestOverrides.chat_template_kwargs is set. On some servers a per-request '
      + 'template kwarg bypasses the prompt cache entirely (measured on mlx-lm: cached_tokens=0 '
      + 'on every request, full prefill each turn). Configure the template at server launch '
      + 'instead, and keep the request identical to production. Warm mode will most likely '
      + 'degrade to cold_only.',
    );
  }

  if (raw.primeUserMessage !== undefined && typeof raw.primeUserMessage !== 'string') {
    fail('primeUserMessage', 'must be a string when present');
  }

  const contract = {
    version: CONTRACT_VERSION,
    name: raw.name || sourceLabel,
    systemVariants: raw.systemVariants,
    tools,
    sampling,
    toolChoice,
    envelopes,
    reasoning,
    requestOverrides,
    primeUserMessage: raw.primeUserMessage || 'ok',
  };

  // Two hashes, because they answer two different questions.
  //  - modelFacingSha: the bytes the model actually receives. Two runs are
  //    comparable if and only if this matches.
  //  - fileSha: the raw file. Lets a report say "same contract, edited notes".
  contract.modelFacingSha = sha256Json({
    version: contract.version,
    systemVariants: contract.systemVariants,
    tools: contract.tools,
    sampling: contract.sampling,
    toolChoice: contract.toolChoice,
    requestOverrides: contract.requestOverrides,
  });

  return { contract, warnings, variantNames };
}

export function loadContract(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (caught) {
    throw new ContractError(`cannot read contract ${path}: ${caught.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (caught) {
    throw new ContractError(`contract ${path} is not valid JSON: ${caught.message}`);
  }
  const result = validateContract(raw, { sourceLabel: path });
  result.contract.fileSha = sha256(text);
  result.contract.path = path;
  return result;
}

export { ContractError };
