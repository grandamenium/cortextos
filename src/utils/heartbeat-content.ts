/**
 * heartbeat-content.ts — Pure heartbeat-content normalization for the recovery
 * watchdog's content-freshness gate. Side-effect-free, no I/O, unit-testable
 * with plain inputs (mirrors the shape of dormancy.ts).
 *
 * WHY THIS EXISTS (see recovery-watchdog.ts C1/C2): the fast-checker writes a
 * daemon-side idle-beat ("[watchdog] <agent> alive — idle session
 * <ts>") every ~50min regardless of REPL state, so `last_heartbeat` stays fresh
 * even when the agent brain is wedged. Timestamp-based staleness therefore
 * cannot see a mapped wedge. The watchdog instead tracks whether the SEMANTIC
 * content of the heartbeat (status + current_task) is frozen across a window.
 *
 * The normalizer strips every field that changes on its own without the agent's
 * brain doing anything:
 *   - `last_heartbeat` / `timestamp` / `mode` / `loop_interval` — excluded
 *     entirely (never read).
 *   - ISO-8601 timestamps embedded inside `status` / `current_task` — collapsed
 *     to a constant token, so a spawn that re-stamps the same text does not read
 *     as fresh content ("spawn-carry").
 *   - a daemon idle-beat `status` — collapsed to the WATCHDOG_IDLE constant,
 *     so the ~50min daemon beat (whose only moving part is its timestamp) does
 *     not read as fresh content either.
 *
 * The same normalizer feeds BOTH detection (FrozenContentTrigger: content
 * unchanged across the freeze window) AND recovery-verification (did a restart
 * produce genuinely different content — see `contentDiffers`).
 */

import type { Heartbeat } from '../types/index.js';

/**
 * Canonical token for a heartbeat whose `status` is the daemon's idle-beat.
 * Any two idle-beat heartbeats normalize to this SAME value, so an
 * agent emitting only idle beats reads as "content frozen", not "content
 * changed each beat". It is NOT treated as genuine fresh content by
 * `contentDiffers` — recovery is only credited for real, non-idle content.
 */
export const WATCHDOG_IDLE = '__WATCHDOG_IDLE__';

/** Constant an embedded ISO-8601 timestamp collapses to. */
const ISO_TOKEN = '__TS__';

/** ISO-8601 timestamp anywhere inside a field (with or without milliseconds). */
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * Daemon idle-beat `status`, written by fast-checker.ts's heartbeatTimer as
 * `bus update-heartbeat "[watchdog] <agent> alive — idle session <ts>"`. Matched
 * dash-agnostically (the real string uses an em dash) so the gate does not
 * hinge on the exact separator glyph.
 */
const WATCHDOG_IDLE_RE = /^\[watchdog\].*\balive\b.*idle session/i;

/**
 * Reduce a heartbeat to a canonical semantic-content string from `status` +
 * `current_task` only. Pure. Returns '' for a null/missing heartbeat.
 */
export function normalizeHeartbeatContent(hb: Partial<Heartbeat> | null | undefined): string {
  if (!hb) return '';
  const status = typeof hb.status === 'string' ? hb.status : '';
  if (WATCHDOG_IDLE_RE.test(status.trim())) return WATCHDOG_IDLE;
  const task = typeof hb.current_task === 'string' ? hb.current_task : '';
  const scrub = (s: string) => s.replace(ISO_RE, ISO_TOKEN).trim();
  // NUL delimiter between the two fields: a byte that cannot occur in real
  // status/task text, so the fingerprint is unambiguous. Must stay the \0
  // ESCAPE — a literal NUL char here makes git treat this source as binary
  // and blinds every text-based diff/review/PII sweep of this file.
  return `${scrub(status)}\0${scrub(task)}`;
}

/**
 * Recovery-verification predicate: does the live normalized content represent
 * GENUINELY FRESH agent output relative to the content captured before a
 * restart? True only when it is neither identical to the captured content
 * (spawn-carry) NOR the daemon idle beat (which no agent brain authored).
 */
export function contentDiffers(normalizedLive: string, captured: string): boolean {
  return normalizedLive !== captured && normalizedLive !== WATCHDOG_IDLE;
}
