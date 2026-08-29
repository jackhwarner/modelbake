import { resolve } from 'node:path';
import { readJsonl } from '../jsonl.mjs';
import { analyzeFile, LATENCY_METRICS } from '../analyze.mjs';
import { loadBar, evaluateBar } from '../bar.mjs';
import { UsageError, boolFlag, floatFlag, intFlag } from '../args.mjs';
import { pct } from '../stats.mjs';

const METRIC_LABEL = {
  firstEventMs: 'firstEvent',
  firstReasoningMs: 'firstReasoning',
  firstVisibleMs: 'firstVisible',
  firstToolMs: 'firstTool',
  totalMs: 'total',
};

const rule = (char = '-') => char.repeat(72);
const fmtMs = (v) => (v === null || v === undefined ? '-' : `${v}ms`);

function printLatencyBlock(title, block, indent = '  ') {
  console.log(`${indent}${title}`);
  console.log(`${indent}  metric            p50        p90        min        max      n`);
  for (const metric of LATENCY_METRICS) {
    const s = block[metric];
    if (!s || !s.n) {
      console.log(`${indent}  ${METRIC_LABEL[metric].padEnd(16)}${'-'.padEnd(11)}${'-'.padEnd(11)}${'-'.padEnd(11)}${'-'.padEnd(9)}0`);
      continue;
    }
    console.log(
      `${indent}  ${METRIC_LABEL[metric].padEnd(16)}${fmtMs(s.p50).padEnd(11)}${fmtMs(s.p90).padEnd(11)}${fmtMs(s.min).padEnd(11)}${fmtMs(s.max).padEnd(9)}${s.n}`,
    );
  }
}

function printAnalysis(analysis, { maxFailures }) {
  const meta = analysis.meta;
  console.log(rule('='));
  console.log(`${analysis.label}`);
  console.log(rule('='));
  console.log(`  file        ${analysis.path}`);
  console.log(`  model       ${meta.model}`);
  console.log(`  endpoint    ${meta.baseUrl}`);
  console.log(`  contract    ${meta.contractSha?.slice(0, 12)}   cases ${meta.casesSha?.slice(0, 12)}`);
  console.log(`  sampling    ${JSON.stringify(meta.sampling)}`);
  console.log(`  rows        ${analysis.rowCount}  (${meta.caseCount} cases x ${meta.reps} reps)`);
  console.log(`  mode        ${analysis.mode}${analysis.mode === 'warm' ? '  (prime verified)' : `  -- ${analysis.coldReason || 'unknown reason'}`}`);
  if (!analysis.completed) {
    console.log(`  INCOMPLETE  ${analysis.endReason || 'the run did not finish cleanly; treat every number below as partial'}`);
  }

  console.log('');
  console.log(`  STRUCTURAL   ${analysis.structural.pass}/${analysis.structural.total}  ${pct(analysis.structural.rate)}`);
  if (analysis.structural.failures.length) {
    const shown = analysis.structural.failures.slice(0, maxFailures);
    for (const failure of shown) console.log(`     x ${failure}`);
    if (analysis.structural.failures.length > shown.length) {
      console.log(`     ... and ${analysis.structural.failures.length - shown.length} more (raise --max-failures to see them)`);
    }
  }

  console.log(`  OBJECTIVE    ${analysis.objective.pass}/${analysis.objective.total} checks  ${pct(analysis.objective.rate)}`);
  if (analysis.objective.failures.length) {
    const shown = analysis.objective.failures.slice(0, maxFailures);
    for (const failure of shown) console.log(`     x ${failure}`);
    if (analysis.objective.failures.length > shown.length) {
      console.log(`     ... and ${analysis.objective.failures.length - shown.length} more (raise --max-failures to see them)`);
    }
  }
  if (analysis.byCategory.length > 1) {
    console.log('  by category');
    for (const row of analysis.byCategory) {
      console.log(`     ${row.category.padEnd(20)}${String(`${row.pass}/${row.total}`).padEnd(10)}${pct(row.rate)}`);
    }
  }

  console.log('');
  if (analysis.latency.warm) {
    printLatencyBlock(`LATENCY  warm  (${analysis.latency.warm.rowCount} rows with verified cache coverage)`, analysis.latency.warm);
    if (analysis.warmInvalid) {
      console.log(`  ${analysis.warmInvalid} warm-phase rows were EXCLUDED: their own usage did not show the primed prefix cached.`);
    }
  } else {
    console.log('  LATENCY  warm   NOT MEASURED');
    console.log(`    ${analysis.coldReason || 'this run never verified a warm prefix'}`);
    console.log('    A warm number without a verified cache hit is a cold number wearing a warm label.');
  }
  if (analysis.latency.cold) {
    console.log('');
    printLatencyBlock(`LATENCY  cold  (${analysis.latency.cold.rowCount} rows, no verified cache)`, analysis.latency.cold);
  }
  if (analysis.coldDiagnostic) {
    const c = analysis.coldDiagnostic;
    console.log('');
    console.log(`  COLD DIAGNOSTIC (n=1)  firstVisible ${fmtMs(c.firstVisibleMs)}  total ${fmtMs(c.totalMs)}`);
    console.log('    Only truly cold if the server had not served this prefix before the run.');
  }

  console.log('');
  if (analysis.throughput) {
    console.log(`  THROUGHPUT   ${analysis.throughput.p50.toFixed(1)} tok/s p50   ${analysis.throughput.p90.toFixed(1)} tok/s p90   (n=${analysis.throughput.n})`);
    console.log('               completion tokens / (total - first output event)');
  } else {
    const why = analysis.throughputSkipped?.noTokenCount
      ? 'the endpoint returned no completion-token count'
      : 'no row had a decode window longer than a millisecond to divide by';
    console.log(`  THROUGHPUT   NOT MEASURED -- ${why}`);
  }

  if (analysis.cache.sources.length) {
    console.log(`  CACHE        read from ${analysis.cache.sources.join(', ')}`);
    console.log(`               field provenance: ${analysis.cache.verified}`);
    if (analysis.cache.hitRatio) console.log(`               hit ratio p50 ${pct(analysis.cache.hitRatio.p50)}   warm-valid rows ${analysis.cache.warmValidRows}/${analysis.rowCount}`);
  } else {
    console.log('  CACHE        the endpoint reported no cached-token field at all');
  }

  const d = analysis.diagnostics;
  console.log(`  DIAGNOSTICS  truncated(finish_reason=length) ${d.truncated}   unterminated reasoning ${d.unterminatedReasoning}   transport errors ${d.transportErrors}`);
  if (d.droppedStreamOptions) {
    console.log('               note: the endpoint rejected stream_options; usage was requested without include_usage.');
  }
  console.log('');
}

