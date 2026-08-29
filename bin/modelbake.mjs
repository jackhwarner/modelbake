#!/usr/bin/env node
import { parseArgs, UsageError } from '../src/args.mjs';
import { VERSION } from '../src/version.mjs';

const USAGE = `modelbake ${VERSION} -- will this model actually run YOUR app?

  modelbake init [dir]
      Scaffold contract.json, cases.json and AGENTS.md. AGENTS.md is written for
      your coding agent: it extracts the real prompt, tools and sampling out of
      your codebase and drafts cases for you to curate.

  modelbake run --contract contract.json --cases cases.json \\
                --base-url URL --model ID --label NAME [--reps 3]
      Run every case against one OpenAI-compatible endpoint and write JSONL.
      Primes the contract prefix and VERIFIES the prime before trusting any warm
      number; degrades to a cold_only run, honestly labelled, if it cannot.

      --reps N            repetitions per case (default 3)
      --out PATH          output file (default results/<label>.jsonl)
      --only a,b          run only these case ids
      --no-warm           skip priming; every row is cold
      --warm-coverage R   fraction of the primed prefix that must be cached (0.9)
      --reprime-every N   re-prime after N cases so an LRU cannot evict (8)
      --api-key KEY       bearer token (or set MODELBAKE_API_KEY)
      --timeout MS        per-request timeout (300000)
      --dry-run           validate and print the plan; send nothing

  modelbake report a.jsonl [b.jsonl ...] [--bar bar.json]
      Pass rates with named failures, split-timing percentiles, throughput and
      cache stats. Two or more files add a champion-vs-challenger table. --bar
      declares PASS/FAIL against limits you wrote BEFORE you saw the numbers.

      --bar PATH          bar file; its SHA is stamped in the output
      --json              machine-readable output
      --max-failures N    failures listed per section (12)

  modelbake blind OUT_DIR a.jsonl b.jsonl [--rubric r.md]
      Label-stripped grading packets plus a key file. v1 does not grade;
      the packet is the product.

      --rep N | --all-reps    which repetition to include (default 1)
      --rubric PATH           embed your rubric in the packet README
      --no-timings            hide latency so speed cannot bias quality

  modelbake help | version
`;

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === 'version' || flags.version) {
    console.log(VERSION);
    return 0;
  }

  switch (command) {
    case 'init': {
      const { initCommand } = await import('../src/commands/init.mjs');
      return initCommand(flags, rest);
    }
    case 'run': {
      const { runCommand } = await import('../src/commands/run.mjs');
      return runCommand(flags);
    }
    case 'report': {
      const { reportCommand } = await import('../src/commands/report.mjs');
      return reportCommand(flags, rest);
    }
    case 'blind': {
      const { blindCommand } = await import('../src/commands/blind.mjs');
      return blindCommand(flags, rest);
    }
    default:
      throw new UsageError(`unknown command "${command}". Run \`modelbake help\`.`);
  }
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    if (error?.isUsageError) {
      console.error(`modelbake: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`modelbake: unexpected failure: ${error?.stack || error}`);
    process.exitCode = 70;
  });
