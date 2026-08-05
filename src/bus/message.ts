import { readdirSync, readFileSync, renameSync, statSync, existsSync, unlinkSync } from 'fs';
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

  // A reply IS proof the replied-to message was delivered and read: ack the
  // original in the sender's own inflight/inbox. reply_to was previously
  // stored as metadata only, so every replied-to message redelivered after
  // 5 minutes (D1, 2026-07-10).
  if (replyTo) {
    try {
      ackInbox(paths, replyTo);
    } catch {
      // Best-effort: a missing or already-acked original must not fail the send.
    }
  }

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
 * Acknowledge a message by moving it to processed.
 *
 * Scans BOTH inflight and inbox: a message recovered by recoverStaleInflight
 * sits back in inbox — an explicit ack while it waits there used to be a
 * silent no-op, so the message redelivered anyway (D3, 2026-07-10).
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inflight, inbox, processed } = paths;
  ensureDir(processed);

  for (const dir of [inflight, inbox]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const msg = JSON.parse(content);
        if (msg.id === messageId) {
          renameSync(filePath, join(processed, file));
          clearDeferredMarker(inflight, file);
          return;
        }
      } catch {
        // Skip corrupt files
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred-confirmation markers (G-D2-6/G-D2-7, 2026-07-10)
//
// A message injected into an alive-but-mid-turn session is held in
// DEFERRED_CONFIRM by the daemon: its content is queued in the CLI input box
// and will flush at the next turn boundary, so it must NOT be recovered and
// re-injected by the 300s stale-inflight sweep — that recreates the exact
// redelivery loop the deferral exists to kill. The exemption lives HERE
// because agent CLIs call recoverStaleInflight via every check-inbox, not
// just the daemon.
//
// Markers are plain files in <inflight>/.deferred/<message-filename>.json and
// carry the ORIGINAL hold deadline. They are a pure function of visible state
// (rebuild-on-boot; cannot leak by construction): the daemon rederives its
// watch list from them, and a marker whose deadline passed — or whose message
// file is gone — is deleted on sight by the sweep itself.
// ---------------------------------------------------------------------------

export interface DeferredMarker {
  /** ms epoch when the paste was injected (hold START — never refreshed). */
  injectedAt: number;
  /** ms epoch when the G-D2-5 timeout expires (original clock; a daemon
   *  restart mid-hold must honor this, not stamp a fresh one). */
  deadline: number;
  /** sha256 of the injected content block, for confirm attribution. */
  contentSha: string;
  /** The injected content block, so a rebooted daemon can resume the
   *  substring-attribution check for this hold. Same trust boundary as the
   *  message file sitting next to it. */
  content: string;
}

function deferredDir(inflightDir: string): string {
  return join(inflightDir, '.deferred');
}

export function writeDeferredMarker(inflightDir: string, messageFile: string, marker: DeferredMarker): void {
  const dir = deferredDir(inflightDir);
  ensureDir(dir);
  atomicWriteSync(join(dir, `${messageFile}.marker`), JSON.stringify(marker));
}

export function clearDeferredMarker(inflightDir: string, messageFile: string): void {
  try {
    unlinkSync(join(deferredDir(inflightDir), `${messageFile}.marker`));
  } catch {
    // Already gone — fine.
  }
}

export function readDeferredMarker(inflightDir: string, messageFile: string): DeferredMarker | null {
  try {
    return JSON.parse(readFileSync(join(deferredDir(inflightDir), `${messageFile}.marker`), 'utf-8'));
  } catch {
    return null;
  }
}

/** List all live markers (message file still present). Orphans are deleted. */
export function listDeferredMarkers(inflightDir: string): Array<{ messageFile: string; marker: DeferredMarker }> {
  const dir = deferredDir(inflightDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.marker'));
  } catch {
    return [];
  }
  const out: Array<{ messageFile: string; marker: DeferredMarker }> = [];
  for (const f of files) {
    const messageFile = f.slice(0, -'.marker'.length);
    const marker = readDeferredMarker(inflightDir, messageFile);
    if (!marker || !existsSync(join(inflightDir, messageFile))) {
      // Orphan (unreadable, or its message was acked/recovered without cleanup).
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      continue;
    }
    out.push({ messageFile, marker });
  }
  return out;
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 * Messages under an active deferred-confirmation hold are exempt until their
 * ORIGINAL deadline passes (G-D2-6); expired or orphaned markers are removed.
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
): void {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const marker = readDeferredMarker(inflightDir, file);
      if (marker) {
        if (nowMs < marker.deadline) {
          continue; // active hold — exempt from recovery
        }
        clearDeferredMarker(inflightDir, file); // hold expired — normal recovery resumes
      }
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime > thresholdSeconds) {
        renameSync(filePath, join(inboxDir, file));
      }
    } catch {
      // Ignore stat/move errors
    }
  }

  // GC markers whose message file is gone (acked or recovered elsewhere).
  listDeferredMarkers(inflightDir);
}
