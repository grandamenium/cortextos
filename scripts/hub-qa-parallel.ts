#!/usr/bin/env node
/**
 * hub-qa-parallel.ts
 * Parallel QA harness — runs hub-qa-playwright.ts checks in batches.
 *
 * Each page gets an isolated child process (own browser + auth session).
 * This avoids Supabase real-time token collisions between contexts.
 *
 * Usage:
 *   npx tsx scripts/hub-qa-parallel.ts
 *   npx tsx scripts/hub-qa-parallel.ts --pages /time,/my-day,/companies
 *   npx tsx scripts/hub-qa-parallel.ts --batch-size 3
 *   npx tsx scripts/hub-qa-parallel.ts --dry-run   (print plan, don't run)
 *
 * Path A (Codex native subagents): already deployed — code work runs parallel by default.
 * Path C (this script): Playwright multi-process for web QA.
 * Path B (Orgo VM multi-display): future work — tracked in docs/multi-cu-parallel.md.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (flag: string, def = '') => {
  const eqForm = argv.find(a => a.startsWith(`${flag}=`));
  if (eqForm) return eqForm.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('-')) return argv[idx + 1];
  return def;
};

const DRY_RUN    = argv.includes('--dry-run');
const BATCH_SIZE = parseInt(getArg('--batch-size', '4'), 10);
const USER_EMAIL = getArg('--user', 'greg@revopsglobal.com');

const ALL_PAGES = [
  '/',
  '/time',
  '/my-day',
  '/tasks',
  '/companies',
  '/projects',
  '/pipeline',
  '/reports',
  '/app/orchestrator',
  '/app/fleet/activity',
  '/app/work/inbox',
  '/app/work/approvals',
  '/app/fleet/tasks',
  '/app/fleet/agents',
  '/social-content',
  '/content-review',
  '/app/wiki',
  '/app/cortex/theta',
  '/app/presence',
  '/app/signals',
];

const customPages = getArg('--pages', '');
const PAGES = customPages ? customPages.split(',').map(p => p.trim()) : ALL_PAGES;

// ---------------------------------------------------------------------------
// Single-page runner — spawns hub-qa-playwright.ts as child process
// ---------------------------------------------------------------------------
interface PageResult {
  page: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runPage(page: string): Promise<PageResult> {
  const start = Date.now();
  return new Promise(resolve => {
    const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'hub-qa-playwright.ts');
    const proc = spawn('npx', ['tsx', scriptPath, '--page', page, '--user', USER_EMAIL, '--no-send'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: { ...process.env },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.on('data', (d: Buffer) => stdout.push(d.toString()));
    proc.stderr.on('data', (d: Buffer) => stderr.push(d.toString()));

    proc.on('close', code => {
      resolve({
        page,
        durationMs: Date.now() - start,
        exitCode: code ?? 0,
        stdout: stdout.join(''),
        stderr: stderr.join('').trim(),
      });
    });

    proc.on('error', err => {
      resolve({
        page,
        durationMs: Date.now() - start,
        exitCode: 2,
        stdout: '',
        stderr: `spawn error: ${err.message}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Timing summary
// ---------------------------------------------------------------------------
function fmtMs(ms: number): string {
  return ms >= 60000
    ? `${(ms / 60000).toFixed(1)}m`
    : `${(ms / 1000).toFixed(1)}s`;
}

function extractSummary(stdout: string): string {
  const match = stdout.match(/Summary:\s*(.*)/);
  return match ? match[1].trim() : '(no summary)';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const batches: string[][] = [];
  for (let i = 0; i < PAGES.length; i += BATCH_SIZE) {
    batches.push(PAGES.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n╔══ hub-qa-parallel ═══════════════════════════════╗`);
  console.log(`║  Pages:      ${PAGES.length} total`);
  console.log(`║  Batch size: ${BATCH_SIZE}`);
  console.log(`║  Batches:    ${batches.length}`);
  console.log(`║  Mode:       ${DRY_RUN ? 'dry-run (no execution)' : 'live'}`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  if (DRY_RUN) {
    batches.forEach((batch, i) => {
      console.log(`Batch ${i + 1}: ${batch.join('  ')}`);
    });
    console.log('\nEstimated sequential time: ~10-45s per page');
    console.log(`Estimated parallel time:   ~${batches.length} x (slowest in batch)`);
    return;
  }

  const allResults: PageResult[] = [];
  const totalStart = Date.now();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchStart = Date.now();
    console.log(`\n── Batch ${i + 1}/${batches.length}: ${batch.join('  ')} ──`);

    const batchResults = await Promise.all(batch.map(p => runPage(p)));
    const batchMs = Date.now() - batchStart;

    batchResults.forEach(r => {
      const icon = r.exitCode === 0 ? '✓' : r.exitCode === 1 ? '✗' : '?';
      const summary = extractSummary(r.stdout);
      console.log(`  ${icon} ${r.page.padEnd(30)} ${fmtMs(r.durationMs).padStart(6)}  ${summary}`);
      if (r.stderr && r.exitCode !== 0) {
        console.log(`    stderr: ${r.stderr.split('\n')[0].slice(0, 120)}`);
      }
    });

    console.log(`  ── batch done in ${fmtMs(batchMs)} ──`);
    allResults.push(...batchResults);
  }

  const totalMs = Date.now() - totalStart;
  const passed  = allResults.filter(r => r.exitCode === 0).length;
  const failed  = allResults.filter(r => r.exitCode === 1).length;
  const errored = allResults.filter(r => r.exitCode > 1).length;

  // Estimate what sequential would have taken
  const totalSerialMs = allResults.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(`\n╔══ Results ════════════════════════════════════════╗`);
  console.log(`║  Pages: ${PAGES.length}  ✓ ${passed}  ✗ ${failed}  ? ${errored}`);
  console.log(`║  Parallel time:    ${fmtMs(totalMs)}`);
  console.log(`║  Sequential est.:  ${fmtMs(totalSerialMs)}`);
  const speedup = totalSerialMs / totalMs;
  console.log(`║  Speedup:          ${speedup.toFixed(1)}x`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // Write timing log
  const OUTPUT_DIR = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../orgs/revops-global/agents/codex/output/playwright-qa'
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const timingPath = path.join(OUTPUT_DIR, `parallel-timing-${today}.md`);
  const lines = [
    `# Parallel QA Timing — ${today}`,
    ``,
    `| Page | Duration | Exit | Summary |`,
    `|------|----------|------|---------|`,
    ...allResults.map(r =>
      `| ${r.page} | ${fmtMs(r.durationMs)} | ${r.exitCode} | ${extractSummary(r.stdout)} |`
    ),
    ``,
    `**Parallel total**: ${fmtMs(totalMs)}`,
    `**Sequential estimate**: ${fmtMs(totalSerialMs)}`,
    `**Speedup**: ${speedup.toFixed(1)}x`,
    `**Batch size**: ${BATCH_SIZE}`,
    `**Batches**: ${batches.length}`,
  ];
  fs.writeFileSync(timingPath, lines.join('\n'));
  console.log(`Timing log: ${timingPath}`);

  process.exit(failed + errored > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
