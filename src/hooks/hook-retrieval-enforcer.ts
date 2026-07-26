/**
 * RETRIEVAL ENFORCER — UserPromptSubmit hook (fleet-wide), selective/cached.
 *
 * Ports ~/.claude/hooks/retrieval-enforcer.js into tracked TS and adds "the
 * splitter" (fleet-context-diet OBF): the retrieval blocks are still injected
 * DETERMINISTICALLY (the model cannot skip them), but the expensive, stable
 * blocks (conversation direction, recent commits, kb-query) are no longer
 * re-injected on EVERY turn when they are provably redundant.
 *
 * Constraints (02-master-plan.md):
 *  - Never silently drop context an agent genuinely needs. Every gate is "skip
 *    only when provably redundant or provably irrelevant", never blanket.
 *  - Fail OPEN: any cache read/parse/write error → behave as first turn (full
 *    context). Never fail closed.
 *  - Session boundary = full reset. A restart (new session id / new transcript)
 *    gets a fresh cache → turnCount 0 → full first-turn context, like today.
 *  - Output envelope byte-compatible with the reference emit().
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const ORG = process.env.CTX_ORG || 'clearworksai';
const AGENT = process.env.CTX_AGENT_NAME || '';
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

export const RETRIEVAL_INTENT = new RegExp(
  [
    'transcript', 'jsonl',
    'what did (you|we|i)', 'last (time|session|week|night|month)',
    'earlier', 'recall', 'look (back|up)', 'thorough(ly)?',
    'reference (the )?past', 'previously', '\\bbefore\\b', '\\bhistory\\b',
    'read (the |your |our )?(past|old|previous|prior)', 'did (you|we) (ever|already)',
    'have (you|we) (ever|already)', 'go back', 'dig (in|up)',
  ].join('|'),
  'i',
);

// Force-open signal: a genuinely important turn always gets full context,
// bypassing every cache gate. Defense in depth on top of the session reset.
export const URGENT = /urgent|prod(uction)? down|security incident|breaking|outage/i;

const STOP = new Set([
  'read', 'transcript', 'transcripts', 'jsonl', 'what', 'that', 'this', 'with',
  'from', 'your', 'our', 'the', 'and', 'did', 'have', 'about', 'please', 'last',
  'time', 'session', 'sessions', 'previous', 'history', 'before', 'earlier',
  'recall', 'thorough', 'reference', 'past', 'look', 'into', 'them', 'were', 'they',
  'which', 'when', 'where', 'does', 'said', 'says', 'today', 'yesterday',
]);

export interface CacheState {
  turnCount: number;
  lastCommitsHash?: string;
  lastDirectionTurn?: number;
  lastKbQueryNormalized?: string;
  lastKbResult?: string;
  lastKbAtMs?: number;
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function readStdinRaw(): string {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Parse the hook stdin envelope: the prompt text AND the session id (new). */
export function parseEnvelope(raw: string): { prompt: string; sessionId: string } {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const prompt = (o.prompt || o.user_prompt || o.message || '').toString();
    const sessionId = (o.session_id || o.sessionId || '').toString();
    return { prompt, sessionId };
  } catch {
    return { prompt: (raw || '').toString(), sessionId: '' };
  }
}

/** Stable per-session cache key: real session_id if present, else agent+newest transcript. */
export function sessionKey(sessionId: string, newestTranscript: string): string {
  if (sessionId) return sha(sessionId);
  return sha(`${AGENT}:${newestTranscript}`);
}

function cacheDir(): string {
  const root = process.env.CTX_ROOT || os.tmpdir();
  return path.join(root, 'retrieval-cache', AGENT || 'unknown');
}

/** Read the per-session cache. Fail-open: any error → fresh first-turn state. */
export function readCache(key: string): CacheState {
  try {
    const p = path.join(cacheDir(), `${key}.json`);
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as CacheState;
    if (typeof parsed.turnCount !== 'number') return { turnCount: 0 };
    return parsed;
  } catch {
    return { turnCount: 0 };
  }
}

