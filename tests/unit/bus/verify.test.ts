import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox } from '../../../src/bus/message';
import { verifyMessage, parseMsgId } from '../../../src/bus/verify';
import type { BusPaths } from '../../../src/types';

/**
 * F10 mitigation regression suite. Covers the full case matrix from ana's spec:
 *   T1-T4 positive (VERIFIED / exit 0)
 *   P1-P5 phantom (PHANTOM / exit 1)
 *   U1-U2 unverifiable (UNVERIFIABLE / exit 2, strict → PHANTOM)
 *   E1-E3 error (ERROR / exit 3)
 *
 * P1 is the 2026-04-18 incident reproduction — the msg_id itself encodes the
 * failure, no fixtures needed. If this test ever goes green against a fabricated
 * msg_id, the mitigation has regressed.
 */

const ORG = 'cleverwave';

interface TestEnv {
  testDir: string;
  senderPaths: BusPaths;
  receiverPaths: BusPaths;
}

function setupEnv(): TestEnv {
  const testDir = mkdtempSync(join(tmpdir(), 'cortextos-verify-test-'));
  const mkPaths = (agent: string): BusPaths => ({
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'orgs', ORG, 'analytics'),
    deliverablesDir: join(testDir, 'orgs', ORG, 'deliverables'),
  });
  return {
    testDir,
    senderPaths: mkPaths('sender'),
    receiverPaths: mkPaths('receiver'),
  };
}

function writeSenderEvent(env: TestEnv, sender: string, epochMs: number, msgId: string, eventName = 'agent_message_sent'): void {
  const date = new Date(epochMs).toISOString().split('T')[0];
  const dir = join(env.senderPaths.analyticsDir, 'events', sender);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    id: `${Math.floor(epochMs / 1000)}-${sender}-abcde`,
    agent: sender,
    org: ORG,
    timestamp: new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    category: 'message',
    event: eventName,
    severity: 'info',
    metadata: { to: 'receiver', priority: 'normal', msg_id: msgId, reply_to: null },
  });
  appendFileSync(join(dir, `${date}.jsonl`), line + '\n', 'utf-8');
}

describe('parseMsgId', () => {
  it('accepts canonical {epoch}-{sender}-{rand5}', () => {
    const p = parseMsgId('1776500000000-joma-abcde');
    expect(p).toEqual({ epochMs: 1776500000000, sender: 'joma', rand: 'abcde' });
  });

  it('accepts hyphenated sender names', () => {
    const p = parseMsgId('1776500000000-mhcrm-pr-review-xyz12');
    expect(p).toEqual({ epochMs: 1776500000000, sender: 'mhcrm-pr-review', rand: 'xyz12' });
  });

  it('rejects malformed ids', () => {
    expect(parseMsgId('')).toBeNull();
    expect(parseMsgId('not-a-msgid')).toBeNull();                 // only 2 segments
    expect(parseMsgId('abc-def-ghi')).toBeNull();                 // non-numeric epoch
    expect(parseMsgId('1776500000000')).toBeNull();               // no sender/rand
    expect(parseMsgId('-joma-abcde')).toBeNull();                 // empty epoch
  });
});

