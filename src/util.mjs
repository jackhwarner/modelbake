import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted recursively, arrays left in order. Two
// contracts that differ only by key order or whitespace must hash the same,
// because they send the model the same bytes.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Json(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function words(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

// Dotted path lookup that tolerates array indices: "a.b.0.c".
export function getPath(value, path) {
  if (value === null || value === undefined) return undefined;
  return String(path).split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, value);
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deterministic PRNG so `blind` produces a stable, reproducible mapping from
// the same inputs and seed. Math.random would make a grading run
// unreproducible, which is the opposite of the point.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(list, seed) {
  const random = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function seedFromString(text) {
  return Number.parseInt(sha256(text).slice(0, 8), 16) >>> 0;
}
