import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker.js';
import type { BusPaths } from '../../../src/types/index.js';
import {
  contextHandoffLeasePath,
  releaseContextHandoffLease,
  requestContextHandoffLease,
} from '../../../src/daemon/context-handoff-lease.js';

describe('context handoff fleet lease', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'handoff-lease-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('drains a 6-agent herd without exceeding max concurrent handoffs', () => {
    const now = Date.now();
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'];

    const firstWave = agents.map((agentName) =>
      requestContextHandoffLease({ ctxRoot, agentName, now, maxConcurrent: 2 }));

    expect(firstWave.filter((decision) => decision.status === 'acquired')).toHaveLength(2);
    expect(firstWave.filter((decision) => decision.status === 'queued')).toHaveLength(4);
    expect(readState().active).toHaveLength(2);
    expect(readState().queue).toHaveLength(4);
    expect(readState().queue.every((entry: any) => entry.not_before > entry.requested_at)).toBe(true);

    releaseContextHandoffLease(ctxRoot, 'agent-a', (firstWave[0] as any).leaseId);
    releaseContextHandoffLease(ctxRoot, 'agent-b', (firstWave[1] as any).leaseId);

    const secondWave = agents.slice(2).map((agentName) =>
      requestContextHandoffLease({ ctxRoot, agentName, now: now + 90_000, maxConcurrent: 2 }));
    expect(secondWave.filter((decision) => decision.status === 'acquired')).toHaveLength(2);
    expect(readState().active).toHaveLength(2);

    const activeSecond = readState().active.map((entry: any) => entry.agent);
    for (const agent of activeSecond) {
      releaseContextHandoffLease(ctxRoot, agent);
    }

    const thirdWave = agents.slice(4).map((agentName) =>
      requestContextHandoffLease({ ctxRoot, agentName, now: now + 180_000, maxConcurrent: 2 }));
    expect(thirdWave.filter((decision) => decision.status === 'acquired')).toHaveLength(2);
    expect(readState().active).toHaveLength(2);
    expect(readState().queue).toHaveLength(0);
  });

  it('returns an existing active lease id for duplicate requests from the same agent', () => {
    const first = requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: 1000, maxConcurrent: 2 });
    const second = requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: 2000, maxConcurrent: 2 });

    expect(first.status).toBe('acquired');
    expect(second.status).toBe('acquired');
    expect((second as any).leaseId).toBe((first as any).leaseId);
    expect(readState().active).toHaveLength(1);
  });

  it('limits actual FastChecker handoff prompts when six agents cross at once', async () => {
    const agents = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'];
    const records = agents.map((agentName) => createChecker(agentName));

    await Promise.all(records.map((record) =>
      (record.checker as any).checkContextStatus()));

    expect(records.filter((record) => handoffPrompts(record).length === 1)).toHaveLength(2);
    expect(records.filter((record) => handoffPrompts(record).length === 0)).toHaveLength(4);
    expect(readState().active).toHaveLength(2);
    expect(readState().queue).toHaveLength(4);

    for (const active of readState().active as Array<{ agent: string; lease_id: string }>) {
      releaseContextHandoffLease(ctxRoot, active.agent, active.lease_id);
    }

    await Promise.all(records.map((record) =>
      (record.checker as any).checkContextStatus()));
    expect(records.filter((record) => handoffPrompts(record).length === 1)).toHaveLength(2);

    const queuedAgents = records
      .filter((record) => handoffPrompts(record).length === 0)
      .map((record) => record.agentName);
    for (const queuedAgent of queuedAgents) {
      const state = readState();
      const queued = state.queue.find((entry: any) => entry.agent === queuedAgent);
      if (queued) queued.not_before = 0;
      writeFileSync(contextHandoffLeasePath(ctxRoot), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    }

    await Promise.all(records.map((record) =>
      (record.checker as any).checkContextStatus()));
    expect(records.filter((record) => handoffPrompts(record).length === 1)).toHaveLength(4);

    for (const active of readState().active as Array<{ agent: string; lease_id: string }>) {
      releaseContextHandoffLease(ctxRoot, active.agent, active.lease_id);
    }
    for (const queuedAgent of records
      .filter((record) => handoffPrompts(record).length === 0)
      .map((record) => record.agentName)) {
      const state = readState();
      const queued = state.queue.find((entry: any) => entry.agent === queuedAgent);
      if (queued) queued.not_before = 0;
      writeFileSync(contextHandoffLeasePath(ctxRoot), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    }

    await Promise.all(records.map((record) =>
      (record.checker as any).checkContextStatus()));
    expect(records.filter((record) => handoffPrompts(record).length === 1)).toHaveLength(6);
    expect(readState().active).toHaveLength(2);
    expect(readState().queue).toHaveLength(0);
  });

  it('releases a leaked lease by name on fresh-session bootstrap, not at TTL', async () => {
    // A prior session of agent-a handed off and leaked its lease: a context handoff
    // restarts the agent, recreating the monitor's per-agent state (ctxLastSessionId
    // and the in-memory lease id back to null), so the old gated release never fired
    // and the lease sat in `active` until its 10-min TTL.
    requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: Date.now(), maxConcurrent: 2 });
    expect(readState().active.map((entry: any) => entry.agent)).toContain('agent-a');

    // The restarted agent comes back as a fresh low-context session. A brand-new
    // FastChecker instance models the recreated monitor (both fields null).
    const restarted = createChecker('agent-a', { pct: 5, sessionId: 'sess-new' });
    await (restarted.checker as any).checkContextStatus();

    // The leaked lease must be released by NAME on the new-session bootstrap — not
    // held to the TTL — so downstream queued agents can drain immediately. Under the
    // old release path (gated on the lost in-memory lease id) agent-a would still be
    // active here.
    expect(readState().active.map((entry: any) => entry.agent)).not.toContain('agent-a');
  });

  it('releases a leaked lease by name on a fresh below-threshold session reporting NULL session_id', async () => {
    // The Claude null-session_id edge (the actual F3 case): hook-context-status writes
    // `session_id ?? null`, so a fresh Claude session reports session_id ABSENT/null.
    // The non-null-session_id new-session path never fires, so a lease leaked by the
    // agent's prior session must still be released by name on a below-threshold tick —
    // not held to the 10-min TTL. createChecker omits session_id entirely => null.
    requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: Date.now(), maxConcurrent: 2 });
    expect(readState().active.map((entry: any) => entry.agent)).toContain('agent-a');

    const restarted = createChecker('agent-a', { pct: 5 }); // no sessionId => session_id null
    await (restarted.checker as any).checkContextStatus();

    expect(readState().active.map((entry: any) => entry.agent)).not.toContain('agent-a');
  });

  it('does NOT release a lease the current session legitimately holds (over-release guard)', async () => {
    // Guard against over-release: a lease acquired by THIS live session (ctxHandoffLeaseId
    // set) must never be freed by the by-name cleanup, even though the session reports
    // below-threshold (context_status is reset to 0% right after a Tier-2 acquire). Freeing
    // it would hand the slot to a queued agent while this agent is still mid-handoff.
    const lease = requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: Date.now(), maxConcurrent: 2 });
    expect(lease.status).toBe('acquired');

    const record = createChecker('agent-a', { pct: 5, sessionId: 'sess-1' });
    // Model a monitor that acquired the lease this session: in-memory lease id set, and
    // ctxLastSessionId already this session so the new-session release path stays inert.
    (record.checker as any).ctxHandoffLeaseId = (lease as any).leaseId;
    (record.checker as any).ctxLastSessionId = 'sess-1';
    await (record.checker as any).checkContextStatus();

    expect(readState().active.map((entry: any) => entry.agent)).toContain('agent-a');
  });

  it('releases the dying session lease on a Tier-3 forceContextRestart teardown', async () => {
    // Tier-3 arm of the null-session_id leak: forceContextRestart restarts IN-PROCESS
    // (sessionRefresh does not recreate this FastChecker), so ctxHandoffLeaseId survives
    // into the fresh session and the checkContextStatus by-name cleanup (gated on
    // ctxHandoffLeaseId === null) would never fire for a fresh session reporting
    // session_id:null. The dying session must release its OWN lease on teardown — before
    // the restart spawns the new session — not wait for the 10-min TTL.
    const lease = requestContextHandoffLease({ ctxRoot, agentName: 'agent-a', now: Date.now(), maxConcurrent: 2 });
    expect(lease.status).toBe('acquired');
    expect(readState().active.map((entry: any) => entry.agent)).toContain('agent-a');

    const record = createChecker('agent-a', { pct: 90, sessionId: 'sess-old' });
    // Model the live session that acquired the lease this session.
    (record.checker as any).ctxHandoffLeaseId = (lease as any).leaseId;
    // forceContextRestart releases synchronously, before the async sessionRefresh.
    (record.checker as any).forceContextRestart('ctx 90% — handoff not completed within 5min');

    expect(readState().active.map((entry: any) => entry.agent)).not.toContain('agent-a');
    expect((record.checker as any).ctxHandoffLeaseId).toBeNull();
  });

  function readState(): any {
    return JSON.parse(readFileSync(contextHandoffLeasePath(ctxRoot), 'utf-8'));
  }

  function createChecker(
    agentName: string,
    opts: { pct?: number; sessionId?: string } = {},
  ): { agentName: string; checker: FastChecker; injectMessage: ReturnType<typeof vi.fn> } {
    const stateDir = join(ctxRoot, 'state', agentName);
    const agentDir = join(ctxRoot, 'agents', agentName);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({}), 'utf-8');
    const status: Record<string, unknown> = {
      // Default crosses the handoff threshold (default-ON at 60%) so the herd test
      // fires handoffs without each call having to pass an explicit pct.
      used_percentage: opts.pct ?? 70,
      exceeds_200k_tokens: false,
      written_at: new Date().toISOString(),
    };
    if (opts.sessionId) status.session_id = opts.sessionId;
    writeFileSync(
      join(stateDir, 'context_status.json'),
      JSON.stringify(status),
      'utf-8',
    );
    const injectMessage = vi.fn();
    const agent = {
      name: agentName,
      injectMessage,
      getConfig: () => ({}),
      getAgentDir: () => agentDir,
      getOutputBuffer: () => ({ getRecent: () => '' }),
      sessionRefresh: () => Promise.resolve(),
    } as any;
    const paths: BusPaths = {
      ctxRoot,
      inbox: join(ctxRoot, 'inbox'),
      inflight: join(ctxRoot, 'inflight'),
      processed: join(ctxRoot, 'processed'),
      logDir: join(ctxRoot, 'logs', agentName),
      stateDir,
      taskDir: join(ctxRoot, 'tasks'),
      approvalDir: join(ctxRoot, 'approvals'),
      analyticsDir: join(ctxRoot, 'analytics'),
      heartbeatDir: join(ctxRoot, 'heartbeats'),
    };
    for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
    const checker = new FastChecker(agent, paths, '/tmp/framework', {
      log: () => {},
    });
    return { agentName, checker, injectMessage };
  }

  function handoffPrompts(record: { injectMessage: ReturnType<typeof vi.fn> }): string[] {
    return record.injectMessage.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('[CONTEXT HANDOFF REQUIRED]'));
  }
});
