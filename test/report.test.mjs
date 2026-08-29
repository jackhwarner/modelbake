import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile } from '../src/analyze.mjs';
import { readJsonl } from '../src/jsonl.mjs';
import { validateBar, evaluateBar } from '../src/bar.mjs';
import { reportCommand } from '../src/commands/report.mjs';
import { quietly } from './helpers/quiet.mjs';

const load = (name) => analyzeFile(readJsonl(`test/fixtures/${name}.jsonl`), `test/fixtures/${name}.jsonl`);

test('a warm lane summarises structural, objective and split-timing percentiles', () => {
  const a = load('champion');
  assert.equal(a.mode, 'warm');
  assert.equal(a.structural.pass, 8);
  assert.equal(a.structural.total, 8);
  assert.equal(a.objective.pass, 14);
  assert.equal(a.objective.total, 15);
  assert.equal(a.latency.warm.firstVisibleMs.p50, 410);
  assert.equal(a.latency.warm.firstVisibleMs.p90, 520);
  assert.equal(a.latency.warm.totalMs.p50, 910);
  assert.equal(a.latency.warm.firstToolMs.n, 2, 'only rows that called a tool contribute a firstTool');
  assert.equal(a.latency.warm.firstReasoningMs.n, 0);
});

test('the cold diagnostic is kept out of the warm percentiles', () => {
  const a = load('champion');
  assert.equal(a.coldDiagnostic.firstVisibleMs, 8000);
  assert.equal(a.latency.warm.firstVisibleMs.max, 520, 'the 8000ms cold row is not in the warm sample');
  assert.equal(a.rowCount, 8);
});

test('failures are named, not just counted', () => {
  const a = load('champion');
  assert.equal(a.objective.failures.length, 1);
  assert.match(a.objective.failures[0], /restraint\.2/);
  assert.match(a.objective.failures[0], /no_tool/);
});

test('a leaked-reasoning row fails the structural gate and is named', () => {
  const a = load('challenger');
  assert.equal(a.structural.pass, 7);
  assert.equal(a.structural.total, 8);
  assert.match(a.structural.failures[0], /greet\.1/);
  assert.match(a.structural.failures[0], /leaked/);
});

test('a cold_only lane exposes no warm latency at all', () => {
  const a = load('cold-only');
  assert.equal(a.mode, 'cold_only');
  assert.equal(a.latency.warm, null);
  assert.ok(a.latency.cold.totalMs.n > 0, 'cold rows are still measured, just labelled');
  assert.match(a.coldReason, /no cached-token field/);
});

