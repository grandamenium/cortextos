/**
 * Inter-process exclusion on `<ctxRoot>/config/enabled-agents.json`.
 *
 * Five CLI call sites used to read-modify-write this registry unlocked, so two
 * concurrent commands could lose each other's entry. `mutateEnabledAgents`
 * (src/utils/enabled-agents.ts) now wraps the whole read-mutate-write in
 * `withFileLockSync`. This file is what demonstrates that under real
 * contention, rather than arguing it from reading the code.
 *
 * WHY REAL CHILD PROCESSES: an in-process test cannot prove this. Vitest is
 * single-threaded, so the lock is uncontended on every acquire and the test
 * goes green whether or not the lock exists — it would only be pinning the
 * refactor. The exclusion is between OS processes, so the test has to spawn
 * OS processes.
 *
 * WHY THE PRODUCTION BINARY: the children run `node dist/cli.js disable`, not
 * the helper directly. Calling the helper would only prove the helper works;
 * spawning the CLI proves the call sites actually route through it. `disable`
 * is the lightest full-stack mutator — no .env or Telegram preflight — and it
 * mutates the registry before it touches anything else.
 *
 * SANDBOXING: these call sites derive ctxRoot as `join(homedir(), '.cortextos',
 * <instance>)`, NOT from CTX_ROOT — so unlike tests/integration/
 * concurrent-cron-mutations.test.ts, setting CTX_ROOT in the child env does
 * nothing here. We override HOME instead (`os.homedir()` honours $HOME on
 * POSIX). That also sandboxes `getIpcPath()`, which is derived the same way,
 * so `isDaemonRunning()` finds no socket and the children cannot reach the
 * real daemon or stop real agents.
 *
 * NOTE: the CLI arm invokes compiled `dist/cli.js` and skips itself if that is
 * absent (`npm run build` first). The control arm and the lock-protocol cases
 * below need no build and always run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mutateEnabledAgents, enabledAgentsDir, enabledAgentsPath } from '../../src/utils/enabled-agents';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');
const INSTANCE = 'default';

/** Sandboxed $HOME; ctxRoot lives underneath it. */
let sandboxHome: string;
let ctxRoot: string;

beforeEach(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), 'enabled-agents-race-'));
  ctxRoot = join(sandboxHome, '.cortextos', INSTANCE);
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
});

