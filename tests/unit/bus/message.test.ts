import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Worker } from 'worker_threads';
import { sendMessage, checkInbox, ackInbox } from '../../../src/bus/message';
import { acquireLock } from '../../../src/utils/lock';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });

    it('recovers from a stale wedged lock instead of returning []', () => {
      // Regression: a holder that crashed between mkdir and the pid write
      // left a 0-byte pid .lock.d that wedged the inbox forever — every
      // check-inbox silently returned [] while messages sat in inbox/.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'wedged');

        const lockDir = join(receiverPaths.inbox, '.lock.d');
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, 'pid'), '');
        const old = new Date(Date.now() - 120_000); // past the 60s stale default
        utimesSync(lockDir, old, old);

        const messages = checkInbox(receiverPaths);
        expect(messages.length).toBe(1);
        expect(messages[0].text).toBe('wedged');
      } finally {
        warn.mockRestore();
      }
    });

    it('waits out a briefly-held lock and returns real messages', async () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'delayed');

      // Hold the inbox lock from this (live) process — young + alive, so it
      // is NOT reclaimable; checkInbox must sit in its retry loop. A worker
      // thread (own event loop, unaffected by the sync-blocked main thread)
      // releases the lock after ~300ms.
      expect(acquireLock(receiverPaths.inbox)).toBe(true);
      const lockDir = join(receiverPaths.inbox, '.lock.d');
      const worker = new Worker(
        `const { rmSync } = require('fs');
         const { workerData } = require('worker_threads');
         setTimeout(() => rmSync(workerData.lockDir, { recursive: true, force: true }), 300);`,
        { eval: true, workerData: { lockDir } },
      );
      try {
        const messages = checkInbox(receiverPaths);
        expect(messages.length).toBe(1);
        expect(messages[0].text).toBe('delayed');
      } finally {
        await worker.terminate();
      }
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed and returns true', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      expect(ackInbox(receiverPaths, msgId)).toBe(true);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });

    it('returns false when the id is not in inflight (ack miss)', () => {
      expect(ackInbox(receiverPaths, 'no-such-id')).toBe(false);
    });

    it('returns false for a message never checked out of the inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'unread');
      // No checkInbox: the message is still in inbox/, not inflight/.
      expect(ackInbox(receiverPaths, msgId)).toBe(false);
      // ...and the file must still be sitting in the inbox, untouched.
      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      expect(inboxFiles.length).toBe(1);
    });

    it('returns false on double-ack', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'once');
      checkInbox(receiverPaths);
      expect(ackInbox(receiverPaths, msgId)).toBe(true);
      expect(ackInbox(receiverPaths, msgId)).toBe(false);
    });
  });
});
