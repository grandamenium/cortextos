// Trigger resolution — the "why" chain for token-audit.
//
// For each session, identify what fired it:
//   - 'bus'  — first user msg starts with "=== AGENT MESSAGE from <X>"
//   - 'user' — first user msg starts with "=== TELEGRAM" OR is human-typed in CC terminal
//   - 'cron' — first user msg matches a cron prompt AND cron-state.json `last_fire`
//              is within ±2 minutes of session.start_ts
//   - 'hook' — starts with a hook output pattern (e.g. crash-alert)
//   - 'unknown' — none of the above

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CronDefinition } from '../types/index.js';
import { readCronState } from '../bus/cron-state.js';
import type { TriggerKind, TurnFact } from './types.js';

const TRUNCATE = 1024;

export interface ResolvedTrigger {
  kind: TriggerKind;
  name: string | null;
  prompt: string | null;
  session_opener: string | null;
}

export interface CronCatalogEntry {
  agent: string;
  cron: CronDefinition;
  /** Most recent `last_fire` ISO timestamp from cron-state.json, if available. */
  last_fire: string | null;
}

/**
 * Read all crons for all agents under <ctxRoot>. Crons live in:
 *   <ctxRoot>/.cortextOS/state/agents/<agent>/crons.json
 * Last-fire times live in:
 *   <ctxRoot>/state/<agent>/cron-state.json
 */
export function loadCronCatalog(ctxRoot: string): CronCatalogEntry[] {
  const out: CronCatalogEntry[] = [];
  const cronsDir = join(ctxRoot, '.cortextOS', 'state', 'agents');
  if (!existsSync(cronsDir)) return out;

  let agents: string[] = [];
  try {
    agents = readdirSync(cronsDir).filter((d) => !d.startsWith('.'));
  } catch {
    return out;
  }

  for (const agent of agents) {
    const cronsPath = join(cronsDir, agent, 'crons.json');
    if (!existsSync(cronsPath)) continue;
    let envelope: { crons?: CronDefinition[] };
    try {
      envelope = JSON.parse(readFileSync(cronsPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!envelope.crons || !Array.isArray(envelope.crons)) continue;

    const stateDir = join(ctxRoot, 'state', agent);
    const fireState = readCronState(stateDir);
    const fireByName = new Map(fireState.crons.map((r) => [r.name, r.last_fire]));

    for (const cron of envelope.crons) {
      out.push({
        agent,
        cron,
        last_fire: fireByName.get(cron.name) ?? null,
      });
    }
  }
  return out;
}

// Normalize a prompt for matching: collapse whitespace, lowercase.
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Cheap edit-distance-ish similarity: prefix match OR substring contains.
// Levenshtein is overkill for the matching we do (prompts are short and
// stable — the only variation is the cron prefix `[CRON: name] ` that the
// daemon prepends).
function similar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // The daemon prepends "[CRON: name] " to cron prompts injected into the PTY.
  const stripped = na.replace(/^\[cron:[^\]]+\]\s*/, '');
  if (stripped === nb) return true;
  if (nb.length >= 20 && stripped.startsWith(nb.slice(0, Math.min(60, nb.length)))) return true;
  if (nb.length >= 20 && stripped.includes(nb.slice(0, Math.min(60, nb.length)))) return true;
  return false;
}

export interface ResolveOpts {
  /** First user message of the session. */
  openerText: string;
  /** Session start timestamp. */
  sessionStart: Date;
  /** Agent that owns the session. */
  agent: string;
  /** Pre-loaded cron catalog. */
  cronCatalog: CronCatalogEntry[];
}

