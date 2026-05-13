import { describe, it, expect } from 'vitest';
import {
  getConnector,
  CONNECTOR_ALLOWLIST,
  TelegramConnector,
  NullConnector,
} from '../../../src/connectors/index.js';

describe('connector factory + allowlist', () => {
  it('CONNECTOR_ALLOWLIST starts with telegram + none', () => {
    expect(CONNECTOR_ALLOWLIST).toContain('telegram');
    expect(CONNECTOR_ALLOWLIST).toContain('none');
  });

  it('getConnector("telegram", ...) constructs a TelegramConnector with unpacked env', () => {
    const c = getConnector('telegram', '/tmp/agent', {
      BOT_TOKEN: '123:abc',
      CHAT_ID: '12345',
      ALLOWED_USER: '67890',
    });
    expect(c).toBeInstanceOf(TelegramConnector);
    if (c instanceof TelegramConnector) {
      expect(c.getChatId()).toBe('12345');
      expect(c.getAllowedUserId()).toBe(67890);
    }
  });

  it('getConnector("none", ...) constructs a NullConnector', () => {
    const c = getConnector('none', '/tmp/agent', {});
    expect(c).toBeInstanceOf(NullConnector);
  });

  it('getConnector throws on an unknown kind with the allowlist in the message', () => {
    expect(() =>
      getConnector('mattermost' as any, '/tmp/agent', {}),
    ).toThrow(/Unknown connector "mattermost"/);
    expect(() =>
      getConnector('matrix' as any, '/tmp/agent', {}),
    ).toThrow(/Allowed: telegram, none/);
  });

  it('getConnector("telegram") handles missing env keys without crashing (validation surface is validateCredentials)', () => {
    const c = getConnector('telegram', '/tmp/agent', {});
    expect(c).toBeInstanceOf(TelegramConnector);
    // Empty BOT_TOKEN, etc., are caught by validateCredentials, not the
    // factory — the factory is purely structural.
  });
});
