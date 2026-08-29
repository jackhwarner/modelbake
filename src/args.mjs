// Argument parsing. Supports --key=value, --key value, bare --flag, and
// positionals. Deliberately tiny: zero runtime dependencies is a feature of
// this tool, not an accident (see DESIGN.md "No dependencies").

export function parseArgs(argv) {
  const flags = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positional };
}

export function requireFlags(flags, names, command) {
  const missing = names.filter((name) => flags[name] === undefined || flags[name] === true);
  if (missing.length) {
    throw new UsageError(`${command}: missing required ${missing.map((n) => `--${n}=`).join(', ')}`);
  }
}

export function intFlag(flags, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (flags[name] === undefined) return fallback;
  const value = Number.parseInt(String(flags[name]), 10);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be an integer, got ${JSON.stringify(flags[name])}`);
  if (value < min || value > max) throw new UsageError(`--${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

export function floatFlag(flags, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (flags[name] === undefined) return fallback;
  const value = Number.parseFloat(String(flags[name]));
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got ${JSON.stringify(flags[name])}`);
  if (value < min || value > max) throw new UsageError(`--${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

export function boolFlag(flags, name, fallback = false) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (raw === true || raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new UsageError(`--${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.isUsageError = true;
  }
}
