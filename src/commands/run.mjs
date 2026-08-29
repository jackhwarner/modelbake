import { resolve } from 'node:path';
import { loadContract } from '../contract.mjs';
import { loadCases } from '../cases.mjs';
import { openJsonl } from '../jsonl.mjs';
import { streamCompletion, primeCompletion } from '../client.mjs';
import { CACHE_FIELD_NAMES } from '../cache.mjs';
import { extractEnvelopes } from '../envelopes.mjs';
import { evaluateAssertion, describeAssertion, structuralGate } from '../assertions.mjs';
import { UsageError, boolFlag, floatFlag, intFlag, requireFlags } from '../args.mjs';
import { words } from '../util.mjs';
import { VERSION } from '../version.mjs';

function rotate(list, offset) {
  const n = list.length;
  if (!n) return [];
  const o = ((offset % n) + n) % n;
  return [...list.slice(o), ...list.slice(0, o)];
}

function toRow(testCase, { label, model, rep, phase, warmValid, result, contract }) {
  const envelopes = extractEnvelopes(result.content, contract.envelopes);
  const base = {
    kind: 'result',
    label,
    model,
    phase,
    rep,
    caseId: testCase.id,
    category: testCase.category,
    systemVariant: testCase.systemVariant,
    ...result,
    envelopes,
    contentWords: words(result.content),
    reviewNote: testCase.reviewNote,
    warmValid,
  };
  const gate = structuralGate(base);
  const checks = testCase.assertions.map((assertion) => {
    const outcome = evaluateAssertion(base, assertion);
    return { assertion: describeAssertion(assertion), type: assertion.type, pass: outcome.pass, actual: outcome.actual ?? null };
  });
  return { ...base, structural: gate, checks };
}

