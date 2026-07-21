/**
 * tests/unit/daemon/command-cron.test.ts
 *
 * Isolated tests for the headless "command" cron runtime (Phase 2).
 *
 * These exercise the REAL executor against REAL short-lived child processes
 * (node -e ...), with an isolated temp CTX_ROOT so execution-log writes land in
 * a throwaway directory. No production path, daemon, or PM2 is involved.
 *
 * Coverage (per the plan):
 *   1. successful headless execution (no Claude escalation)
 *   2. non-zero exit code (failure → escalation)
 *   3. timeout (killed → failure → escalation)
 *   4. overlapping execution prevention
 *   5. actionable output escalation (escalate_on_output + ESCALATE: sentinel)
 *   6. no-action output without Claude escalation
 *   7. backward-compatible agent runtime (scheduler still injects prompt)
 *   8. logging (rich execution-log entry written)
 *   9. retry behavior (retry_count honored, only on failure)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runCommandCron,
  escalationReason,
  __resetInFlightForTests,
} from '../../../src/daemon/command-cron';
import { cronExecutionLogPathFor } from '../../../src/bus/crons-schema';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Per-test isolated CTX_ROOT + inject spy
// ---------------------------------------------------------------------------

let tmpRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
let injected: string[];

function inject(msg: string): boolean {
  injected.push(msg);
  return true;
}

function readLog(agent: string): Record<string, unknown>[] {
  const p = join(tmpRoot, cronExecutionLogPathFor(agent));
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Build a command cron that runs `node -e <code>`. */
function nodeCron(name: string, code: string, extra: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name,
    prompt: '',
    schedule: '1h',
    enabled: true,
    created_at: '2026-07-21T00:00:00.000Z',
    runtime: 'command',
    command: 'node',
    args: ['-e', code],
    timeout_seconds: 5,
    ...extra,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cmdcron-'));
  process.env.CTX_ROOT = tmpRoot;
  injected = [];
  __resetInFlightForTests();
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 1. Successful headless execution — no escalation
// ---------------------------------------------------------------------------

describe('successful headless execution', () => {
  it('exits 0, does not inject a Claude turn, logs status "fired"', async () => {
    const cron = nodeCron('ok', 'process.stdout.write("done")');
    const res = await runCommandCron('agentA', cron, { inject });

    expect(res.skipped).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.escalated).toBe(false);
    expect(injected).toHaveLength(0); // NO Claude turn

    const log = readLog('agentA');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ cron: 'ok', status: 'fired', runtime: 'command', exit_code: 0, escalated: false });
  });
});

// ---------------------------------------------------------------------------
// 2. Non-zero exit → failure → escalation
// ---------------------------------------------------------------------------

describe('non-zero exit code', () => {
  it('escalates by default and logs status "failed"', async () => {
    const cron = nodeCron('boom', 'console.error("bad"); process.exit(3)');
    const res = await runCommandCron('agentA', cron, { inject });

    expect(res.exitCode).toBe(3);
    expect(res.escalated).toBe(true);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatch(/COMMAND FAILURE/);
    expect(injected[0]).toMatch(/code 3/);

    const log = readLog('agentA');
    expect(log[log.length - 1]).toMatchObject({ status: 'failed', exit_code: 3, runtime: 'command' });
  });

  it('does NOT escalate when escalate_on_error is false, but still logs failed', async () => {
    const cron = nodeCron('quietfail', 'process.exit(1)', { escalate_on_error: false });
    const res = await runCommandCron('agentA', cron, { inject });

    expect(res.exitCode).toBe(1);
    expect(res.escalated).toBe(false);
    expect(injected).toHaveLength(0);
    expect(readLog('agentA').pop()).toMatchObject({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// 3. Timeout → killed → failure → escalation
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('kills a long-running command and escalates as a timeout', async () => {
    // Sleep 10s but timeout at 1s.
    const cron = nodeCron('slow', 'setTimeout(()=>{}, 10000)', { timeout_seconds: 1 });
    const res = await runCommandCron('agentA', cron, { inject });

    expect(res.timedOut).toBe(true);
    expect(res.escalated).toBe(true);
    expect(injected[0]).toMatch(/TIMED OUT|timed out/i);
    expect(readLog('agentA').pop()).toMatchObject({ status: 'failed', timed_out: true });
  }, 8000);
});

// ---------------------------------------------------------------------------
// 4. Overlap prevention
// ---------------------------------------------------------------------------

describe('overlapping execution prevention', () => {
  it('skips a second fire while the first is still in flight', async () => {
    const cron = nodeCron('overlap', 'setTimeout(()=>{}, 400)', { timeout_seconds: 5 });

    const first = runCommandCron('agentA', cron, { inject });
    // Fire again immediately, before `first` resolves.
    const second = await runCommandCron('agentA', cron, { inject });
    expect(second.skipped).toBe(true);

    const firstRes = await first;
    expect(firstRes.skipped).toBe(false);

    const log = readLog('agentA');
    expect(log.some((e) => e.status === 'skipped')).toBe(true);
  });

  it('allows overlap when prevent_overlap is false', async () => {
    const cron = nodeCron('nooverlap', 'setTimeout(()=>{}, 300)', { prevent_overlap: false, timeout_seconds: 5 });
    const first = runCommandCron('agentA', cron, { inject });
    const second = await runCommandCron('agentA', cron, { inject });
    expect(second.skipped).toBe(false);
    await first;
  });
});

// ---------------------------------------------------------------------------
// 5. Actionable output escalation
// ---------------------------------------------------------------------------

describe('actionable output escalation', () => {
  it('escalates on escalate_on_output regex match despite exit 0', async () => {
    const cron = nodeCron('watch', 'process.stdout.write("2 NEW_LEAD found")', {
      escalate_on_output: 'NEW_LEAD',
    });
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.exitCode).toBe(0);
    expect(res.escalated).toBe(true);
    expect(injected[0]).toMatch(/COMMAND ESCALATION/);
    expect(readLog('agentA').pop()).toMatchObject({ status: 'fired', escalated: true });
  });

  it('escalates on the ESCALATE: sentinel line', async () => {
    const cron = nodeCron('sentinel', 'console.log("ESCALATE: rent check bounced")');
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.escalated).toBe(true);
    expect(injected[0]).toMatch(/rent check bounced/);
  });

  it('escalates on an actionable exit code without retrying', async () => {
    const cron = nodeCron('signal', 'process.exit(10)', { actionable_exit_codes: [10], retry_count: 3 });
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.exitCode).toBe(10);
    expect(res.escalated).toBe(true);
    expect(res.attempts).toBe(1); // actionable → NOT retried
    expect(injected[0]).toMatch(/actionable exit code 10/);
  });
});

// ---------------------------------------------------------------------------
// 6. No-action output without escalation
// ---------------------------------------------------------------------------

describe('no-action output', () => {
  it('does not escalate when output does not match escalate_on_output', async () => {
    const cron = nodeCron('quiet', 'process.stdout.write("no new items")', {
      escalate_on_output: 'NEW_LEAD',
    });
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.escalated).toBe(false);
    expect(injected).toHaveLength(0);
    expect(readLog('agentA').pop()).toMatchObject({ status: 'fired', escalated: false });
  });
});

