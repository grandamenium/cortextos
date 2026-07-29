/**
 * Inter-process exclusion on `<frameworkRoot>/orgs/<org>/context.json`.
 *
 * `cortextos init` and `cortextos add-agent --template orchestrator` both did an
 * unlocked read-modify-write on this file, over DISJOINT field sets — init fills
 * in missing org fields, add-agent claims `orchestrator`. That disjointness is
 * exactly what makes the race destructive rather than benign: each writes the
 * whole object back, so the later writer silently discards the other's field.
 * `mutateOrgContext` (src/utils/org-context.ts) now wraps read+mutate+write in
 * `withFileLockSync`. This file demonstrates that under real contention instead
 * of arguing it from reading the code.
 *
 * WHY REAL CHILD PROCESSES: an in-process test cannot prove this. Vitest is
 * single-threaded, so the lock is uncontended on every acquire and the test goes
 * green whether or not the lock exists — it would only be pinning the refactor.
 * The exclusion is between OS processes, so the test spawns OS processes.
 *
 * WHY THE PRODUCTION BINARY: the children run `node dist/cli.js`, not the helper
 * directly. Calling the helper would only prove the helper works; spawning the
 * CLI proves the two call sites actually route through it.
 *
 * SANDBOXING: `init` derives projectRoot from `process.cwd()` and ctxRoot from
 * `join(homedir(), '.cortextos', <instance>)`; `add-agent` derives projectRoot
 * from CTX_FRAMEWORK_ROOT/CTX_PROJECT_ROOT/cwd. So the children run with cwd set
 * to a temp dir, HOME overridden (os.homedir() honours $HOME on POSIX), and
 * those three CTX_* vars deleted so the real installation cannot leak in.
 * Overriding HOME also sandboxes getIpcPath(), so the children cannot reach the
 * real daemon.
 *
 * NOTE: the CLI arms invoke compiled `dist/cli.js` and skip themselves if it is
 * absent (`npm run build` first). The control arm needs no build and always runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mutateOrgContext, orgContextDir, orgContextPath, CorruptOrgContextError } from '../../src/utils/org-context';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const ORG = 'raceorg';
const ORCHESTRATOR = 'boss';

/** Sandboxed $HOME, which doubles as the project root (cwd) for the children. */
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'org-context-race-'));
  mkdirSync(join(sandbox, 'orgs', ORG), { recursive: true });
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

const contextPath = () => join(sandbox, 'orgs', ORG, 'context.json');

/**
 * Padding keys nobody mutates, present only to make the file big.
 *
 * Load-bearing, not decoration. The unlocked window is
 * parse -> mutate -> serialise -> write, and against a file this small that
 * window is far shorter than the startup jitter of two different CLI commands,
 * so the children would rarely overlap and a broken build would go green.
 * Padding widens the window enough that loss becomes reliable — see the
 * detection rate recorded on the CLI arm below. Both writers preserve unknown
 * keys, so padding survives a correct run untouched.
 */
const PADDING_ENTRIES = 3000;

/** Fields `init`'s upgrade pass fills in, and that add-agent must not discard. */
const INIT_FIELDS = [
  'name', 'description', 'industry', 'icp', 'value_prop', 'timezone',
  'day_mode_start', 'day_mode_end', 'default_approval_categories', 'communication_style',
];

/**
 * Seed a context.json that BOTH commands have real work to do on: every field
 * `init` fills is absent, and `orchestrator` is unset so add-agent will claim it.
 * If either side had nothing to write, the race could not be observed at all.
 */
function seed(): void {
  const ctx: Record<string, any> = {};
  for (let i = 0; i < PADDING_ENTRIES; i++) ctx[`padding_${i}`] = 'x'.repeat(200);
  writeFileSync(contextPath(), JSON.stringify(ctx, null, 2) + '\n');
}

/**
 * The detector, shared by both arms so the control arm validates the exact
 * assertion the CLI arm relies on. Returns the list of things that were lost;
 * empty means both mutations survived intact.
 */
function losses(): string[] {
  const raw = readFileSync(contextPath(), 'utf-8');
  let ctx: Record<string, any>;
  try {
    ctx = JSON.parse(raw);
  } catch {
    // A torn/truncated file is the worst outcome, not merely a lost field:
    // every reader of context.json swallows parse errors and keeps defaults.
    return [`context.json is not valid JSON (${raw.length} bytes)`];
  }

  const lost: string[] = [];
  if (ctx.orchestrator !== ORCHESTRATOR) {
    lost.push(`orchestrator: expected "${ORCHESTRATOR}", got ${JSON.stringify(ctx.orchestrator)}`);
  }
  for (const field of INIT_FIELDS) {
    if (ctx[field] === undefined) lost.push(`init field missing: ${field}`);
  }
  // A stale-snapshot write drops keys wholesale, including ones nobody touched.
  const paddingPresent = Object.keys(ctx).filter(k => k.startsWith('padding_')).length;
  if (paddingPresent !== PADDING_ENTRIES) {
    lost.push(`padding keys: expected ${PADDING_ENTRIES}, found ${paddingPresent}`);
  }
  return lost;
}

