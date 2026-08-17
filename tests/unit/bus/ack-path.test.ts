import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  sendMessage, checkInbox, ackInbox,
  writeDeferredMarker, readDeferredMarker, clearDeferredMarker, listDeferredMarkers,
} from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

/**
 * ACKFIX regression spec (ACKFIX_REQUIREMENTS.md, 2026-07-10) — bus half:
 *   G-REG-1  reply acks the original at send time (D1)
 *   G-REG-2  explicit ack works from BOTH inflight and inbox (D3)
 *   G-REG-7  deferred messages are exempt from 300s stale-inflight recovery (G-D2-6)
 *   G-REG-8  marker cleanup on both exit paths + ORIGINAL deadline preserved (G-D2-7)
 */

function mkPaths(root: string, agent: string): BusPaths {
  const p = {
    ctxRoot: root,
    inbox: join(root, 'inbox', agent),
    inflight: join(root, 'inflight', agent),
    processed: join(root, 'processed', agent),
    stateDir: join(root, 'state', agent),
  } as unknown as BusPaths;
  for (const d of [p.inbox, p.inflight, (p as { processed: string }).processed, (p as { stateDir: string }).stateDir]) {
    mkdirSync(d, { recursive: true });
  }
  return p;
}

/** Age a file's mtime so recoverStaleInflight sees it as stale. */
function ageFile(path: string, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(path, t, t);
}

