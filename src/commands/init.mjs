import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boolFlag } from '../args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = join(HERE, '..', 'scaffold');

const FILES = [
  { template: 'contract.template.json', target: 'contract.json', what: 'the frozen contract: system prompts, tool schemas, sampling' },
  { template: 'cases.template.json', target: 'cases.json', what: 'your app\'s own cases and their assertions' },
  { template: 'AGENTS.template.md', target: 'AGENTS.md', what: 'the extraction brief -- point your coding agent at this' },
];

export function initCommand(flags, positional) {
  const dir = resolve(positional[0] || String(flags.dir || '.'));
  const force = boolFlag(flags, 'force', false);
  mkdirSync(dir, { recursive: true });

  const written = [];
  const skipped = [];
  for (const file of FILES) {
    const target = join(dir, file.target);
    if (existsSync(target) && !force) {
      skipped.push(file.target);
      continue;
    }
    copyFileSync(join(SCAFFOLD, file.template), target);
    written.push(file);
  }

  console.log(`modelbake init  ->  ${dir}`);
  for (const file of written) console.log(`  wrote   ${file.target.padEnd(16)}${file.what}`);
  for (const name of skipped) console.log(`  kept    ${name.padEnd(16)}already exists (use --force to overwrite)`);

  if (written.length || skipped.length) {
    console.log('');
    console.log('modelbake is agent-operated by design. The tool validates shapes; your agent');
    console.log('does the extraction. Next step, in your coding agent, in this repo:');
    console.log('');
    console.log('    Read AGENTS.md and follow it.');
    console.log('');
    console.log('Then check the result without sending a request:');
    console.log('');
    console.log('    npx modelbake run --contract contract.json --cases cases.json \\');
    console.log('      --base-url http://localhost:8080/v1 --model any --label check --dry-run');
    console.log('');
  }
  return 0;
}

export function scaffoldText(name) {
  return readFileSync(join(SCAFFOLD, name), 'utf8');
}
