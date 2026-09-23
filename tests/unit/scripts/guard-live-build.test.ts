import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const GUARD = resolve(__dirname, '../../../scripts/guard-live-build.mjs');
const REPO = resolve(__dirname, '../../..');

/**
 * Run the guard with a PATH in which `cortextos` may or may not resolve into
 * this repo's dist/ — the thing that decides "is this build a deploy?".
 */
function runGuard(opts: { liveBin: boolean; env?: Record<string, string> }): { code: number; stderr: string; stdout: string } {
  const shimDir = mkdtempSync(join(tmpdir(), 'cortextos-guard-path-'));
  try {
    if (opts.liveBin) {
      // Reproduce npm's global bin: a symlink pointing into the checkout's dist.
      symlinkSync(join(REPO, 'dist', 'cli.js'), join(shimDir, 'cortextos'));
    }
    const res = execFileSync('node', [GUARD], {
      cwd: REPO,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CI: '',
        CORTEXTOS_ALLOW_LIVE_BUILD: '',
        // The guard shells out to `sh` and `git`, so those must stay reachable.
        // What varies is only whether a `cortextos` on PATH resolves into this
        // checkout's dist/. The not-live case deliberately excludes the real
        // npm global bin (which, on a fleet host, DOES point into this dist).
        PATH: opts.liveBin ? `${shimDir}:/usr/bin:/bin` : '/usr/bin:/bin',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: res, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
}

/**
 * `npm run build` writes dist/, and dist/ is what the global `cortextos`
 * command executes on a host installed from a working checkout. So on a live
 * fleet box, "just check it compiles" ships your half-finished branch to every
 * running agent — which is exactly what happened, from a branch whose merge was
 * explicitly being held for review.
 *
 * The gate was on `merge`. The deploy happens at `build`. This guard moves the
 * check to where the decision actually is.
 */
describe('guard-live-build: a build on a live host is a deploy', () => {
  it('REFUSES when dist/ is the live binary and we are on a WIP branch', () => {
    // The repo is on a feature branch during test runs, so this is the real case.
    const { code, stderr } = runGuard({ liveBin: true });
    expect(code).toBe(1);
    expect(stderr).toMatch(/REFUSING TO BUILD/);
    expect(stderr).toMatch(/would DEPLOY, not just compile/);
    // It must tell you the safe way, not just say no.
    expect(stderr).toMatch(/npm run typecheck/);
  });

  it('ALLOWS when dist/ is not the live binary (ordinary contributor checkout)', () => {
    const { code } = runGuard({ liveBin: false });
    expect(code).toBe(0);
  });

  it('ALLOWS in CI — a throwaway checkout nothing executes', () => {
    const { code } = runGuard({ liveBin: true, env: { CI: 'true' } });
    expect(code).toBe(0);
  });

  it('ALLOWS a deliberate deploy via the explicit escape hatch', () => {
    const { code, stdout } = runGuard({ liveBin: true, env: { CORTEXTOS_ALLOW_LIVE_BUILD: '1' } });
    expect(code).toBe(0);
    expect(stdout).toMatch(/deliberately/i);
  });
});
