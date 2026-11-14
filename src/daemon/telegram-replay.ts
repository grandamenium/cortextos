/**
 * Telegram replay + stale-task warning + downtime detection on session start.
 *
 * theta 63 — see docs/architecture/telegram-replay-session-start.md.
 *
 * `fast-checker` injects inbound Telegram into the live PTY as messages arrive,
 * and every inbound is archived to `{ctxRoot}/logs/<agent>/inbound-messages.jsonl`
 * by `recordInboundTelegram()`. But if the PTY is not alive at inject time
 * (stop / restart / crash-recovery window) the archive lands and the injection
 * is dropped — silent message loss. `check-inbox` only covers a2a bus messages.
 *
 * This module replays the archive on session start, bounded by a per-chat
 * watermark cursor + a 24h time window + a per-chat count cap, and separately
 * warns about stale in-progress tasks and multi-hour downtime.
 *
 * The core selection logic (`selectMissed`) is pure and dependency-injected so
 * it is unit-testable without a live daemon; the orchestrators take an `inject`
 * callback (mirroring `AgentProcess.injectMessage(content): boolean`).
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { listTasks } from '../bus/task.js';
import { logEvent } from '../bus/event.js';
import type { BusPaths, EventCategory, EventSeverity } from '../types/index.js';

// ---------------------------------------------------------------------------
// Constants (tuneable; some are exposed as knobs on the deps objects)
// ---------------------------------------------------------------------------

export const CURSOR_FILE = 'telegram-cursor.json';
const HEARTBEAT_FILE = 'heartbeat.json';
const INBOUND_FILE = 'inbound-messages.jsonl';

export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h time cap
export const REPLAY_PER_CHAT_CAP = 100; // freshest N per chat
export const DOWNTIME_WARN_HOURS = 4; // gap > this → [STARTUP] warning
export const STALE_TASK_HOURS = 2; // in_progress older than this → warn

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of the inbound JSONL schema this module reads. The archive also
 * carries `from`, `has_media`, `file_id`, `file_size`, `mime_type`, `timestamp`,
 * `agent` — see src/telegram/logging.ts. We tolerate extra/missing fields.
 */
export interface InboundEntry {
  message_id: number;
  chat_id: number | string;
  from_name?: string;
  text?: string;
  has_media?: boolean;
  media_type?: string | null;
  file_name?: string;
  duration?: number;
  transcript?: string;
  archived_at: string; // ISO 8601
}

/** chat_id (as string key) -> last processed message_id. */
export type TelegramCursor = Record<string, number>;

type Emit = (category: EventCategory, event: string, severity: EventSeverity, meta: Record<string, unknown>) => void;

export interface ReplayDeps {
  stateDir: string;
  logDir: string;
  paths: BusPaths;
  agentName: string;
  org: string;
  /** Injects into the live PTY; returns true on success (dedup/PTY-down → false). */
  inject: (content: string) => boolean;
  /** Injectable clock (ms since epoch). */
  now: number;
  windowMs?: number;
  perChatCap?: number;
  downtimeThresholdH?: number;
  /** Defaults to a `logEvent` wrapper; injectable for tests. */
  emit?: Emit;
  log?: (m: string) => void;
}

export interface WarnStaleDeps {
  paths: BusPaths;
  agentName: string;
  org: string;
  inject: (content: string) => boolean;
  now: number;
  thresholdHours?: number;
  emit?: Emit;
  log?: (m: string) => void;
}

// ---------------------------------------------------------------------------
// chat_id normalization — JSON object keys are always strings, and Telegram
// group ids look like -1003928420107. Casting on every read/write avoids the
// int-vs-string key mismatch that would double-inject (design test 10).
// ---------------------------------------------------------------------------

export function chatKey(chatId: number | string): string {
  return String(chatId);
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

export function cursorPath(stateDir: string): string {
  return join(stateDir, CURSOR_FILE);
}

export function readCursor(stateDir: string): TelegramCursor {
  const p = cursorPath(stateDir);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Normalize values to numbers; drop anything non-numeric.
    const out: TelegramCursor = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write. May throw (e.g. ENOSPC) — callers decide how to degrade. */
export function writeCursorAtomic(stateDir: string, cursor: TelegramCursor): void {
  atomicWriteSync(cursorPath(stateDir), JSON.stringify(cursor, null, 2));
}

/**
 * Advance the live cursor for a message the live pipeline handled. Called from
 * the daemon's Telegram handler after a successful queue while the PTY is up,
 * so that the same message is not re-surfaced by replay on the next start.
 * Best-effort: swallows write errors (a missed advance only risks one idempotent
 * double-replay, never a lost message).
 */
export function advanceCursorLive(stateDir: string, chatId: number | string, messageId: number): void {
  if (!Number.isFinite(messageId)) return;
  const cursor = readCursor(stateDir);
  const k = chatKey(chatId);
  if ((cursor[k] ?? 0) >= messageId) return;
  cursor[k] = messageId;
  try {
    writeCursorAtomic(stateDir, cursor);
  } catch {
    /* best-effort; replay + idempotency cover a missed advance */
  }
}

// ---------------------------------------------------------------------------
// Archive scan + selection (pure core)
// ---------------------------------------------------------------------------

export function tailScanInbound(logDir: string): InboundEntry[] {
  const p = join(logDir, INBOUND_FILE);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch {
    return [];
  }
  const out: InboundEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e == null || typeof e.message_id !== 'number' || e.chat_id == null || typeof e.archived_at !== 'string') {
        continue; // skip malformed / non-message lines
      }
      out.push(e as InboundEntry);
    } catch {
      continue;
    }
  }
  return out;
}

