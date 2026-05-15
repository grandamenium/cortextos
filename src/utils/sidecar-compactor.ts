import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import type { BusPaths, CompactionLedger } from '../types/index.js';
import {
  findActiveJsonl,
  isSafePoint,
  parseJsonlTurns,
  redactWithCount,
  sessionIdFromJsonlPath,
  type ParsedTurn,
} from './agent-session.js';

export type Logger = (msg: string) => void;

/**
 * Context passed to a variant-specific summarizer.
 *
 * `middleTurnsText` is a pre-redacted, pre-flattened transcript of all
 * turns except the most recent N tokens. `recentTurnsText` is the
 * verbatim tail (also redacted) that the ledger preserves so the
 * post-restart session can pick up exactly where the prior thought
 * stopped.
 */
export interface CompactionContext {
  agentName: string;
  middleTurnsText: string;
  recentTurnsText: string;
  contextPct: number;
  now: string;
}

/**
 * Output of a variant compactor's summarize() call. The base flow
 * fills in compacted_at, session_id, schema_version, variant, and
 * recent_turns_summary — variants only return the LLM-extracted parts.
 */
export type CompactionSummary = Pick<
  CompactionLedger,
  'resolved' | 'pending' | 'key_facts' | 'redaction_count'
>;

/**
 * Interface every variant (Claude/Haiku/OpenAI/Deterministic) implements.
 * Returning null = sidecar failed/unavailable → caller falls through to
 * the existing Tier 1-3 path.
 */
export interface SidecarCompactor {
  /**
   * Run the variant-specific summarization and return the partial
   * ledger (or null on failure / unavailable).
   *
   * Implementations MUST be tolerant of network errors, malformed
   * model output, and missing API keys — never throw.
   */
  summarize(ctx: CompactionContext): Promise<CompactionSummary | null>;
}

/**
 * Wait until the active JSONL ends at a safe point (last assistant
 * turn is final text and no in-flight tool_use). Polls every 2s up to
 * maxWaitMs. Returns true on success, false on timeout.
 */
export async function waitForSafePoint(
  agentDir: string,
  maxWaitMs = 30_000,
  log: Logger = () => {},
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const jsonl = findActiveJsonl(agentDir);
    if (jsonl) {
      const turns = parseJsonlTurns(jsonl);
      if (turns.length > 0 && isSafePoint(turns)) {
        return true;
      }
    }
    await sleep(2_000);
  }
  log('[compactor] waitForSafePoint: timed out after 30s — skipping');
  return false;
}

/**
 * Slice the parsed turns into a recent tail (~budget tokens) plus a
 * middle (everything before). Token budget is filled from the END so
 * the most recent activity is preserved verbatim.
 */
export function splitTurnsByTokenBudget(
  turns: ParsedTurn[],
  budgetTokens: number,
): { middle: ParsedTurn[]; recent: ParsedTurn[] } {
  const recent: ParsedTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (used + t.estimatedTokens > budgetTokens && recent.length > 0) break;
    recent.unshift(t);
    used += t.estimatedTokens;
  }
  const middle = turns.slice(0, turns.length - recent.length);
  return { middle, recent };
}

/**
 * Flatten a list of parsed turns into newline-joined "role: text"
 * blocks. Used to build the prompt input for sidecar variants.
 */
export function flattenTurns(turns: ParsedTurn[]): string {
  return turns.map(t => `${t.role}: ${t.contentText}`).join('\n\n');
}

/**
 * Build the markdown ledger doc written to memory/handoffs/.
 */
