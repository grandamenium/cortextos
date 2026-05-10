/**
 * Integration-shape test for BL-2026-05-10-001 wiring.
 *
 * Drives a real TelegramPoller with the same observer + onMessage pattern
 * agent-manager.ts uses and asserts on the on-disk artifacts the
 * production diagnostic consumer reads (filtered-inbound.jsonl and
 * telegram-updates-YYYY-MM-DD.jsonl). Per .claude/rules/code-quality/
 * integration-artifact-tests.md — tests must read what the consumer
 * reads, not what the writer's internal state shows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { TelegramPoller } from '../../../src/telegram/poller';
import {
  recordRawTelegramUpdate,
  recordFilteredInbound,
} from '../../../src/telegram/logging';
import { shouldForwardMessage, type BotIdentity } from '../../../src/telegram/filter';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramMessage, TelegramUpdate } from '../../../src/types/index';

const BOT: BotIdentity = { id: 1234, username: 'sb_fullstack_bot' };

function stubApi(updates: TelegramUpdate[]): TelegramAPI {
  return {
    getUpdates: vi.fn(async (offset: number) => ({
      result: updates.filter((u) => u.update_id >= offset),
    })),
  } as unknown as TelegramAPI;
}

/**
 * Replicate the agent-manager wiring shape in a self-contained closure
 * so the test can drive it without spinning up the whole daemon.
 *
 * Shape mirrors src/daemon/agent-manager.ts (BL-001 wiring):
 *   - poller constructed with onRawUpdate observer that calls
 *     recordRawTelegramUpdate
 *   - onMessage runs the ALLOWED_USER gate (skipped here for brevity),
 *     then shouldForwardMessage; on drop calls recordFilteredInbound and
 *     returns; on pass falls through to the agent-side handling
 */
function wireUpPoller(opts: {
  api: TelegramAPI;
  stateDir: string;
  ctxRoot: string;
  agentName: string;
  botIdentity: BotIdentity | null;
  forwarded: TelegramMessage[];
}): TelegramPoller {
  const poller = new TelegramPoller(
    opts.api,
    opts.stateDir,
    1000,
    undefined,
    (update) => recordRawTelegramUpdate(opts.ctxRoot, opts.agentName, update),
  );

  poller.onMessage((msg) => {
    if (opts.botIdentity) {
      const decision = shouldForwardMessage(msg, opts.botIdentity);
      if (!decision.forward) {
        recordFilteredInbound(opts.ctxRoot, opts.agentName, msg, decision.reason);
        return;
      }
    }
    opts.forwarded.push(msg);
  });

  return poller;
}

