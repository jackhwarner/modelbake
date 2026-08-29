import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJsonl } from '../jsonl.mjs';
import { analyzeFile } from '../analyze.mjs';
import { UsageError, boolFlag, intFlag } from '../args.mjs';
import { seedFromString, seededShuffle } from '../util.mjs';

// v1 does not grade. It produces the packet a human or an LLM grades FROM.
// That split is deliberate (DESIGN.md "What is deliberately missing"): an
// automated judge is a model whose own failure modes would silently become the
// bakeoff's failure modes, and this tool's whole claim is that it does not
// print numbers it cannot stand behind.

function renderMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') return `**tool result** (\`${message.name || message.tool_call_id}\`):\n\n\`\`\`json\n${message.content}\n\`\`\``;
    if (message.role === 'assistant' && message.tool_calls) {
      const calls = message.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join('\n');
      return `**assistant** (tool call):\n\n\`\`\`\n${calls}\n\`\`\``;
    }
    return `**${message.role}:**\n\n${message.content}`;
  }).join('\n\n');
}

function renderResponse(row, { showTimings }) {
  const lines = [];
  lines.push(row.content?.trim() ? `${row.content.trim()}` : '_(no visible content)_');
  if (row.toolCalls?.length) {
    lines.push('');
    lines.push('Tool calls:');
    lines.push('```');
    for (const call of row.toolCalls) {
      lines.push(`${call.name}(${call.argumentsRaw})${call.argumentError ? `   <-- UNPARSEABLE: ${call.argumentError}` : ''}`);
    }
    lines.push('```');
  }
  const envelopes = Object.entries(row.envelopes || {}).filter(([, env]) => env.matched);
  if (envelopes.length) {
    lines.push('');
    for (const [name, env] of envelopes) {
      lines.push(`Envelope \`${name}\`: ${JSON.stringify(env.fields).slice(0, 2000)}`);
    }
  }
  const facts = [`finish_reason: ${row.finishReason ?? 'none'}`];
  if (row.reasoningPresent) facts.push(`reasoning: ${row.reasoningChars} chars (hidden from the visible answer)`);
  if (row.truncated) facts.push('TRUNCATED at the token limit');
  if (showTimings) {
    const t = (v) => (Number.isFinite(v) ? `${v}ms` : 'none');
    facts.push(`firstVisible ${t(row.firstVisibleMs)}`, `firstTool ${t(row.firstToolMs)}`, `total ${t(row.totalMs)}`);
  }
  lines.push('');
  lines.push(`_${facts.join(' · ')}_`);
  return lines.join('\n');
}