describe('ACKFIX bus regression', () => {
  let root: string;
  let alice: BusPaths; // original sender
  let bob: BusPaths;   // recipient / replier

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-ackfix-'));
    alice = mkPaths(root, 'alice');
    bob = mkPaths(root, 'bob');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('G-REG-1: sending a reply acks the original in the REPLIER inflight at send time', () => {
    const origId = sendMessage(alice, 'alice', 'bob', 'normal', 'ping');
    const got = checkInbox(bob); // bob reads: message moves to bob's inflight
    expect(got.map(m => m.id)).toEqual([origId]);
    expect(readdirSync(bob.inflight).filter(f => f.endsWith('.json'))).toHaveLength(1);

    sendMessage(bob, 'bob', 'alice', 'normal', 'pong', origId);

    // Original left bob's inflight for processed — no 5-min redelivery.
    expect(readdirSync(bob.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync((bob as unknown as { processed: string }).processed)).toHaveLength(1);
  });

  it('G-REG-1: a reply_to that matches nothing does not break the send', () => {
    const id = sendMessage(bob, 'bob', 'alice', 'normal', 'reply to ghost', 'no-such-id');
    expect(id).toBeTruthy();
    expect(checkInbox(alice)).toHaveLength(1);
  });

  it('G-REG-2: explicit ack succeeds while the message sits in inflight AND after recovery to inbox', () => {
    // inflight case
    const id1 = sendMessage(alice, 'alice', 'bob', 'normal', 'one');
    checkInbox(bob);
    ackInbox(bob, id1);
    expect(readdirSync(bob.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);

    // recovered-to-inbox case: deliver, move to inflight, age past 300s, let
    // checkInbox recover it back to inbox, then ack — pre-fix this no-oped.
    const id2 = sendMessage(alice, 'alice', 'bob', 'normal', 'two');
    checkInbox(bob);
    const file = readdirSync(bob.inflight).filter(f => f.endsWith('.json'))[0];
    ageFile(join(bob.inflight, file), 400);
    checkInbox(bob); // recovery sweep moves it to inbox (and re-reads it)
    ackInbox(bob, id2);
    expect(readdirSync(bob.inbox).filter(f => f.endsWith('.json') && !f.startsWith('.'))).toHaveLength(0);
    expect(readdirSync(bob.inflight).filter(f => f.endsWith('.json'))).toHaveLength(0);
    expect(readdirSync((bob as unknown as { processed: string }).processed)).toHaveLength(2);
  });

  it('G-REG-7: a deferred message aged past 300s is NOT recovered while its hold is active', () => {
    const id = sendMessage(alice, 'alice', 'bob', 'normal', 'held payload');
    checkInbox(bob);
    const file = readdirSync(bob.inflight).filter(f => f.endsWith('.json'))[0];
    ageFile(join(bob.inflight, file), 400); // stale by mtime
    writeDeferredMarker(bob.inflight, file, {
      injectedAt: Date.now() - 400_000,
      deadline: Date.now() + 200_000, // hold still active
      contentSha: 'a'.repeat(64),
      content: 'held payload block',
    });

    const recovered = checkInbox(bob); // recovery sweep runs inside — must skip the held file
    expect(recovered).toHaveLength(0);
    expect(readdirSync(bob.inflight).filter(f => f.endsWith('.json'))).toHaveLength(1);
    expect(readDeferredMarker(bob.inflight, file)).not.toBeNull();
    void id;
  });

  it('G-REG-7/G-D2-5: once the hold deadline passes, recovery resumes and the message redelivers', () => {
    const id = sendMessage(alice, 'alice', 'bob', 'normal', 'timed out payload');
    checkInbox(bob);
    const file = readdirSync(bob.inflight).filter(f => f.endsWith('.json'))[0];
    ageFile(join(bob.inflight, file), 400);
    writeDeferredMarker(bob.inflight, file, {
      injectedAt: Date.now() - 700_000,
      deadline: Date.now() - 100_000, // expired hold
      contentSha: 'b'.repeat(64),
      content: 'x',
    });

    const redelivered = checkInbox(bob); // sweep clears expired marker, recovers, re-reads
    expect(redelivered.map(m => m.id)).toEqual([id]);
    expect(readDeferredMarker(bob.inflight, file)).toBeNull();
  });

  it('G-REG-8: ack during a hold clears the marker (confirm exit path)', () => {
    const id = sendMessage(alice, 'alice', 'bob', 'normal', 'confirming');
    checkInbox(bob);
    const file = readdirSync(bob.inflight).filter(f => f.endsWith('.json'))[0];
    writeDeferredMarker(bob.inflight, file, {
      injectedAt: Date.now(), deadline: Date.now() + 600_000, contentSha: 'c'.repeat(64), content: 'y',
    });
    ackInbox(bob, id);
    expect(readDeferredMarker(bob.inflight, file)).toBeNull();
    expect(existsSync(join(bob.inflight, '.deferred', `${file}.marker`))).toBe(false);
  });

  it('G-REG-8: markers survive "restart" with the ORIGINAL deadline — never refreshed', () => {
    sendMessage(alice, 'alice', 'bob', 'normal', 'restart survivor');
    checkInbox(bob);
    const file = readdirSync(bob.inflight).filter(f => f.endsWith('.json'))[0];
    const injectedAt = Date.now() - 120_000;
    const deadline = injectedAt + 600_000;
    writeDeferredMarker(bob.inflight, file, { injectedAt, deadline, contentSha: 'd'.repeat(64), content: 'z' });

    // A rebooted daemon rederives its watch list from listDeferredMarkers:
    const rebuilt = listDeferredMarkers(bob.inflight);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].marker.deadline).toBe(deadline);     // original clock (G-D2-7)
    expect(rebuilt[0].marker.injectedAt).toBe(injectedAt); // hold START preserved
  });

  it('G-REG-8: orphan markers (message file gone) are garbage-collected', () => {
    mkdirSync(join(bob.inflight, '.deferred'), { recursive: true });
    writeFileSync(
      join(bob.inflight, '.deferred', 'no-such-message.json.marker'),
      JSON.stringify({ injectedAt: 1, deadline: 2, contentSha: 'e'.repeat(64), content: 'w' }),
    );
    expect(listDeferredMarkers(bob.inflight)).toHaveLength(0); // orphan pruned on sight
    expect(existsSync(join(bob.inflight, '.deferred', 'no-such-message.json.marker'))).toBe(false);
  });

  it('clearDeferredMarker is idempotent', () => {
    clearDeferredMarker(bob.inflight, 'never-existed.json');
  });
});
