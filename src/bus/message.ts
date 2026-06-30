import { readdirSync, readFileSync, renameSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateAgentName, validatePriority } from '../utils/validate.js';

// ---------------------------------------------------------------------------
// Security (H10): HMAC-SHA256 message signing
// ---------------------------------------------------------------------------

/**
 * Load the shared bus signing key from config.
 * Returns null if the key file doesn't exist (legacy installs without signing).
 */
function loadSigningKey(ctxRoot: string): string | null {
  const keyPath = join(ctxRoot, 'config', 'bus-signing-key');
  if (!existsSync(keyPath)) return null;
  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function hmacSign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function hmacVerify(key: string, payload: string, sig: string): boolean {
  const expected = hmacSign(key, payload);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function signPayload(msgId: string, from: string, to: string, text: string): string {
  return `${msgId}:${from}:${to}:${text}`;
}

/**
 * Send a message to another agent's inbox.
 * Creates a JSON file with format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
 * Identical to bash send-message.sh output.
 */
export function sendMessage(
  paths: BusPaths,
  from: string,
  to: string,
  priority: Priority,
  text: string,
  replyTo?: string,
): string {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);

  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;

  // Security (H10): Sign message with HMAC-SHA256.
  const signingKey = loadSigningKey(paths.ctxRoot);
  const message: InboxMessage = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    text,
    reply_to: replyTo || null,
    ...(signingKey ? { sig: hmacSign(signingKey, signPayload(msgId, from, to, text)) } : {}),
  };

  // Write to target agent's inbox
  const inboxDir = join(paths.ctxRoot, 'inbox', to);
  ensureDir(inboxDir);
  atomicWriteSync(join(inboxDir, filename), JSON.stringify(message));

  return msgId;
}

/**
 * Check inbox for pending messages.
 * Reads inbox directory, moves messages to inflight, returns sorted array.
 * Recovers stale inflight messages (>5 minutes old).
 * Identical to bash check-inbox.sh behavior.
 */
export function checkInbox(paths: BusPaths): InboxMessage[] {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  if (!acquireLock(inbox)) {
    return [];
  }

  try {
    // Recover stale inflight messages (>5 min old)
    recoverStaleInflight(inflight, inbox, 300);

    // Read and sort messages by filename (priority then timestamp)
    const files = readdirSync(inbox)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    if (files.length === 0) {
      return [];
    }

    // Security (H10): Load signing key for HMAC verification.
    const signingKey = loadSigningKey(paths.ctxRoot);

    const messages: InboxMessage[] = [];
    for (const file of files) {
      const srcPath = join(inbox, file);
      try {
        const content = readFileSync(srcPath, 'utf-8');
        const msg: InboxMessage = JSON.parse(content);

        // Security (H10): Verify HMAC signature if key is available and message has sig.
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification — rejecting`);
            const errDir = join(inbox, '.errors');
            ensureDir(errDir);
            try { renameSync(srcPath, join(errDir, file)); } catch { /* ignore */ }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          // Signing key exists but message has no sig — legacy message, log warning
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' — accepted (legacy)`);
        }

        // Move to inflight
        const destPath = join(inflight, file);
        renameSync(srcPath, destPath);
        messages.push(msg);
      } catch {
        // Move corrupt files to .errors/
        const errDir = join(inbox, '.errors');
        ensureDir(errDir);
        try {
          renameSync(srcPath, join(errDir, file));
        } catch {
          // Ignore if move fails
        }
      }
    }

    return messages;
  } finally {
    releaseLock(inbox);
  }
}

