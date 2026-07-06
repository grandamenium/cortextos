import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkAndRecord,
  dedupKey,
  removeRecord,
} from '../../../src/telegram/dedup';

describe('telegram dedup rollback', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-tg-dedup-rollback-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  function ledgerPath(): string {
    return join(ctxRoot, 'state', 'telegram-dedup.json');
  }

  function readLedger(): Record<string, number> {
    return JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as Record<string, number>;
  }

  it('allows a retry after the recorded message is rolled back', () => {
    const first = checkAndRecord(ctxRoot, 'chat-a', 'critical alert', 21_600);
    expect(first).toEqual({ duplicate: false });

    removeRecord(ctxRoot, 'chat-a', 'critical alert');

    const second = checkAndRecord(ctxRoot, 'chat-a', 'critical alert', 21_600);
    expect(second).toEqual({ duplicate: false });
  });

  it('still suppresses a duplicate when there is no rollback', () => {
    checkAndRecord(ctxRoot, 'chat-a', 'critical alert', 21_600);

    const duplicate = checkAndRecord(ctxRoot, 'chat-a', 'critical alert', 21_600);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.ageSec).toBeDefined();
  });

  it('removes only the targeted chat/body key', () => {
    checkAndRecord(ctxRoot, 'chat-a', 'critical alert', 21_600);
    checkAndRecord(ctxRoot, 'chat-b', 'critical alert', 21_600);

    removeRecord(ctxRoot, 'chat-a', 'critical alert');

    expect(readLedger()).toEqual({
      [dedupKey('chat-b', 'critical alert')]: expect.any(Number),
    });
  });

  it('is a no-op when the targeted key is absent', () => {
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify({}, null, 2), 'utf-8');

    removeRecord(ctxRoot, 'chat-a', 'critical alert');

    expect(readLedger()).toEqual({});
  });
});