export function buildLedgerDoc(agentName: string, ledger: CompactionLedger): string {
  const lines: string[] = [];
  lines.push(`# Compaction Ledger — ${agentName} — ${ledger.compacted_at}`);
  lines.push('');
  lines.push(
    `> schema_version: ${ledger.schema_version} | session_id: ${ledger.session_id} | variant: ${ledger.variant} | context_pct: ${ledger.context_pct_at_compact}%`,
  );
  lines.push('');
  lines.push('## Resolved');
  if (ledger.resolved.length === 0) {
    lines.push('_(none)_');
  } else {
    ledger.resolved.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  lines.push('');
  lines.push('## Pending');
  if (ledger.pending.length === 0) {
    lines.push('_(none)_');
  } else {
    ledger.pending.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  }
  lines.push('');
  lines.push('## Current State');
  lines.push(ledger.key_facts.current_state || '_(unspecified)_');
  lines.push('');
  lines.push('## Next Action');
  lines.push(ledger.key_facts.next_action || '_(unspecified)_');
  if (ledger.key_facts.active_files && ledger.key_facts.active_files.length > 0) {
    lines.push('');
    lines.push('## Active Files');
    ledger.key_facts.active_files.forEach(f => lines.push(`- ${f}`));
  }
  if (ledger.key_facts.blockers && ledger.key_facts.blockers.length > 0) {
    lines.push('');
    lines.push('## Blockers');
    ledger.key_facts.blockers.forEach(b => lines.push(`- ${b}`));
  }
  lines.push('');
  lines.push('## Recent Turns (verbatim excerpt)');
  lines.push(ledger.recent_turns_summary || '_(empty)_');
  if (ledger.key_facts.coordination) {
    lines.push('');
    lines.push('## Coordination State');
    lines.push('```json');
    lines.push(JSON.stringify(ledger.key_facts.coordination, null, 2));
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}

/**
 * Strict ledger validation. Returns the validated ledger on success,
 * or null with an error logged when a required field is missing.
 *
 * Per spec: empty pending while recent turns show active work becomes
 * `["[unknown — sidecar failed to extract pending tasks]"]`. Empty
 * next_action is a hard failure.
 */
export function validateAndPatchSummary(
  summary: CompactionSummary,
  hasRecentActivity: boolean,
  log: Logger = () => {},
): CompactionSummary | null {
  const next = summary.key_facts?.next_action?.trim();
  if (!next) {
    log('[compactor] ledger validation failed: next_action empty');
    return null;
  }
  let pending = Array.isArray(summary.pending) ? summary.pending.filter(p => typeof p === 'string') : [];
  if (pending.length === 0 && hasRecentActivity) {
    log('[compactor] WARNING: empty pending while recent turns show activity — patching');
    pending = ['[unknown — sidecar failed to extract pending tasks]'];
  }
  const resolved = Array.isArray(summary.resolved) ? summary.resolved.filter(p => typeof p === 'string') : [];
  return {
    resolved,
    pending,
    key_facts: summary.key_facts,
    redaction_count: summary.redaction_count ?? 0,
  };
}

/**
 * Write the ledger doc to disk and the .handoff-doc-path marker so
 * the next session boot prompt picks it up via the existing handoff
 * infrastructure.
 *
 * Caller is responsible for triggering forceContextRestart() after
 * this returns successfully.
 */
export function writeLedgerAndMarker(
  agentDir: string,
  paths: BusPaths,
  agentName: string,
  ledger: CompactionLedger,
): string {
  const handoffsDir = join(agentDir, 'memory', 'handoffs');
  if (!existsSync(handoffsDir)) {
    mkdirSync(handoffsDir, { recursive: true });
  }
  const ts = ledger.compacted_at.replace(/[:.]/g, '-').slice(0, 19) + 'Z';
  const docPath = join(handoffsDir, `compaction-${ts}.md`);
  writeFileSync(docPath, buildLedgerDoc(agentName, ledger), 'utf-8');

  if (!existsSync(paths.stateDir)) {
    mkdirSync(paths.stateDir, { recursive: true });
  }
  // Only write .handoff-doc-path here. .force-fresh and context_status.json reset
  // are written by forceContextRestart() — keeping them in the same transaction
  // prevents a crash-in-gap leaving a stale force-fresh with masked high-context status.
  writeFileSync(join(paths.stateDir, '.handoff-doc-path'), docPath, 'utf-8');
  return docPath;
}

/**
 * Atomically claim a Variant-D compact request file via rename.
 * Returns true on a successful claim, false if the file is already
 * gone (another path won the race) or rename failed.
 */
export function atomicClaimRequest(stateDir: string, requestId: string): boolean {
  const src = join(stateDir, `.compact-request-${requestId}`);
  const dst = join(stateDir, `.compact-request-${requestId}.claimed`);
  if (!existsSync(src)) return false;
  try {
    renameSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find any compaction-ledger handoff doc written within the last N
 * minutes. Used by fast-checker when re-arming the .handoff-doc-path
 * marker for a subsequent restart.
 */
export function findRecentCompactionDoc(agentDir: string, withinMs: number): string | null {
  const handoffsDir = join(agentDir, 'memory', 'handoffs');
  if (!existsSync(handoffsDir)) return null;
  const cutoff = Date.now() - withinMs;
  try {
    const recent = readdirSync(handoffsDir)
      .filter(f => f.startsWith('compaction-') && f.endsWith('.md'))
      .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
      .filter(({ mtime }) => mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime);
    return recent.length > 0 ? join(handoffsDir, recent[0].f) : null;
  } catch {
    return null;
  }
}

export { sessionIdFromJsonlPath };

/**
 * Mandatory output redaction (delta MEDIUM #7). Applied to the entire
 * JSON-stringified ledger output BEFORE validation and BEFORE the
 * markdown doc is written. Re-stamps the redaction_count to include
 * any additional substitutions caught in the LLM's response.
 */
export function redactLedgerSummary(summary: CompactionSummary): CompactionSummary {
  const json = JSON.stringify(summary);
  const { text, count } = redactWithCount(json);
  let parsed: CompactionSummary;
  try {
    parsed = JSON.parse(text) as CompactionSummary;
  } catch {
    parsed = summary;
  }
  return {
    ...parsed,
    redaction_count: (summary.redaction_count ?? 0) + count,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
