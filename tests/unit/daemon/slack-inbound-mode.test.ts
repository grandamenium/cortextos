import { describe, it, expect } from 'vitest';
import { resolveSlackInboundMode } from '../../../src/daemon/slack-inbound-mode.js';

const base = { channel: 'C123', intervalMs: 60_000 };

describe('resolveSlackInboundMode', () => {
  it('both tokens + WebSocket available (Node 22+) -> socket primary', () => {
    const d = resolveSlackInboundMode({
      ...base, botToken: 'xoxb-1', appToken: 'xapp-1', webSocketAvailable: true,
    });
    expect(d).toEqual({ mode: 'socket', channel: 'C123', botToken: 'xoxb-1', appToken: 'xapp-1' });
  });

  // THE regression guard: both tokens present but WebSocket unavailable (Node 20/21).
  // Must NOT go silent — must fall back to the poll with a loud reason.
  it('both tokens but WebSocket UNavailable (Node <22) -> poll fallback, never silent', () => {
    const d = resolveSlackInboundMode({
      ...base, botToken: 'xoxb-1', appToken: 'xapp-1', webSocketAvailable: false,
    });
    expect(d.mode).toBe('poll');
    if (d.mode === 'poll') {
      expect(d.channel).toBe('C123');
      expect(d.botToken).toBe('xoxb-1');
      expect(d.intervalMs).toBe(60_000);
      expect(d.reason).toMatch(/WebSocket.*unavailable|Node 22/i);
    }
  });

  it('bot token only (no app token) -> poll, no reason (legacy path)', () => {
    const d = resolveSlackInboundMode({
      ...base, botToken: 'xoxb-1', appToken: '', webSocketAvailable: true,
    });
    expect(d).toEqual({ mode: 'poll', channel: 'C123', botToken: 'xoxb-1', intervalMs: 60_000 });
  });

  it('app token only but no WebSocket -> still poll fallback if bot token present', () => {
    // app token without WebSocket and WITH bot token -> poll (covered above);
    // here confirm bot-token presence is what gates poll vs none.
    const d = resolveSlackInboundMode({
      ...base, botToken: 'xoxb-1', appToken: 'xapp-1', webSocketAvailable: false,
    });
    expect(d.mode).toBe('poll');
  });

  it('no bot token -> none (cannot do inbound at all)', () => {
    const d = resolveSlackInboundMode({
      ...base, botToken: '', appToken: 'xapp-1', webSocketAvailable: true,
    });
    expect(d.mode).toBe('none');
    if (d.mode === 'none') expect(d.reason).toMatch(/SLACK_BOT_TOKEN/);
  });

  it('no tokens at all -> none', () => {
    const d = resolveSlackInboundMode({
      ...base, botToken: '', appToken: '', webSocketAvailable: false,
    });
    expect(d.mode).toBe('none');
  });
});