/** Max message_id per chat over all entries — used to seed the first-run cursor. */
export function maxPerChat(entries: InboundEntry[]): TelegramCursor {
  const out: TelegramCursor = {};
  for (const e of entries) {
    const k = chatKey(e.chat_id);
    if ((out[k] ?? 0) < e.message_id) out[k] = e.message_id;
  }
  return out;
}

/**
 * Pure selection: entries strictly newer than the cursor for their chat, within
 * the time window, capped to the freshest `perChatCap` per chat, returned in
 * global archived_at ASC order (chronological across chats).
 */
export function selectMissed(
  entries: InboundEntry[],
  cursor: TelegramCursor,
  nowMs: number,
  windowMs: number = REPLAY_WINDOW_MS,
  perChatCap: number = REPLAY_PER_CHAT_CAP,
): InboundEntry[] {
  const windowStart = nowMs - windowMs;
  const eligible = entries.filter((e) => {
    const seen = cursor[chatKey(e.chat_id)] ?? 0;
    if (e.message_id <= seen) return false;
    const t = Date.parse(e.archived_at);
    return Number.isFinite(t) && t >= windowStart;
  });

  // Per-chat cap: keep the freshest `perChatCap` by (archived_at, message_id).
  const byChat = new Map<string, InboundEntry[]>();
  for (const e of eligible) {
    const k = chatKey(e.chat_id);
    const arr = byChat.get(k) ?? [];
    arr.push(e);
    byChat.set(k, arr);
  }
  const capped: InboundEntry[] = [];
  for (const arr of byChat.values()) {
    arr.sort(cmpChrono);
    // freshest N = tail after ASC sort
    capped.push(...(arr.length > perChatCap ? arr.slice(arr.length - perChatCap) : arr));
  }
  capped.sort(cmpChrono);
  return capped;
}

function cmpChrono(a: InboundEntry, b: InboundEntry): number {
  const ta = Date.parse(a.archived_at);
  const tb = Date.parse(b.archived_at);
  if (ta !== tb) return ta - tb;
  return a.message_id - b.message_id; // stable tiebreak
}

// ---------------------------------------------------------------------------
// Downtime detection (reuses heartbeat.json last_heartbeat — the existing
// liveness signal — rather than a new last-alive.txt written on every tick)
// ---------------------------------------------------------------------------

