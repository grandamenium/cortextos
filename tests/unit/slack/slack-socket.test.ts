import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateSlackEnvelope,
  isTimestampValid,
  shouldDeliverSlackMessage,
  SlackSocketClient,
} from '../../../src/slack/slack-socket.js';

describe('validateSlackEnvelope', () => {
  // Regression guard for the lifted-code bug: Slack's `hello` control frame
  // carries NO envelope_id, so requiring envelope_id for every type rejected
  // it and the connection never authenticated.
  it('accepts a hello frame that has no envelope_id', () => {
    const hello = {
      type: 'hello',
      num_connections: 1,
      connection_info: { app_id: 'A123' },
      debug_info: { host: 'applink-1' },
    };
    expect(validateSlackEnvelope(hello)).toEqual({ valid: true });
  });

  it('accepts a disconnect frame that has no envelope_id', () => {
    const disconnect = { type: 'disconnect', reason: 'warning', debug_info: {} };
    expect(validateSlackEnvelope(disconnect)).toEqual({ valid: true });
  });

  it('still requires envelope_id for events_api frames (must be acked)', () => {
    const eventNoId = {
      type: 'events_api',
      payload: { event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' } },
    };
    const result = validateSlackEnvelope(eventNoId);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/envelope_id/i);
  });

  it('accepts a well-formed events_api frame with envelope_id and payload', () => {
    const good = {
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' } },
    };
    expect(validateSlackEnvelope(good)).toEqual({ valid: true });
  });

  it('rejects events_api frame missing its payload', () => {
    const noPayload = { envelope_id: 'env-1', type: 'events_api' };
    const result = validateSlackEnvelope(noPayload);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/payload/i);
  });

  it('rejects an unknown envelope type', () => {
    const result = validateSlackEnvelope({ envelope_id: 'x', type: 'bogus' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unknown envelope type/i);
  });

  it('rejects a frame with no type', () => {
    const result = validateSlackEnvelope({ envelope_id: 'x' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/type/i);
  });

  it('rejects a non-object', () => {
    expect(validateSlackEnvelope(null).valid).toBe(false);
    expect(validateSlackEnvelope('str' as unknown).valid).toBe(false);
  });
});

describe('isTimestampValid (sanity — replay window)', () => {
  it('accepts a current timestamp', () => {
    const now = Math.floor(Date.now() / 1000).toString();
    expect(isTimestampValid(now)).toBe(true);
  });

  it('rejects a stale timestamp beyond the 5-minute window', () => {
    const stale = (Math.floor(Date.now() / 1000) - 600).toString();
    expect(isTimestampValid(stale)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(isTimestampValid('not-a-number')).toBe(false);
  });
});

describe('shouldDeliverSlackMessage (parity with the legacy poll)', () => {
  it('delivers a plain text message (no subtype)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message', text: 'hello team' })).toBe(true);
  });

  // THE regression guard: the poll delivered file shares (non-bot subtype with
  // text); the socket must too, or human file/photo shares are silently dropped.
  it('delivers a file_share message that has text (not dropped)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', text: 'here is the leak photo' }),
    ).toBe(true);
  });

  it('delivers a thread_broadcast message that has text', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'thread_broadcast', text: 'reposting to channel' }),
    ).toBe(true);
  });

  it('drops bot_message (self-wake prevention preserved)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'bot_message', text: 'i am a bot' }),
    ).toBe(false);
  });

  // A photo/file shared with NO caption has empty text — the poll woke on these,
  // so the socket must deliver them too (else captionless photo shares vanish).
  it('delivers a captionless file_share (empty text)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', text: '' })).toBe(true);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share' })).toBe(true);
  });

  it('drops a contentless event with no text and not a file_share (edit/delete/join)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message' })).toBe(false);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'message_deleted', text: '' })).toBe(false);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'channel_join', text: '' })).toBe(false);
  });

  it('drops non-message event types', () => {
    expect(shouldDeliverSlackMessage({ type: 'reaction_added', text: 'x' })).toBe(false);
  });

  // Self-echo guard: a message the agent posts via its own bot token arrives as
  // a NORMAL message (no bot_message subtype) but carries bot_id — it must be
  // dropped, or our own outbound reply loops back into our inbox.
  it('drops a bot-authored message carrying bot_id (self-echo, no subtype)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', bot_id: 'B0123', text: 'my own reply' }),
    ).toBe(false);
  });

  it('drops a bot_id message even if it also looks like a file_share', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', bot_id: 'B0123', text: 'echo' }),
    ).toBe(false);
  });
});

describe('SlackSocketClient — shutdown race on the restart path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Regression guard: if stop() lands while apps.connections.open is in flight,
  // the resumed success path must NOT create a WebSocket (ghost listener that
  // authenticates post-shutdown). The fix re-checks isShuttingDown after the
  // fetch await.
  it('stop() during in-flight connections.open -> no WebSocket created', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal('fetch', fetchMock);

    let wsConstructed = 0;
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        wsConstructed++;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );

    // start() kicks off connect(), which awaits the open fetch.
    const startPromise = client.start();
    // A restart lands mid-fetch.
    client.stop();
    // The open fetch now resolves successfully (URL returned).
    resolveFetch({ json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    await startPromise;
    await Promise.resolve();

    expect(wsConstructed).toBe(0);
    expect(client.getConnectionState().getState()).toBe('disconnected');
  });

  it('clean open (no stop) DOES create a WebSocket — guard does not over-block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    vi.stubGlobal('fetch', fetchMock);

    let wsConstructed = 0;
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        wsConstructed++;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    await Promise.resolve();
    expect(wsConstructed).toBe(1);
    client.stop();
  });
});