describe('verifyMessage — positive (T1-T4 VERIFIED)', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { rmSync(env.testDir, { recursive: true, force: true }); });

  it('T1: message in inflight/ (post-check, pre-ack) + sender event present → VERIFIED', () => {
    const msgId = sendMessage(env.senderPaths, 'sender', 'receiver', 'normal', 'hello');
    // checkInbox moves inbox → inflight.
    checkInbox(env.receiverPaths);
    const parsed = parseMsgId(msgId)!;
    writeSenderEvent(env, 'sender', parsed.epochMs, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: true, org: ORG,
    });
    expect(report.result).toBe('VERIFIED');
    expect(report.exit_code).toBe(0);
    expect(report.checks.bus_file.location).toBe('inflight');
  });

  it('T2: message in processed/ (post-ack) → VERIFIED', () => {
    const msgId = sendMessage(env.senderPaths, 'sender', 'receiver', 'normal', 'hello');
    checkInbox(env.receiverPaths);
    ackInbox(env.receiverPaths, msgId);
    const parsed = parseMsgId(msgId)!;
    writeSenderEvent(env, 'sender', parsed.epochMs, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: true, org: ORG,
    });
    expect(report.result).toBe('VERIFIED');
    expect(report.checks.bus_file.location).toBe('processed');
  });

  it('T3: timestamp at exactly now (0s skew) → VERIFIED', () => {
    const msgId = sendMessage(env.senderPaths, 'sender', 'receiver', 'normal', 'now');
    const parsed = parseMsgId(msgId)!;
    writeSenderEvent(env, 'sender', parsed.epochMs, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: true, org: ORG,
      now: parsed.epochMs, // wall-clock pinned to exactly the send time
    });
    expect(report.result).toBe('VERIFIED');
    expect(Math.abs(report.checks.timestamp.skew_seconds!)).toBeLessThanOrEqual(1);
  });

  it('T4: 6-day-old message still under 7d max-age → VERIFIED', () => {
    // Forge a msg_id at 6 days ago; handcraft the inbox file with matching id.
    const sixDaysAgo = Date.now() - 6 * 86400000;
    const msgId = `${sixDaysAgo}-sender-aaaaa`;
    const filename = `2-${sixDaysAgo}-from-sender-aaaaa.json`;
    const msgBody = {
      id: msgId, from: 'sender', to: 'receiver', priority: 'normal',
      timestamp: new Date(sixDaysAgo).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      text: 'old', reply_to: null,
    };
    mkdirSync(env.receiverPaths.processed, { recursive: true });
    writeFileSync(join(env.receiverPaths.processed, filename), JSON.stringify(msgBody));
    writeSenderEvent(env, 'sender', sixDaysAgo, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: true, org: ORG,
    });
    expect(report.result).toBe('VERIFIED');
  });
});

