import { describe, it, expect } from 'vitest';
import {
  buildEvent,
  buildAuthEvent,
  buildChannelMessageEvent,
  computeEventId,
  verifyEvent,
  getPublicKey,
  generateKeypair,
} from '../../../src/buzz/event';

describe('generateKeypair', () => {
  it('produces a 64-char hex secret key and a matching 64-char hex pubkey', () => {
    const { secretKey, pubkey } = generateKeypair();
    expect(secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(secretKey)).toBe(pubkey);
  });

  it('generates distinct keys on repeated calls', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

describe('buildEvent', () => {
  const { secretKey, pubkey } = generateKeypair();

  it('signs with the correct pubkey derived from the secret key', () => {
    const event = buildEvent(9, 'hello', [['h', 'chan-1']], secretKey);
    expect(event.pubkey).toBe(pubkey);
  });

  it('computes an id matching computeEventId over the same fields', () => {
    const event = buildEvent(9, 'hello', [['h', 'chan-1']], secretKey);
    const recomputed = computeEventId({
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    });
    expect(event.id).toBe(recomputed);
  });

  it('produces a signature that verifies successfully', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    expect(verifyEvent(event)).toBe(true);
  });

  it('two events with different content have different ids', () => {
    const a = buildEvent(9, 'hello', [], secretKey);
    const b = buildEvent(9, 'goodbye', [], secretKey);
    expect(a.id).not.toBe(b.id);
  });
});

describe('buildAuthEvent', () => {
  const { secretKey } = generateKeypair();

  it('is kind 22242 with empty content', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(event.kind).toBe(22242);
    expect(event.content).toBe('');
  });

  it('carries relay and challenge tags', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(event.tags).toContainEqual(['relay', 'wss://relay.example.com']);
    expect(event.tags).toContainEqual(['challenge', 'challenge-abc']);
  });

  it('verifies successfully', () => {
    const event = buildAuthEvent('challenge-abc', 'wss://relay.example.com', secretKey);
    expect(verifyEvent(event)).toBe(true);
  });
});

describe('buildChannelMessageEvent', () => {
  const { secretKey } = generateKeypair();

  it('is kind 9 with an #h channel tag (relay requires this for channel scoping)', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hello channel', secretKey);
    expect(event.kind).toBe(9);
    expect(event.tags).toContainEqual(['h', 'chan-uuid-1']);
    expect(event.content).toBe('hello channel');
  });

  it('omits the reply tag when replyToEventId is not provided', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hi', secretKey);
    expect(event.tags.some((t) => t[0] === 'e')).toBe(false);
  });

  it('adds a NIP-10 reply tag when replyToEventId is provided', () => {
    const event = buildChannelMessageEvent('chan-uuid-1', 'hi', secretKey, 'parent-event-id');
    expect(event.tags).toContainEqual(['e', 'parent-event-id', '', 'reply']);
  });
});

describe('verifyEvent', () => {
  const { secretKey } = generateKeypair();

  it('returns false when the signature does not match a tampered id', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const tampered = { ...event, id: 'a'.repeat(64) };
    expect(verifyEvent(tampered)).toBe(false);
  });

  it('returns false when content is tampered after signing (id mismatch)', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const tampered = { ...event, content: 'tampered content' };
    expect(verifyEvent(tampered)).toBe(false);
  });

  it('returns false on malformed hex fields rather than throwing', () => {
    const event = buildEvent(9, 'hello', [], secretKey);
    const malformed = { ...event, sig: 'not-hex!!' };
    expect(() => verifyEvent(malformed)).not.toThrow();
    expect(verifyEvent(malformed)).toBe(false);
  });
});
