import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';

/**
 * F10 mitigation: verify a claimed inbound message actually came from the bus
 * and was sent by the claimed sender before acting on it at merge-grade.
 *
 * See `/orgs/cleverwave/agents/ana/surfaces/verify-message-cli-spec.md` for the
 * full contract. Three checks:
 *   1. Bus-file audit — message exists in inbox/, inflight/, or processed/ under
 *      the recipient. Found in .errors/ counts as phantom.
 *   2. Timestamp sanity — epochMs prefix is within [now - maxAgeDays, now + futureSkewSeconds].
 *   3. Sender event cross-check — sender's analytics/events/<sender>/<date>.jsonl
 *      contains a message_sent / agent_message_sent / telegram_sent event whose
 *      metadata.msg_id matches.
 *
 * Exit codes: 0 VERIFIED | 1 PHANTOM | 2 UNVERIFIABLE | 3 ERROR.
 */

export type VerifyResultKind = 'VERIFIED' | 'PHANTOM' | 'UNVERIFIABLE' | 'ERROR';

export interface CheckOutcome {
  passed: boolean;
  unverifiable?: boolean;
  detail: string;
  paths_searched?: string[];
  /** Timestamp check extras. */
  decoded_iso?: string;
  skew_seconds?: number;
  /** Bus-file check extra. */
  location?: string;
}

export interface VerifyReport {
  msg_id: string;
  sender: string;
  recipient: string;
  checks: {
    bus_file: CheckOutcome;
    timestamp: CheckOutcome;
    sender_event: CheckOutcome;
  };
  result: VerifyResultKind;
  exit_code: number;
}

export interface VerifyOptions {
  senderOverride?: string;
  recipient: string;
  maxAgeDays: number;
  futureSkewSeconds: number;
  strict: boolean;
  org: string;
  /** Optional override for `Date.now()` — used by tests to pin wall-clock. */
  now?: number;
}

const RESULT_EXIT: Record<VerifyResultKind, number> = {
  VERIFIED: 0,
  PHANTOM: 1,
  UNVERIFIABLE: 2,
  ERROR: 3,
};

/**
 * Parse a msg_id of the form `{epochMs}-{sender}-{rand5}`. Returns null when
 * the id is malformed (caller surfaces as ERROR / exit 3).
 */
export function parseMsgId(msgId: string): { epochMs: number; sender: string; rand: string } | null {
  if (typeof msgId !== 'string' || msgId.length === 0) return null;
  const parts = msgId.split('-');
  // Expect at least 3 dash-segments. Sender names can contain hyphens
  // (e.g. "mhcrm-pr-review"), so sender = middle segments joined, rand = last.
  if (parts.length < 3) return null;
  const epochMs = Number(parts[0]);
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs) || epochMs <= 0) return null;
  const rand = parts[parts.length - 1];
  const sender = parts.slice(1, -1).join('-');
  if (!sender || !rand) return null;
  return { epochMs, sender, rand };
}

/**
 * Search a directory for a JSON file whose `.id` field matches the msg_id.
 * Returns the message object on hit, null on miss, or 'corrupt' when the file
 * existed but couldn't be parsed.
 */
function findInDir(dir: string, msgId: string): { file: string; msg: Record<string, unknown> } | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const content = readFileSync(full, 'utf-8');
      const msg = JSON.parse(content) as Record<string, unknown>;
      if (msg && typeof msg === 'object' && msg.id === msgId) {
        return { file: entry, msg };
      }
    } catch {
      // Skip unreadable / corrupt files — they're not our match.
    }
  }
  return null;
}

function checkBusFile(ctxRoot: string, recipient: string, msgId: string, expectedSender: string): CheckOutcome {
  const baseDirs = ['inbox', 'inflight', 'processed'];
  const pathsSearched: string[] = [];
  for (const kind of baseDirs) {
    const dir = join(ctxRoot, kind, recipient);
    pathsSearched.push(join(kind, recipient));
    const hit = findInDir(dir, msgId);
    if (hit) {
      // P5: msg.from must match the sender segment in msg_id — mismatch is tampering.
      const from = typeof hit.msg.from === 'string' ? (hit.msg.from as string) : '';
      if (from !== expectedSender) {
        return {
          passed: false,
          detail: `found in ${kind}/${recipient} but msg.from='${from}' does not match msg_id sender='${expectedSender}' (tampering)`,
          paths_searched: pathsSearched,
          location: kind,
        };
      }
      return {
        passed: true,
        detail: `found in ${kind}/${recipient}`,
        paths_searched: pathsSearched,
        location: kind,
      };
    }
  }
  // Check .errors/ last — presence there is decisive failure (HMAC rejected).
  const errDir = join(ctxRoot, 'inbox', recipient, '.errors');
  pathsSearched.push(join('inbox', recipient, '.errors'));
  const errHit = findInDir(errDir, msgId);
  if (errHit) {
    return {
      passed: false,
      detail: `found in inbox/${recipient}/.errors (HMAC-rejected or corrupt)`,
      paths_searched: pathsSearched,
      location: '.errors',
    };
  }
  return {
    passed: false,
    detail: `not found in inbox/, inflight/, processed/, or .errors/ for recipient ${recipient}`,
    paths_searched: pathsSearched,
  };
}

