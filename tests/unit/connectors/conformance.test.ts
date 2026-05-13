/**
 * Compile-time + runtime conformance tests for the MessageConnector
 * interface. Pins:
 *  - Both shipping implementations (TelegramConnector, NullConnector)
 *    satisfy the interface
 *  - capability flags are booleans (no `undefined` leaking)
 *  - `kind` literals are correct
 */
import { describe, it, expect } from 'vitest';
import type { MessageConnector } from '../../../src/connectors/index.js';
import { TelegramConnector, NullConnector } from '../../../src/connectors/index.js';

describe('MessageConnector conformance', () => {
  it('TelegramConnector satisfies MessageConnector', () => {
    const c: MessageConnector = new TelegramConnector('/tmp/agent', {
      BOT_TOKEN: '123:abc',
      CHAT_ID: '12345',
      ALLOWED_USER: '67890',
    });
    expect(c.kind).toBe('telegram');
    for (const flag of [
      'inlineButtons', 'media', 'voiceTranscription', 'formattedText',
      'longPolling', 'typingIndicator', 'reactions',
    ] as const) {
      expect(typeof c.capabilities[flag]).toBe('boolean');
    }
    expect(c.capabilities.reactions).toBe(true);
  });

  it('NullConnector satisfies MessageConnector', () => {
    const c: MessageConnector = new NullConnector();
    expect(c.kind).toBe('none');
    for (const flag of [
      'inlineButtons', 'media', 'voiceTranscription', 'formattedText',
      'longPolling', 'typingIndicator', 'reactions',
    ] as const) {
      expect(typeof c.capabilities[flag]).toBe('boolean');
      // NullConnector has every capability false
      expect(c.capabilities[flag]).toBe(false);
    }
  });

  it('TelegramConnector exposes the typed escape hatch rawTelegramApi', () => {
    const c = new TelegramConnector('/tmp/agent', {
      BOT_TOKEN: '123:abc',
      CHAT_ID: '12345',
      ALLOWED_USER: '67890',
    });
    // Same instance on every call (no transient construction).
    expect(c.rawTelegramApi()).toBe(c.rawTelegramApi());
  });

  it('TelegramConnector exposes its bound chat id and allowed-user id', () => {
    const c = new TelegramConnector('/tmp/agent', {
      BOT_TOKEN: '123:abc',
      CHAT_ID: '12345',
      ALLOWED_USER: '67890',
    });
    expect(c.getChatId()).toBe('12345');
    expect(c.getAllowedUserId()).toBe(67890);
  });

  it('TelegramConnector handles empty ALLOWED_USER gracefully', () => {
    const c = new TelegramConnector('/tmp/agent', {
      BOT_TOKEN: '123:abc',
      CHAT_ID: '12345',
      ALLOWED_USER: '',
    });
    expect(c.getAllowedUserId()).toBeUndefined();
  });
});
