import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

export interface DedupResult {
  duplicate: boolean;
  ageSec?: number;
}

type DedupLedger = Record<string, number>;

export function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}

export function dedupKey(chatId: string, body: string): string {
  return createHash('sha256')
    .update(`${chatId}\n${normalizeBody(body)}`)
    .digest('hex');
}

function isDedupLedger(value: unknown): value is DedupLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function readLedger(filePath: string): DedupLedger {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    return isDedupLedger(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dedupLockDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.locks', 'telegram-dedup');
}

export function checkAndRecord(
  ctxRoot: string,
  chatId: string,
  body: string,
  windowSec: number,
): DedupResult {
  const ledgerPath = join(ctxRoot, 'state', 'telegram-dedup.json');
  const lockDir = dedupLockDir(ctxRoot);
  const now = Math.floor(Date.now() / 1000);
  const pruneAfterSec = Math.max(windowSec, 86400);
  const key = dedupKey(chatId, body);
  ensureDir(dirname(ledgerPath));
  ensureDir(lockDir);

  return withFileLockSync(lockDir, () => {
    const ledger = readLedger(ledgerPath);

    const nextLedger = Object.fromEntries(
      Object.entries(ledger).filter(([, firstSentAt]) => now - firstSentAt <= pruneAfterSec),
    ) as DedupLedger;

    const firstSentAt = nextLedger[key];
    if (firstSentAt !== undefined) {
      const ageSec = now - firstSentAt;
      if (ageSec < windowSec) {
        return { duplicate: true, ageSec };
      }
    }

    nextLedger[key] = now;
    atomicWriteSync(ledgerPath, JSON.stringify(nextLedger, null, 2), /* keepBak= */ true);
    return { duplicate: false };
  });
}

export function removeRecord(ctxRoot: string, chatId: string, body: string): void {
  const ledgerPath = join(ctxRoot, 'state', 'telegram-dedup.json');
  const lockDir = dedupLockDir(ctxRoot);
  const key = dedupKey(chatId, body);
  ensureDir(dirname(ledgerPath));
  ensureDir(lockDir);

  withFileLockSync(lockDir, () => {
    const ledger = readLedger(ledgerPath);
    if (ledger[key] === undefined) {
      return;
    }
    delete ledger[key];
    atomicWriteSync(ledgerPath, JSON.stringify(ledger, null, 2), /* keepBak= */ true);
  });
}
