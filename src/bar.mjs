import { readFileSync } from 'node:fs';
import { isPlainObject, sha256 } from './util.mjs';
import { LATENCY_METRICS, latencyValue } from './analyze.mjs';

// A bar is a pre-commitment: you write down what "good enough" means BEFORE you
// see the numbers, and the report stamps the file's SHA so you cannot quietly
// move it afterwards. That is the whole feature.

class BarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BarError';
    this.isUsageError = true;
  }
}

export function validateBar(raw) {
  if (!isPlainObject(raw)) throw new BarError('bar must be a JSON object');
  if (raw.version !== 1) throw new BarError(`bar.version must be 1, got ${JSON.stringify(raw.version)}`);
  const allowed = new Set(['version', 'structuralPassRate', 'objectivePassRate', 'phase', 'latency', 'minSemanticDelta', 'requiredCases', 'note']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new BarError(`bar: unknown key "${key}". Known: ${[...allowed].join(', ')}`);
  }
  for (const key of ['structuralPassRate', 'objectivePassRate', 'minSemanticDelta']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || raw[key] < 0 || raw[key] > 1)) {
      throw new BarError(`bar.${key} must be a number between 0 and 1 (a rate, not a percent)`);
    }
  }
  const phase = raw.phase === undefined ? 'warm' : raw.phase;
  if (!['warm', 'cold'].includes(phase)) throw new BarError('bar.phase must be "warm" or "cold"');
  if (raw.latency !== undefined) {
    if (!isPlainObject(raw.latency)) throw new BarError('bar.latency must be an object');
    for (const [metric, ceilings] of Object.entries(raw.latency)) {
      if (!LATENCY_METRICS.includes(metric)) {
        throw new BarError(`bar.latency.${metric} is not a metric. Known: ${LATENCY_METRICS.join(', ')}`);
      }
      if (!isPlainObject(ceilings)) throw new BarError(`bar.latency.${metric} must be an object of { p50, p90 } ceilings in ms`);
      for (const [p, value] of Object.entries(ceilings)) {
        if (!['p50', 'p90'].includes(p)) throw new BarError(`bar.latency.${metric}.${p} must be p50 or p90`);
        if (typeof value !== 'number' || value <= 0) throw new BarError(`bar.latency.${metric}.${p} must be a positive number of milliseconds`);
      }
    }
  }
  if (raw.requiredCases !== undefined && (!Array.isArray(raw.requiredCases) || raw.requiredCases.some((c) => typeof c !== 'string'))) {
    throw new BarError('bar.requiredCases must be an array of case ids');
  }
  return { ...raw, phase };
}

export function loadBar(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (caught) {
    throw new BarError(`cannot read bar ${path}: ${caught.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (caught) {
    throw new BarError(`bar ${path} is not valid JSON: ${caught.message}`);
  }
  return { bar: validateBar(raw), sha: sha256(text), path };
}

// Every criterion resolves to PASS, FAIL, or NOT EVALUATED. There is no fourth
// outcome and no default-to-pass: a criterion this version cannot judge makes
// the verdict INCOMPLETE, which is a different thing from PASS.
export function evaluateBar(bar, analysis) {
  const criteria = [];

  if (bar.structuralPassRate !== undefined) {
    const actual = analysis.structural.rate;
    criteria.push({
      name: `structural >= ${(bar.structuralPassRate * 100).toFixed(1)}%`,
      actual: actual === null ? null : `${(actual * 100).toFixed(1)}%`,
      status: actual === null ? 'NOT EVALUATED' : (actual >= bar.structuralPassRate ? 'PASS' : 'FAIL'),
      note: actual === null ? 'no scored rows' : null,
    });
  }
  if (bar.objectivePassRate !== undefined) {
    const actual = analysis.objective.rate;
    criteria.push({
      name: `objective >= ${(bar.objectivePassRate * 100).toFixed(1)}%`,
      actual: actual === null ? null : `${(actual * 100).toFixed(1)}%`,
      status: actual === null ? 'NOT EVALUATED' : (actual >= bar.objectivePassRate ? 'PASS' : 'FAIL'),
      note: actual === null ? 'no assertions in the selected cases' : null,
    });
  }
  for (const [metric, ceilings] of Object.entries(bar.latency || {})) {
    for (const [p, ceiling] of Object.entries(ceilings)) {
      const actual = latencyValue(analysis, bar.phase, metric, p);
      criteria.push({
        name: `${bar.phase} ${metric} ${p} <= ${ceiling}ms`,
        actual: actual === null ? null : `${actual}ms`,
        status: actual === null ? 'NOT EVALUATED' : (actual <= ceiling ? 'PASS' : 'FAIL'),
        note: actual === null
          ? (bar.phase === 'warm' && analysis.mode !== 'warm'
            ? `run is ${analysis.mode}: ${analysis.coldReason || 'warm was never verified'}`
            : `no ${bar.phase} rows recorded this metric`)
          : null,
      });
    }
  }
  if (bar.requiredCases?.length) {
    for (const caseId of bar.requiredCases) {
      const rows = analysis.results.filter((row) => row.caseId === caseId);
      if (!rows.length) {
        criteria.push({ name: `required case ${caseId} passes every rep`, actual: null, status: 'NOT EVALUATED', note: 'case not present in this run' });
        continue;
      }
      const bad = rows.filter((row) => !row.structural?.pass || (row.checks || []).some((c) => !c.pass));
      criteria.push({
        name: `required case ${caseId} passes every rep`,
        actual: `${rows.length - bad.length}/${rows.length} reps`,
        status: bad.length ? 'FAIL' : 'PASS',
        note: null,
      });
    }
  }
  if (bar.minSemanticDelta !== undefined) {
    criteria.push({
      name: `semantic delta >= ${(bar.minSemanticDelta * 100).toFixed(1)}%`,
      actual: null,
      status: 'NOT EVALUATED',
      note: 'modelbake v1 ships no judge. Produce packets with `modelbake blind`, grade them with your rubric, and settle this criterion by hand.',
    });
  }

  const failed = criteria.filter((c) => c.status === 'FAIL').length;
  const unevaluated = criteria.filter((c) => c.status === 'NOT EVALUATED').length;
  const verdict = failed ? 'FAIL' : (unevaluated ? 'INCOMPLETE' : 'PASS');
  return { criteria, failed, unevaluated, verdict };
}

export { BarError };