function checkTimestamp(epochMs: number, now: number, futureSkewSeconds: number, maxAgeDays: number): CheckOutcome {
  const futureSkewMs = futureSkewSeconds * 1000;
  const maxAgeMs = maxAgeDays * 86400 * 1000;
  const skewSeconds = Math.round((epochMs - now) / 1000);
  const decodedIso = new Date(epochMs).toISOString();

  if (epochMs > now + futureSkewMs) {
    return {
      passed: false,
      detail: `decodes to ${decodedIso}, ${skewSeconds} s in the future (beyond ${futureSkewSeconds} s skew)`,
      decoded_iso: decodedIso,
      skew_seconds: skewSeconds,
    };
  }
  if (epochMs < now - maxAgeMs) {
    const ageDays = Math.round((now - epochMs) / 86400000);
    return {
      passed: false,
      detail: `decodes to ${decodedIso}, ${ageDays} d in the past (beyond ${maxAgeDays} d max-age)`,
      decoded_iso: decodedIso,
      skew_seconds: skewSeconds,
    };
  }
  return {
    passed: true,
    detail: `decodes to ${decodedIso} (skew ${skewSeconds} s within ±${futureSkewSeconds} s future / ${maxAgeDays} d past)`,
    decoded_iso: decodedIso,
    skew_seconds: skewSeconds,
  };
}

function utcDateString(epochMs: number, dayOffset = 0): string {
  const d = new Date(epochMs + dayOffset * 86400000);
  return d.toISOString().split('T')[0];
}

/**
 * Walk an events JSONL file and return true if any line is a
 * message_sent / agent_message_sent / telegram_sent event whose metadata.msg_id
 * equals `msgId`.
 */
function eventsFileHasMessageSent(filePath: string, msgId: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    if (!line.includes(msgId)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const category = parsed.category;
    const event = parsed.event;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    const metaMsgId = metadata && typeof metadata === 'object' ? metadata.msg_id : undefined;
    const matchesEvent = (category === 'message' || category === 'action')
      && (event === 'agent_message_sent' || event === 'message_sent' || event === 'telegram_sent');
    if (matchesEvent && metaMsgId === msgId) {
      return true;
    }
  }
  return false;
}

function checkSenderEvent(paths: BusPaths, sender: string, epochMs: number, msgId: string): CheckOutcome {
  // Probe both `epochMs` date and `epochMs+1d` in case fire-time and ingest-time
  // straddle a UTC midnight boundary.
  const dates = [utcDateString(epochMs), utcDateString(epochMs, 1)];
  const searched: string[] = [];
  let anyFileExisted = false;
  for (const date of dates) {
    const file = join(paths.analyticsDir, 'events', sender, `${date}.jsonl`);
    searched.push(file.replace(paths.ctxRoot + '/', ''));
    if (!existsSync(file)) continue;
    anyFileExisted = true;
    if (eventsFileHasMessageSent(file, msgId)) {
      return {
        passed: true,
        detail: `found matching message_sent event for ${msgId} in ${date}.jsonl`,
        paths_searched: searched,
      };
    }
  }
  if (!anyFileExisted) {
    return {
      passed: false,
      unverifiable: true,
      detail: `sender analytics file missing — pre-86bc202 agent or retention gap`,
      paths_searched: searched,
    };
  }
  return {
    passed: false,
    detail: `no matching message_sent / agent_message_sent / telegram_sent event for ${msgId}`,
    paths_searched: searched,
  };
}

/**
 * Run all three checks and produce a verdict.
 */
export function verifyMessage(paths: BusPaths, msgId: string, opts: VerifyOptions): VerifyReport {
  const parsed = parseMsgId(msgId);
  if (!parsed) {
    return {
      msg_id: msgId,
      sender: opts.senderOverride ?? '',
      recipient: opts.recipient,
      checks: {
        bus_file: { passed: false, detail: 'skipped — malformed msg_id' },
        timestamp: { passed: false, detail: 'skipped — malformed msg_id' },
        sender_event: { passed: false, detail: 'skipped — malformed msg_id' },
      },
      result: 'ERROR',
      exit_code: RESULT_EXIT.ERROR,
    };
  }

  const sender = opts.senderOverride ?? parsed.sender;
  const now = opts.now ?? Date.now();

  const busFile = checkBusFile(paths.ctxRoot, opts.recipient, msgId, sender);
  const timestamp = checkTimestamp(parsed.epochMs, now, opts.futureSkewSeconds, opts.maxAgeDays);
  const senderEvent = checkSenderEvent(paths, sender, parsed.epochMs, msgId);

  // Resolve verdict.
  let result: VerifyResultKind;
  if (!busFile.passed || !timestamp.passed) {
    // Decisive failures — even if sender_event is UNVERIFIABLE, the message is PHANTOM.
    result = 'PHANTOM';
  } else if (senderEvent.passed) {
    result = 'VERIFIED';
  } else if (senderEvent.unverifiable) {
    result = opts.strict ? 'PHANTOM' : 'UNVERIFIABLE';
  } else {
    result = 'PHANTOM';
  }

  return {
    msg_id: msgId,
    sender,
    recipient: opts.recipient,
    checks: { bus_file: busFile, timestamp, sender_event: senderEvent },
    result,
    exit_code: RESULT_EXIT[result],
  };
}

export function formatReportText(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`msg_id:       ${report.msg_id}`);
  lines.push(`sender:       ${report.sender}`);
  lines.push(`recipient:    ${report.recipient}`);
  const fmt = (label: string, c: CheckOutcome) => {
    const tag = c.passed ? 'PASS' : (c.unverifiable ? 'UNVERIFIABLE' : 'FAIL');
    lines.push(`${label.padEnd(14)}${tag} — ${c.detail}`);
  };
  fmt('bus_file:', report.checks.bus_file);
  fmt('timestamp:', report.checks.timestamp);
  fmt('sender_event:', report.checks.sender_event);
  lines.push(`RESULT:       ${report.result} (exit ${report.exit_code})`);
  return lines.join('\n');
}
