/**
 * E2E: does a REAL process death reach the daemon's crash classifier?
 *
 * WHY THIS EXISTS, GIVEN tests/unit/daemon/agent-process.test.ts ALREADY COVERS IT
 * ------------------------------------------------------------------------------
 * The unit test at agent-process.test.ts:165 mocks node-pty and invokes the
 * captured `onExit(1, 0)` callback by hand. That proves the CRASH branch is
 * REACHABLE — it is not dead code — but it assumes the very thing an operator
 * needs to trust: that a real agent binary dying unexpectedly actually produces
 * that call, with a non-zero exit code, through the real PTY layer.
 *
 * That gap is not academic. On this host the daemon's crash classifier wrote
 * ZERO entries in 10.6 days while the same restarts.log took 342 planned
 * HARD-RESTART lines, and the hook-side `type=crash` signal — which is a bare
 * "no marker found" fallback, not a detector — fired 3 times, all false
 * positives. Silence from the daemon side is therefore the ONLY signal an
 * alert can be gated on, and "it is silent because nothing crashed" has to be
 * distinguishable from "it is silent because nothing reaches it." Only a real
 * spawn + real death can tell those apart.
 *
 * SEAM: AgentPTY.getBinaryName() returns the bare name 'claude' and node-pty
 * resolves it through the PATH carried in the spawn env (getBaseEnv copies
 * PATH from process.env). Prepending a temp bin dir holding an executable
 * named `claude` therefore exercises the ENTIRE unmodified production path —
 * AgentProcess.start -> AgentPTY.spawn -> node-pty -> real child -> real exit
 * -> onExit -> handleExit -> appendCrashToRestartsLog. No production source is
 * modified and no seam is injected to make this test pass.
 *
 * BOTH ARMS ARE REQUIRED. An assertion that "a CRASH line appeared" passes
 * just as happily under a daemon that classifies EVERY exit as a crash — which
 * is precisely the over-classification the stopRequested / .daemon-stop guards
 * exist to prevent, and precisely the false-positive failure this whole effort
 * is trying to eliminate. The control arm (intentional stop => NO crash line)
 * is what makes the crash arm mean something.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { AgentProcess } from '../../src/daemon/agent-process';
import type { CtxEnv } from '../../src/types';

// node-pty is a native addon and the PTY dance takes real wall-clock time
// (spawn + the mock's own startup delay, and on the control arm stop()'s
// Ctrl-C/`/exit` sequence with its built-in sleeps).
const ARM_TIMEOUT_MS = 30_000;

let testDir: string;
let ctxRoot: string;
let agentDir: string;
let binDir: string;
let originalPath: string | undefined;

/**
 * Write an executable named `claude` into binDir. Each arm gets its own body:
 * the PTY env is an ALLOWLIST (getBaseEnv keeps PATH/HOME/TERM/... and the
 * CTX_* vars), so an arbitrary MOCK_MODE env var would be stripped before it
 * reached the child. Baking the behaviour into the script is what survives.
 */
function writeMockClaude(body: string): void {
  const p = join(binDir, 'claude');
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`, 'utf-8');
  chmodSync(p, 0o755);
}

/** Emitting 'permissions' is what OutputBuffer.isBootstrapped() looks for. */
const MOCK_BOOTSTRAP = `
console.log('Claude Code (e2e mock)');
console.log('permissions: all granted');
`;

function makeEnv(): CtxEnv {
  return {
    instanceId: 'e2e',
    ctxRoot,
    frameworkRoot: testDir,
    agentName: 'crashy',
    agentDir,
    org: 'e2e-org',
    projectRoot: testDir,
  };
}

const restartsLogPath = (): string => join(ctxRoot, 'logs', 'crashy', 'restarts.log');

function readRestartsLog(): string {
  const p = restartsLogPath();
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

/** Poll until `pred` holds or the budget runs out. Returns whether it held. */
async function waitFor(pred: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ctx-e2e-crash-'));
  ctxRoot = join(testDir, '.cortextos', 'e2e');
  agentDir = join(testDir, 'orgs', 'e2e-org', 'agents', 'crashy');
  binDir = join(testDir, 'bin');
  mkdirSync(ctxRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Scoped to this vitest worker process only — the live daemon is a separate
  // process and cannot see this. Restored in afterEach regardless.
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(testDir, { recursive: true, force: true });
});

describe('E2E: daemon crash classification over a real PTY', () => {
  it(
    'CRASH ARM — a real agent binary dying unprompted is classified as a crash and persisted',
    async () => {
      // Boots, announces bootstrap, then dies on its own with a non-zero code.
      // Nothing calls stop(); from the daemon's side this is indistinguishable
      // from Claude Code falling over.
      writeMockClaude(`${MOCK_BOOTSTRAP}
setTimeout(() => process.exit(3), 400);
`);

      const ap = new AgentProcess('crashy', makeEnv(), {});
      await ap.start();

      const landed = await waitFor(() => /\] CRASH:/.test(readRestartsLog()), 15_000);
      const log = readRestartsLog();

      expect(landed, `restarts.log never received a CRASH line. Contents: ${JSON.stringify(log)}`).toBe(true);

      // Assert the real exit code survives the whole chain. `exit_code=3` can
      // only come from the mock's own process.exit(3) travelling through
      // node-pty's onExit into handleExit — a hardcoded or defaulted 0/1 would
      // not produce it, so this pins the value end-to-end rather than merely
      // asserting that some line appeared.
      expect(log).toMatch(/\] CRASH: exit_code=3 crash_count=1 backoff_s=5\b/);
      expect(ap.getStatus().status).toBe('crashed');

      // handleExit scheduled a backoff restart; stop it so the respawn cannot
      // outlive the test and spawn into a torn-down temp dir.
      await ap.stop().catch(() => { /* already down */ });
    },
    ARM_TIMEOUT_MS,
  );

  it(
    'CONTROL ARM — an intentional stop of the same binary writes NO crash line',
    async () => {
      // Identical mock EXCEPT it stays alive, so the only difference between
      // the arms is who initiated the exit. Exits on the `/exit` line stop()
      // sends, and on the signals from pty.kill().
      writeMockClaude(`${MOCK_BOOTSTRAP}
process.stdin.on('data', (d) => { if (String(d).includes('/exit')) process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000);
`);

      const ap = new AgentProcess('crashy', makeEnv(), {});
      await ap.start();
      expect(ap.getStatus().status).toBe('running');

      await ap.stop();

      // The PTY really did exit — this is the arm's own liveness check. Without
      // it, "no CRASH line" would also be satisfied by a mock that never
      // started, never spawned, or never died, i.e. the arm would pass by doing
      // nothing. getStatus() must show a completed stop, not a crash.
      expect(ap.getStatus().status).toBe('stopped');

      // Give any misclassification the same wall-clock window the crash arm
      // needed to produce its line, so this is a real absence and not an
      // absence measured too early to be meaningful.
      const misclassified = await waitFor(() => /\] CRASH:/.test(readRestartsLog()), 3_000);
      expect(
        misclassified,
        `Intentional stop was misclassified as a crash: ${JSON.stringify(readRestartsLog())}`,
      ).toBe(false);
      expect(readRestartsLog()).not.toMatch(/CRASH|HALTED|CRASH_LOOP/);
    },
    ARM_TIMEOUT_MS,
  );
});
