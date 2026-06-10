/**
 * E2E (sandbox, in-process): two crons scheduled for the SAME minute on one
 * agent must BOTH produce a clean, separately-submitted turn — the #510 / #590
 * "cron collision" acceptance. Drives the REAL CronScheduler firing two
 * same-minute crons, whose onFire calls the REAL injectMessage (#590 fix:
 * resolves only after the deferred ENTER is written) into a capture sink.
 *
 * Collision signature: two PASTE writes with no ENTER between them — the second
 * cron's text lands in the PTY paste buffer before the first cron's ENTER
 * submits, so one ENTER submits the concatenation and a turn is lost.
 *
 * Run from cortextos-build-t3 (= clean main cdd8fc61 + #616 diff).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadCrons = vi.fn();
const mockUpdateCron = vi.fn();
const mockReadCronsWithStatus = vi.fn();
vi.mock('../../src/bus/crons.js', () => ({
  readCrons: (...a: unknown[]) => mockReadCrons(...a),
  readCronsWithStatus: (...a: unknown[]) => mockReadCronsWithStatus(...a),
  updateCron: (...a: unknown[]) => mockUpdateCron(...a),
}));

import { CronScheduler } from '../../src/daemon/cron-scheduler';
import { injectMessage, KEYS } from '../../src/pty/inject';
import type { CronDefinition } from '../../src/types/index';

const A = 'CRON_A_PAYLOAD';
const B = 'CRON_B_PAYLOAD';
const ENTER_DELAY = 50;
const TICK = CronScheduler.TICK_INTERVAL_MS;

type Ev = { kind: 'paste'; cron: 'A' | 'B' | '?' } | { kind: 'enter' };

function classify(data: string): Ev {
  if (data === KEYS.ENTER) return { kind: 'enter' };
  if (data.includes(A)) return { kind: 'paste', cron: 'A' };
  if (data.includes(B)) return { kind: 'paste', cron: 'B' };
  return { kind: 'paste', cron: '?' }; // PASTE_START/END framing writes — treat as paste-fragment
}

/** The collision check: no two PASTE-of-distinct-content writes without an ENTER between. */
function hasCollision(events: Ev[]): boolean {
  let pendingPaste = false;
  for (const e of events) {
    if (e.kind === 'paste' && e.cron !== '?') {
      if (pendingPaste) return true; // a second real paste before an ENTER submitted the first
      pendingPaste = true;
    } else if (e.kind === 'enter') {
      pendingPaste = false;
    }
  }
  return false;
}

function makeCron(o: Partial<CronDefinition>): CronDefinition {
  return { name: 'c', prompt: 'p', schedule: '1m', enabled: true, created_at: new Date().toISOString(), ...o };
}

describe('#510/#590 E2E — two same-minute crons both submit cleanly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReadCrons.mockReset();
    mockUpdateCron.mockReset();
    mockReadCronsWithStatus.mockReset();
    mockReadCronsWithStatus.mockImplementation((agent: string) => ({ crons: mockReadCrons(agent) ?? [], corrupt: false }));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('REAL injectMessage (#590): both crons produce a separate PASTE+ENTER — no collision', async () => {
    const events: Ev[] = [];
    const write = (d: string) => { events.push(classify(d)); };

    mockReadCrons.mockReturnValue([
      makeCron({ name: 'cron-a', prompt: A, schedule: '1m' }),
      makeCron({ name: 'cron-b', prompt: B, schedule: '1m' }),
    ]);

    const scheduler = new CronScheduler({
      agentName: 'agent-x',
      onFire: async (cron) => { await injectMessage(write, cron.prompt, ENTER_DELAY); },
      logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000 + TICK + ENTER_DELAY * 4 + 1_000);
    scheduler.stop();

    const pastesA = events.filter(e => e.kind === 'paste' && e.cron === 'A').length;
    const pastesB = events.filter(e => e.kind === 'paste' && e.cron === 'B').length;
    const enters = events.filter(e => e.kind === 'enter').length;

    expect(pastesA).toBeGreaterThanOrEqual(1);   // cron A submitted at least one turn
    expect(pastesB).toBeGreaterThanOrEqual(1);   // cron B submitted at least one turn
    expect(enters).toBeGreaterThanOrEqual(2);    // each got its own ENTER
    expect(hasCollision(events)).toBe(false);    // ← the #510 guarantee: never two pastes before an ENTER
  });

  it('CONTRAST — a pre-#590 inject (resolves before its ENTER) DOES collide (proves the harness detects it)', async () => {
    const events: Ev[] = [];
    const write = (d: string) => { events.push(classify(d)); };

    // Simulates the old behaviour: PASTE now, ENTER deferred but NOT awaited, resolve immediately.
    const buggyInject = (w: (d: string) => void, content: string, delay: number): Promise<boolean> => {
      w(`\x1b[200~${content}\x1b[201~`);
      setTimeout(() => { try { w(KEYS.ENTER); } catch { /* ignore */ } }, delay);
      return Promise.resolve(true); // resolves BEFORE the ENTER — the bug
    };

    mockReadCrons.mockReturnValue([
      makeCron({ name: 'cron-a', prompt: A, schedule: '1m' }),
      makeCron({ name: 'cron-b', prompt: B, schedule: '1m' }),
    ]);

    const scheduler = new CronScheduler({
      agentName: 'agent-x',
      onFire: async (cron) => { await buggyInject(write, cron.prompt, ENTER_DELAY); },
      logger: () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000 + TICK + ENTER_DELAY * 4 + 1_000);
    scheduler.stop();

    expect(hasCollision(events)).toBe(true); // both PASTEs land before either ENTER → collision
  });

  it('torn-down PTY mid-inject: injectMessage reports submit failure (false), not silent success', async () => {
    // The PTY is torn down during the enterDelay window: the ENTER write throws.
    const write = (d: string) => {
      if (d === KEYS.ENTER) throw new Error('pty torn down during enter');
    };
    const ok = await (async () => {
      const p = injectMessage(write, 'msg-after-teardown', ENTER_DELAY);
      await vi.advanceTimersByTimeAsync(ENTER_DELAY + 10);
      return p;
    })();
    expect(ok).toBe(false); // submit failure surfaced → cron retry can fire, no false success
  });
});
