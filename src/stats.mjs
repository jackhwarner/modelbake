// Percentiles use the nearest-rank method on the sorted sample. With the small
// samples this tool produces (cases x reps, often 20-60 values) interpolation
// would invent a number that no run actually produced; nearest-rank always
// reports a value the endpoint really returned.
export function percentile(values, p) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { n: 0, p50: null, p90: null, min: null, max: null };
  return {
    n: clean.length,
    p50: percentile(clean, 0.5),
    p90: percentile(clean, 0.9),
    min: Math.min(...clean),
    max: Math.max(...clean),
  };
}

export function pct(value, digits = 1) {
  return value === null || value === undefined ? '-' : `${(value * 100).toFixed(digits)}%`;
}