export function blindCommand(flags, positional) {
  const [outDir, ...files] = positional;
  if (!outDir || files.length < 1) {
    throw new UsageError('blind: usage is `modelbake blind <out-dir> <a.jsonl> [b.jsonl ...]`');
  }
  const rep = flags['all-reps'] ? null : intFlag(flags, 'rep', 1, { min: 0 });
  const showTimings = !boolFlag(flags, 'no-timings', false);
  const outRoot = resolve(outDir);
  const packetsDir = join(outRoot, 'packets');
  mkdirSync(packetsDir, { recursive: true });

  const analyses = files.map((file) => {
    const path = resolve(file);
    return analyzeFile(readJsonl(path), path);
  });
  if (new Set(analyses.map((a) => a.label)).size !== analyses.length) {
    throw new UsageError('two files share a label; a label names a lane, so re-run one with a different --label');
  }

  const seed = flags.seed !== undefined
    ? intFlag(flags, 'seed', 0)
    : seedFromString(analyses.map((a) => `${a.meta.contractSha}:${a.meta.casesSha}:${a.label}`).sort().join('|'));
  const masked = seededShuffle(analyses.map((a) => a.label), seed)
    .map((label, index) => ({ mask: `M${index + 1}`, label }));
  const maskFor = new Map(masked.map((m) => [m.label, m.mask]));

  const caseIds = [...new Set(analyses.flatMap((a) => a.results.map((row) => row.caseId)))];
  const packets = [];
  let written = 0;

  for (const caseId of caseIds) {
    const rowsByMask = [];
    let sample = null;
    let caseRow = null;
    for (const analysis of analyses) {
      caseRow = caseRow || analysis.caseIndex.get(caseId) || null;
      const rows = analysis.results
        .filter((row) => row.caseId === caseId && (rep === null || row.rep === rep));
      for (const row of rows) {
        sample = sample || row;
        rowsByMask.push({ mask: maskFor.get(analysis.label), rep: row.rep, row });
      }
    }
    if (!rowsByMask.length) continue;
    rowsByMask.sort((a, b) => (a.mask === b.mask ? a.rep - b.rep : a.mask.localeCompare(b.mask, 'en', { numeric: true })));

    const caseMessages = caseRow?.messages || null;
    const md = [];
    md.push(`# Case \`${caseId}\``);
    md.push('');
    md.push(`Category: ${sample.category}   ·   system variant: ${sample.systemVariant}`);
    if (sample.reviewNote) {
      md.push('');
      md.push(`> Reviewer note from the case author: ${sample.reviewNote}`);
    }
    md.push('');
    md.push('## Input');
    md.push('');
    md.push(caseMessages ? renderMessages(caseMessages) : '_(input not recorded in this results file)_');
    md.push('');
    md.push('## Responses');
    for (const entry of rowsByMask) {
      md.push('');
      md.push(`### ${entry.mask}${rep === null ? ` · rep ${entry.rep}` : ''}`);
      md.push('');
      md.push(renderResponse(entry.row, { showTimings }));
    }
    md.push('');
    writeFileSync(join(packetsDir, `${caseId}.md`), `${md.join('\n')}\n`);
    written += 1;

    packets.push({
      caseId,
      category: sample.category,
      systemVariant: sample.systemVariant,
      reviewNote: sample.reviewNote || caseRow?.reviewNote || null,
      input: caseMessages,
      responses: rowsByMask.map((entry) => ({
        mask: entry.mask,
        rep: entry.rep,
        content: entry.row.content,
        toolCalls: (entry.row.toolCalls || []).map((c) => ({ name: c.name, arguments: c.argumentsRaw, argumentError: c.argumentError })),
        envelopes: entry.row.envelopes,
        finishReason: entry.row.finishReason,
        reasoningChars: entry.row.reasoningChars,
        timings: showTimings
          ? { firstVisibleMs: entry.row.firstVisibleMs, firstToolMs: entry.row.firstToolMs, totalMs: entry.row.totalMs }
          : null,
      })),
    });
  }

  const rubricPath = flags.rubric ? resolve(String(flags.rubric)) : null;
  let rubricText = null;
  if (rubricPath) {
    try {
      rubricText = readFileSync(rubricPath, 'utf8');
    } catch (caught) {
      throw new UsageError(`cannot read --rubric ${rubricPath}: ${caught.message}`);
    }
  }

  writeFileSync(join(outRoot, 'packets.json'), `${JSON.stringify({ tool: 'modelbake', seed, masks: masked.map((m) => m.mask), packets }, null, 2)}\n`);
  writeFileSync(join(outRoot, 'key.json'), `${JSON.stringify({
    tool: 'modelbake',
    seed,
    warning: 'Do not open this until grading is finished and written down.',
    key: Object.fromEntries(masked.map((m) => [m.mask, m.label])),
    lanes: analyses.map((a) => ({ label: a.label, model: a.meta.model, path: a.path, contractSha: a.meta.contractSha, mode: a.mode })),
  }, null, 2)}\n`);

  const readme = [
    '# Blind grading packets',
    '',
    `${written} cases · ${masked.length} lanes, masked as ${masked.map((m) => m.mask).join(', ')}.`,
    `Seed ${seed} (deterministic: the same inputs and seed always produce the same masking).`,
    '',
    '`key.json` maps each mask back to its label. **Do not read it until your scores are written down.**',
    '',
    '## What is already settled',
    '',
    'Structural correctness, tool choice, argument validity and latency are measured by',
    '`modelbake report` and are NOT what you are grading here. Grade only what a machine',
    'cannot: whether the answer chose the right thing to say and do.',
    '',
    '## How to grade',
    '',
    '1. Read `packets/<case>.md` one case at a time.',
    '2. Score every mask on every dimension of your rubric before moving on.',
    '3. Write one short reason per score. A score with no reason is not evidence.',
    '4. Only when every case is scored, open `key.json`.',
    '',
    'For an LLM grader, `packets.json` carries the same content as structured data.',
    'Feed it your rubric and require a reason per dimension per mask.',
    '',
  ];
  if (rubricText) {
    readme.push('## Rubric', '', rubricText.trim(), '');
  } else {
    readme.push('## Rubric', '', '_No rubric was supplied. Re-run with `--rubric your-rubric.md` to embed yours here._', '');
  }
  readme.push(
    '## A limit worth knowing',
    '',
    'Masking removes the label, not every clue. A model that names itself, or one that is',
    'dramatically faster than the rest, can still be identifiable across packets. Pass',
    '`--no-timings` if speed would bias your reading of quality.',
    '',
  );
  writeFileSync(join(outRoot, 'README.md'), `${readme.join('\n')}\n`);

  console.log(`wrote ${written} packets to ${packetsDir}`);
  console.log(`  ${masked.map((m) => m.mask).join(', ')}  (mapping in ${join(outRoot, 'key.json')} -- do not open it yet)`);
  console.log(`  start here: ${join(outRoot, 'README.md')}`);
  return 0;
}