function direction(metric) {
  return metric.endsWith('%') || metric === 'tok/s p50' ? 'higher' : 'lower';
}

function deltaCell(champ, chal, metric, epsRate, epsRel) {
  if (champ === null || chal === null) return { text: '-', flag: 'NOT COMPARABLE' };
  const higherIsBetter = direction(metric) === 'higher';
  const diff = chal - champ;
  const within = higherIsBetter
    ? Math.abs(diff) <= epsRate
    : Math.abs(diff) <= Math.abs(champ) * epsRel;
  const text = higherIsBetter
    ? `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`
    : `${diff >= 0 ? '+' : ''}${Math.round(diff)}ms`;
  if (within) return { text, flag: '~same' };
  const better = higherIsBetter ? diff > 0 : diff < 0;
  return { text, flag: better ? 'better' : 'REGRESSION' };
}

function printComparison(analyses, { epsRate, epsRel }) {
  const [champion, ...challengers] = analyses;
  console.log(rule('='));
  console.log(`CHAMPION vs CHALLENGER   champion = ${champion.label}`);
  console.log(rule('='));

  const blockers = [];
  for (const challenger of challengers) {
    if (challenger.meta.contractSha !== champion.meta.contractSha) {
      blockers.push(`${challenger.label}: contract sha ${challenger.meta.contractSha?.slice(0, 12)} != champion ${champion.meta.contractSha?.slice(0, 12)}`);
    }
    if (challenger.meta.casesSha !== champion.meta.casesSha) {
      blockers.push(`${challenger.label}: cases sha ${challenger.meta.casesSha?.slice(0, 12)} != champion ${champion.meta.casesSha?.slice(0, 12)}`);
    }
  }
  if (blockers.length) {
    console.log('  REFUSED: these lanes did not answer the same question.');
    for (const blocker of blockers) console.log(`    x ${blocker}`);
    console.log('  Re-run every lane against one frozen contract and one cases file, then compare.');
    console.log('');
    return;
  }

  const modes = new Set(analyses.map((a) => a.mode));
  const latencyComparable = modes.size === 1 && modes.has('warm');
  const phase = latencyComparable ? 'warm' : null;
  if (!latencyComparable) {
    console.log('  Latency rows are omitted: not every lane proved a warm prefix.');
    for (const a of analyses) console.log(`    ${a.label}: ${a.mode}${a.mode === 'warm' ? '' : ` -- ${a.coldReason}`}`);
    console.log('  Correctness below is still comparable; serving latency is not.');
  }

  const metrics = [
    { key: 'structural %', get: (a) => a.structural.rate, fmt: (v) => (v === null ? '-' : pct(v)) },
    { key: 'objective %', get: (a) => a.objective.rate, fmt: (v) => (v === null ? '-' : pct(v)) },
  ];
  if (latencyComparable) {
    for (const metric of LATENCY_METRICS) {
      for (const p of ['p50', 'p90']) {
        metrics.push({
          key: `${METRIC_LABEL[metric]} ${p}`,
          get: (a) => (a.latency[phase]?.[metric]?.n ? a.latency[phase][metric][p] : null),
          fmt: fmtMs,
        });
      }
    }
  }
  metrics.push({ key: 'tok/s p50', get: (a) => (a.throughput ? a.throughput.p50 : null), fmt: (v) => (v === null ? '-' : v.toFixed(1)) });

  const VALUE_W = 12;
  const DELTA_W = 11;
  const FLAG_W = 13;
  const metricW = Math.max(20, ...metrics.map((m) => m.key.length + 2));
  const header = `  ${'metric'.padEnd(metricW)}${champion.label.padEnd(VALUE_W)}`
    + challengers.map((c) => c.label.padEnd(VALUE_W + DELTA_W + FLAG_W)).join('');
  console.log('');
  console.log(header);
  console.log(`  ${'-'.repeat(header.length - 2)}`);
  for (const metric of metrics) {
    const champValue = metric.get(champion);
    const isRate = metric.key.endsWith('%');
    let line = `  ${metric.key.padEnd(metricW)}${metric.fmt(champValue).padEnd(VALUE_W)}`;
    for (const challenger of challengers) {
      const value = metric.get(challenger);
      let cell;
      if (champValue === null || value === null) {
        cell = { text: '', flag: 'not measured' };
      } else if (metric.key === 'tok/s p50') {
        // Higher-is-better on a ratio scale, so it uses the relative epsilon
        // rather than the percentage-point one.
        const diff = value - champValue;
        const within = Math.abs(diff) <= Math.abs(champValue) * epsRel;
        cell = { text: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`, flag: within ? '~same' : (diff > 0 ? 'better' : 'REGRESSION') };
      } else {
        cell = deltaCell(champValue, value, metric.key, epsRate, epsRel);
        if (cell.text === '-') cell.text = '';
      }
      line += `${metric.fmt(value).padEnd(VALUE_W)}${cell.text.padEnd(DELTA_W)}${cell.flag.padEnd(FLAG_W)}`;
    }
    console.log(line.trimEnd());
  }
  console.log('');
  console.log(`  "~same" means inside the noise window (rates ${(epsRate * 100).toFixed(1)}pp, times/rates ${(epsRel * 100).toFixed(0)}% relative).`);
  console.log('  Nothing here grades whether an answer was GOOD. Use `modelbake blind` for that.');
  console.log('');
}

function printBar(barFile, analyses) {
  console.log(rule('='));
  console.log(`BAR  ${barFile.path}`);
  console.log(`     sha ${barFile.sha}`);
  console.log(rule('='));
  for (const analysis of analyses) {
    const outcome = evaluateBar(barFile.bar, analysis);
    const width = Math.max(38, ...outcome.criteria.map((c) => c.name.length + 2));
    console.log(`  ${analysis.label}`);
    for (const criterion of outcome.criteria) {
      console.log(`    ${criterion.status.padEnd(15)}${criterion.name.padEnd(width)}${criterion.actual ?? ''}`);
      if (criterion.note) console.log(`                   ^ ${criterion.note}`);
    }
    console.log(`    VERDICT: ${outcome.verdict}  (${outcome.failed} failed, ${outcome.unevaluated} not evaluated)`);
    console.log('');
  }
}

export function reportCommand(flags, positional) {
  const files = positional;
  if (!files.length) throw new UsageError('report: pass one or more JSONL result files');
  const maxFailures = intFlag(flags, 'max-failures', 12, { min: 0 });
  const epsRate = floatFlag(flags, 'noise-rate', 0.005, { min: 0, max: 1 });
  const epsRel = floatFlag(flags, 'noise-relative', 0.03, { min: 0, max: 1 });

  const analyses = files.map((file) => {
    const path = resolve(file);
    return analyzeFile(readJsonl(path), path);
  });

  const labels = new Map();
  for (const analysis of analyses) {
    if (labels.has(analysis.label)) {
      throw new UsageError(`two files share the label "${analysis.label}" (${labels.get(analysis.label)} and ${analysis.path}). A label names a lane; re-run one of them with a different --label.`);
    }
    labels.set(analysis.label, analysis.path);
  }

  const barFile = flags.bar ? loadBar(resolve(String(flags.bar))) : null;

  if (boolFlag(flags, 'json', false)) {
    const payload = {
      tool: 'modelbake',
      lanes: analyses.map((a) => ({
        label: a.label,
        path: a.path,
        model: a.meta.model,
        contractSha: a.meta.contractSha,
        casesSha: a.meta.casesSha,
        mode: a.mode,
        coldReason: a.coldReason,
        completed: a.completed,
        structural: a.structural,
        objective: a.objective,
        byCategory: a.byCategory,
        latency: a.latency,
        throughput: a.throughput,
        cache: a.cache,
        diagnostics: a.diagnostics,
        bar: barFile ? evaluateBar(barFile.bar, a) : null,
      })),
      bar: barFile ? { path: barFile.path, sha: barFile.sha } : null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return analyses.some((a) => barFile && evaluateBar(barFile.bar, a).verdict === 'FAIL') ? 1 : 0;
  }

  for (const analysis of analyses) printAnalysis(analysis, { maxFailures });
  if (analyses.length > 1) printComparison(analyses, { epsRate, epsRel });
  if (barFile) printBar(barFile, analyses);

  if (barFile) {
    const verdicts = analyses.map((a) => evaluateBar(barFile.bar, a).verdict);
    if (verdicts.includes('FAIL')) return 1;
  }
  return 0;
}
