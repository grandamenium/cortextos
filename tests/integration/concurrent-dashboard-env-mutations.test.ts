/**
 * Inter-process exclusion and merge-preservation on `<ctxRoot>/dashboard.env`.
 *
 * TWO independent writers touch this file:
 *   - `cortextos install`   (src/cli/install.ts)
 *   - `cortextos dashboard` (src/cli/dashboard.ts)
 * Both did a bare read-modify-write. With the file absent or missing
 * AUTH_SECRET, each generates its own secrets; the last writer wins the file
 * while the dashboard has already captured ITS values in memory, handed them to
 * the Next.js child, and printed the admin password. The user is then shown a
 * password that is not the stored one. Both call sites now go through
 * `mutateDashboardEnv` (src/utils/dashboard-env.ts).
 *
 * Separately, and needing no concurrency at all: install rewrote the file from a
 * FIXED five-key list, so every install silently dropped any other key.
 *
 * WHY REAL CHILD PROCESSES: an in-process test cannot prove this. Vitest is
 * single-threaded, so the lock is uncontended on every acquire and the test
 * would go green with or without it — pinning the refactor, not the exclusion.
 * The exclusion is between OS processes, so the test spawns OS processes.
 *
 * SCOPE — READ THIS BEFORE QUOTING THE GREEN. Unlike the org-context suite, the
 * children here run the shared helper via `tsx`, NOT the production binary.
 * `cortextos install` runs `npm link` + `npm install` and `cortextos dashboard`
 * starts a server, so neither is spawnable from a test. So this file proves:
 *   (a) the helper serializes read-modify-write across real processes, and
 *   (b) it preserves keys it does not own.
 * It does NOT re-prove that install.ts/dashboard.ts route through the helper —
 * that rests on both call sites importing it and typechecking. If someone
 * reintroduces a bare writeFileSync at either call site, THIS FILE STAYS GREEN.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mutateDashboardEnv, dashboardEnvPath } from '../../src/utils/dashboard-env';
import { parseEnvContent, serializeEnvContent } from '../../src/utils/env';

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const HELPER_SRC = join(REPO_ROOT, 'src', 'utils', 'dashboard-env.ts');

/** Root is only meaningful as a real dir; each test gets a fresh one. */
let ctxRoot: string;
let scriptPath: string;

/**
 * Child: add one uniquely-named key, holding the lock for `holdMs` so the
 * critical sections genuinely overlap rather than happening to serialize.
 */
const ADD_KEY_SCRIPT = `
import { mutateDashboardEnv } from ${JSON.stringify(HELPER_SRC)};
const [ctxRoot, key, holdMs] = process.argv.slice(2);
mutateDashboardEnv(ctxRoot, creds => {
  const until = Date.now() + Number(holdMs);
  // Busy-wait, not a timer: the callback must stay synchronous. An async
  // callback would release the lock before the write and still typecheck.
  while (Date.now() < until) { /* widen the critical section */ }
  creds[key] = 'v-' + key;
});
`;

/**
 * Child: reproduce the credential-divergence shape. Generates AUTH_SECRET and
 * ADMIN_PASSWORD only when absent, then prints the values it would show the
 * user. The invariant under test is that what a writer believes it stored is
 * what is actually on disk afterwards.
 */
const CREDS_SCRIPT = `
import { mutateDashboardEnv } from ${JSON.stringify(HELPER_SRC)};
import { randomBytes } from 'crypto';
const [ctxRoot, holdMs] = process.argv.slice(2);
let observedSecret = '', observedPassword = '';
mutateDashboardEnv(ctxRoot, creds => {
  const until = Date.now() + Number(holdMs);
  while (Date.now() < until) { /* widen the critical section */ }
  creds['AUTH_SECRET'] ||= randomBytes(16).toString('hex');
  creds['ADMIN_PASSWORD'] ||= randomBytes(8).toString('hex');
  observedSecret = creds['AUTH_SECRET'];
  observedPassword = creds['ADMIN_PASSWORD'];
});
process.stdout.write(JSON.stringify({ observedSecret, observedPassword }));
`;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-dashenv-'));
  scriptPath = join(ctxRoot, 'child.ts');
});