export function getLastAliveMs(stateDir: string): number | null {
  const p = join(stateDir, HEARTBEAT_FILE);
  if (!existsSync(p)) return null;
  try {
    const hb = JSON.parse(readFileSync(p, 'utf-8'));
    const t = Date.parse(hb?.last_heartbeat ?? '');
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function detectDowntimeHours(lastAliveMs: number | null, nowMs: number): number {
  if (lastAliveMs == null) return 0; // unknown liveness → don't cry downtime
  const gapMs = nowMs - lastAliveMs;
  return gapMs > 0 ? gapMs / (60 * 60 * 1000) : 0;
}

// ---------------------------------------------------------------------------
// Replay formatter — a dedicated, self-contained formatter marked [REPLAYED].
// We do NOT reuse the FastChecker media formatters: the archive stores file_id
// / file_name / mime_type but NOT the downloaded local path (media is fetched
// live and may be gone after a downtime window), so media replays surface as a
// note. The [REPLAYED archived_at] prefix also salts the content past the two
// dedup layers (AgentProcess MessageDedup + FastChecker SHA-256) that would
// otherwise swallow a byte-identical re-inject.
// ---------------------------------------------------------------------------

export function formatReplayEntry(entry: InboundEntry): string {
  const from = entry.from_name || 'Unknown';
  const chatId = entry.chat_id;
  let body: string;
  if (entry.has_media && entry.media_type) {
    const parts = [`[media: ${entry.media_type}]`];
    if (entry.file_name) parts.push(`file: ${entry.file_name}`);
    if (entry.text) parts.push(`caption: ${entry.text}`);
    if (entry.transcript) parts.push(`transcript: ${entry.transcript}`);
    parts.push('(archived during downtime; file not re-downloaded — ask sender to resend if you need it)');
    body = parts.join(' ');
  } else {
    body = entry.text || '(empty message)';
  }
  return `=== TELEGRAM (REPLAYED ${entry.archived_at}) from ${from} (chat_id:${chatId}) ===
${body}
Reply using: cortextos bus send-telegram ${chatId} "<reply>"

`;
}

// ---------------------------------------------------------------------------
// Default event emitter
// ---------------------------------------------------------------------------

function defaultEmit(paths: BusPaths, agentName: string, org: string): Emit {
  return (category, event, severity, meta) => {
    try {
      logEvent(paths, agentName, org, category, event, severity, meta);
    } catch {
      /* telemetry must never break the replay path */
    }
  };
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export interface ReplayResult {
  replayed: number;
  downtimeHours: number;
  firstRun: boolean;
}

/**
 * Replay missed Telegram messages on session start. Fires after the PTY is
 * bootstrapped, before/around the first live Telegram poll.
 */
export function replayMissedTelegram(deps: ReplayDeps): ReplayResult {
  const {
    stateDir, logDir, paths, agentName, org, inject, now,
    windowMs = REPLAY_WINDOW_MS,
    perChatCap = REPLAY_PER_CHAT_CAP,
    downtimeThresholdH = DOWNTIME_WARN_HOURS,
    log = () => {},
  } = deps;
  const emit = deps.emit ?? defaultEmit(paths, agentName, org);

  const entries = tailScanInbound(logDir);
  const cursorExists = existsSync(cursorPath(stateDir));

  // First run: no cursor → establish the watermark at the current max per chat
  // and skip replay ("start-from-now"). Prevents replaying the entire archive
  // the first time the feature ships.
  if (!cursorExists) {
    try {
      writeCursorAtomic(stateDir, maxPerChat(entries));
    } catch (e) {
      log(`[telegram-replay] first-run cursor init failed: ${e}`);
    }
    return { replayed: 0, downtimeHours: 0, firstRun: true };
  }

  const cursor = readCursor(stateDir);
  const missed = selectMissed(entries, cursor, now, windowMs, perChatCap);
  if (missed.length === 0) {
    return { replayed: 0, downtimeHours: 0, firstRun: false };
  }

  const downtimeHours = detectDowntimeHours(getLastAliveMs(stateDir), now);
  if (downtimeHours > downtimeThresholdH) {
    inject(
      `[STARTUP] Detected ${downtimeHours.toFixed(1)}h downtime. Replaying ${missed.length} missed Telegram message(s) (bounded to last 24h, ${perChatCap}/chat).`,
    );
    emit('action', 'downtime_detected', 'warning', { downtime_hours: downtimeHours, missed_count: missed.length });
  }

  let replayed = 0;
  for (const entry of missed) {
    const formatted = formatReplayEntry(entry);
    if (!inject(formatted)) continue; // PTY down / deduped — leave cursor, retry next start
    const k = chatKey(entry.chat_id);
    cursor[k] = Math.max(cursor[k] ?? 0, entry.message_id);
    try {
      writeCursorAtomic(stateDir, cursor);
    } catch (e) {
      // Cursor advance failed (e.g. ENOSPC). The message was injected but the
      // watermark did not persist; stop here so we don't inject a burst we
      // cannot checkpoint. Next start re-processes from the last durable cursor
      // (agent side is idempotent on message_id).
      log(`[telegram-replay] cursor write failed after inject, halting replay: ${e}`);
      break;
    }
    emit('message', 'telegram_replayed', 'info', {
      chat_id: entry.chat_id,
      message_id: entry.message_id,
      archived_at: entry.archived_at,
    });
    replayed++;
  }

  return { replayed, downtimeHours, firstRun: false };
}

export interface WarnStaleResult {
  stale: number;
}

/**
 * Warn (do not act) about in-progress tasks whose `updated_at` is older than
 * `thresholdHours`. Surfaces work orphaned by a restart. Signal only — never
 * auto-resumes, auto-completes, or auto-drops.
 */
export function warnStaleTasks(deps: WarnStaleDeps): WarnStaleResult {
  const { paths, agentName, org, inject, now, thresholdHours = STALE_TASK_HOURS, log = () => {} } = deps;
  const emit = deps.emit ?? defaultEmit(paths, agentName, org);

  let inProg;
  try {
    inProg = listTasks(paths, { status: 'in_progress' });
  } catch (e) {
    log(`[stale-tasks] listTasks failed: ${e}`);
    return { stale: 0 };
  }
  const cutoff = now - thresholdHours * 60 * 60 * 1000;
  const stale = inProg.filter((t) => {
    const u = Date.parse(t.updated_at);
    return Number.isFinite(u) && u < cutoff;
  });
  if (stale.length === 0) return { stale: 0 };

  const ids = stale.slice(0, 10).map((t) => t.id).join(', ');
  const more = stale.length > 10 ? ` (+${stale.length - 10} more)` : '';
  inject(
    `[STALE-TASKS] ${stale.length} in-progress task(s) with updated_at > ${thresholdHours}h ago: ${ids}${more}. Review — resume, complete, or drop.`,
  );
  emit('task', 'stale_tasks_warned', 'warning', { count: stale.length });
  return { stale: stale.length };
}
