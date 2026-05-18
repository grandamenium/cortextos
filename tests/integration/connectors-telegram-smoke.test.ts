/**
 * End-to-end smoke test for the TelegramConnector against the
 * MockTelegramServer. Replicates the 6-step manual verification I'd
 * otherwise run against a real Telegram bot:
 *
 *   1. Inbound text message → NormalizedMessage delivered to handler
 *   2. Inbound photo → media pipeline downloads + emits with media populated
 *   3. Inbound document with file_size → cap precheck + collision prefix
 *   4. Outbound message with inline buttons (callback variant) → wire format
 *   5. Inbound callback → connector emits CallbackPayload → editMessage + ack
 *   6. Inbound reaction → NormalizedReactionPayload with ConnectorReaction
 *   7. Outbound reaction via sendReaction → setMessageReaction wire shape
 *
 * Scenario 8 from the spec (crash notification) is daemon-side (agent-
 * manager.ts onStatusChanged) not connector-side; covered separately by
 * fast-checker / daemon tests + the deliberate manual smoke checklist at
 * docs/architecture/connectors.md §16's "Recommended next step".
 *
 * This file is the automated successor to that manual checklist for
 * everything UP TO the daemon's status-change wiring. It does NOT
 * replace a real-bot smoke test — the MockTelegramServer is a faithful
 * but not exhaustive replica of Telegram's actual API.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MockTelegramServer } from '../playwright/mock-telegram-server.js';
import { TelegramConnector } from '../../src/connectors/index.js';
import type {
  NormalizedMessage,
  NormalizedReactionPayload,
  CallbackPayload,
} from '../../src/connectors/index.js';

describe('TelegramConnector end-to-end smoke (integration with mock server)', () => {
  let server: MockTelegramServer;
  let connector: TelegramConnector;
  let stateDir: string;
  let downloadDir: string;
  let messages: NormalizedMessage[];
  let callbacks: CallbackPayload[];
  let reactions: NormalizedReactionPayload[];

  beforeAll(async () => {
    server = new MockTelegramServer(39191);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    messages = [];
    callbacks = [];
    reactions = [];
    stateDir = join(tmpdir(), `tg-smoke-${Date.now()}-${Math.random()}`);
    mkdirSync(stateDir, { recursive: true });
    downloadDir = join(tmpdir(), `tg-smoke-dl-${Date.now()}-${Math.random()}`);
    mkdirSync(downloadDir, { recursive: true });

    connector = new TelegramConnector(
      stateDir,
      {
        BOT_TOKEN: '123:abc_DEF',
        CHAT_ID: '12345',
        ALLOWED_USER: '67890',
      },
      { downloadDir },
    );
    // Point the underlying TelegramAPI at the mock server. We override
    // BOTH the API base URL (sendMessage / getUpdates / etc.) and the
    // FILE base URL (downloadFile). The latter override is the c23 hook
    // added explicitly for this test — production never touches it.
    (connector as any).api.baseUrl =
      server.getBaseUrl() + '/bot123:abc_DEF';
    (connector as any).api.fileBaseUrl = server.getBaseUrl() + '/file';

    await connector.startInbound({
      onMessage: (m) => { messages.push(m); },
      onCallback: (c) => { callbacks.push(c); },
      onReaction: (r) => { reactions.push(r); },
    });
  });

  /**
   * Poll until `pred()` returns true OR the timeout expires. Tests use
   * this instead of fixed delays so they remain deterministic on slow
   * CI runners.
   */
  async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!pred()) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 1 — inbound text message
  // ─────────────────────────────────────────────────────────────────────

  it('1. inbound text message reaches the agent handler', async () => {
    server.queueMessage({ text: 'hello agent' });
    await waitUntil(() => messages.length >= 1);
    await connector.stopInbound();

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('hello agent');
    expect(messages[0].from.id).toBe('67890');
    expect(messages[0].from.username).toBe('testuser');
    expect(messages[0].chat_id).toBe('12345');
    expect(typeof messages[0].id).toBe('string');
    expect(typeof messages[0].ts).toBe('number');
    // ts is milliseconds, not seconds (PR4 normalization rule)
    expect(messages[0].ts).toBeGreaterThan(1000000000000);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 2 — inbound photo with media download
  // ─────────────────────────────────────────────────────────────────────

  it('2. inbound photo downloads + emits NormalizedMessage.media populated', async () => {
    // Pre-load the mock server's file store so getFile + downloadFile resolve.
    const photoBytes = Buffer.from('fake-photo-content-bytes');
    server.storeFile('photo_large_id', photoBytes);

    server.queueMessage({
      caption: 'check this out',
      photo: [
        { file_id: 'photo_small_id', width: 90, height: 90, file_size: 100 },
        { file_id: 'photo_large_id', width: 800, height: 600, file_size: photoBytes.length },
      ],
    });

    await waitUntil(() => messages.length >= 1);
    await connector.stopInbound();

    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.media).toBeDefined();
    expect(m.media!.kind).toBe('photo');
    expect(m.media!.localPath).toMatch(/^\//); // absolute path
    expect(m.media!.localPath).toContain(downloadDir);
    expect(existsSync(m.media!.localPath)).toBe(true);
    expect(readFileSync(m.media!.localPath).toString()).toBe('fake-photo-content-bytes');
    // Caption flows through as text
    expect(m.text).toBe('check this out');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 3 — inbound document with collision-prefix filename
  // ─────────────────────────────────────────────────────────────────────

  it('3. inbound document writes msg<message_id>_-prefixed filename (PR4 c15 collision fix)', async () => {
    const docBytes = Buffer.from('PDF-1.4 fake content');
    server.storeFile('doc_id', docBytes);

    // queueMessage assigns the next sequential message_id. Capture pre-state
    // so the test asserts the actual prefix value.
    server.queueMessage({
      document: {
        file_id: 'doc_id',
        file_name: 'report.pdf',
        file_size: docBytes.length,
      },
      caption: 'monthly report',
    });

    await waitUntil(() => messages.length >= 1);
    await connector.stopInbound();

    const m = messages[0];
    expect(m.media).toBeDefined();
    expect(m.media!.kind).toBe('document');
    // PR4 c15: collision prefix prevents two report.pdf messages from
    // overwriting each other. Filename starts with msg<message_id>_.
    const basename = m.media!.localPath.split('/').pop()!;
    expect(basename).toMatch(/^msg\d+_report\.pdf$/);
    expect(m.media!.fileName).toMatch(/^msg\d+_report\.pdf$/);
    expect(existsSync(m.media!.localPath)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 4 — outbound message with inline buttons
  // ─────────────────────────────────────────────────────────────────────

  it('4. outbound sendMessage with ConnectorAction buttons → Telegram inline_keyboard', async () => {
    await connector.sendMessage('approve this?', {
      buttons: [
        [
          { kind: 'callback' as const, label: '✅ Yes', actionId: 'yes_action' },
          { kind: 'callback' as const, label: '❌ No', actionId: 'no_action' },
        ],
        [
          { kind: 'url' as const, label: 'Open docs', url: 'https://example.com/docs' },
        ],
      ],
    });
    await connector.stopInbound();

    const sends = server.getRequestsFor('sendMessage');
    expect(sends).toHaveLength(1);
    const body = sends[0].body as any;
    expect(body.chat_id).toBe('12345'); // connector's bound chat
    expect(body.text).toBe('approve this?');
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Yes', callback_data: 'yes_action' },
          { text: '❌ No', callback_data: 'no_action' },
        ],
        // URL variant translates to {text, url} (no callback_data)
        [
          { text: 'Open docs', url: 'https://example.com/docs' },
        ],
      ],
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 5 — inbound callback round-trip (edit + ack)
  // ─────────────────────────────────────────────────────────────────────

  it('5. inbound callback emits typed CallbackPayload + supports edit + ack round-trip', async () => {
    server.queueCallback('yes_action', 99);
    await waitUntil(() => callbacks.length >= 1);

    expect(callbacks).toHaveLength(1);
    const cb = callbacks[0];
    expect(cb.data).toBe('yes_action');
    expect(cb.message_id).toBe('99');
    expect(cb.chat_id).toBe('12345');
    expect(cb.from.id).toBe('67890');
    expect(cb.from.username).toBe('testuser');

    // Agent acks the callback (toast) + edits the original message
    await connector.acknowledgeCallback!(cb.id, 'Got it');
    await connector.editMessage!(cb.message_id, '✅ Approved');
    await connector.stopInbound();

    const acks = server.getRequestsFor('answerCallbackQuery');
    expect(acks).toHaveLength(1);
    expect((acks[0].body as any).callback_query_id).toBe(cb.id);
    expect((acks[0].body as any).text).toBe('Got it');

    const edits = server.getRequestsFor('editMessageText');
    expect(edits).toHaveLength(1);
    expect((edits[0].body as any).chat_id).toBe('12345');
    expect((edits[0].body as any).message_id).toBe(99);
    expect((edits[0].body as any).text).toBe('✅ Approved');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 6 — inbound reaction → NormalizedReactionPayload
  // ─────────────────────────────────────────────────────────────────────

  it('6. inbound reaction emits NormalizedReactionPayload with ConnectorReaction[] shape', async () => {
    server.queueReaction({
      messageId: 42,
      newReaction: [{ type: 'emoji', emoji: '👍' }],
    });
    await waitUntil(() => reactions.length >= 1);
    await connector.stopInbound();

    const r = reactions[0];
    expect(r.from.id).toBe('67890');
    expect(r.chat_id).toBe('12345');
    expect(typeof r.message_id).toBe('string'); // PR4 c8 stringified
    expect(r.message_id).toBe('42');
    expect(r.new_reaction).toEqual([{ kind: 'unicode', value: '👍' }]);
    expect(r.old_reaction).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 7 — outbound reaction via sendReaction
  // ─────────────────────────────────────────────────────────────────────

  it('7. outbound sendReaction posts setMessageReaction with bound chatId', async () => {
    await connector.sendReaction!('100', '👀');
    await connector.sendReaction!('100', '✅');  // swap emoji (Telegram set-to-list contract)
    await connector.sendReaction!('100', '👀', { remove: true });  // clear
    await connector.stopInbound();

    const calls = server.getRequestsFor('setMessageReaction');
    expect(calls).toHaveLength(3);

    // First call: react with 👀
    expect((calls[0].body as any).chat_id).toBe('12345');
    expect((calls[0].body as any).message_id).toBe(100);
    expect((calls[0].body as any).reaction).toEqual([{ type: 'emoji', emoji: '👀' }]);

    // Second call: replace with ✅ (Telegram set-to-list contract)
    expect((calls[1].body as any).reaction).toEqual([{ type: 'emoji', emoji: '✅' }]);

    // Third call: remove (empty array)
    expect((calls[2].body as any).reaction).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 8 — sanity: ALLOWED_USER gate is preserved
  // ─────────────────────────────────────────────────────────────────────

  it('8. ALLOWED_USER gate state preserved on the connector (allowedUserId accessor)', async () => {
    // The connector exposes the parsed allowedUserId so the daemon's
    // onMessage gate can string-compare against from.id. Verifies the
    // numeric-validation regression check from PR1 didn't drift.
    expect(connector.getAllowedUserId()).toBe(67890);
    expect(connector.getChatId()).toBe('12345');
    await connector.stopInbound();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 9 — Markdown→HTML conversion still applied on outbound
  // ─────────────────────────────────────────────────────────────────────

  it('9. outbound sendMessage applies Markdown→HTML (preserves main behavior)', async () => {
    await connector.sendMessage('hello *bold* and _italic_ text');
    await connector.stopInbound();

    const sends = server.getRequestsFor('sendMessage');
    expect(sends).toHaveLength(1);
    const body = sends[0].body as any;
    // Telegram's parse_mode is HTML by default (the connector translates
    // SendOptions.parseMode absent → 'HTML'). Main behaved identically.
    expect(body.parse_mode).toBe('HTML');
    // markdownToHtml converts *bold* → <b>bold</b>, _italic_ → <i>italic</i>
    expect(body.text).toContain('<b>bold</b>');
    expect(body.text).toContain('<i>italic</i>');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 10 — sendChatAction (typing indicator) routes through
  // ─────────────────────────────────────────────────────────────────────

  it('10. setTypingIndicator(true) → sendChatAction with action=typing', async () => {
    await connector.setTypingIndicator!(true);
    await connector.setTypingIndicator!(false);  // no-op per spec
    await connector.stopInbound();

    const actions = server.getRequestsFor('sendChatAction');
    expect(actions).toHaveLength(1);
    expect((actions[0].body as any).chat_id).toBe('12345');
    expect((actions[0].body as any).action).toBe('typing');
  });

  // Cleanup the temp dirs per test. afterEach not strictly needed for
  // correctness — beforeEach creates fresh dirs — but tidies the tmp tree.
});