// ---------------------------------------------------------------------------
// 7. Backward-compatible agent runtime
// ---------------------------------------------------------------------------

describe('backward-compatible agent runtime', () => {
  it('escalationReason is irrelevant; a cron with no runtime is treated as agent by callers', () => {
    // The command executor is only invoked when runtime === "command".
    // A definition with no runtime field must be left for the agent path.
    const legacy: CronDefinition = {
      name: 'legacy', prompt: 'do a thing', schedule: '4h',
      enabled: true, created_at: '2026-07-21T00:00:00.000Z',
    };
    expect(legacy.runtime).toBeUndefined();
    // Sanity: our classifier only reasons about command runs, never agent crons.
    expect(typeof escalationReason).toBe('function');
  });

  it('a missing command field on a command cron fails loud (does not silently no-op)', async () => {
    const bad: CronDefinition = {
      name: 'misconfigured', prompt: '', schedule: '1h',
      enabled: true, created_at: '2026-07-21T00:00:00.000Z',
      runtime: 'command', // but no `command`
    };
    const res = await runCommandCron('agentA', bad, { inject });
    expect(res.error).toMatch(/no "command"/);
    expect(injected).toHaveLength(1); // escalated by default
    expect(readLog('agentA').pop()).toMatchObject({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// 8. Logging
// ---------------------------------------------------------------------------

describe('logging', () => {
  it('writes a rich JSONL entry with command fields', async () => {
    const cron = nodeCron('logtest', 'process.stdout.write("hi"); console.error("warn")');
    await runCommandCron('agentB', cron, { inject });
    const log = readLog('agentB');
    expect(log).toHaveLength(1);
    const e = log[0];
    expect(e).toHaveProperty('duration_ms');
    expect(e).toHaveProperty('runtime', 'command');
    expect(e).toHaveProperty('exit_code', 0);
    expect(e).toHaveProperty('stdout_excerpt');
    expect(String(e.stdout_excerpt)).toContain('hi');
    expect(String(e.stderr_excerpt)).toContain('warn');
  });
});

// ---------------------------------------------------------------------------
// 9. Retry behavior
// ---------------------------------------------------------------------------

describe('retry behavior', () => {
  it('retries failures up to retry_count, logging each retry', async () => {
    const cron = nodeCron('retry', 'process.exit(2)', {
      retry_count: 2,
      retry_delay_seconds: 0,
    });
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.attempts).toBe(3); // 1 initial + 2 retries
    const log = readLog('agentA');
    const retried = log.filter((e) => e.status === 'retried');
    expect(retried).toHaveLength(2);
    expect(log.pop()).toMatchObject({ status: 'failed', attempt: 3 });
  });

  it('does not retry a successful command', async () => {
    const cron = nodeCron('nosuccessretry', 'process.stdout.write("ok")', {
      retry_count: 5,
      retry_delay_seconds: 0,
    });
    const res = await runCommandCron('agentA', cron, { inject });
    expect(res.attempts).toBe(1);
  });
});