/** Child env: sandboxed HOME, and every projectRoot override cleared. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: sandbox };
  delete env.CTX_ROOT;
  delete env.CTX_FRAMEWORK_ROOT;
  delete env.CTX_PROJECT_ROOT;
  return env;
}

/**
 * Control-arm harness: the *unlocked* read-modify-write these two call sites
 * used to do, as a standalone script with no repo imports. Its job is to prove
 * the detector above can actually see a lost update — without it, a green CLI
 * arm is indistinguishable from a test that checks nothing.
 *
 * Takes a wall-clock start deadline so both children read the same instant.
 * Relying on startup jitter to produce overlap would make the control arm
 * flaky, and a flaky control arm proves nothing on the runs where it passes.
 */
const UNSAFE_HARNESS = `
const { readFileSync, writeFileSync } = require('fs');
const [file, role, startAtMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const waitFor = Number(startAtMs) - Date.now();
if (waitFor > 0) sleep(waitFor);

const ctx = JSON.parse(readFileSync(file, 'utf-8'));   // read...
sleep(200);                                             // ...window...
if (role === 'init') {
  ctx.name = 'raceorg';
  ctx.description = ''; ctx.industry = ''; ctx.icp = ''; ctx.value_prop = '';
  ctx.timezone = 'UTC';
  ctx.day_mode_start = '08:00'; ctx.day_mode_end = '00:00';
  ctx.default_approval_categories = ['external-comms'];
  ctx.communication_style = 'direct and casual';
} else {
  ctx.orchestrator = 'boss';
}
writeFileSync(file, JSON.stringify(ctx, null, 2) + '\\n');  // ...write. No lock.
`;

describe('context.json: concurrent org-context mutation', () => {
  it('CONTROL ARM: unlocked read-modify-write loses updates, and the detector sees it', async () => {
    const harness = join(sandbox, 'unsafe-rmw.cjs');
    writeFileSync(harness, UNSAFE_HARNESS);
    seed();

    const startAt = Date.now() + 1000;
    await Promise.all(
      ['init', 'orchestrator'].map(role =>
        execFileAsync(process.execPath, [harness, contextPath(), role, String(startAt)], {
          env: childEnv(),
        }),
      ),
    );

    // Both read the same snapshot, so only the last writer's fields survive —
    // whichever order they land in, the other side's work is gone.
    expect(
      losses(),
      'control arm lost nothing — the detector cannot see the failure the CLI ' +
        'arm claims to rule out, so the CLI arm would prove nothing',
    ).not.toEqual([]);
  }, 60_000);

  describe.skipIf(!existsSync(DIST_CLI))('via the production CLI (requires npm run build)', () => {
    /**
     * THIS TEST MUST STILL BE ABLE TO FAIL. Verified by mutation: replacing the
     * `withFileLockSync` call in src/utils/org-context.ts with a direct call to
     * its callback and rebuilding makes it fail. Detection rate is recorded in
     * the commit message — a single observed failure would not have been
     * enough, because whether the two commands' write windows actually overlap
     * is probabilistic. Re-run that experiment if you change PADDING_ENTRIES,
     * ITERATIONS, or the commands being spawned: every one of those knobs
     * controls whether the children collide, and a green here means nothing if
     * they never do.
     */
    it('concurrent `init` and `add-agent --template orchestrator`: both mutations survive', async () => {
      const ITERATIONS = 6;
      const failures: string[] = [];

      for (let iter = 0; iter < ITERATIONS; iter++) {
        rmSync(join(sandbox, 'orgs'), { recursive: true, force: true });
        mkdirSync(join(sandbox, 'orgs', ORG), { recursive: true });
        seed();

        await Promise.all([
          execFileAsync(process.execPath, [DIST_CLI, 'init', ORG], {
            cwd: sandbox,
            env: childEnv(),
          }),
          execFileAsync(
            process.execPath,
            [DIST_CLI, 'add-agent', ORCHESTRATOR, '--template', 'orchestrator', '--org', ORG],
            { cwd: sandbox, env: childEnv() },
          ),
        ]);

        const lost = losses();
        if (lost.length) failures.push(`iteration ${iter}: ${lost.join('; ')}`);
      }

      expect(
        failures,
        'concurrent init/add-agent must not lose each other\'s fields',
      ).toEqual([]);
    }, 180_000);
  });
});

