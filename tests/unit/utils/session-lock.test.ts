import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireSession,
  readSession,
  releaseSession,
  verifySessionOwnership,
  SessionOwnershipError,
  isPidAlive,
} from '../../../src/utils/session-lock';

describe('session-lock', () => {
  let stateDir: string;
  const originalEnv = process.env.CTX_SESSION_OWNER_PID;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-session-lock-test-'));
    delete process.env.CTX_SESSION_OWNER_PID;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.CTX_SESSION_OWNER_PID;
    else process.env.CTX_SESSION_OWNER_PID = originalEnv;
  });

  describe('acquireSession / readSession / releaseSession', () => {
    it('writes a lock file with the supplied identity', () => {
      const lock = acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: 12345,
        pty_pid: 67890,
      });
      expect(lock.agent).toBe('alpha');
      expect(lock.owner_pid).toBe(12345);
      expect(lock.pty_pid).toBe(67890);
      expect(lock.session_id).toMatch(/^[0-9a-f]{16}$/);
      expect(lock.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(existsSync(join(stateDir, 'session.lock'))).toBe(true);
    });

    it('round-trips through readSession', () => {
      const written = acquireSession(stateDir, {
        agent: 'beta',
        instance_id: 'default',
        owner_pid: 99,
      });
      const read = readSession(stateDir);
      expect(read).toEqual(written);
    });

    it('readSession returns null when no lock exists', () => {
      expect(readSession(stateDir)).toBeNull();
    });

    it('readSession returns null on corrupt JSON', () => {
      acquireSession(stateDir, { agent: 'c', instance_id: 'default', owner_pid: 1 });
      const lockPath = join(stateDir, 'session.lock');
      const { writeFileSync } = require('fs');
      writeFileSync(lockPath, 'not-json{', 'utf-8');
      expect(readSession(stateDir)).toBeNull();
    });

    it('releaseSession removes the lock file', () => {
      acquireSession(stateDir, { agent: 'd', instance_id: 'default', owner_pid: 1 });
      releaseSession(stateDir);
      expect(existsSync(join(stateDir, 'session.lock'))).toBe(false);
    });

    it('releaseSession is idempotent', () => {
      expect(() => releaseSession(stateDir)).not.toThrow();
      expect(() => releaseSession(stateDir)).not.toThrow();
    });
  });

  describe('isPidAlive', () => {
    it('returns true for current process pid', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for a clearly dead pid', () => {
      // 2^22 is well above any valid linux/darwin pid (max is typically 2^15-2^22).
      // Pick a sentinel unlikely to map to a running process.
      expect(isPidAlive(99999999)).toBe(false);
    });

    it('returns false for invalid pids', () => {
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(NaN)).toBe(false);
    });
  });

  describe('verifySessionOwnership', () => {
    it('passes when no lock exists (legacy)', () => {
      expect(() => verifySessionOwnership(stateDir, 'alpha')).not.toThrow();
    });

    it('passes when the lock is for a different agent', () => {
      acquireSession(stateDir, {
        agent: 'other-agent',
        instance_id: 'default',
        owner_pid: process.pid,
      });
      expect(() => verifySessionOwnership(stateDir, 'alpha')).not.toThrow();
    });

    it('passes when the lock owner is a dead pid (orphan recovery)', () => {
      acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: 99999999,
      });
      expect(() => verifySessionOwnership(stateDir, 'alpha')).not.toThrow();
    });

    it('passes when CTX_SESSION_OWNER_PID matches the lock', () => {
      acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: process.pid,
      });
      process.env.CTX_SESSION_OWNER_PID = String(process.pid);
      expect(() => verifySessionOwnership(stateDir, 'alpha')).not.toThrow();
    });

    it('throws SessionOwnershipError when env pid does not match', () => {
      // owner_pid is a live process (our own) — alive, not matched by env.
      acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: process.pid,
        session_id: 'sess-abc-123',
      });
      // Caller did not inherit CTX_SESSION_OWNER_PID — simulates a separate
      // shell launching `cortextos bus send-message` for the same agent.
      expect(() => verifySessionOwnership(stateDir, 'alpha')).toThrow(
        SessionOwnershipError,
      );
    });

    it('error message names the conflicting pid and session id', () => {
      acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: process.pid,
        session_id: 'sess-deadbeef',
      });
      try {
        verifySessionOwnership(stateDir, 'alpha');
        expect.fail('verifySessionOwnership should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionOwnershipError);
        const e = err as SessionOwnershipError;
        expect(e.conflictingPid).toBe(process.pid);
        expect(e.conflictingSessionId).toBe('sess-deadbeef');
        expect(e.agentName).toBe('alpha');
        // Must mention the pid clearly for operator debugging.
        expect(e.message).toContain(String(process.pid));
        expect(e.message).toContain('sess-deadbeef');
        expect(e.message).toContain('alpha');
      }
    });

    it('throws when env pid is set but does not match lock owner', () => {
      acquireSession(stateDir, {
        agent: 'alpha',
        instance_id: 'default',
        owner_pid: process.pid,
      });
      process.env.CTX_SESSION_OWNER_PID = String(process.pid + 1);
      expect(() => verifySessionOwnership(stateDir, 'alpha')).toThrow(
        SessionOwnershipError,
      );
    });
  });
});