/**
 * Acknowledge a message by moving it from inflight to processed.
 * Identical to bash ack-inbox.sh behavior.
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inflight, processed } = paths;
  ensureDir(processed);

  // Find the file in inflight that contains this message ID
  let files: string[];
  try {
    files = readdirSync(inflight).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflight, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        renameSync(filePath, join(processed, file));
        return;
      }
    } catch {
      // Skip corrupt files
    }
  }
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime > thresholdSeconds) {
        renameSync(filePath, join(inboxDir, file));
      }
    } catch {
      // Ignore stat/move errors
    }
  }
}

// ---------------------------------------------------------------------------
// Inbox / lock health monitor (Fix C — observability)
//
// A wedged inbox (e.g. a stale lock that `checkInbox` can't acquire) goes
// SILENT — messages pile up and the agent looks idle. This is the day-1
// visibility that would have surfaced the 2026-06-01 codex inbox deadlock
// instead of it festering for 3 days. Read-only; safe to run every heartbeat.
// ---------------------------------------------------------------------------

export type InboxLockState = 'none' | 'pid_alive' | 'pid_dead' | 'pid_corrupt' | 'pid_missing';

export interface InboxHealthRow {
  agent: string;
  depth: number;              // count of deliverable *.json in the inbox
  lock: InboxLockState;       // state of the .lock file
  lockAgeMs: number | null;   // age of the .lock file, or null if none
  legacyLockDir: boolean;     // leftover pre-migration .lock.d directory
  warnings: string[];         // human-readable health warnings (empty = healthy)
}

export interface InboxHealthOpts {
  /** Limit to one agent; omit to scan every agent under inbox/. */
  agent?: string;
  /** WARN above this inbox depth (default 20). */
  depthWarn?: number;
  /** WARN when a LIVE-held lock is older than this (default 10min). */
  lockAgeWarnMs?: number;
}

/**
 * Per-agent inbox depth + lock state. WARN on: deep inbox (consumer not
 * draining), a stale lock (dead/corrupt/pid-less — wedges checkInbox), a live
 * lock held implausibly long, or a leftover .lock.d from before the migration.
 */
export function checkInboxHealth(ctxRoot: string, opts: InboxHealthOpts = {}): InboxHealthRow[] {
  const depthWarn = opts.depthWarn ?? 20;
  const lockAgeWarnMs = opts.lockAgeWarnMs ?? 10 * 60_000;
  const inboxRoot = join(ctxRoot, 'inbox');

  let agents: string[];
  if (opts.agent) {
    agents = [opts.agent];
  } else {
    try {
      agents = readdirSync(inboxRoot).filter(a => {
        try { return statSync(join(inboxRoot, a)).isDirectory(); } catch { return false; }
      });
    } catch {
      agents = [];
    }
  }

  const rows: InboxHealthRow[] = [];
  for (const agent of agents) {
    const dir = join(inboxRoot, agent);

    let depth = 0;
    try {
      depth = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.')).length;
    } catch { /* inbox dir gone — depth 0 */ }

    let lock: InboxLockState = 'none';
    let lockAgeMs: number | null = null;
    const lockFile = join(dir, '.lock');
    try {
      lockAgeMs = Date.now() - statSync(lockFile).mtimeMs;
      const raw = readFileSync(lockFile, 'utf-8').trim();
      if (raw === '') {
        lock = 'pid_missing';
      } else {
        const pid = parseInt(raw, 10);
        if (Number.isNaN(pid)) {
          lock = 'pid_corrupt';
        } else {
          try { process.kill(pid, 0); lock = 'pid_alive'; }
          catch { lock = 'pid_dead'; }
        }
      }
    } catch { /* no .lock file */ }

    const legacyLockDir = existsSync(join(dir, '.lock.d'));

    const warnings: string[] = [];
    if (depth > depthWarn) warnings.push(`inbox depth ${depth} > ${depthWarn} (consumer not draining?)`);
    if (lock === 'pid_dead' || lock === 'pid_corrupt' || lock === 'pid_missing') {
      warnings.push(`stale lock (${lock}) — wedges checkInbox`);
    }
    if (lock === 'pid_alive' && lockAgeMs !== null && lockAgeMs > lockAgeWarnMs) {
      warnings.push(`lock held ${Math.round(lockAgeMs / 60_000)}min > ${Math.round(lockAgeWarnMs / 60_000)}min`);
    }
    if (legacyLockDir) warnings.push('legacy .lock.d present (pre-migration leftover — safe to remove)');

    rows.push({ agent, depth, lock, lockAgeMs, legacyLockDir, warnings });
  }
  return rows;
}
