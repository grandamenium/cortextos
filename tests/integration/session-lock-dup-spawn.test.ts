/**
 * tests/integration/session-lock-dup-spawn.test.ts
 *
 * Replicates the gc96d-style duplicate-spawn collision that motivated the
 * session-lock guard:
 *
 *   - A daemon-managed PTY owns `state/<agent>/session.lock` with
 *     owner_pid = daemon pid, and propagates that pid into the PTY env via
 *     CTX_SESSION_OWNER_PID.
 *   - A separately launched process (manual `cortextos bus *` from another
 *     shell, scoped spawn-codex, snapshot run) sets only CTX_AGENT_NAME and
 *     attempts a mutation against the same bus identity.
 *
 * Pre-fix: both sessions wrote to inbox/state for the same agent and raced
 * each other (inflight recovery stole messages, heartbeat clobbered).
 * Post-fix: the second process MUST hard-fail with a SessionOwnershipError
 * whose message names the conflicting pid for operator diagnosis.
 *
 * Implementation notes:
 *   - resolvePaths() derives ctxRoot from `${homedir()}/.cortextos/{instance}`
 *     and does NOT honor CTX_ROOT, so the test overrides HOME=tmpRoot.
 *   - The test invokes the compiled CLI directly; requires `npm run build`.
 *     Without `dist/cli.js`, the suite is skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

const AGENT = 'alpha';
const INSTANCE = 'default';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, ...args],
      { env },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function seedSessionLock(
  homeDir: string,
  ownerPid: number,
  sessionId = 'sess-int-test',
): string {
  const stateDir = join(homeDir, '.cortextos', INSTANCE, 'state', AGENT);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'session.lock'),
    JSON.stringify({
      agent: AGENT,
      instance_id: INSTANCE,
      owner_pid: ownerPid,
      pty_pid: ownerPid + 1,
      session_id: sessionId,
      started_at: '2026-05-17T15:00:00Z',
    }) + '\n',
  );
  return stateDir;
}

describe.skipIf(!existsSync(DIST_CLI))('session-lock: dup-spawn collision guard', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-session-lock-int-'));
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects a mutation from a process that did not inherit CTX_SESSION_OWNER_PID', async () => {
    // Daemon (this vitest pid) already owns the lock.
    seedSessionLock(tmpHome, process.pid);

    // Simulates an operator opening a separate shell and running
    // `cortextos bus update-heartbeat ...` with only CTX_AGENT_NAME set.
    // They never inherit the daemon-set CTX_SESSION_OWNER_PID.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      CTX_AGENT_NAME: AGENT,
      CTX_INSTANCE_ID: INSTANCE,
    };
    delete env.CTX_SESSION_OWNER_PID;

    const result = await runCli(['bus', 'update-heartbeat', 'online'], env);

    expect(result.code).not.toBe(0);
    // Error must name the conflicting pid clearly for operator diagnosis.
    expect(result.stderr).toContain(String(process.pid));
    expect(result.stderr).toContain(AGENT);
    expect(result.stderr.toLowerCase()).toContain('session.lock');
  }, 30_000);

  it('rejects every mutation in the allowlist when a dup session attempts it', async () => {
    // Confirms the guard applies broadly, not just to one command.
    // Probes a handful of high-traffic mutations.
    seedSessionLock(tmpHome, process.pid);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      CTX_AGENT_NAME: AGENT,
      CTX_INSTANCE_ID: INSTANCE,
    };
    delete env.CTX_SESSION_OWNER_PID;

    const probes: string[][] = [
      ['bus', 'update-heartbeat', 'online'],
      ['bus', 'ack-inbox', 'msg-1'],
      ['bus', 'log-event', 'action', 'session_start', 'info'],
    ];
    for (const args of probes) {
      const result = await runCli(args, env);
      expect(result.code, `expected ${args.join(' ')} to be rejected`).not.toBe(0);
      expect(result.stderr).toContain(String(process.pid));
    }
  }, 30_000);

  it('allows a mutation from a process that inherits CTX_SESSION_OWNER_PID', async () => {
    // The daemon-spawned PTY: env carries CTX_SESSION_OWNER_PID == lock owner.
    seedSessionLock(tmpHome, process.pid);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      CTX_AGENT_NAME: AGENT,
      CTX_INSTANCE_ID: INSTANCE,
      CTX_SESSION_OWNER_PID: String(process.pid),
    };

    const result = await runCli(['bus', 'update-heartbeat', 'online'], env);

    // The guard must not block. (The command itself may print warnings, but
    // must not exit with the SessionOwnershipError signature.)
    expect(result.stderr).not.toContain('is not the owner');
  }, 30_000);

  it('allows a mutation when the lock owner pid is dead (orphan recovery)', async () => {
    // Daemon crashed mid-session, leaving an orphan lock. A fresh process
    // must be able to take over — the previous owner is no longer alive.
    seedSessionLock(tmpHome, 99999999, 'sess-orphan');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      CTX_AGENT_NAME: AGENT,
      CTX_INSTANCE_ID: INSTANCE,
    };
    delete env.CTX_SESSION_OWNER_PID;

    const result = await runCli(['bus', 'update-heartbeat', 'online'], env);

    expect(result.stderr).not.toContain('is not the owner');
  }, 30_000);

  it('allows read-only commands to pass through (no lock check on reads)', async () => {
    // The guard is mutation-only; read-only commands are not in the
    // mutation allowlist and pass through regardless of ownership.
    seedSessionLock(tmpHome, process.pid);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tmpHome,
      CTX_AGENT_NAME: AGENT,
      CTX_INSTANCE_ID: INSTANCE,
    };
    delete env.CTX_SESSION_OWNER_PID;

    const result = await runCli(['bus', 'list-tasks'], env);

    expect(result.stderr).not.toContain('is not the owner');
  }, 30_000);
});
