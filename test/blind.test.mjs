import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blindCommand } from '../src/commands/blind.mjs';
import { quietly } from './helpers/quiet.mjs';

const FILES = ['test/fixtures/champion.jsonl', 'test/fixtures/challenger.jsonl'];

async function blind(flags = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'modelbake-blind-'));
  await quietly(() => blindCommand(flags, [dir, ...FILES]));
  return {
    dir,
    key: JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')),
    packets: JSON.parse(readFileSync(join(dir, 'packets.json'), 'utf8')),
    readme: readFileSync(join(dir, 'README.md'), 'utf8'),
    files: readdirSync(join(dir, 'packets')),
  };
}

test('packets carry the input and every masked response', async () => {
  const { packets, files } = await blind();
  assert.equal(files.length, 4);
  const greet = packets.packets.find((p) => p.caseId === 'greet');
  assert.ok(greet.input, 'the case input is rendered from the case rows, not guessed');
  assert.equal(greet.responses.length, 2);
  assert.deepEqual(greet.responses.map((r) => r.mask).sort(), ['M1', 'M2']);
});

test('no packet leaks a label or a model id', async () => {
  const { dir, files, packets } = await blind();
  const text = files.map((f) => readFileSync(join(dir, 'packets', f), 'utf8')).join('\n')
    + JSON.stringify(packets);
  for (const secret of ['champion', 'challenger', 'model-a', 'model-b']) {
    assert.equal(text.includes(secret), false, `packets must not contain "${secret}"`);
  }
});

test('the key maps every mask back, and is kept out of the packets', async () => {
  const { key } = await blind();
  assert.deepEqual(Object.keys(key.key).sort(), ['M1', 'M2']);
  assert.deepEqual(Object.values(key.key).sort(), ['challenger', 'champion']);
  assert.match(key.warning, /until grading is finished/);
});

test('masking is deterministic for the same inputs, and steerable with --seed', async () => {
  const a = await blind();
  const b = await blind();
  assert.deepEqual(a.key.key, b.key.key);
  assert.equal(a.key.seed, b.key.seed);
  const seeded = await blind({ seed: '1' });
  assert.equal(seeded.key.seed, 1);
});

test('one mask means the same lane in every packet', async () => {
  const { packets, key } = await blind();
  const championMask = Object.entries(key.key).find(([, label]) => label === 'champion')[0];
  // champion answered `restraint` without a tool on rep 1; challenger did not.
  const restraint = packets.packets.find((p) => p.caseId === 'restraint');
  const fromChampion = restraint.responses.find((r) => r.mask === championMask);
  assert.ok(fromChampion, 'the champion appears under one stable mask');
  for (const packet of packets.packets) {
    assert.equal(packet.responses.filter((r) => r.mask === championMask).length, 1);
  }
});

test('--rubric embeds the grader\'s own rubric in the packet README', async () => {
  const { readme } = await blind({ rubric: 'test/fixtures/rubric.md' });
  assert.match(readme, /Dimension one: judgement/);
});

test('without a rubric the README says so rather than inventing one', async () => {
  const { readme } = await blind();
  assert.match(readme, /No rubric was supplied/);
});

test('--no-timings removes latency so speed cannot bias a quality read', async () => {
  const { packets, dir, files } = await blind({ 'no-timings': true });
  assert.equal(packets.packets[0].responses[0].timings, null);
  const text = files.map((f) => readFileSync(join(dir, 'packets', f), 'utf8')).join('\n');
  assert.doesNotMatch(text, /firstVisible/);
});

test('the README names the limits of masking rather than overclaiming', async () => {
  const { readme } = await blind();
  assert.match(readme, /Masking removes the label, not every clue/);
});