export function resolveTrigger(opts: ResolveOpts): ResolvedTrigger {
  const opener = opts.openerText ?? '';
  const session_opener = opener.slice(0, TRUNCATE);
  const trimmed = opener.trim();

  // Bus
  const busMatch = /^===\s*AGENT MESSAGE from\s+([\w-]+)/i.exec(trimmed);
  if (busMatch) {
    return { kind: 'bus', name: busMatch[1], prompt: session_opener, session_opener };
  }

  // Telegram → user
  if (/^===\s*TELEGRAM/i.test(trimmed)) {
    return { kind: 'user', name: 'telegram', prompt: session_opener, session_opener };
  }

  // Hook patterns. Crash-alert and the other hooks all emit lines that start
  // with a recognisable banner — keep the check shallow and additive.
  if (/^(===\s*HOOK|\[CRASH-ALERT\]|\[CONTEXT-STATUS\]|\[WORKTREE-WARN\])/i.test(trimmed)) {
    return { kind: 'hook', name: extractHookName(trimmed), prompt: session_opener, session_opener };
  }

  // Cron — match prompt + ±2 minute fire window
  const TWO_MIN = 120_000;
  for (const entry of opts.cronCatalog) {
    if (entry.agent !== opts.agent) continue;
    if (!similar(opener, entry.cron.prompt)) continue;
    if (entry.last_fire) {
      const fireMs = new Date(entry.last_fire).getTime();
      if (Number.isFinite(fireMs) && Math.abs(opts.sessionStart.getTime() - fireMs) <= TWO_MIN) {
        return { kind: 'cron', name: entry.cron.name, prompt: entry.cron.prompt.slice(0, TRUNCATE), session_opener };
      }
    } else {
      // last_fire missing — still claim a cron match (lower confidence) so
      // the operator can see "looks like a cron but no fire record".
      return { kind: 'cron', name: entry.cron.name, prompt: entry.cron.prompt.slice(0, TRUNCATE), session_opener };
    }
  }

  // Default: user-typed in the CC terminal.
  if (trimmed.length > 0) {
    return { kind: 'user', name: 'terminal', prompt: session_opener, session_opener };
  }
  return { kind: 'unknown', name: null, prompt: null, session_opener };
}

function extractHookName(text: string): string {
  const m = /\[([\w-]+)\]/.exec(text);
  return m ? m[1].toLowerCase() : 'hook';
}

// --- enrich a batch of TurnFact rows with trigger metadata -----------------
// Walks turns by session, finds the opener (first user message OR first turn
// in the transcript file), resolves the trigger, stamps the fields on every
// turn in the session.

export interface SessionOpener {
  session_id: string;
  agent: string;
  start_ts: string;
  opener_text: string;
}

export function enrichTriggers(
  turns: TurnFact[],
  openers: SessionOpener[],
  catalog: CronCatalogEntry[],
): TurnFact[] {
  const openerBySession = new Map<string, SessionOpener>();
  for (const o of openers) openerBySession.set(o.session_id, o);

  return turns.map((t) => {
    const o = openerBySession.get(t.session_id);
    if (!o) return t;
    const resolved = resolveTrigger({
      openerText: o.opener_text,
      sessionStart: new Date(o.start_ts),
      agent: o.agent,
      cronCatalog: catalog,
    });
    return {
      ...t,
      trigger_kind: resolved.kind,
      trigger_name: resolved.name,
      trigger_prompt: resolved.prompt,
      session_opener: resolved.session_opener,
    };
  });
}

/**
 * Extract session openers from raw Claude transcript files. Walks each
 * file and finds the first user-typed message per session. Codex sessions
 * don't have a comparable opener stream — Phase 2 leaves codex triggers
 * as 'unknown' unless the codex-thread join (separate module) provides one.
 */
export function extractClaudeOpeners(
  filePath: string,
  agent: string,
): SessionOpener[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const firstBySession = new Map<string, SessionOpener>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      sessionId?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'user') continue;
    const sid = entry.sessionId;
    if (!sid || firstBySession.has(sid)) continue;
    const text = extractUserText(entry.message?.content);
    if (!text) continue;
    firstBySession.set(sid, {
      session_id: sid,
      agent,
      start_ts: entry.timestamp ?? new Date().toISOString(),
      opener_text: text.slice(0, TRUNCATE),
    });
  }
  return Array.from(firstBySession.values());
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const obj = block as Record<string, unknown>;
        if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text);
        else if (typeof obj.content === 'string') parts.push(obj.content);
      }
    }
    return parts.join('\n');
  }
  return '';
}