describe('mention-only filter wire-up (agent-manager Phase 2 shape)', () => {
  let testDir: string;
  let ctxRoot: string;
  let stateDir: string;
  const agentName = 'fullstack';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-wire-'));
    ctxRoot = join(testDir, 'instance');
    stateDir = join(ctxRoot, 'state', agentName);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function filteredInboundPath() {
    return join(ctxRoot, 'logs', agentName, 'filtered-inbound.jsonl');
  }

  function rawUpdatesPath() {
    const today = new Date().toISOString().slice(0, 10);
    return join(ctxRoot, 'logs', agentName, `telegram-updates-${today}.jsonl`);
  }

  it('drops a non-mentioning supergroup message and writes filtered-inbound.jsonl', async () => {
    const groupNoise: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        chat: { id: -1001234, type: 'supergroup' },
        from: { id: 999, first_name: 'Alice' },
        text: 'random group chatter',
      },
    };

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi([groupNoise]),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: BOT,
      forwarded,
    });

    await poller.pollOnce();

    expect(forwarded).toEqual([]);

    const entries = readFileSync(filteredInboundPath(), 'utf-8').trim().split('\n');
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0]);
    expect(entry.filter_reason).toBe('no_mention');
    expect(entry.message_id).toBe(100);
    expect(entry.chat_id).toBe(-1001234);
    expect(entry.chat_type).toBe('supergroup');
  });

  it('drops a service-message storm with reason=service_message', async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 10,
        message: {
          message_id: 1,
          chat: { id: -1001234, type: 'supergroup' },
          ...({ migrate_to_chat_id: -1009999 } as Partial<TelegramMessage>),
        },
      },
      {
        update_id: 11,
        message: {
          message_id: 2,
          chat: { id: -1009999, type: 'supergroup' },
          ...({
            new_chat_members: [{ id: BOT.id, first_name: 'fullstack' }],
          } as Partial<TelegramMessage>),
        },
      },
      {
        update_id: 12,
        message: {
          message_id: 3,
          chat: { id: -1009999, type: 'supergroup' },
          ...({ pinned_message: { message_id: 99 } } as Partial<TelegramMessage>),
        },
      },
    ];

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi(updates),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: BOT,
      forwarded,
    });

    await poller.pollOnce();

    expect(forwarded).toEqual([]);
    const entries = readFileSync(filteredInboundPath(), 'utf-8').trim().split('\n');
    expect(entries).toHaveLength(3);
    for (const line of entries) {
      expect(JSON.parse(line).filter_reason).toBe('service_message');
    }
  });

  it('forwards a DM unchanged and does NOT touch filtered-inbound.jsonl', async () => {
    const dm: TelegramUpdate = {
      update_id: 20,
      message: {
        message_id: 200,
        chat: { id: 999, type: 'private' },
        from: { id: 999, first_name: 'Saurav' },
        text: 'hey',
      },
    };

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi([dm]),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: BOT,
      forwarded,
    });

    await poller.pollOnce();

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].text).toBe('hey');
    expect(existsSync(filteredInboundPath())).toBe(false);
  });

  it('forwards a supergroup message that @-mentions the bot', async () => {
    const text = '@sb_fullstack_bot please look';
    const update: TelegramUpdate = {
      update_id: 30,
      message: {
        message_id: 300,
        chat: { id: -1001234, type: 'supergroup' },
        from: { id: 999, first_name: 'Saurav' },
        text,
        entities: [{ type: 'mention', offset: 0, length: 17 }],
      },
    };

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi([update]),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: BOT,
      forwarded,
    });

    await poller.pollOnce();

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].message_id).toBe(300);
    expect(existsSync(filteredInboundPath())).toBe(false);
  });

  it('fails OPEN when botIdentity is null — every message forwards untouched', async () => {
    // Mirrors the boot-time getMe-failure path: botIdentityRef.current
    // stays null until a later refresh succeeds. While null, the filter
    // is bypassed entirely — better to over-forward than silently drop
    // legitimate traffic.
    const groupNoise: TelegramUpdate = {
      update_id: 40,
      message: {
        message_id: 400,
        chat: { id: -1001234, type: 'supergroup' },
        text: 'normally we would drop this',
      },
    };

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi([groupNoise]),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: null,
      forwarded,
    });

    await poller.pollOnce();

    expect(forwarded).toHaveLength(1);
    expect(existsSync(filteredInboundPath())).toBe(false);
  });

  it('writes raw-update archive for EVERY update, including filtered ones', async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 50,
        message: {
          message_id: 1,
          chat: { id: -1, type: 'supergroup' },
          text: 'noise', // will be filtered
        },
      },
      {
        update_id: 51,
        message: {
          message_id: 2,
          chat: { id: 999, type: 'private' },
          text: 'dm pass',
        },
      },
      {
        update_id: 52,
        message: {
          message_id: 3,
          chat: { id: -1, type: 'supergroup' },
          ...({ new_chat_title: 'renamed' } as Partial<TelegramMessage>),
        },
      },
    ];

    const forwarded: TelegramMessage[] = [];
    const poller = wireUpPoller({
      api: stubApi(updates),
      stateDir,
      ctxRoot,
      agentName,
      botIdentity: BOT,
      forwarded,
    });

    await poller.pollOnce();

    // 1 forward (DM), 2 filtered (group noise + service msg)
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].message_id).toBe(2);

    // Raw archive captures all three regardless of filter outcome.
    const rawLines = readFileSync(rawUpdatesPath(), 'utf-8').trim().split('\n');
    expect(rawLines).toHaveLength(3);
    const ids = rawLines.map((l) => JSON.parse(l).update_id);
    expect(ids).toEqual([50, 51, 52]);
  });

  it('still archives raw updates when an onMessage handler throws', async () => {
    // Defensive: the raw-update observer fires before message handlers
    // and is independent of handler success — diagnostic capture is
    // load-bearing for "what did Telegram send us when X happened?"
    // post-mortems.
    const update: TelegramUpdate = {
      update_id: 60,
      message: {
        message_id: 1,
        chat: { id: 999, type: 'private' },
        text: 'will throw downstream',
      },
    };

    const poller = new TelegramPoller(
      stubApi([update]),
      stateDir,
      1000,
      undefined,
      (u) => recordRawTelegramUpdate(ctxRoot, agentName, u),
    );
    poller.onMessage(() => {
      throw new Error('downstream failure');
    });

    await expect(poller.pollOnce()).resolves.toBeUndefined();

    const rawLines = readFileSync(rawUpdatesPath(), 'utf-8').trim().split('\n');
    expect(rawLines).toHaveLength(1);
    expect(JSON.parse(rawLines[0]).update_id).toBe(60);
  });
});