/** Persist the per-session cache. Best-effort — never throws. */
export function writeCache(key: string, state: CacheState): void {
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${key}.json`);
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch { /* fail-open */ }
}

export function extractKeywords(prompt: string): { strong: string[]; weak: string[] } {
  const all = [...new Set((prompt.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []))]
    .filter((w) => !STOP.has(w));
  const strong = all
    .filter((w) => w.length >= 7 || /[-0-9]/.test(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  const weak = all.filter((w) => !strong.includes(w)).slice(0, 4);
  return { strong, weak };
}

export function listRecentTranscripts(): string[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(PROJECTS)
      .filter((d) => (AGENT ? d.includes(AGENT) : true))
      .map((d) => path.join(PROJECTS, d));
  } catch { return []; }
  const cutoff = Date.now() - 3 * 86400 * 1000;
  const files: Array<{ fp: string; m: number }> = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(d, f);
        try {
          const m = fs.statSync(fp).mtimeMs;
          if (m > cutoff) files.push({ fp, m });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  files.sort((a, b) => b.m - a.m);
  return files.map((x) => x.fp);
}

interface TurnLine { txt: string; role: string; ts: string }

function lineText(line: string): TurnLine | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const msg = (obj.message as Record<string, unknown>) || obj;
  const c = (msg && msg.content !== undefined) ? msg.content : obj.content;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) for (const b of c) {
    const bb = b as Record<string, unknown>;
    if (bb && bb.type === 'text') txt += (bb.text as string) || '';
  }
  txt = (txt || '').trim();
  if (!txt) return null;
  if (txt.includes('documented-past-retrieval')) return null;
  const role = ((msg && (msg.role as string)) || (obj.type as string) || '');
  return { txt, role, ts: (obj.timestamp as string) || '' };
}

export function kbQuery(prompt: string): string {
  const q = prompt.replace(/["`$\\]/g, "'").replace(/\n/g, ' ').slice(0, 280).trim();
  if (!q) return '';
  try {
    return execSync(
      `cortextos bus kb-query "${q}" --org ${ORG} --top-k 5 --threshold 0.45 2>/dev/null`,
      { encoding: 'utf8', timeout: 12000 },
    ).trim();
  } catch { return ''; }
}

export function transcriptHits(prompt: string): string {
  const { strong, weak } = extractKeywords(prompt);
  if (!strong.length && !weak.length) return '';
  const files = listRecentTranscripts().slice(0, 14);
  const MAX_TOTAL = 8;
  const MAX_PER_FILE = 3;
  const MAX_CANDS_PER_FILE = 6;
  const cands: Array<{ score: number; fi: number; fp: string; t: TurnLine }> = [];
  files.forEach((fp, fi) => {
    let lines: string[];
    try { lines = fs.readFileSync(fp, 'utf8').split('\n'); } catch { return; }
    let n = 0;
    for (let i = lines.length - 1; i >= 0 && n < MAX_CANDS_PER_FILE; i--) {
      const low = lines[i].toLowerCase();
      let score = 0;
      if (strong.length) {
        for (const k of strong) if (low.includes(k)) score += k.length;
        if (!score) continue;
      } else {
        const weakMatches = weak.filter((k) => low.includes(k)).length;
        if (weakMatches < Math.min(2, weak.length)) continue;
        score = weakMatches;
      }
      const t = lineText(lines[i]);
      if (!t || t.txt.length < 40) continue;
      cands.push({ score, fi, fp, t });
      n++;
    }
  });
  cands.sort((a, b) => b.score - a.score || a.fi - b.fi);
  const perFile: Record<string, number> = {};
  const picked: typeof cands = [];
  for (const c of cands) {
    if (picked.length >= MAX_TOTAL) break;
    perFile[c.fp] = (perFile[c.fp] || 0) + 1;
    if (perFile[c.fp] > MAX_PER_FILE) continue;
    picked.push(c);
  }
  picked.sort((a, b) => (b.t.ts || '').localeCompare(a.t.ts || ''));
  return picked
    .map((c) => `[${c.t.ts}] (${c.t.role}) ${c.t.txt.replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n---\n');
}

export function recentCommits(): string {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!top) return '';
    const out = execSync(
      `git -C "${top}" log --all --since="48 hours ago" -n 12 --date=format:"%m-%d %H:%M" --pretty=format:"%h %ad%d %s"`,
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return '';
    return `repo ${path.basename(top)} (git log --all, last 48h, incl. unmerged branches):\n${out}`;
  } catch { return ''; }
}

export function conversationDirection(): string {
  const files = listRecentTranscripts().slice(0, 3);
  const turns: string[] = [];
  for (const fp of files) {
    let lines: string[];
    try { lines = fs.readFileSync(fp, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0 && turns.length < 6; i--) {
      const t = lineText(lines[i]);
      if (!t || t.txt.length < 30) continue;
      if (t.role !== 'user' && t.role !== 'assistant') continue;
      if (/^\[CRON FIRED/.test(t.txt) || t.txt.startsWith('<')) continue;
      turns.push(`[${t.ts}] ${t.role}: ${t.txt.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    if (turns.length >= 6) break;
  }
  return turns.reverse().join('\n');
}

export interface GateDecision {
  wantDirection: boolean;
  wantCommits: boolean;
  wantKb: boolean;
  wantTranscripts: boolean;
  forceOpen: boolean;
}

/**
 * The splitter. Given the prompt + prior cache, decide which blocks to inject.
 * Pure function (no IO) so it is fully unit-testable.
 */
export function decideGates(prompt: string, cache: CacheState): GateDecision {
  const firstTurn = (cache.turnCount || 0) === 0;
  const intent = RETRIEVAL_INTENT.test(prompt);
  const urgent = URGENT.test(prompt);
  const forceOpen = intent || urgent;
  const { strong } = extractKeywords(prompt);
  const wantTranscripts = intent || strong.length > 0;
  // Gate A: direction only on first turn, or explicit retrieval intent, or force-open.
  const wantDirection = firstTurn || intent || forceOpen;
  // Gate B: commits handled by hash-compare in main (include on first turn / force-open /
  // changed hash). decideGates only signals the eligibility; hash diff decides the rest.
  const wantCommits = true; // eligible; main() suppresses when hash unchanged (and not forceOpen/firstTurn)
  // Gate C: kb only when there is retrieval need OR a long/ambiguous prompt OR force-open.
  const wantKb = wantTranscripts || forceOpen || firstTurn || prompt.length > 200;
  return { wantDirection, wantCommits, wantKb, wantTranscripts, forceOpen };
}

function emit(ctx: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
  }));
  process.exit(0);
}

