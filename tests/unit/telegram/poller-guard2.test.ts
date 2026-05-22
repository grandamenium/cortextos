import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';

/**
 * Guard #2 — in-process comms-liveness detector (analyst eve-review §4).
 * Drives the real start() loop under fake timers so backoff, the degraded
 * marker, the recovery callbacks and the in-process restart are exercised
 * end-to-end deterministically (no real network, no real wall-clock wait).
 */
describe('TelegramPoller — Guard #2 comms-liveness', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-g2-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it(
    'escalates: backoff → degraded marker+callback → in-process restart → recovery',
    { timeout: 20_000 },
    async () => {
      let calls = 0;
      const failUntil = 8; // calls 1..8 fail, call 9 succeeds
      const recreated: number[] = [];
      const makeApi = () =>
        ({
          getUpdates: vi.fn(async () => {
            calls += 1;
            if (calls <= failUntil) {
              throw new Error('Telegram API request failed: fetch failed');
            }
            return { result: [] }; // success, no updates
          }),
        } as unknown as TelegramAPI);

      const degraded: Array<Record<string, unknown>> = [];
      const recovered: Array<Record<string, unknown>> = [];
      const poller = new TelegramPoller(makeApi(), stateDir, 1000, undefined, {
        recreateApi: () => {
          recreated.push(calls);
          return makeApi();
        },
        onCommsDegraded: (i) => degraded.push(i as unknown as Record<string, unknown>),
        onCommsRecovered: (i) => recovered.push(i as unknown as Record<string, unknown>),
      });

      const marker = join(stateDir, '.comms-degraded');
      const runP = poller.start();

      // Cumulative backoff to the 9th call ≈ 1+2+4+8+16+32+60+60 = 183s.
      await vi.advanceTimersByTimeAsync(200_000);
      poller.stop();
      await vi.advanceTimersByTimeAsync(60_000); // flush the in-flight sleep
      await runP;

      // (iii) degraded fired exactly once, at the 5th consecutive failure.
      expect(degraded.length).toBe(1);
      expect(degraded[0].consecutiveFailures).toBe(5);
      expect(degraded[0].lastErrorClass).toBe('network');
      // (ii) in-process restart attempted (recreateApi) at/after the 7th failure.
      expect(recreated.length).toBeGreaterThanOrEqual(1);
      // (iii) recovery fired once and the marker was cleared on recovery.
      expect(recovered.length).toBe(1);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it(
    'writes a stable, relay-consumable marker schema while degraded',
    { timeout: 20_000 },
    async () => {
      const api = {
        getUpdates: vi.fn(async () => {
          throw new Error('Telegram API error: Too Many Requests: retry after 30');
        }),
      } as unknown as TelegramAPI;
      const poller = new TelegramPoller(api, stateDir, 1000, undefined, {
        onCommsDegraded: () => {},
      });

      const marker = join(stateDir, '.comms-degraded');
      const runP = poller.start();
      await vi.advanceTimersByTimeAsync(40_000); // ~5 failures (1+2+4+8+16=31s)
      poller.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await runP;

      expect(existsSync(marker)).toBe(true);
      const m = JSON.parse(readFileSync(marker, 'utf-8'));
      // Required fields a relay can rely on:
      expect(m.schema_version).toBe(1);
      expect(m.state).toBe('degraded');
      expect(typeof m.since).toBe('string');
      expect(m.consecutive_failures).toBeGreaterThanOrEqual(5);
      expect('last_ok' in m).toBe(true); // null is acceptable (no success yet)
      expect(typeof m.updated).toBe('string');
      // Context extra: AM-class correctly classified.
      expect(m.last_error_class).toBe('rate_limit');
    },
  );

  it(
    'non-comms-managed poller (no opts, e.g. activity channel) writes NO marker',
    { timeout: 20_000 },
    async () => {
      const api = {
        getUpdates: vi.fn(async () => {
          throw new Error('Telegram API request failed: fetch failed');
        }),
      } as unknown as TelegramAPI;
      const poller = new TelegramPoller(api, stateDir); // no opts → backoff only
      const runP = poller.start();
      await vi.advanceTimersByTimeAsync(120_000);
      poller.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await runP;

      expect(existsSync(join(stateDir, '.comms-degraded'))).toBe(false);
    },
  );

  it(
    'Hole A: window-based detection fires even when consecutiveFailures resets on each flap',
    { timeout: 20_000 },
    async () => {
      // Alternating fail → empty-success → fail → empty-success ...
      // consecutiveFailures resets to 0 on every empty-success, so it never
      // exceeds 1. The sliding window accumulates all failures regardless.
      let callCount = 0;
      const api = {
        getUpdates: vi.fn(async () => {
          callCount++;
          if (callCount % 2 === 1) {
            throw new Error('Telegram API request failed: fetch failed');
          }
          return { result: [] }; // empty success — resets consecutiveFailures
        }),
      } as unknown as TelegramAPI;

      const degraded: Array<Record<string, unknown>> = [];
      const poller = new TelegramPoller(api, stateDir, 1_000, undefined, {
        onCommsDegraded: (i) => degraded.push(i as unknown as Record<string, unknown>),
      });

      const runP = poller.start();
      // Each alternating pair takes ~2s (1s backoff + 1s success sleep).
      // 5 failures need 9 calls ≈ 9s. Advance 15s for headroom.
      await vi.advanceTimersByTimeAsync(15_000);
      poller.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      await runP;

      // DEGRADED must fire exactly once — window accumulated 5 failures even
      // though consecutiveFailures never exceeded 1.
      expect(degraded.length).toBe(1);
      expect(degraded[0].consecutiveFailures).toBe(1); // always 1 (flapping reset)
      expect(degraded[0].windowFailures).toBeGreaterThanOrEqual(5);
    },
  );

  it(
    'Hole B: watchdog fires degraded marker when the poll loop stalls',
    { timeout: 20_000 },
    async () => {
      // getUpdates hangs for 5s (fake time) — longer than the watchdog stall
      // threshold so the watchdog fires before the poll resolves.
      const api = {
        getUpdates: vi.fn(
          () => new Promise<{ result: unknown[] }>(resolve => {
            setTimeout(() => resolve({ result: [] }), 5_000);
          }),
        ),
      } as unknown as TelegramAPI;

      const degraded: Array<Record<string, unknown>> = [];
      const marker = join(stateDir, '.comms-degraded');
      const poller = new TelegramPoller(api, stateDir, 1_000, undefined, {
        onCommsDegraded: (i) => degraded.push(i as unknown as Record<string, unknown>),
        // Small values so the test completes quickly under fake timers.
        watchdog: { checkMs: 200, stallMs: 500 },
      });

      const runP = poller.start();

      // Advance far enough for the watchdog to tick past the stall threshold
      // (checkMs=200 → checks at 200, 400, 600 ms; stall fires at 600ms)
      // but NOT past the getUpdates sleep (5000ms) so the marker is still there.
      await vi.advanceTimersByTimeAsync(800);

      expect(existsSync(marker)).toBe(true);
      expect(degraded.length).toBe(1);
      expect(degraded[0].lastError).toMatch(/stall/i);

      // Cleanup: advance past the getUpdates sleep, then stop.
      await vi.advanceTimersByTimeAsync(5_000);
      poller.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await runP;
    },
  );
});
