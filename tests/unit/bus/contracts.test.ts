import { describe, it, expect } from 'vitest';
import {
  parseBusContract,
  serializeBusContract,
  validateContract,
  isContractKind,
  type BusContractMessage,
  type TaskMessage,
  type AckMessage,
  type StatusMessage,
  type QueryMessage,
  type ReplyMessage,
  type BroadcastMessage,
  type ErrorMessage,
  type BusContractKind,
} from '../../../src/bus/contracts.js';

// ---------------------------------------------------------------------------
// Task #66 acceptance: round-trip serialize/parse for every kind, reject
// unknown kinds, tolerate malformed JSON (return null, never throw).
// ---------------------------------------------------------------------------

describe('bus/contracts — serialize + parse round-trips for all 7 kinds', () => {
  const cases: Array<{ name: BusContractKind; msg: BusContractMessage }> = [
    {
      name: 'task',
      msg: {
        kind: 'task',
        from: 'sam',
        to: 'forge',
        payload: { title: 'Ship the release', priority: 'high' },
      } as TaskMessage,
    },
    {
      name: 'ack',
      msg: {
        kind: 'ack',
        from: 'forge',
        to: 'sam',
        payload: { ref: 'task-123' },
      } as AckMessage,
    },
    {
      name: 'status',
      msg: {
        kind: 'status',
        from: 'analyst',
        to: 'sam',
        payload: { state: 'running', uptime_s: 4200 },
      } as StatusMessage,
    },
    {
      name: 'query',
      msg: {
        kind: 'query',
        from: 'pa',
        to: 'analyst',
        payload: { question: 'How many tasks are blocked?' },
      } as QueryMessage,
    },
    {
      name: 'reply',
      msg: {
        kind: 'reply',
        from: 'analyst',
        to: 'pa',
        payload: { ref: 'query-99', answer: '3 blocked' },
      } as ReplyMessage,
    },
    {
      name: 'broadcast',
      msg: {
        kind: 'broadcast',
        from: 'chief',
        to: '*',
        payload: { headline: 'Daily standup at 09:00' },
      } as BroadcastMessage,
    },
    {
      name: 'error',
      msg: {
        kind: 'error',
        from: 'forge',
        to: 'sam',
        payload: { code: 'BUILD_FAILED', message: 'TypeScript compile error' },
      } as ErrorMessage,
    },
  ];

  for (const { name, msg } of cases) {
    it(`round-trips ${name}`, () => {
      const text = serializeBusContract(msg);
      const parsed = parseBusContract(text);
      expect(parsed).not.toBeNull();
      expect(parsed).toEqual(msg);
      // The kind-discriminator guard narrows correctly.
      expect(isContractKind(parsed!, name)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative-path tests — the bus relies on parseBusContract being null-safe
// for every junk input. Throws here would crash the receiver.
// ---------------------------------------------------------------------------

describe('bus/contracts — parse rejects unknown kinds and malformed input', () => {
  it('returns null for empty string', () => {
    expect(parseBusContract('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseBusContract('   \n\t  ')).toBeNull();
  });

  it('returns null for plain-text (no JSON shape) — legacy fallback', () => {
    expect(parseBusContract('hello, this is a chat message')).toBeNull();
    expect(parseBusContract('TASK: do the thing')).toBeNull();
  });

  it('returns null for malformed JSON in a JSON-shaped body (no throw)', () => {
    // Truncated JSON.
    expect(() => parseBusContract('{"kind": "task", "from')).not.toThrow();
    expect(parseBusContract('{"kind": "task", "from')).toBeNull();
    // Trailing junk.
    expect(parseBusContract('{not json}')).toBeNull();
    // Bare-array malformed.
    expect(parseBusContract('[1, 2, 3')).toBeNull();
  });

  it('returns null for unknown kind values (typo guard — the bug this fixes)', () => {
    // 'aks' is the typo that motivated the contract layer.
    const wonky = JSON.stringify({ kind: 'aks', from: 'a', to: 'b', payload: {} });
    expect(parseBusContract(wonky)).toBeNull();

    // 'borardcast' is another seen typo in field reports.
    const wonky2 = JSON.stringify({ kind: 'borardcast', from: 'a', to: 'b', payload: {} });
    expect(parseBusContract(wonky2)).toBeNull();
  });

  it('returns null when kind is missing entirely', () => {
    const noKind = JSON.stringify({ from: 'a', to: 'b', payload: {} });
    expect(parseBusContract(noKind)).toBeNull();
  });

  it('returns null when from/to are missing or non-string', () => {
    expect(parseBusContract(JSON.stringify({ kind: 'task', to: 'b', payload: {} }))).toBeNull();
    expect(parseBusContract(JSON.stringify({ kind: 'task', from: 'a', payload: {} }))).toBeNull();
    expect(parseBusContract(JSON.stringify({ kind: 'task', from: 1, to: 'b' }))).toBeNull();
    expect(parseBusContract(JSON.stringify({ kind: 'task', from: 'a', to: '' }))).toBeNull();
  });

  it('returns null for arrays at the top level', () => {
    expect(parseBusContract(JSON.stringify([{ kind: 'task', from: 'a', to: 'b' }]))).toBeNull();
  });

  it('returns null for primitives wrapped in JSON', () => {
    expect(parseBusContract('"just a string"')).toBeNull();
    expect(parseBusContract('42')).toBeNull();
    expect(parseBusContract('true')).toBeNull();
    expect(parseBusContract('null')).toBeNull();
  });

  it('coerces missing payload to {} (forgiving senders)', () => {
    const noPayload = JSON.stringify({ kind: 'ack', from: 'a', to: 'b' });
    const parsed = parseBusContract(noPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('ack');
    expect(parsed!.payload).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// `validateContract` direct-path — call sites that already JSON.parse'd
// (e.g. dashboard JSON loaders) can validate without re-stringifying.
// ---------------------------------------------------------------------------

describe('bus/contracts — validateContract', () => {
  it('accepts a pre-parsed object', () => {
    const obj = { kind: 'status', from: 'sam', to: 'pa', payload: { ok: true } };
    const parsed = validateContract(obj);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('status');
  });

  it('rejects null / undefined', () => {
    expect(validateContract(null)).toBeNull();
    expect(validateContract(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serializeBusContract — output stability (same input → same string).
// ---------------------------------------------------------------------------

describe('bus/contracts — serializeBusContract output stability', () => {
  it('produces stable key ordering across calls', () => {
    const msg: TaskMessage = {
      kind: 'task',
      from: 'sam',
      to: 'forge',
      payload: { z: 1, a: 2 },
    };
    expect(serializeBusContract(msg)).toBe(serializeBusContract(msg));
    // Top-level order is kind, from, to, payload — assert by direct match.
    expect(serializeBusContract(msg)).toBe(
      '{"kind":"task","from":"sam","to":"forge","payload":{"z":1,"a":2}}',
    );
  });
});
