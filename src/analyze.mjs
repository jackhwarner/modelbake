import { summarize, percentile } from './stats.mjs';

export const LATENCY_METRICS = ['firstEventMs', 'firstReasoningMs', 'firstVisibleMs', 'firstToolMs', 'totalMs'];

function decodeStart(row) {
  for (const key of ['firstVisibleMs', 'firstToolMs', 'firstReasoningMs', 'firstEventMs']) {
    if (Number.isFinite(row[key])) return row[key];
  }
  return null;
}

function latencyFor(rows) {
  const out = {};
  for (const metric of LATENCY_METRICS) out[metric] = summarize(rows.map((row) => row[metric]));
  out.rowCount = rows.length;
  return out;
}

export function analyzeFile(rows, path) {
  const meta = rows.find((row) => row.kind === 'meta');
  if (!meta) {
    const error = new Error(`${path} has no meta row -- was it produced by \`modelbake run\`?`);
    error.isUsageError = true;
    throw error;
  }
  const modeRow = rows.find((row) => row.kind === 'mode');
  const endRow = rows.find((row) => row.kind === 'end');
  const results = rows.filter((row) => row.kind === 'result');
  const primes = rows.filter((row) => row.kind === 'prime');
  const verifies = rows.filter((row) => row.kind === 'verify');
  const caseIndex = new Map(rows.filter((row) => row.kind === 'case').map((row) => [row.caseId, row]));

  const coldDiagnostic = results.find((row) => row.phase === 'cold-diagnostic') || null;
  const scored = results.filter((row) => row.phase === 'warm' || row.phase === 'cold');

  const structuralFailures = [];
  let structuralPass = 0;
  const objectiveFailures = [];
  let objectivePass = 0;
  let objectiveTotal = 0;
  const byCategory = new Map();

  for (const row of scored) {
    if (row.structural?.pass) structuralPass += 1;
    else {
      for (const failure of row.structural?.failures || ['unknown structural failure']) {
        structuralFailures.push(`${row.caseId}.${row.rep}  ${failure}`);
      }
    }
    const bucket = byCategory.get(row.category) || { pass: 0, total: 0 };
    for (const check of row.checks || []) {
      objectiveTotal += 1;
      bucket.total += 1;
      if (check.pass) { objectivePass += 1; bucket.pass += 1; } else {
        objectiveFailures.push(`${row.caseId}.${row.rep}  ${check.assertion}${check.actual ? `  actual ${check.actual}` : ''}`);
      }
    }
    byCategory.set(row.category, bucket);
  }

  const warmRows = scored.filter((row) => row.phase === 'warm' && row.warmValid);
  const coldRows = scored.filter((row) => row.phase === 'cold');
  const warmInvalid = scored.filter((row) => row.phase === 'warm' && !row.warmValid).length;

  const rates = [];
  const throughputSkipped = { noTokenCount: 0, noDecodeWindow: 0 };
  for (const row of scored) {
    const tokens = row.completionTokens;
    const start = decodeStart(row);
    if (!Number.isFinite(tokens)) { throughputSkipped.noTokenCount += 1; continue; }
    if (!Number.isFinite(start) || !Number.isFinite(row.totalMs)) { throughputSkipped.noDecodeWindow += 1; continue; }
    const seconds = (row.totalMs - start) / 1000;
    // A decode window at or below a millisecond cannot produce an honest rate:
    // the divisor is dominated by clock granularity, not by the model.
    if (seconds <= 0.001) { throughputSkipped.noDecodeWindow += 1; continue; }
    rates.push(tokens / seconds);
  }

  const cacheSources = [...new Set(scored.map((row) => row.cacheSource).filter(Boolean))];
  const hitRatios = scored.map((row) => row.cacheHitRatio).filter(Number.isFinite);

  return {
    path,
    meta,
    label: meta.label,
    mode: modeRow?.mode || 'cold_only',
    coldReason: modeRow?.reason || null,
    completed: endRow ? endRow.completed !== false : false,
    endReason: endRow?.reason || null,
    rowCount: scored.length,
    coldDiagnostic,
    caseIndex,
    primes,
    verifies,
    results: scored,
    structural: {
      pass: structuralPass,
      total: scored.length,
      rate: scored.length ? structuralPass / scored.length : null,
      failures: structuralFailures,
    },
    objective: {
      pass: objectivePass,
      total: objectiveTotal,
      rate: objectiveTotal ? objectivePass / objectiveTotal : null,
      failures: objectiveFailures,
    },
    byCategory: [...byCategory.entries()]
      .map(([category, value]) => ({ category, ...value, rate: value.total ? value.pass / value.total : null }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    latency: {
      warm: warmRows.length ? latencyFor(warmRows) : null,
      cold: coldRows.length ? latencyFor(coldRows) : null,
    },
    warmInvalid,
    throughput: rates.length
      ? { n: rates.length, p50: percentile(rates, 0.5), p90: percentile(rates, 0.9) }
      : null,
    throughputSkipped,
    cache: {
      sources: cacheSources,
      verified: scored.some((row) => row.cacheSourceVerified === false)
        ? 'includes a field this project has NOT verified against a live server -- treat the methodology as unconfirmed'
        : 'documented by the server vendor',
      hitRatio: hitRatios.length ? { n: hitRatios.length, p50: percentile(hitRatios, 0.5) } : null,
      warmValidRows: warmRows.length,
    },
    diagnostics: {
      truncated: scored.filter((row) => row.truncated).length,
      unterminatedReasoning: scored.filter((row) => row.reasoningUnterminated).length,
      transportErrors: scored.filter((row) => row.transportError).length,
      droppedStreamOptions: scored.some((row) => row.droppedStreamOptions),
    },
  };
}

// The metric a comparison should read for a given phase. Returns null -- never
// a substituted value -- when the phase was not measured, so the caller can
// refuse rather than silently compare warm against cold.
export function latencyValue(analysis, phase, metric, p) {
  const block = analysis.latency[phase];
  if (!block) return null;
  const summary = block[metric];
  return summary && summary.n ? summary[p] : null;
}
