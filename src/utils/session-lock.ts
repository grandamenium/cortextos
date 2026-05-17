import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync, ensureDir } from './atomic.js';

/**
 * Single-session-per-identity enforcement.
 *
 * Bug we are fixing: any process that sets `CTX_AGENT_NAME=X` and shells
 * `cortextos bus *` writes to the same per-agent bus paths
 * (inbox/{X}/, state/{X}/, etc.). The daemon's intra-process guards prevent
 * itself from spawning two PTYs for the same name, but a separately-launched
 * snapshot run / scoped spawn / raw claude-code invocation in another shell
 * bypasses every daemon guard. Two such sessions end up clobbering heartbeat,
 * racing inflight-recovery, and answering each other's reply_to chains.
 *
 * Mechanism: the daemon writes `state/{agent}/session.lock` after it spawns
 * the PTY and propagates `CTX_SESSION_OWNER_PID=<daemonPid>` into the PTY
 * environment. Every `cortextos bus *` mutation reads the lock and accepts
 * the call only if either (a) no live lock exists, (b) the holder is a
 * dead pid (orphan recovery), or (c) the caller's
 * `process.env.CTX_SESSION_OWNER_PID` matches `lock.owner_pid`.
 *
 * Anything that fails those checks raises `SessionOwnershipError`, which
 * names the conflicting pid so an operator can diagnose the duplicate
 * session immediately. Read-only diagnostic commands can opt out via
 * `CTX_SESSION_BYPASS=1`; the CLI gates this allowlist explicitly in
 * `src/cli/bus.ts`, so mutation commands never honor the bypass.
 */
export interface SessionLockData {
  agent: string;
  instance_id: string;
  owner_pid: number;
  pty_pid?: number;
  session_id: string;
  started_at: string;
}

const LOCK_FILENAME = 'session.lock';

function lockPath(stateDir: string): string {
  return join(stateDir, LOCK_FILENAME);
}

/**
 * Write a session lock atomically. Overwrites an existing lock — the caller
 * (typically agent-manager.startAgent) is responsible for stopping the
 * previous session first.
 */
export function acquireSession(
  stateDir: string,
  data: Omit<SessionLockData, 'session_id' | 'started_at'> & { session_id?: string },
): SessionLockData {
  ensureDir(stateDir);
  const session_id = data.session_id ?? randomBytes(8).toString('hex');
  const started_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload: SessionLockData = { ...data, session_id, started_at };
  atomicWriteSync(lockPath(stateDir), JSON.stringify(payload));
  return payload;
}

/**
 * Read the session lock, or null if absent / corrupt.
 */
export function readSession(stateDir: string): SessionLockData | null {
  const p = lockPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionLockData;
  } catch {
    return null;
  }
}

/**
 * Remove the session lock. Idempotent — safe to call when no lock exists.
 */
export function releaseSession(stateDir: string): void {
  try { unlinkSync(lockPath(stateDir)); } catch { /* ignore */ }
}

/**
 * True iff `pid` corresponds to a running process visible to the kernel.
 * signal=0 probes existence without delivering a signal. EPERM means the
 * process exists but is unowned by us, which still counts as alive for
 * the purposes of "is the previous owner still running".
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export class SessionOwnershipError extends Error {
  readonly conflictingPid: number;
  readonly conflictingSessionId: string;
  readonly startedAt: string;
  readonly agentName: string;

  constructor(lock: SessionLockData, ourPid: number) {
    super(
      `cortextos: session.lock for "${lock.agent}" is held by pid ${lock.owner_pid} ` +
      `(session ${lock.session_id}, started ${lock.started_at}). ` +
      `This process (pid ${ourPid}) is not the owner. ` +
      `If this is intentional and you only need to read state, set CTX_SESSION_BYPASS=1.`,
    );
    this.name = 'SessionOwnershipError';
    this.conflictingPid = lock.owner_pid;
    this.conflictingSessionId = lock.session_id;
    this.startedAt = lock.started_at;
    this.agentName = lock.agent;
  }
}

/**
 * Verify that the current process is authorized to mutate bus state for the
 * named agent. Returns silently if authorized. Throws SessionOwnershipError
 * when a live session lock is held by a different owner.
 *
 * Authorization rules, in order:
 *   1. No lock present              → pass (legacy / no daemon-managed session).
 *   2. Lock belongs to a different agent → pass (we are looking at the wrong dir).
 *   3. Lock owner_pid is dead       → pass (orphan, daemon crashed without releasing).
 *   4. process.env.CTX_SESSION_OWNER_PID matches lock.owner_pid → pass.
 *   5. Otherwise                    → throw.
 *
 * Callers should treat the throw as a hard failure — the CLI exits non-zero
 * and prints the error message so an operator sees the conflicting pid.
 */
export function verifySessionOwnership(
  stateDir: string,
  agentName: string,
): void {
  const lock = readSession(stateDir);
  if (!lock) return;
  if (lock.agent !== agentName) return;
  if (!isPidAlive(lock.owner_pid)) return;

  const claimedPid = parseInt(process.env.CTX_SESSION_OWNER_PID ?? '', 10);
  if (!isNaN(claimedPid) && claimedPid === lock.owner_pid) return;

  throw new SessionOwnershipError(lock, process.pid);
}