afterEach(() => {
  try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const registryPath = () => join(ctxRoot, 'config', 'enabled-agents.json');
const agentNames = (n: number) => Array.from({ length: n }, (_, i) => `race-agent-${i}`);

/**
 * Padding entries nobody mutates, present only to make the registry big.
 *
 * This is load-bearing, not decoration. The unlocked window is
 * parse -> mutate -> serialise -> write, and against a tiny file that window
 * is so much shorter than process-startup jitter that the children rarely
 * overlap. Measured against a deliberately lock-bypassed build (see the
 * "must still be able to fail" note on the CLI arm): at N=8 with no padding
 * only 2 of 5 iterations lost anything, so a broken build would have gone
 * green most runs. Padding the registry widens the window enough that loss
 * became reliable. A registry this size is realistic for a large fleet.
 */
const PADDING_ENTRIES = 400;

/** Seed N agents, all enabled. Each child will flip exactly one to disabled. */
function seed(names: string[]): void {
  const agents: Record<string, any> = {};
  for (const name of names) agents[name] = { enabled: true, org: 'lifeos' };
  for (let i = 0; i < PADDING_ENTRIES; i++) {
    agents[`padding-agent-${i}`] = {
      enabled: true,
      org: 'lifeos',
      status: 'configured',
      note: 'x'.repeat(80),
    };
  }
  writeFileSync(registryPath(), JSON.stringify(agents, null, 2) + '\n');
}

/**
 * The detector, shared by both arms so the control arm validates the exact
 * assertion the CLI arm relies on. A "lost" entry is one whose disable did not
 * survive — either overwritten back to enabled, or dropped from the file
 * entirely by a stale-snapshot write.
 */
function countLost(names: string[]): number {
  const agents = JSON.parse(readFileSync(registryPath(), 'utf-8'));
  let lost = 0;
  for (const name of names) {
    if (!agents[name] || agents[name].enabled !== false) lost++;
  }
  return lost;
}

/** Child env: sandboxed HOME, and CTX_ROOT cleared so nothing leaks in. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: sandboxHome };
  delete env.CTX_ROOT;
  return env;
}

/**
 * Control-arm harness: the *unlocked* read-modify-write these call sites used
 * to do, as a standalone script with no repo imports. Its job is to prove the
 * detector above can actually see a lost update — without it, a green CLI arm
 * is indistinguishable from a test that checks nothing.
 *
 * It takes a wall-clock start deadline so every child reads at the same
 * instant. Relying on process-startup jitter to produce overlap would make the
 * control arm flaky, and a flaky control arm proves nothing on the runs where
 * it happens to pass.
 */
const UNSAFE_HARNESS = `
const { readFileSync, writeFileSync } = require('fs');
const [file, name, startAtMs] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Barrier: line every child up on the same wall-clock instant.
const waitFor = Number(startAtMs) - Date.now();
if (waitFor > 0) sleep(waitFor);

const agents = JSON.parse(readFileSync(file, 'utf-8'));   // read...
sleep(150);                                                // ...window...
agents[name].enabled = false;
writeFileSync(file, JSON.stringify(agents, null, 2) + '\\n'); // ...write. No lock.
`;

describe('enabled-agents.json: concurrent registry mutation', () => {
  it('CONTROL ARM: unlocked read-modify-write loses updates, and the detector sees it', async () => {
    const harness = join(sandboxHome, 'unsafe-rmw.cjs');
    writeFileSync(harness, UNSAFE_HARNESS);

    const names = agentNames(8);
    seed(names);

    const startAt = Date.now() + 1000;
    await Promise.all(
      names.map(name =>
        execFileAsync(process.execPath, [harness, registryPath(), name, String(startAt)], {
          env: childEnv(),
        }),
      ),
    );

    // Every child read the same snapshot, so only the last writer's flip
    // survives. The exact count depends on write ordering; what must hold is
    // that the detector reports loss at all.
    const lost = countLost(names);
    expect(
      lost,
      'control arm did not lose any updates — the detector cannot see the failure ' +
        'the CLI arm claims to rule out, so the CLI arm proves nothing',
    ).toBeGreaterThan(0);
  }, 60_000);

  describe.skipIf(!existsSync(DIST_CLI))('via the production CLI (requires npm run build)', () => {
    /**
     * THIS TEST MUST STILL BE ABLE TO FAIL. Verified by mutation: bypassing
     * `withFileLockSync` in src/utils/enabled-agents.ts and rebuilding makes it
     * fail, with loss in 25 of 25 iterations across five runs at this N and
     * padding. Re-run that experiment if you change N, PADDING_ENTRIES, or the
     * command being spawned — every one of those knobs controls whether the
     * children actually collide, and a green here means nothing if they don't.
     */
    it('N concurrent `cortextos disable` processes: every mutation survives', async () => {
      const N = 16;
      const ITERATIONS = 5;
      const lostPerIteration: number[] = [];

      for (let iter = 0; iter < ITERATIONS; iter++) {
        const names = agentNames(N);
        seed(names);

        await Promise.all(
          names.map(name =>
            execFileAsync(
              process.execPath,
              [DIST_CLI, 'disable', name, '--instance', INSTANCE],
              { env: childEnv() },
            ),
          ),
        );

        lostPerIteration.push(countLost(names));

        // A stale-snapshot write drops entries wholesale, including ones no
        // child touched. Nothing may vanish, not just the mutated agents.
        const onDisk = JSON.parse(readFileSync(registryPath(), 'utf-8'));
        expect(Object.keys(onDisk).length, 'registry entries must not vanish').toBe(
          N + PADDING_ENTRIES,
        );
      }

      const totalLost = lostPerIteration.reduce((a, b) => a + b, 0);
      if (totalLost > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[enabled-agents race] lost per iteration: ${lostPerIteration.join(', ')} ` +
            `(total ${totalLost} of ${N * ITERATIONS})`,
        );
      }
      expect(totalLost, 'concurrent `cortextos disable` must not lose any updates').toBe(0);
    }, 120_000);
  });
});

describe('enabled-agents.json: lock protocol', () => {
  const lockDir = () => join(ctxRoot, 'config', '.lock.d');

  /**
   * Pins the literal rendezvous path. This is NOT a concurrency claim — it is
   * a path assertion, and it matters because the lock only excludes writers
   * that lock the SAME directory. The dashboard's helper locks
   * `dirname(enabled-agents.json)`; if this side ever locked somewhere else,
   * every test here would still pass while the two processes locked different
   * doors. Until both branches merge, this pin is the only thing holding the
   * two sides to one marker.
   */
  it('holds <ctxRoot>/config/.lock.d for the duration of the mutation, and releases it', () => {
    expect(enabledAgentsDir(ctxRoot)).toBe(join(ctxRoot, 'config'));
    expect(enabledAgentsPath(ctxRoot)).toBe(join(ctxRoot, 'config', 'enabled-agents.json'));
    expect(existsSync(lockDir())).toBe(false);

    let heldDuringMutate: boolean | null = null;
    mutateEnabledAgents(ctxRoot, (agents) => {
      heldDuringMutate = existsSync(lockDir());
      agents.alpha = { enabled: true };
    });

    expect(heldDuringMutate, 'lock marker must exist while mutate runs').toBe(true);
    expect(existsSync(lockDir()), 'lock marker must be released afterwards').toBe(false);
  });

  it('steals a .lock.d whose recorded PID is dead, and completes the mutation', async () => {
    // A PID that is genuinely dead: spawn a process and wait for it to exit.
    // Guessing a high number risks colliding with a live process.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>(resolve => child.on('exit', () => resolve()));
    const deadPid = child.pid!;

    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), 'pid'), String(deadPid));

    const wrote = mutateEnabledAgents(ctxRoot, (agents) => {
      agents.alpha = { enabled: false };
    });

    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(registryPath(), 'utf-8')).alpha.enabled).toBe(false);
    expect(existsSync(lockDir()), 'stolen lock must still be released').toBe(false);
  }, 20_000);

  it('refuses a .lock.d held by a live process and throws at the timeout', () => {
    // Our own PID is unambiguously alive, so acquireLock must never steal it.
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), 'pid'), String(process.pid));

    const started = Date.now();
    expect(() => mutateEnabledAgents(ctxRoot, () => { /* must never run */ })).toThrow(
      /failed to acquire lock/i,
    );
    const elapsed = Date.now() - started;

    // Default timeout is 5s; assert it actually waited rather than failing fast.
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(existsSync(registryPath()), 'must not have written anything').toBe(false);
  }, 20_000);
});