describe('context.json: lock protocol', () => {
  const lockDir = () => join(sandbox, 'orgs', ORG, '.lock.d');

  /**
   * Pins the literal rendezvous path. NOT a concurrency claim — a path
   * assertion, and it matters because the lock only excludes writers that lock
   * the SAME directory. The dashboard resolves this file to the same
   * `<frameworkRoot>/orgs/<org>/` and re-exports the same lock module, so if
   * this side ever locked somewhere else, every test here would still pass
   * while the two processes locked different doors.
   */
  it('holds <frameworkRoot>/orgs/<org>/.lock.d during the mutation, and releases it', () => {
    expect(orgContextDir(sandbox, ORG)).toBe(join(sandbox, 'orgs', ORG));
    expect(orgContextPath(sandbox, ORG)).toBe(join(sandbox, 'orgs', ORG, 'context.json'));
    expect(existsSync(lockDir())).toBe(false);

    let heldDuringMutate: boolean | null = null;
    mutateOrgContext(sandbox, ORG, (ctx) => {
      heldDuringMutate = existsSync(lockDir());
      ctx.name = ORG;
    });

    expect(heldDuringMutate, 'lock marker must exist while mutate runs').toBe(true);
    expect(existsSync(lockDir()), 'lock marker must be released afterwards').toBe(false);
  });

  it('creates the file when absent, reporting existed=false', () => {
    let sawExisted: boolean | null = null;
    const wrote = mutateOrgContext(sandbox, ORG, (ctx, existed) => {
      sawExisted = existed;
      ctx.orchestrator = ORCHESTRATOR;
    });

    expect(sawExisted).toBe(false);
    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(contextPath(), 'utf-8')).orchestrator).toBe(ORCHESTRATOR);
  });

  it('declines the write when mutate returns false, leaving the file byte-identical', () => {
    writeFileSync(contextPath(), JSON.stringify({ name: ORG }, null, 2) + '\n');
    const before = readFileSync(contextPath(), 'utf-8');

    const wrote = mutateOrgContext(sandbox, ORG, (ctx) => {
      ctx.orchestrator = 'ignored-because-we-decline';
      return false;
    });

    expect(wrote).toBe(false);
    // Byte-identical matters beyond the field values: declining exists so a
    // no-op run does not churn the mtime the dashboard's watcher keys on.
    expect(readFileSync(contextPath(), 'utf-8')).toBe(before);
  });

  /**
   * The refusal is the whole reason the helper can be trusted to run inside
   * `init`, whose mutate is a fill-in-the-missing-fields pass: treating a parse
   * failure as `{}` would rewrite a recoverable file down to bare defaults and
   * report success.
   */
  it('refuses to overwrite a corrupt file, and preserves a backup of it', () => {
    const corrupt = '{ this is not json';
    writeFileSync(contextPath(), corrupt);

    let err: unknown;
    try {
      mutateOrgContext(sandbox, ORG, (ctx) => { ctx.name = 'clobbered'; });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(CorruptOrgContextError);
    expect(readFileSync(contextPath(), 'utf-8'), 'original must be untouched').toBe(corrupt);

    const backupPath = (err as CorruptOrgContextError).backupPath;
    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath!, 'utf-8')).toBe(corrupt);
    expect(existsSync(lockDir()), 'lock must be released even on refusal').toBe(false);
  });

  it('refuses a JSON array, which would otherwise pass a bare typeof check', () => {
    writeFileSync(contextPath(), '[]');
    expect(() => mutateOrgContext(sandbox, ORG, () => { /* must never run */ })).toThrow(
      CorruptOrgContextError,
    );
    expect(readFileSync(contextPath(), 'utf-8')).toBe('[]');
  });

  it('upgrades a BOM-prefixed file instead of silently skipping it', () => {
    // Without stripBom the parse throws, which is what used to make every
    // re-run of `cortextos init` leave a BOM'd context.json un-upgraded forever.
    writeFileSync(contextPath(), '﻿' + JSON.stringify({ name: ORG }, null, 2) + '\n');

    const wrote = mutateOrgContext(sandbox, ORG, (ctx) => { ctx.orchestrator = ORCHESTRATOR; });

    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(contextPath(), 'utf-8')).orchestrator).toBe(ORCHESTRATOR);
  });
});
