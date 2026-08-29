import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer } from './helpers/mock-server.mjs';
import { TODO_APP_SCRIPT, TODO_APP_SCRIPT_WEAKER } from './helpers/example-script.mjs';

const run = promisify(execFile);
const CLI = 'bin/modelbake.mjs';

// The whole loop a stranger runs, end to end, with no model: init, two lanes
// against a mock endpoint, a champion-vs-challenger report, a bar verdict, and
// blind packets.
async function cli(args, { expectCode = 0 } = {}) {
  let code = 0;
  let output = '';
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: process.cwd() });
    output = stdout + stderr;
  } catch (error) {
    code = error.code;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.equal(code, expectCode, `expected exit ${expectCode}, got ${code}:\n${output}`);
  return output;
}

test('init scaffolds three files that validate but still say TODO', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-init-'));
  const out = await cli(['init', dir]);
  assert.match(out, /Read AGENTS\.md and follow it/);
  for (const name of ['contract.json', 'cases.json', 'AGENTS.md']) {
    assert.ok(existsSync(join(dir, name)), `${name} was written`);
  }
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Copy the final string, not the template/);
  assert.match(agents, /12-20 cases/);

  // The scaffold is valid enough to run through the validator, and loud enough
  // that nobody mistakes it for a finished extraction.
  const dry = await cli([
    'run', '--contract', join(dir, 'contract.json'), '--cases', join(dir, 'cases.json'),
    '--base-url', 'http://127.0.0.1:1/v1', '--model', 'x', '--label', 'scaffold', '--dry-run',
  ], { expectCode: 2 });
  assert.match(dry, /TODO_replace_with_a_real_tool_name|is not a tool in the contract/);
});

test('init does not clobber existing work without --force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-init2-'));
  await cli(['init', dir]);
  const out = await cli(['init', dir]);
  assert.match(out, /kept +contract\.json/);
});

test('the full loop: two lanes, a report, a bar and blind packets', async (t) => {
  const strong = await startMockServer({ script: TODO_APP_SCRIPT, deltaMs: 1 });
  const weak = await startMockServer({ script: TODO_APP_SCRIPT_WEAKER, deltaMs: 2 });
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-e2e-'));
  t.after(async () => { await strong.close(); await weak.close(); });

  const championOut = join(dir, 'champion.jsonl');
  const challengerOut = join(dir, 'challenger.jsonl');

  const runLog = await cli([
    'run', '--contract', 'examples/todo-app/contract.json', '--cases', 'examples/todo-app/cases.json',
    '--base-url', strong.url, '--model', 'mock-strong', '--label', 'champion', '--reps', '2', '--out', championOut,
  ]);
  assert.match(runLog, /mode: WARM \(prime verified\)/);
  assert.match(runLog, /verify-voice +cached=/);

  await cli([
    'run', '--contract', 'examples/todo-app/contract.json', '--cases', 'examples/todo-app/cases.json',
    '--base-url', weak.url, '--model', 'mock-weak', '--label', 'challenger', '--reps', '2', '--out', challengerOut,
  ]);

  // The bar fails the challenger, so report exits 1.
  const report = await cli(['report', championOut, challengerOut, '--bar', 'examples/todo-app/bar.json'], { expectCode: 1 });
  assert.match(report, /CHAMPION vs CHALLENGER/);
  assert.match(report, /structural %/);
  assert.match(report, /REGRESSION/);
  assert.match(report, /VERDICT: INCOMPLETE/, 'champion passes every measurable criterion but the semantic one is unjudged');
  assert.match(report, /VERDICT: FAIL/, 'challenger breaks the structural floor');
  assert.match(report, /reasoning leaked into visible content/);
  assert.match(report, /complete-needs-lookup/, 'the guessed-id failure is named');

  const blindDir = join(dir, 'blind');
  const blindLog = await cli(['blind', blindDir, championOut, challengerOut, '--rubric', 'test/fixtures/rubric.md']);
  assert.match(blindLog, /M1, M2/);
  const packets = readdirSync(join(blindDir, 'packets'));
  assert.equal(packets.length, 10);
  const allText = packets.map((f) => readFileSync(join(blindDir, 'packets', f), 'utf8')).join('\n');
  assert.doesNotMatch(allText, /champion|challenger|mock-strong|mock-weak/);
  assert.match(readFileSync(join(blindDir, 'README.md'), 'utf8'), /Dimension one: judgement/);
});

test('a report on a single lane still works and exits zero without a bar', async (t) => {
  const server = await startMockServer({ script: TODO_APP_SCRIPT });
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-single-'));
  const out = join(dir, 'solo.jsonl');
  t.after(async () => { await server.close(); });
  await cli([
    'run', '--contract', 'examples/support-bot/contract.json', '--cases', 'examples/support-bot/cases.json',
    '--base-url', server.url, '--model', 'mock', '--label', 'solo', '--reps', '1', '--out', out,
  ]);
  const report = await cli(['report', out]);
  assert.match(report, /solo/);
  assert.match(report, /STRUCTURAL/);
  assert.doesNotMatch(report, /CHAMPION vs CHALLENGER/);
});

test('unknown commands and missing flags fail with usage errors, not stack traces', async () => {
  assert.match(await cli(['frobnicate'], { expectCode: 2 }), /unknown command "frobnicate"/);
  assert.match(await cli(['run', '--contract', 'x.json'], { expectCode: 2 }), /missing required --cases=/);
  assert.match(await cli(['report'], { expectCode: 2 }), /pass one or more JSONL/);
});