test('the printed report refuses a warm section for a cold_only lane', async () => {
  const { output } = await quietly(() => reportCommand({}, ['test/fixtures/cold-only.jsonl']));
  assert.match(output, /LATENCY {2}warm {3}NOT MEASURED/);
  assert.match(output, /no cached-token field/);
  assert.doesNotMatch(output, /LATENCY {2}warm {2}\(/);
});

test('the comparison refuses lanes run against different contracts', async () => {
  const { output } = await quietly(() => reportCommand({}, ['test/fixtures/champion.jsonl', 'test/fixtures/other-contract.jsonl']));
  assert.match(output, /REFUSED: these lanes did not answer the same question/);
  assert.match(output, /contract sha/);
});

test('the comparison omits latency when one lane never proved warm', async () => {
  const { output } = await quietly(() => reportCommand({}, ['test/fixtures/champion.jsonl', 'test/fixtures/cold-only.jsonl']));
  assert.match(output, /Latency rows are omitted/);
  assert.match(output, /structural %/, 'correctness is still compared');
  assert.doesNotMatch(output, /firstVisible p50/);
});

test('two files sharing a label is an error, because a label names a lane', () => {
  assert.throws(
    () => reportCommand({}, ['test/fixtures/champion.jsonl', 'test/fixtures/champion.jsonl']),
    /share the label "champion"/,
  );
});

test('a results file with no meta row is rejected', () => {
  assert.throws(() => analyzeFile([{ kind: 'result' }], 'x.jsonl'), /no meta row/);
});

test('the bar passes, fails and stays incomplete for the right reasons', () => {
  const bar = validateBar({
    version: 1,
    structuralPassRate: 0.95,
    objectivePassRate: 0.9,
    latency: { firstVisibleMs: { p50: 500 }, totalMs: { p90: 2000 } },
  });
  const champion = evaluateBar(bar, load('champion'));
  assert.equal(champion.verdict, 'PASS');

  const challenger = evaluateBar(bar, load('challenger'));
  assert.equal(challenger.verdict, 'FAIL');
  assert.ok(challenger.criteria.some((c) => c.status === 'FAIL' && /structural/.test(c.name)));
  assert.ok(challenger.criteria.some((c) => c.status === 'FAIL' && /firstVisibleMs/.test(c.name)));
});

test('a latency ceiling against a cold_only lane is NOT EVALUATED, never assumed passed', () => {
  const bar = validateBar({ version: 1, latency: { firstVisibleMs: { p50: 500 } } });
  const outcome = evaluateBar(bar, load('cold-only'));
  assert.equal(outcome.criteria[0].status, 'NOT EVALUATED');
  assert.match(outcome.criteria[0].note, /cold_only/);
  assert.equal(outcome.verdict, 'INCOMPLETE');
});

test('minSemanticDelta is always NOT EVALUATED in v1, and says where to settle it', () => {
  const outcome = evaluateBar(validateBar({ version: 1, minSemanticDelta: 0.1 }), load('champion'));
  assert.equal(outcome.criteria[0].status, 'NOT EVALUATED');
  assert.match(outcome.criteria[0].note, /modelbake blind/);
  assert.equal(outcome.verdict, 'INCOMPLETE');
});

test('requiredCases fails when any rep of that case fails', () => {
  const bar = validateBar({ version: 1, requiredCases: ['restraint', 'greet'] });
  const outcome = evaluateBar(bar, load('champion'));
  const restraint = outcome.criteria.find((c) => c.name.includes('restraint'));
  const greet = outcome.criteria.find((c) => c.name.includes('greet'));
  assert.equal(restraint.status, 'FAIL');
  assert.equal(restraint.actual, '1/2 reps');
  assert.equal(greet.status, 'PASS');
});

test('a bar naming a case that is not in the run is NOT EVALUATED', () => {
  const outcome = evaluateBar(validateBar({ version: 1, requiredCases: ['nope'] }), load('champion'));
  assert.equal(outcome.criteria[0].status, 'NOT EVALUATED');
  assert.match(outcome.criteria[0].note, /not present/);
});

test('a percentage-shaped bar rate is rejected before it silently passes everything', () => {
  assert.throws(() => validateBar({ version: 1, structuralPassRate: 95 }), /between 0 and 1/);
});

test('an unknown latency metric in a bar is rejected', () => {
  assert.throws(() => validateBar({ version: 1, latency: { ttftMs: { p50: 1 } } }), /is not a metric/);
});

test('report exits non-zero when a bar fails', async () => {
  const { value: code } = await quietly(() => reportCommand(
    { bar: 'test/fixtures/strict-bar.json' },
    ['test/fixtures/challenger.jsonl'],
  ));
  assert.equal(code, 1);
});

test('report --json emits machine-readable lanes for an agent to read', async () => {
  const { output } = await quietly(() => reportCommand({ json: true }, ['test/fixtures/champion.jsonl']));
  const payload = JSON.parse(output);
  assert.equal(payload.lanes.length, 1);
  assert.equal(payload.lanes[0].label, 'champion');
  assert.equal(payload.lanes[0].mode, 'warm');
  assert.equal(payload.lanes[0].latency.warm.firstVisibleMs.p50, 410);
});