export function main(): void {
  const raw = readStdinRaw();
  const { prompt, sessionId } = parseEnvelope(raw);
  if (!prompt || prompt.trim().length < 3) emit('');
  if (/^\s*\[CRON FIRED/.test(prompt)) emit('');

  const newest = listRecentTranscripts()[0] || '';
  const key = sessionKey(sessionId, newest);
  const cache = readCache(key);
  const g = decideGates(prompt, cache);
  const firstTurn = (cache.turnCount || 0) === 0;

  // Gate C — kb-query (with same-query freshness reuse, <2min)
  let kb = '';
  if (g.wantKb) {
    const norm = prompt.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 280);
    const fresh = cache.lastKbQueryNormalized === norm
      && cache.lastKbResult !== undefined
      && cache.lastKbAtMs !== undefined
      && (Date.now() - cache.lastKbAtMs) < 120_000;
    if (fresh) {
      kb = cache.lastKbResult || '';
    } else {
      kb = kbQuery(prompt);
      cache.lastKbQueryNormalized = norm;
      cache.lastKbResult = kb;
      cache.lastKbAtMs = Date.now();
    }
  }

  // Gate B — commits: hash-compare; suppress only when unchanged AND not first/force-open.
  const commitsRaw = recentCommits();
  const commitsHash = commitsRaw ? sha(commitsRaw) : '';
  const commitsUnchanged = !!commitsHash && commitsHash === cache.lastCommitsHash;
  const wantCommits = commitsRaw !== '' && (firstTurn || g.forceOpen || !commitsUnchanged);
  if (commitsHash) cache.lastCommitsHash = commitsHash;

  // Gate A — direction
  const direction = g.wantDirection ? conversationDirection() : '';

  // Gate D — transcripts (unchanged relevance gate)
  const tr = g.wantTranscripts ? transcriptHits(prompt) : '';

  // Persist the incremented turn count for this session.
  cache.turnCount = (cache.turnCount || 0) + 1;
  writeCache(key, cache);

  const parts: string[] = [];
  const hasContent = !!kb || wantCommits || !!direction || g.wantTranscripts;
  if (!hasContent) emit(''); // genuinely redundant/routine turn — matches cron precedent

  parts.push('<documented-past-retrieval>');
  parts.push(
    'Deterministic retrieval ran BEFORE your response. Answer FROM the evidence below and CITE the source (path/timestamp). Do NOT answer from memory or guess. If the evidence is empty or thin, say so and run a deeper search yourself (cortextos bus kb-query, open the actual jsonl) BEFORE answering — never substitute assumption for a real read.',
  );
  if (g.wantKb) {
    if (kb) parts.push('', '## MMRAG (cortextos bus kb-query) — cited hits:', kb);
    else parts.push('', '## MMRAG: no hits above threshold. Broaden the query or read source directly before answering — do not conclude "nothing exists" from one miss.');
  }
  if (wantCommits) {
    parts.push('', '## Recent commits — what just shipped (answer "what changed lately" from THIS, not memory):', commitsRaw);
  }
  if (direction) {
    parts.push('', '## Conversation direction — recent arc from your own transcripts (oldest -> newest):', direction);
  }
  if (g.wantTranscripts) {
    parts.push('', '## Transcript excerpts — recency-first jsonl reads (this IS reading the transcripts):');
    parts.push(tr || '(no matching turns in last 3 days for the extracted keywords — widen keywords and read more files before claiming nothing exists)');
  }
  parts.push('</documented-past-retrieval>');
  emit(parts.join('\n'));
}

// Run when executed as the hook entry (not when imported by tests).
if (require.main === module) {
  main();
}
