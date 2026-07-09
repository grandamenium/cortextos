import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index.js';

// Mock the PTY/Telegram layers — same shape as agent-manager-inspect-op.test.ts
// so AgentManager constructs without spawning anything real.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));
vi.mock('../../../src/daemon/cron-execution-log.js', () => ({
  appendExecutionLog: vi.fn(),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { appendExecutionLog } = await import('../../../src/daemon/cron-execution-log.js');

function makeManager() {
  const testDir = mkdtempSync(join(tmpdir(), 'coalesce-test-'));
  const manager = new AgentManager('test-instance', testDir, testDir, 'testorg');
  return { manager, testDir };
}

const recurringCron = (name: string): CronDefinition =>
  ({ name, prompt: `run ${name}`, schedule: '15m', enabled: true } as CronDefinition);
const onceCron = (name: string): CronDefinition =>
  ({ name, prompt: `run ${name}`, schedule: '', enabled: true, fire_at: '2026-07-09T10:23:00Z' } as CronDefinition);

describe('AgentManager cron coalescing', () => {
  let testDir: string;
  let manager: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    ({ manager, testDir } = makeManager());
    vi.mocked(appendExecutionLog).mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('shouldQueueCronFire', () => {
    it('is false by default (no detector wired) — behavior identical to current', () => {
      expect(manager.shouldQueueCronFire(recurringCron('heartbeat'))).toBe(false);
    });

    it('is true for recurring crons while the sleep window is open', () => {
      manager.setSleepWindowPredicate(() => true);
      expect(manager.shouldQueueCronFire(recurringCron('heartbeat'))).toBe(true);
    });

    it('is always false for one-shot (fire_at) crons', () => {
      manager.setSleepWindowPredicate(() => true);
      expect(manager.shouldQueueCronFire(onceCron('remind-user'))).toBe(false);
    });

    it('treats a throwing predicate as "not in a window"', () => {
      manager.setSleepWindowPredicate(() => { throw new Error('detector broken'); });
      expect(manager.shouldQueueCronFire(recurringCron('heartbeat'))).toBe(false);
    });
  });

  describe('drainCoalescedCronFires', () => {
    it('is a no-op with an empty queue', async () => {
      const inject = vi.spyOn(manager, 'injectAgent').mockReturnValue(true);
      await manager.drainCoalescedCronFires();
      expect(inject).not.toHaveBeenCalled();
    });

    it('collapses same-named fires into ONE injection with count and span; distinct names stay separate', async () => {
      const inject = vi.spyOn(manager, 'injectAgent').mockReturnValue(true);
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T11:05:00Z');
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T11:20:00Z');
      manager.queueCronFireForCoalescing('kirk', 'heartbeat', 'do heartbeat', '2026-07-09T12:00:00Z');

      await manager.drainCoalescedCronFires();

      expect(inject).toHaveBeenCalledTimes(2);
      const texts = inject.mock.calls.map(c => c[1]);
      const vipText = texts.find(t => t.includes('vip-scan'))!;
      expect(vipText).toContain('[CRON FIRED 2026-07-09T11:20:00Z] vip-scan: scan vips');
      expect(vipText).toContain('coalesced: 3 fires');
      expect(vipText).toContain('between 2026-07-09T10:50:00Z and 2026-07-09T11:20:00Z');
      expect(vipText).toContain('handle ONCE');
      const hbText = texts.find(t => t.includes('heartbeat'))!;
      // single fire → byte-identical to the normal direct format, no coalesce note
      expect(hbText).toBe('[CRON FIRED 2026-07-09T12:00:00Z] heartbeat: do heartbeat');
    });

    it('logs a coalesced execution-log entry for each collapsed fire, none for the delivered one', async () => {
      vi.spyOn(manager, 'injectAgent').mockReturnValue(true);
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T11:05:00Z');
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T11:20:00Z');

      await manager.drainCoalescedCronFires();

      const coalesced = vi.mocked(appendExecutionLog).mock.calls
        .filter(c => c[1].status === 'coalesced');
      expect(coalesced).toHaveLength(2); // 3 fires → 2 collapsed + 1 delivered
      expect(coalesced[0][0]).toBe('kirk');
      expect(coalesced[0][1].error).toContain('queued at 2026-07-09T10:50:00Z');
      expect(coalesced[0][1].error).toContain('coalesced into delivery of 2026-07-09T11:20:00Z');
    });

    it('clears the queue: a second drain injects nothing', async () => {
      const inject = vi.spyOn(manager, 'injectAgent').mockReturnValue(true);
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');
      await manager.drainCoalescedCronFires();
      inject.mockClear();
      await manager.drainCoalescedCronFires();
      expect(inject).not.toHaveBeenCalled();
    });

    it('drains queues for multiple agents independently', async () => {
      const inject = vi.spyOn(manager, 'injectAgent').mockReturnValue(true);
      manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');
      manager.queueCronFireForCoalescing('scotty', 'file-drop-monitor', 'check drops', '2026-07-09T11:07:00Z');
      await manager.drainCoalescedCronFires();
      const agents = inject.mock.calls.map(c => c[0]);
      expect(agents).toContain('kirk');
      expect(agents).toContain('scotty');
    });

    it('retries failed injection with backoff, then logs a failed entry', async () => {
      vi.useFakeTimers();
      try {
        const inject = vi.spyOn(manager, 'injectAgent').mockReturnValue(false);
        manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');

        const drain = manager.drainCoalescedCronFires();
        await vi.advanceTimersByTimeAsync(1_000 + 4_000 + 16_000);
        await drain;

        expect(inject).toHaveBeenCalledTimes(4); // initial + 3 retries
        const failed = vi.mocked(appendExecutionLog).mock.calls
          .filter(c => c[1].status === 'failed');
        expect(failed).toHaveLength(1);
        expect(failed[0][1].error).toContain('next scheduled fire covers it');
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers when a retry succeeds mid-backoff', async () => {
      vi.useFakeTimers();
      try {
        const inject = vi.spyOn(manager, 'injectAgent')
          .mockReturnValueOnce(false)
          .mockReturnValue(true);
        manager.queueCronFireForCoalescing('kirk', 'vip-scan', 'scan vips', '2026-07-09T10:50:00Z');

        const drain = manager.drainCoalescedCronFires();
        await vi.advanceTimersByTimeAsync(1_000);
        await drain;

        expect(inject).toHaveBeenCalledTimes(2);
        const failed = vi.mocked(appendExecutionLog).mock.calls
          .filter(c => c[1].status === 'failed');
        expect(failed).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
