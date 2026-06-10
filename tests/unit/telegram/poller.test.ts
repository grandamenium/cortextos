import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller, planPollError } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });
});

describe('TelegramPoller — long-poll window (A:F-08, #6.1)', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-lp-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  it('calls getUpdates with a 25s long-poll window, not the old 1s short-poll', async () => {
    const seen: Array<[number, number | undefined]> = [];
    const api = {
      getUpdates: vi.fn(async (offset: number, timeout?: number) => {
        seen.push([offset, timeout]);
        return { result: [] };
      }),
    } as unknown as TelegramAPI;

    const poller = new TelegramPoller(api, stateDir);
    await poller.pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(25); // long-poll seconds — the 25x idle-traffic cut
  });
});

describe('planPollError — poll-error split (C#1, #6.3)', () => {
  it('409 Conflict → self-die (supervisor retakes the lock)', () => {
    expect(planPollError('Telegram API error: Conflict: terminated by other getUpdates', 0))
      .toEqual({ type: 'conflict' });
  });

  it('429 → honours the "retry after N" value Telegram sends and resets the network streak', () => {
    const plan = planPollError('Telegram API error: Too Many Requests: retry after 7', 3);
    expect(plan).toEqual({ type: 'rate-limit', delayMs: 7000, nextNetFailures: 0 });
  });

  it('429 without a parseable N falls back to a 1s floor', () => {
    const plan = planPollError('Telegram API error: Too Many Requests', 0);
    expect(plan).toEqual({ type: 'rate-limit', delayMs: 1000, nextNetFailures: 0 });
  });

  it('network error → exponential backoff base*2^(n-1), capped at 60s', () => {
    expect(planPollError('Telegram API request failed: fetch failed', 0))
      .toMatchObject({ type: 'network', delayMs: 1000, nextNetFailures: 1, circuitTripped: false });
    expect(planPollError('Telegram API request failed: fetch failed', 1))
      .toMatchObject({ type: 'network', delayMs: 2000, nextNetFailures: 2 });
    expect(planPollError('Telegram API request failed: fetch failed', 2))
      .toMatchObject({ type: 'network', delayMs: 4000, nextNetFailures: 3 });
    // base*2^9 = 512000 → capped
    expect(planPollError('Telegram API request timed out after 30s: getUpdates', 9))
      .toMatchObject({ type: 'network', delayMs: 60000, nextNetFailures: 10 });
  });

  it('trips the circuit-breaker flag at exactly the 5th consecutive network failure', () => {
    expect(planPollError('fetch failed', 3).type).toBe('network');
    expect((planPollError('fetch failed', 3) as { circuitTripped: boolean }).circuitTripped).toBe(false);
    expect((planPollError('fetch failed', 4) as { circuitTripped: boolean }).circuitTripped).toBe(true); // 5th
    expect((planPollError('fetch failed', 5) as { circuitTripped: boolean }).circuitTripped).toBe(false);
  });

  it('a timed-out long-poll is treated as a network failure, not a rate-limit', () => {
    expect(planPollError('Telegram API request timed out after 30s: getUpdates', 0).type).toBe('network');
  });
});
