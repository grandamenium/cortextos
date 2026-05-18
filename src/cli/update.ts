/**
 * `cortextos update` — customer-friendly opt-in update mechanism MVP.
 *
 * Wraps the existing `cortextos bus check-upstream` machinery with a
 * confirmation prompt before applying. Per David's directive (locked
 * 2026-05): the customer must opt in to each apply; updates do NOT run
 * automatically. The daily 06:23 ET cron only CHECKS (no --apply); this
 * command is how the customer hits "yes" when there's something to pull.
 *
 * Flow:
 *   1. Run check-upstream in dry-run mode (--apply NOT set).
 *   2. Pretty-print the result:
 *      - up_to_date: print a one-liner, exit 0
 *      - error: print error + hint, exit 1 (preserves operator awareness)
 *      - updates_available: print commit count + diff stat, prompt y/N
 *   3. On y, re-invoke check-upstream with --apply, print result, exit.
 *   4. On N or anything else, exit 0 without applying.
 *
 * Flags:
 *   --yes / -y       skip the confirmation prompt (for scripted use)
 *   --check          only check; never apply (alias for the daily cron)
 */
import { Command } from 'commander';
import { createInterface, type Interface } from 'readline';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { checkUpstream } from '../bus/metrics.js';

function rl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: Interface, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, answer => resolve(answer.trim())));
}

function findFrameworkRoot(): string {
  const candidates = [
    process.env.CTX_FRAMEWORK_ROOT,
    process.env.CORTEXTOS_DIR,
    process.env.CTX_PROJECT_ROOT,
    process.cwd(),
    join(homedir(), 'cortextos'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) {
      // Verify it's actually cortextos (not a random package.json).
      try {
        const pkg = JSON.parse(require('fs').readFileSync(join(c, 'package.json'), 'utf-8'));
        if (pkg.name === 'cortextos' || pkg.name === 'ascendops') return c;
      } catch { /* ignore */ }
    }
  }
  // Fall back to process.cwd anyway — let checkUpstream surface the not-a-repo error.
  return process.cwd();
}

interface UpdateOptions {
  yes?: boolean;
  check?: boolean;
}

async function runUpdate(opts: UpdateOptions): Promise<void> {
  const frameworkRoot = findFrameworkRoot();

  // Step 1: check (no apply).
  const status = checkUpstream(frameworkRoot, { apply: false }) as any;

  if (status.status === 'error') {
    console.error(`Error: ${status.error}`);
    if (status.hint) console.error(`  Hint: ${status.hint}`);
    process.exit(1);
  }

  if (status.status === 'up_to_date') {
    console.log('Already up to date — no upstream changes available.');
    process.exit(0);
  }

  // Updates available.
  const commitCount = status.commits ?? '?';
  const diffStat = status.diff_stat || '';
  console.log('');
  console.log(`Upstream updates available: ${commitCount} commit(s) behind.`);
  if (diffStat) console.log(`  ${diffStat}`);
  console.log('');

  if (opts.check) {
    console.log('--check mode — exiting without applying.');
    process.exit(0);
  }

  let confirmed = !!opts.yes;
  if (!confirmed) {
    const iface = rl();
    try {
      const answer = await ask(iface, 'Apply the upstream updates now? [y/N]: ');
      confirmed = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    } finally {
      iface.close();
    }
  }

  if (!confirmed) {
    console.log('Aborted — no updates applied. Re-run when ready.');
    process.exit(0);
  }

  console.log('');
  console.log('Applying upstream updates...');
  // checkUpstream's apply path gates on CORTEXTOS_CONFIRM_UPSTREAM_MERGE — the
  // customer's interactive `y` (or --yes flag) IS that confirmation, so set it
  // here before calling. Without this, apply short-circuits with a refusal.
  process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = 'yes';
  const applied = checkUpstream(frameworkRoot, { apply: true }) as any;
  console.log(JSON.stringify(applied, null, 2));

  if (applied.status === 'error') {
    process.exit(1);
  }
  if (applied.status === 'applied') {
    console.log('');
    console.log('Updates applied. You may need to: cortextos stop && cortextos start');
  }
}

export const updateCommand = new Command('update')
  .description('Check for and (with confirmation) apply framework updates from upstream')
  .option('-y, --yes', 'Skip the confirmation prompt (apply without asking)')
  .option('--check', 'Only check — never apply, even with --yes')
  .action(runUpdate);