describe('verifyMessage — phantom (P1-P5 PHANTOM)', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { rmSync(env.testDir, { recursive: true, force: true }); });

  // P1 — 2026-04-18 incident regression. The msg_id itself encodes the failure:
  // future epoch-ms by ~5180 s, zero bus-file trace, no sender event. This test
  // must stay green forever; if it ever VERIFIES, the spec or impl regressed.
  it('P1: 2026-04-18 incident msg_id — all 3 checks fail → PHANTOM', () => {
    const phantomId = '1776501820431-joma-7gxmn';
    // Pin now to when the incident was detected — 2026-04-18T07:17:20Z ≈ 1776496640000 ms.
    const incidentNow = 1776496640000;
    const report = verifyMessage(env.receiverPaths, phantomId, {
      recipient: 'ana', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
      now: incidentNow,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.exit_code).toBe(1);
    expect(report.checks.bus_file.passed).toBe(false);
    expect(report.checks.timestamp.passed).toBe(false);
    expect(report.checks.timestamp.skew_seconds).toBeGreaterThan(60);
    // With no analytics file, sender_event is UNVERIFIABLE — but the other two
    // decisive fails still push the verdict to PHANTOM.
    expect(report.checks.sender_event.unverifiable).toBe(true);
  });

  it('P2: fabricated id with current timestamp but no bus file and no sender event → PHANTOM', () => {
    const now = Date.now();
    const fabId = `${now}-sender-zzzzz`;
    // Write an empty events file so sender_event lands FAIL (not UNVERIFIABLE).
    const date = new Date(now).toISOString().split('T')[0];
    const dir = join(env.senderPaths.analyticsDir, 'events', 'sender');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.jsonl`), '');

    const report = verifyMessage(env.receiverPaths, fabId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.checks.bus_file.passed).toBe(false);
    expect(report.checks.timestamp.passed).toBe(true);
    expect(report.checks.sender_event.passed).toBe(false);
    expect(report.checks.sender_event.unverifiable).toBeFalsy();
  });

  it('P3: 10-day-old message fails stale-reuse even when file present → PHANTOM', () => {
    const tenDaysAgo = Date.now() - 10 * 86400000;
    const msgId = `${tenDaysAgo}-sender-bbbbb`;
    const filename = `2-${tenDaysAgo}-from-sender-bbbbb.json`;
    mkdirSync(env.receiverPaths.processed, { recursive: true });
    writeFileSync(join(env.receiverPaths.processed, filename), JSON.stringify({
      id: msgId, from: 'sender', to: 'receiver', priority: 'normal',
      timestamp: new Date(tenDaysAgo).toISOString(), text: 'old', reply_to: null,
    }));
    writeSenderEvent(env, 'sender', tenDaysAgo, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.checks.timestamp.passed).toBe(false);
    expect(report.checks.bus_file.passed).toBe(true);
  });

  it('P4: message in inbox/.errors/ (HMAC-rejected) → PHANTOM', () => {
    const now = Date.now();
    const msgId = `${now}-sender-ccccc`;
    const filename = `2-${now}-from-sender-ccccc.json`;
    const errDir = join(env.receiverPaths.inbox, '.errors');
    mkdirSync(errDir, { recursive: true });
    writeFileSync(join(errDir, filename), JSON.stringify({
      id: msgId, from: 'sender', to: 'receiver', priority: 'normal',
      timestamp: new Date(now).toISOString(), text: 'rejected', reply_to: null,
      sig: 'invalid',
    }));
    writeSenderEvent(env, 'sender', now, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.checks.bus_file.location).toBe('.errors');
  });

  it('P5: msg.from does not match msg_id sender segment → PHANTOM (tampering)', () => {
    const now = Date.now();
    const msgId = `${now}-sender-ddddd`;
    const filename = `2-${now}-from-sender-ddddd.json`;
    mkdirSync(env.receiverPaths.inflight, { recursive: true });
    writeFileSync(join(env.receiverPaths.inflight, filename), JSON.stringify({
      id: msgId, from: 'someone-else', to: 'receiver', priority: 'normal',
      timestamp: new Date(now).toISOString(), text: 'tampered', reply_to: null,
    }));
    writeSenderEvent(env, 'sender', now, msgId);

    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.checks.bus_file.detail).toMatch(/tampering/);
  });
});

describe('verifyMessage — unverifiable (U1-U2) + strict flip', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { rmSync(env.testDir, { recursive: true, force: true }); });

  it('U1: bus file + timestamp pass, sender events file missing → UNVERIFIABLE', () => {
    const msgId = sendMessage(env.senderPaths, 'sender', 'receiver', 'normal', 'hi');
    // Do NOT write the sender events file at all — simulates pre-86bc202 agent.
    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('UNVERIFIABLE');
    expect(report.exit_code).toBe(2);
    expect(report.checks.bus_file.passed).toBe(true);
    expect(report.checks.timestamp.passed).toBe(true);
    expect(report.checks.sender_event.unverifiable).toBe(true);
  });

  it('U1 + --strict → PHANTOM (exit 1)', () => {
    const msgId = sendMessage(env.senderPaths, 'sender', 'receiver', 'normal', 'hi');
    const report = verifyMessage(env.receiverPaths, msgId, {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: true, org: ORG,
    });
    expect(report.result).toBe('PHANTOM');
    expect(report.exit_code).toBe(1);
  });
});

describe('verifyMessage — error (E1-E3)', () => {
  let env: TestEnv;
  beforeEach(() => { env = setupEnv(); });
  afterEach(() => { rmSync(env.testDir, { recursive: true, force: true }); });

  it('E1: malformed msg_id → ERROR (exit 3)', () => {
    const report = verifyMessage(env.receiverPaths, 'not-a-msgid', {
      recipient: 'receiver', maxAgeDays: 7, futureSkewSeconds: 60, strict: false, org: ORG,
    });
    expect(report.result).toBe('ERROR');
    expect(report.exit_code).toBe(3);
  });
});