afterEach(() => {
  try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('dashboard.env round-trip', () => {
  it('preserves values that the parser would otherwise alter', () => {
    // These are exactly the values a naive `k=v` join would corrupt: the parser
    // trims and strips inline ` #' comments, so an unquoted round-trip loses
    // them. Third-party keys are now preserved, so their values must survive.
    const original = {
      AUTH_SECRET: 'deadbeef',
      WITH_HASH: 'value #notacomment',
      PADDED: '  spaced  ',
      QUOTED_LOOKING: '"already"',
      EMPTY: '',
    };
    expect(parseEnvContent(serializeEnvContent(original))).toEqual(original);
  });

  it('ignores comments and blank lines when reading', () => {
    expect(parseEnvContent('# lead\n\nA=1\n  \nB=2\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('mutateDashboardEnv', () => {
  it('preserves keys it does not own (the fixed-key-list data loss)', () => {
    const file = dashboardEnvPath(ctxRoot);
    writeFileSync(file, 'AUTH_SECRET=keepme\nUSER_ADDED=precious\nPORT_HINT=8080\n', 'utf-8');

    mutateDashboardEnv(ctxRoot, creds => {
      creds['AUTH_SECRET'] ||= 'generated';
      creds['CTX_ROOT'] = ctxRoot;
    });

    const after = parseEnvContent(readFileSync(file, 'utf-8'));
    expect(after['AUTH_SECRET']).toBe('keepme');       // existing value not regenerated
    expect(after['USER_ADDED']).toBe('precious');      // would be dropped pre-fix
    expect(after['PORT_HINT']).toBe('8080');           // would be dropped pre-fix
    expect(after['CTX_ROOT']).toBe(ctxRoot);
  });

  it('reports existed=false and creates the file when absent', () => {
    const seen: boolean[] = [];
    mutateDashboardEnv(ctxRoot, (creds, existed) => { seen.push(existed); creds['A'] = '1'; });
    expect(seen).toEqual([false]);
    expect(existsSync(dashboardEnvPath(ctxRoot))).toBe(true);

    mutateDashboardEnv(ctxRoot, (_creds, existed) => { seen.push(existed); return false; });
    expect(seen).toEqual([false, true]);
  });

  it('does not write when the callback declines', () => {
    // The dashboard's read-only path returns false; starting the dashboard must
    // not churn the file the daemon's watcher keys on.
    const wrote = mutateDashboardEnv(ctxRoot, () => false);
    expect(wrote).toBe(false);
    expect(existsSync(dashboardEnvPath(ctxRoot))).toBe(false);
  });

  it('writes files that are not world-readable', () => {
    mutateDashboardEnv(ctxRoot, creds => { creds['ADMIN_PASSWORD'] = 'hunter2'; });
    const mode = require('fs').statSync(dashboardEnvPath(ctxRoot)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('throws rather than overwriting a file it cannot read', () => {
    // "Unreadable" must not collapse into "absent" — that would regenerate
    // credentials on top of a file whose contents are still there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return; // root bypasses the permission bit; the assertion would be vacuous
    }
    const file = dashboardEnvPath(ctxRoot);
    writeFileSync(file, 'AUTH_SECRET=secret\n', 'utf-8');
    chmodSync(file, 0o000);
    try {
      expect(() => mutateDashboardEnv(ctxRoot, creds => { creds['X'] = '1'; })).toThrow();
      chmodSync(file, 0o600);
      expect(readFileSync(file, 'utf-8')).toContain('AUTH_SECRET=secret');
    } finally {
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  });
});

describe('under real inter-process contention', () => {
  it('loses no concurrent mutation (6 processes, overlapping critical sections)', async () => {
    writeFileSync(scriptPath, ADD_KEY_SCRIPT, 'utf-8');
    const keys = ['K0', 'K1', 'K2', 'K3', 'K4', 'K5'];

    await Promise.all(
      keys.map(key =>
        execFileAsync(TSX_BIN, [scriptPath, ctxRoot, key, '40'], { cwd: REPO_ROOT }),
      ),
    );

    const after = parseEnvContent(readFileSync(dashboardEnvPath(ctxRoot), 'utf-8'));
    // Unlocked, the later writers read a stale map and drop earlier keys.
    for (const key of keys) {
      expect(after[key], `${key} was lost — a concurrent writer clobbered it`).toBe(`v-${key}`);
    }
  }, 60_000);

  it('never shows a writer credentials that differ from what is stored', async () => {
    writeFileSync(scriptPath, CREDS_SCRIPT, 'utf-8');

    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        execFileAsync(TSX_BIN, [scriptPath, ctxRoot, '40'], { cwd: REPO_ROOT }),
      ),
    );

    const stored = parseEnvContent(readFileSync(dashboardEnvPath(ctxRoot), 'utf-8'));
    const observed = results.map(r => JSON.parse(r.stdout));

    // Every process must agree with disk. Pre-fix, concurrent generators each
    // minted their own secret and only the last one survived — so a process
    // printed an admin password the file did not contain.
    for (const o of observed) {
      expect(o.observedSecret).toBe(stored['AUTH_SECRET']);
      expect(o.observedPassword).toBe(stored['ADMIN_PASSWORD']);
    }
    // Sanity: the generation actually happened (guards a vacuous pass where all
    // four somehow read empty strings).
    expect(stored['AUTH_SECRET']).toMatch(/^[0-9a-f]{32}$/);
    expect(stored['ADMIN_PASSWORD']).toMatch(/^[0-9a-f]{16}$/);
  }, 60_000);
});
