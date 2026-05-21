/**
 * tests/unit/bus/message-sanitization.test.ts
 *
 * Tests for HIGH-2 Phase 1: payload schema validation on bus message ingress.
 * Malformed messages must be rejected into .errors/ without crashing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkInbox } from '../../../src/bus/message.js';
import type { BusPaths } from '../../../src/types/index.js';

function makePaths(base: string, agent = 'receiver'): BusPaths {
  return {
    ctxRoot: base,
    inbox: join(base, 'inbox', agent),
    inflight: join(base, 'inflight', agent),
    processed: join(base, 'processed', agent),
    logDir: join(base, 'logs', agent),
    stateDir: join(base, '.cortextOS', 'state', 'agents', agent),
    taskDir: join(base, 'tasks'),
    approvalDir: join(base, 'approvals'),
    analyticsDir: join(base, 'analytics'),
  };
}

function seedSigningKey(ctxRoot: string) {
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  // No signing key seeded here — tests below use unsigned messages and no key,
  // so HMAC enforcement is bypassed, letting us isolate sanitization logic.
}

function writeRawInboxFile(inboxDir: string, filename: string, content: string) {
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, filename), content, 'utf-8');
}

function validMessageJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: '1700000000000-sender-abc12',
    from: 'sender',
    to: 'receiver',
    priority: 'normal',
    timestamp: '2026-05-20T00:00:00.000Z',
    text: 'hello world',
    reply_to: null,
    ...overrides,
  });
}

let testDir: string;
let paths: BusPaths;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'sanitization-test-'));
  paths = makePaths(testDir);
  seedSigningKey(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('bus message payload sanitization', () => {
  it('accepts a well-formed message', () => {
    writeRawInboxFile(paths.inbox, '2-1700000000000-from-sender-abc12.json', validMessageJson());
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('hello world');
    // No errors dir created
    expect(existsSync(join(paths.inbox, '.errors'))).toBe(false);
  });

  it('rejects a payload that is not an object (array)', () => {
    writeRawInboxFile(paths.inbox, '2-1700000000001-from-sender-arr01.json', '["not","an","object"]');
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
    const errDir = join(paths.inbox, '.errors');
    expect(existsSync(errDir)).toBe(true);
    expect(readdirSync(errDir)).toHaveLength(1);
  });

  it('rejects a payload that is not an object (string)', () => {
    writeRawInboxFile(paths.inbox, '2-1700000000002-from-sender-str01.json', '"just a string"');
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message with a missing required field (text)', () => {
    const bad = validMessageJson();
    const parsed = JSON.parse(bad);
    delete parsed.text;
    writeRawInboxFile(paths.inbox, '2-1700000000003-from-sender-nfld.json', JSON.stringify(parsed));
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
    expect(existsSync(join(paths.inbox, '.errors'))).toBe(true);
  });

  it('rejects a message with a missing required field (from)', () => {
    const parsed = JSON.parse(validMessageJson());
    delete parsed.from;
    writeRawInboxFile(paths.inbox, '2-1700000000004-from-sender-nfr2.json', JSON.stringify(parsed));
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message where a required field has wrong type (text is number)', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000005-from-sender-wtyp.json',
      validMessageJson({ text: 42 }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message where priority is invalid', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000006-from-sender-bpri.json',
      validMessageJson({ priority: 'critical' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message with oversized text body', () => {
    const bigText = 'x'.repeat(33_000); // > 32KB limit
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000007-from-sender-obig.json',
      validMessageJson({ text: bigText }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
    expect(existsSync(join(paths.inbox, '.errors'))).toBe(true);
  });

  it('rejects a message with control characters in text', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000008-from-sender-ctrl.json',
      validMessageJson({ text: 'hello\x00world' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message with a bell character in text', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000009-from-sender-bell.json',
      validMessageJson({ text: 'hello\x07world' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('accepts text with normal whitespace (tabs, newlines)', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000010-from-sender-wsp0.json',
      validMessageJson({ text: 'line one\nline two\ttabbed' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('line one\nline two\ttabbed');
  });

  it('rejects a message with malformed id (control char)', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000011-from-sender-bid0.json',
      validMessageJson({ id: 'bad\x01id' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('rejects a message where reply_to is neither string nor null', () => {
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000012-from-sender-rpt0.json',
      validMessageJson({ reply_to: 123 }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(0);
  });

  it('processes multiple messages — valid accepted, invalid rejected', () => {
    writeRawInboxFile(paths.inbox, '2-1700000000013-from-sender-vld0.json', validMessageJson({ text: 'valid' }));
    writeRawInboxFile(
      paths.inbox,
      '2-1700000000014-from-sender-inv0.json',
      validMessageJson({ priority: 'bogus' }),
    );
    const msgs = checkInbox(paths);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('valid');
    expect(readdirSync(join(paths.inbox, '.errors'))).toHaveLength(1);
  });
});