export async function runCommand(flags) {
  requireFlags(flags, ['contract', 'cases', 'base-url', 'model', 'label'], 'run');

  const { contract, warnings: contractWarnings } = loadContract(resolve(String(flags.contract)));
  const casesFile = loadCases(resolve(String(flags.cases)), contract);
  for (const warning of [...contractWarnings, ...casesFile.warnings]) console.warn(`warning: ${warning}`);

  const label = String(flags.label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label)) {
    throw new UsageError('--label must be 1-64 chars of [A-Za-z0-9_.-] and start alphanumeric');
  }
  const model = String(flags.model);
  const baseUrl = String(flags['base-url']).replace(/\/+$/, '');
  const apiKey = flags['api-key'] ? String(flags['api-key']) : process.env.MODELBAKE_API_KEY || null;
  const reps = intFlag(flags, 'reps', 3, { min: 1, max: 100 });
  const timeoutMs = intFlag(flags, 'timeout', 300000, { min: 1000 });
  const warmEnabled = !boolFlag(flags, 'no-warm', false);
  const coverage = floatFlag(flags, 'warm-coverage', 0.9, { min: 0, max: 1 });
  const reprimeEvery = intFlag(flags, 'reprime-every', 8, { min: 1 });
  const outFile = resolve(String(flags.out || `results/${label}.jsonl`));

  const only = flags.only ? new Set(String(flags.only).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const cases = only ? casesFile.cases.filter((c) => only.has(c.id)) : casesFile.cases;
  if (only) {
    const missing = [...only].filter((id) => !casesFile.cases.some((c) => c.id === id));
    if (missing.length) throw new UsageError(`--only names cases that do not exist: ${missing.join(', ')}`);
  }
  if (!cases.length) throw new UsageError('no cases selected');

  const variants = [...new Set(cases.map((c) => c.systemVariant))];
  const systemFor = (variant) => contract.systemVariants[variant];

  if (boolFlag(flags, 'dry-run', false)) {
    console.log(`dry-run: contract ${contract.path}`);
    console.log(`  model-facing sha: ${contract.modelFacingSha}`);
    console.log(`  system variants:  ${Object.keys(contract.systemVariants).join(', ')}`);
    console.log(`  tools:            ${contract.tools.length}`);
    console.log(`  envelopes:        ${Object.keys(contract.envelopes).join(', ') || 'none'}`);
    console.log(`  sampling:         ${JSON.stringify(contract.sampling)}`);
    console.log(`cases ${casesFile.path}: ${cases.length} selected x ${reps} reps = ${cases.length * reps} rows`);
    console.log(`  assertions:       ${cases.reduce((n, c) => n + c.assertions.length, 0)}`);
    console.log(`  variants used:    ${variants.join(', ')}`);
    console.log(`would write:        ${outFile}`);
    console.log('no requests were sent.');
    return 0;
  }

  const out = openJsonl(outFile);
  const startedAt = new Date().toISOString();
  const meta = {
    kind: 'meta',
    tool: 'modelbake',
    toolVersion: VERSION,
    node: process.version,
    startedAt,
    label,
    model,
    baseUrl,
    contractPath: contract.path,
    contractSha: contract.modelFacingSha,
    contractFileSha: contract.fileSha,
    contractName: contract.name,
    casesPath: casesFile.path,
    casesSha: casesFile.fileSha,
    caseCount: cases.length,
    caseIds: cases.map((c) => c.id),
    reps,
    sampling: contract.sampling,
    toolChoice: contract.toolChoice,
    toolCount: contract.tools.length,
    systemVariants: variants,
    warmRequested: warmEnabled,
    warmCoverage: coverage,
    reprimeEvery,
  };
  out.write(meta);
  // One row per case, carrying the input. `blind` needs the prompt to build a
  // grading packet, and putting it here rather than on every result row keeps
  // a 60-row file from repeating the same conversation 60 times.
  for (const testCase of cases) {
    out.write({
      kind: 'case',
      caseId: testCase.id,
      category: testCase.category,
      systemVariant: testCase.systemVariant,
      messages: testCase.messages,
      assertions: testCase.assertions,
      reviewNote: testCase.reviewNote,
    });
  }
  console.log(`modelbake run  label=${label}  model=${model}`);
  console.log(`  contract ${contract.modelFacingSha.slice(0, 12)}  cases ${cases.length}  reps ${reps}  ->  ${outFile}`);

  const call = (testCase, seed, purpose) => streamCompletion({
    baseUrl,
    apiKey,
    model,
    contract,
    systemPrompt: systemFor(testCase.systemVariant),
    messages: testCase.messages,
    seed,
    timeoutMs,
    purpose,
  });

  // 1. One labeled cold diagnostic. Only truly cold if the server was just
  //    started; the row says so rather than pretending otherwise.
  const coldCase = cases[0];
  const cold = await call(coldCase, 0, 'cold-diagnostic');
  out.write({
    ...toRow(coldCase, { label, model, rep: 0, phase: 'cold-diagnostic', warmValid: false, result: cold, contract }),
    caveat: 'cold only if the server had not served this prefix before this run',
  });
  console.log(`  cold-diagnostic  visible=${cold.firstVisibleMs ?? '-'}ms total=${cold.totalMs}ms cached=${cold.cachedTokens ?? '-'}/${cold.promptTokens ?? '-'}`);

  if (cold.transportError) {
    out.write({ kind: 'end', completed: false, reason: `endpoint unreachable: ${cold.transportError}`, finishedAt: new Date().toISOString() });
    console.error(`\nABORTED: the first request failed: ${cold.transportError}`);
    console.error(`Check that ${baseUrl} is serving an OpenAI-compatible /chat/completions and that --model is a model it has loaded.`);
    return 2;
  }

  // 2. Prime + verify, or say why not.
  let mode = 'cold_only';
  let coldReason = null;
  const primeSizes = {};
  if (!warmEnabled) {
    coldReason = 'warm mode disabled with --no-warm';
  } else {
    for (const variant of variants) {
      const primed = await primeCompletion({ baseUrl, apiKey, model, contract, systemPrompt: systemFor(variant), timeoutMs, purpose: `prime-${variant}` });
      out.write({ kind: 'prime', label, model, variant, ...primed });
      primeSizes[variant] = primed.promptTokens;
      console.log(`  prime-${variant}  prompt=${primed.promptTokens ?? '-'} cached=${primed.cachedTokens ?? '-'} ${primed.totalMs}ms${primed.transportError ? ` ERROR ${primed.transportError}` : ''}`);
    }

    const failures = [];
    for (const variant of variants) {
      const probeCase = cases.find((c) => c.systemVariant === variant);
      const probe = await call(probeCase, 99, `verify-${variant}`);
      const need = (primeSizes[variant] || 0) * coverage;
      const ok = Number.isFinite(probe.cachedTokens) && Number.isFinite(primeSizes[variant]) && probe.cachedTokens >= need;
      out.write({
        kind: 'verify',
        label,
        model,
        variant,
        caseId: probeCase.id,
        cachedTokens: probe.cachedTokens,
        promptTokens: probe.promptTokens,
        cacheSource: probe.cacheSource,
        cacheSourceVerified: probe.cacheSourceVerified,
        primePromptTokens: primeSizes[variant] ?? null,
        required: Math.round(need),
        ok,
        transportError: probe.transportError,
      });
      console.log(`  verify-${variant}  cached=${probe.cachedTokens ?? 'none'} need>=${Math.round(need)}  ${ok ? 'OK' : 'FAIL'}${probe.cacheSource ? ` via ${probe.cacheSource}` : ''}`);
      if (!ok) {
        failures.push(probe.cachedTokens === null
          ? `${variant}: endpoint reported no cached-token field (looked for ${CACHE_FIELD_NAMES.join(', ')})`
          : `${variant}: cached ${probe.cachedTokens} of a ${primeSizes[variant] ?? '?'}-token primed prefix, below the ${Math.round(coverage * 100)}% bar`);
      }
    }
    if (failures.length) {
      coldReason = `prime not verified -- ${failures.join('; ')}`;
    } else {
      mode = 'warm';
    }
  }
  out.write({ kind: 'mode', mode, reason: coldReason, coverage, primeSizes });
  if (mode === 'warm') {
    console.log('  mode: WARM (prime verified)');
  } else {
    console.log(`  mode: COLD_ONLY -- ${coldReason}`);
    console.log('  the report will refuse to print warm latency for this file.');
  }

  // 3. The rows themselves. Rotated order per rep so a case never sits in the
  //    same position twice; per-row warmValid from that row's own usage.
  const step = Math.max(1, Math.ceil(cases.length / reps));
  let sincePrime = 0;
  let completed = true;
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const testCase of rotate(cases, (rep - 1) * step)) {
      if (mode === 'warm' && sincePrime >= reprimeEvery) {
        for (const variant of variants) {
          const primed = await primeCompletion({ baseUrl, apiKey, model, contract, systemPrompt: systemFor(variant), timeoutMs, purpose: `reprime-${variant}` });
          out.write({ kind: 'prime', label, model, variant, reprime: true, ...primed });
        }
        sincePrime = 0;
      }
      const result = await call(testCase, rep, mode === 'warm' ? 'warm' : 'cold');
      const need = (primeSizes[testCase.systemVariant] || 0) * coverage;
      const warmValid = mode === 'warm' && Number.isFinite(result.cachedTokens) && result.cachedTokens >= need;
      const row = toRow(testCase, { label, model, rep, phase: mode === 'warm' ? 'warm' : 'cold', warmValid, result, contract });
      out.write(row);
      sincePrime += 1;
      if (result.transportError) completed = false;

      const failed = row.checks.filter((c) => !c.pass).length;
      const status = !row.structural.pass ? 'STRUCT' : failed ? `${failed} FAIL` : 'ok';
      console.log(
        `  ${testCase.id}.${rep}  ${status.padEnd(7)} visible=${result.firstVisibleMs ?? '-'}ms tool=${result.firstToolMs ?? '-'}ms total=${result.totalMs}ms`
        + ` cached=${result.cachedTokens ?? '-'}/${result.promptTokens ?? '-'} warm=${warmValid}`
        + ` tools=${result.toolCalls.map((c) => c.name).join(',') || 'none'}`,
      );
    }
  }

  out.write({ kind: 'end', completed, mode, coldReason, finishedAt: new Date().toISOString() });
  console.log(`\nwrote ${outFile}`);
  console.log(`next: npx modelbake report ${outFile}`);
  return 0;
}
