/**
 * Integration test — drives the TelegramConnector against a real
 * MockTelegramServer and verifies reaction updates (add / change / remove /
 * custom_emoji) flow through `startPolling.onReaction` with the expected
 * NormalizedReactionPayload shape.
 *
 * This is the load-bearing test for the v0.5 H1.v4 fix: the payload
 * carries TelegramReactionType[] arrays (preserving custom-emoji info),
 * plus chat_id and numeric message_id, exactly matching what
 * FastChecker.formatTelegramReaction expects.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MockTelegramServer } from '../playwright/mock-telegram-server.js';
import { TelegramConnector } from '../../src/connectors/index.js';
import type { NormalizedReactionPayload } from '../../src/connectors/index.js';

describe('TelegramConnector reactions (integration with mock server)', () => {
  let server: MockTelegramServer;
  let connector: TelegramConnector;
  let stateDir: string;
  let received: NormalizedReactionPayload[];

  beforeAll(async () => {
    server = new MockTelegramServer(39190);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    received = [];
    stateDir = join(tmpdir(), `connector-reactions-${Date.now()}-${Math.random()}`);
    mkdirSync(stateDir, { recursive: true });

    connector = new TelegramConnector(stateDir, {
      BOT_TOKEN: '123:abc_DEF',
      CHAT_ID: '12345',
      ALLOWED_USER: '67890',
    });
    // Point the underlying TelegramAPI at the mock server
    (connector as any).api.baseUrl = server.getBaseUrl() + '/bot123:abc_DEF';

    await connector.startPolling({
      onMessage: () => {},
      onReaction: (r) => { received.push(r); },
    });
  });

  async function waitForReactions(count: number, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (received.length < count) {
      throw new Error(`Timed out waiting for ${count} reactions; got ${received.length}`);
    }
  }

  it('case (a) — add: old_reaction empty, new_reaction has one emoji', async () => {
    server.queueReaction({
      newReaction: [{ type: 'emoji', emoji: '👍' }],
    });
    await waitForReactions(1);
    await connector.stopPolling();

    expect(received).toHaveLength(1);
    const r = received[0];
    expect(r.old_reaction).toEqual([]);
    expect(r.new_reaction).toEqual([{ type: 'emoji', emoji: '👍' }]);
    expect(r.from.id).toBe('67890');
    expect(r.chat_id).toBe('12345');
    expect(typeof r.message_id).toBe('number');
  });

  it('case (b) — change: both arrays non-empty and different', async () => {
    server.queueReaction({
      oldReaction: [{ type: 'emoji', emoji: '👍' }],
      newReaction: [{ type: 'emoji', emoji: '❤️' }],
    });
    await waitForReactions(1);
    await connector.stopPolling();

    expect(received[0].old_reaction).toEqual([{ type: 'emoji', emoji: '👍' }]);
    expect(received[0].new_reaction).toEqual([{ type: 'emoji', emoji: '❤️' }]);
  });

  it('case (c) — removal: old_reaction non-empty, new_reaction empty', async () => {
    server.queueReaction({
      oldReaction: [{ type: 'emoji', emoji: '👍' }],
      newReaction: [],
    });
    await waitForReactions(1);
    await connector.stopPolling();

    expect(received[0].old_reaction).toEqual([{ type: 'emoji', emoji: '👍' }]);
    expect(received[0].new_reaction).toEqual([]);
    // The "removal" signal is detectable: old non-empty, new empty.
    expect(received[0].old_reaction.length > 0 && received[0].new_reaction.length === 0).toBe(true);
  });

  it('case (d) — custom_emoji: tagged union variant preserved', async () => {
    server.queueReaction({
      newReaction: [{ type: 'custom_emoji', custom_emoji_id: 'premium-thumbs-up-id-12345' }],
    });
    await waitForReactions(1);
    await connector.stopPolling();

    const r = received[0].new_reaction[0];
    expect(r.type).toBe('custom_emoji');
    if (r.type === 'custom_emoji') {
      expect(r.custom_emoji_id).toBe('premium-thumbs-up-id-12345');
    }
  });

  it('synthesizes a stable id from message_id + date', async () => {
    server.queueReaction({
      messageId: 42,
      newReaction: [{ type: 'emoji', emoji: '🎉' }],
    });
    await waitForReactions(1);
    await connector.stopPolling();

    // id shape: `${message_id}-${date}` (date is unix seconds from the mock)
    expect(received[0].id).toMatch(/^42-\d+$/);
  });
});
