import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../src/bus/heartbeat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateHeartbeat: vi.fn(),
}));
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import { AgentProcess } from '../../../src/daemon/agent-process';
import { sendMessage, checkInbox, listDeferredMarkers, readDeferredMarker } from '../../../src/bus/message';
import type { BusPaths, CtxEnv, AgentConfig } from '../../../src/types';

/**
 * ACKFIX regression spec (ACKFIX_REQUIREMENTS.md, 2026-07-10) — daemon half:
 *   G-REG-3  busy-session injection → DEFERRED_CONFIRM; confirm on flag advance
 *            + payload attribution; acked; NO redelivery
 *   G-REG-4  dead session (no flag advance) → hold times out → dedup forgotten,
 *            markers cleared, message released to recovery
 *   G-REG-5  flag-less / legacy-format sessions keep the legacy path
 *   G-REG-6  multi-injection flush: per-payload attribution; an untracked
 *            cron-source paste neither confirms nor blocks tracked holds
 */

function createTestPaths(testDir: string, agent = 'bob'): BusPaths {
  const paths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  } as unknown as BusPaths;
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir as string, { recursive: true });
  }
  return paths;
}

/** Mock AgentProcess exposing exactly the surface the deferral tracker uses. */
function createMockAgent(name = 'bob') {
  return {
    name,
    org: 'test-org',
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    promptFlagMtimeMs: vi.fn().mockReturnValue(0),
    submittedPromptContains: vi.fn().mockReturnValue(false),
    forgetDedup: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('DEFERRED_CONFIRM tracker (fast-checker)', () => {
  let testDir: string;
  let paths: BusPaths;
  let senderPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-deferred-test-'));
    paths = createTestPaths(testDir, 'bob');
    senderPaths = createTestPaths(testDir, 'alice');
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function deliverToInflight(text: string): string {
    const id = sendMessage(senderPaths, 'alice', 'bob', 'normal', text);
    checkInbox(paths); // moves to bob's inflight
    return id;
  }

  it('G-REG-3: deferred hold confirms on flag advance + attribution, acks, leaves nothing to redeliver', () => {
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
    const id = deliverToInflight('hello from alice');
    const injectedAt = Date.now() - 30_000;
    const block = `=== AGENT MESSAGE ... ${id} ===\nhello from alice`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).registerDeferredHold([id], block, {
      injectedAt, deadline: injectedAt + 600_000, contentSha: 'f'.repeat(64),
    });
    expect(listDeferredMarkers(paths.inflight)).toHaveLength(1);

    // Turn boundary: flag advances AND the flushed prompt contains the block.
    agent.promptFlagMtimeMs.mockReturnValue(Date.now());
    agent.submittedPromptContains.mockImplementation((c: string) => c === block);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).checkDeferredHolds();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((checker as any).deferredHolds).toHaveLength(0);
    expect(readdirSync(paths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0); // acked
    expect(listDeferredMarkers(paths.inflight)).toHaveLength(0); // marker gone with ack
    expect(checkInbox(paths)).toHaveLength(0); // nothing redelivers
    expect(agent.forgetDedup).not.toHaveBeenCalled(); // confirm path keeps dedup state
  });

  it('G-REG-4: hold times out with no flag advance → dedup forgotten, marker cleared, recovery redelivers', () => {
    const agent = createMockAgent(); // flag never advances (dead / wedged session)
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
    const id = deliverToInflight('doomed payload');
    const injectedAt = Date.now() - 700_000;
    const block = `block containing ${id}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).registerDeferredHold([id], block, {
      injectedAt, deadline: injectedAt + 600_000, contentSha: '9'.repeat(64), // already expired
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).checkDeferredHolds();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((checker as any).deferredHolds).toHaveLength(0);
    expect(agent.forgetDedup).toHaveBeenCalledWith(block); // G-D2-5: ALL dedup state for the block
    expect(listDeferredMarkers(paths.inflight)).toHaveLength(0);
    // File still in inflight but unmarked: after it goes stale the normal sweep redelivers it.
    expect(readdirSync(paths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('G-REG-6: multi-injection flush — each hold confirms by ITS OWN payload; untracked cron paste neither confirms nor blocks', () => {
    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
    const idA = deliverToInflight('payload A');
    const idB = deliverToInflight('payload B');
    const blockA = `block-A ${idA}`;
    const blockB = `block-B ${idB}`;
    const cronPaste = '[CRON FIRED] vip-scan-priority: untracked legacy-path paste';
    const t0 = Date.now() - 10_000;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).registerDeferredHold([idA], blockA, { injectedAt: t0, deadline: t0 + 600_000, contentSha: '1'.repeat(64) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).registerDeferredHold([idB], blockB, { injectedAt: t0, deadline: t0 + 600_000, contentSha: '2'.repeat(64) });

    // Turn boundary flushes blockA + the cron paste, but NOT blockB.
    const flushed = `${blockA}\n${cronPaste}`;
    agent.promptFlagMtimeMs.mockReturnValue(Date.now());
    agent.submittedPromptContains.mockImplementation((c: string) => flushed.includes(c));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).checkDeferredHolds();

    // A confirmed+acked; B still held (no first-flag-wins); cron paste changed nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const holds = (checker as any).deferredHolds as Array<{ ackIds: string[] }>;
    expect(holds).toHaveLength(1);
    expect(holds[0].ackIds).toEqual([idB]);
    expect(listDeferredMarkers(paths.inflight)).toHaveLength(1);

    // Next boundary flushes blockB — B confirms independently.
    const flushed2 = `${blockB}`;
    agent.submittedPromptContains.mockImplementation((c: string) => flushed2.includes(c));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker as any).checkDeferredHolds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((checker as any).deferredHolds).toHaveLength(0);
    expect(readdirSync(paths.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('G-D2-7: rebuildDeferredHolds restores holds from markers with the ORIGINAL deadline', () => {
    const agent = createMockAgent();
    const id = deliverToInflight('restart survivor');
    const injectedAt = Date.now() - 120_000;
    const deadline = injectedAt + 600_000;
    {
      const checker = new FastChecker(agent, paths, '/tmp/framework', { log: () => {} });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (checker as any).registerDeferredHold([id], 'surviving block', {
        injectedAt, deadline, contentSha: '3'.repeat(64),
      });
    } // daemon "dies" — in-memory hold lost, marker remains

    const checker2 = new FastChecker(createMockAgent(), paths, '/tmp/framework', { log: () => {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (checker2 as any).rebuildDeferredHolds();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const holds = (checker2 as any).deferredHolds as Array<{ ackIds: string[]; deadline: number; injectedAt: number; content: string }>;
    expect(holds).toHaveLength(1);
    expect(holds[0].ackIds).toEqual([id]);
    expect(holds[0].deadline).toBe(deadline);       // never refreshed on restart
    expect(holds[0].injectedAt).toBe(injectedAt);
    expect(holds[0].content).toBe('surviving block'); // attribution check resumes
  });
});

describe('G-REG-5: flag-less / legacy-format fallback (AgentProcess predicate)', () => {
  let testDir: string;

  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'cortextos-flagless-test-')); });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function makeAgent(name: string): AgentProcess {
    const env = { ctxRoot: testDir, org: 'test-org', instanceId: 'test' } as unknown as CtxEnv;
    const config = {} as AgentConfig;
    return new AgentProcess(name, env, config, () => {});
  }

  it('no flag file at all → promptFlagInfo reports no channel (legacy 28s path preserved)', () => {
    const agent = makeAgent('flagless');
    expect(agent.promptFlagInfo()).toEqual({ mtimeMs: 0, sha256: null, hashCapable: false });
  });

  it('legacy plain-integer flag content → hashCapable=false (mtime-only confirmation)', () => {
    const agent = makeAgent('oldhook');
    const stateDir = join(testDir, 'state', 'oldhook');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_prompt.flag'), '1783691952', 'utf-8');
    const info = agent.promptFlagInfo();
    expect(info.hashCapable).toBe(false);
    expect(info.mtimeMs).toBeGreaterThan(0);
  });

  it('JSON flag content → hashCapable=true with the stamped sha', () => {
    const agent = makeAgent('newhook');
    const stateDir = join(testDir, 'state', 'newhook');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_prompt.flag'), JSON.stringify({ ts: 1783691952, sha256: 'ab'.repeat(32), len: 10 }), 'utf-8');
    const info = agent.promptFlagInfo();
    expect(info.hashCapable).toBe(true);
    expect(info.sha256).toBe('ab'.repeat(32));
  });

  it('submittedPromptContains matches per-payload against last_prompt.txt', () => {
    const agent = makeAgent('attrib');
    const stateDir = join(testDir, 'state', 'attrib');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'last_prompt.txt'), 'flushed turn: block-A plus [CRON] noise', 'utf-8');
    expect(agent.submittedPromptContains('block-A')).toBe(true);
    expect(agent.submittedPromptContains('block-B')).toBe(false);
  });

  it('missing last_prompt.txt → attribution is simply false (no throw)', () => {
    const agent = makeAgent('notxt');
    expect(agent.submittedPromptContains('anything')).toBe(false);
  });
});
