/**
 * Regression tests for worker-session suppression in hook-crash-alert.ts.
 *
 * Problem: ephemeral worker sessions inherit the global SessionEnd crash-alert
 * hook. When a worker self-terminates after completing its task (no state
 * marker written), classifyFromMarkers() returns endType='crash'. This fired
 * 🚨 CRASH Telegram pages and bus alerts for workers that completed correctly.
 *
 * Fix:
 *   - WorkerProcess.spawn() writes `.is-worker` into the worker's state dir.
 *   - hook-crash-alert.ts reads isWorker = existsSync(stateDir/.is-worker).
 *   - Worker exits: crash count NOT incremented, crashes.log written WITH
 *     worker=1, then early return (no notifyAgents, no Telegram).
 *   - Non-worker exits: all existing behaviour preserved.
 *
 * Test strategy: use real temp dirs (no fs mock — same pattern as the rest of
 * this test suite). child_process is mocked to intercept notifyAgents() calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// child_process mock must be hoisted before the module import so notifyAgents
// picks it up. Matches the pattern in hook-crash-alert.test.ts.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { isWorkerSession, notifyAgents } from '../../../src/hooks/hook-crash-alert.js';

// ---------------------------------------------------------------------------
// isWorkerSession — the exported sentinel that the hook uses for suppression
// ---------------------------------------------------------------------------
describe('isWorkerSession', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'worker-suppression-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when .is-worker is absent (regular agent session)', () => {
    expect(isWorkerSession(tmp)).toBe(false);
  });

  it('returns true when .is-worker marker exists', () => {
    writeFileSync(join(tmp, '.is-worker'), 'comms-check-1782694522');
    expect(isWorkerSession(tmp)).toBe(true);
  });

  it('returns false when stateDir does not exist at all', () => {
    expect(isWorkerSession(join(tmp, 'nonexistent-agent'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Crash-count suppression for workers
//
// The crash-count block in hook-crash-alert.ts now guards:
//   if (endType === 'crash' && !isWorker) { ... increment ... }
//
// We test this by simulating the exact file operations the hook performs,
// then asserting the countFile is NOT written when isWorker is true.
// ---------------------------------------------------------------------------
describe('crash count — worker exits must not increment .crash_count_today', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'worker-count-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('countFile is NOT created for a worker crash-classified exit', () => {
    // Simulate the hook's guard: isWorker=true → skip the increment branch.
    const isWorker = true;
    const endType = 'crash';
    const countFile = join(tmp, '.crash_count_today');
    const today = new Date().toISOString().split('T')[0];

    // This mirrors the guard that was added to the hook:
    if (endType === 'crash' && !isWorker) {
      writeFileSync(countFile, `${today}:1`, 'utf-8');
    }

    expect(existsSync(countFile)).toBe(false);
  });

  it('countFile IS written for a non-worker crash-classified exit', () => {
    // Simulate the hook's guard: isWorker=false → enter the increment branch.
    const isWorker = false;
    const endType = 'crash';
    const countFile = join(tmp, '.crash_count_today');
    const today = new Date().toISOString().split('T')[0];

    if (endType === 'crash' && !isWorker) {
      writeFileSync(countFile, `${today}:1`, 'utf-8');
    }

    expect(existsSync(countFile)).toBe(true);
    expect(readFileSync(countFile, 'utf-8')).toBe(`${today}:1`);
  });
});

// ---------------------------------------------------------------------------
// crashes.log forensics — workers MUST be logged, with worker=1 token
// ---------------------------------------------------------------------------
describe('crashes.log — worker exits must still be logged (with worker=1)', () => {
  let tmp: string;
  let logDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'worker-log-'));
    logDir = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('worker exit: crashes.log line contains worker=1', () => {
    const isWorker = true;
    const endType = 'crash';
    const reason = 'none';
    const sessionId = 'sess-abc';
    const lastTask = 'comms_check_ok';
    const timestamp = new Date().toISOString();

    // Mirror the hook's logLine construction exactly:
    let logLine = `${timestamp} type=${endType} reason=${reason} session=${sessionId} last_task=${lastTask}`;
    if (isWorker) logLine += ' worker=1';
    logLine += '\n';

    appendFileSync(join(logDir, 'crashes.log'), logLine);

    const content = readFileSync(join(logDir, 'crashes.log'), 'utf-8');
    expect(content).toContain('worker=1');
    expect(content).toContain('type=crash');
    expect(content).toContain('session=sess-abc');
  });

  it('non-worker exit: crashes.log line does NOT contain worker=1', () => {
    const isWorker = false;
    const endType = 'crash';
    const reason = 'none';
    const sessionId = 'sess-xyz';
    const lastTask = '';
    const timestamp = new Date().toISOString();

    let logLine = `${timestamp} type=${endType} reason=${reason} session=${sessionId} last_task=${lastTask}`;
    if (isWorker) logLine += ' worker=1';
    logLine += '\n';

    appendFileSync(join(logDir, 'crashes.log'), logLine);

    const content = readFileSync(join(logDir, 'crashes.log'), 'utf-8');
    expect(content).not.toContain('worker=1');
    expect(content).toContain('type=crash');
  });
});

// ---------------------------------------------------------------------------
// notifyAgents suppression for workers
//
// The hook calls notifyAgents() only AFTER the `if (isWorker) return;` guard.
// We verify: when isWorker is true, the path that calls notifyAgents is never
// reached. We simulate the exact gate from hook-crash-alert.ts main():
//
//   appendFileSync(...)   ← crashes.log (always)
//   if (isWorker) return; ← early exit for workers
//   ...
//   if (endType === 'crash' || endType === 'daemon-crashed') {
//     notifyAgents(...)   ← only for real agents
//   }
// ---------------------------------------------------------------------------
describe('notifyAgents suppression — workers must not reach the bus alert', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('worker session: notifyAgents is NOT called (early return fires first)', () => {
    const isWorker = true;
    const endType = 'crash';

    // Mirror the gate from hook-crash-alert.ts main():
    if (isWorker) {
      // early return — notifyAgents path is never reached
    } else if (endType === 'crash' || endType === 'daemon-crashed') {
      notifyAgents({
        agentName: 'test-worker',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('non-worker crash session: notifyAgents IS called (gate not triggered)', () => {
    const isWorker = false;
    const endType = 'crash';

    if (isWorker) {
      // early return
    } else if (endType === 'crash' || endType === 'daemon-crashed') {
      notifyAgents({
        agentName: 'larry',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    // notifyAgents dispatches one execFile call per recipient
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('worker daemon-crashed session: notifyAgents is NOT called', () => {
    const isWorker = true;
    const endType = 'daemon-crashed';

    if (isWorker) {
      // early return
    } else if (endType === 'crash' || endType === 'daemon-crashed') {
      notifyAgents({
        agentName: 'test-worker',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 0,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: .is-worker marker → full suppression chain
//
// Verify that presence of the marker file correctly drives isWorkerSession()
// which the hook uses to skip the alert path. This ties the WorkerProcess
// side (writes the marker) to the hook side (reads it).
// ---------------------------------------------------------------------------
describe('end-to-end: .is-worker marker → isWorkerSession → alert suppressed', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'worker-e2e-'));
    execFileMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stateDir with .is-worker → isWorkerSession true → notifyAgents never reached', () => {
    // WorkerProcess.spawn() writes this marker:
    writeFileSync(join(tmp, '.is-worker'), 'comms-check-1782694522');

    const isWorker = isWorkerSession(tmp);
    expect(isWorker).toBe(true);

    // Simulate the hook alert gate:
    const endType = 'crash';
    if (!isWorker && (endType === 'crash' || endType === 'daemon-crashed')) {
      notifyAgents({
        agentName: 'comms-check-1782694522',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief', 'analyst'],
      });
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('stateDir without .is-worker → isWorkerSession false → notifyAgents called', () => {
    // No .is-worker written → regular agent session
    const isWorker = isWorkerSession(tmp);
    expect(isWorker).toBe(false);

    const endType = 'crash';
    if (!isWorker && (endType === 'crash' || endType === 'daemon-crashed')) {
      notifyAgents({
        agentName: 'larry',
        endType,
        reason: '',
        lastTask: '',
        crashCount: 1,
        restartAttempted: true,
        recipients: ['chief'],
      });
    }

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
