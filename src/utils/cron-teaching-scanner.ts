/**
 * Scanner for stale cron-teaching patterns in agent workspace files.
 *
 * Pre-external-persistent-crons, agents were taught to use `CronCreate` /
 * `/loop` and to edit `config.json` for cron registration.  After that
 * migration, all persistent crons live in `crons.json` and are managed via
 * `cortextos bus add-cron` / `update-cron` / `remove-cron`.  Existing
 * user-customized agent workspaces still carry the old teaching, which is
 * misleading at best.
 *
 * This scanner walks an agent's workspace files, flags lines that still
 * teach the deprecated pattern, and offers a tightly-scoped `--apply` mode
 * that only performs literal substitutions known to be safe regardless of
 * surrounding context.
 *
 * Whitelist (lines NOT flagged):
 *   - Lines containing negation tokens: "do NOT", "Never use", "won't
 *     survive", "session-only", "evaporate", "recurring: false", etc.
 *   - Files containing the m2c1-worker sentinel comment
 *     (`/loop is intentionally used`) — those teach a legitimate
 *     short-lived session-scoped /loop.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import type { Dirent } from 'fs';
import { join } from 'path';

/** Top-level agent files always scanned, in order. */
const AGENT_TOP_FILES = ['CLAUDE.md', 'AGENTS.md', 'ONBOARDING.md'] as const;

/** Marker comment that opts a file out of scanning entirely. */
export const SENTINEL_MARKER = '/loop is intentionally used';

export interface ScannerMatch {
  /** Pattern name that flagged the line. */
  pattern: string;
  /** Absolute file path. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** Trimmed line content (capped at 200 chars). */
  excerpt: string;
  /** Canonical replacement guidance shown to the user. */
  suggestion: string;
}

export interface FileScanResult {
  file: string;
  matches: ScannerMatch[];
  /** Number of literal substitutions applied (only when `apply` is true). */
  applied: number;
  /** Whether the file was skipped entirely because of the sentinel marker. */
  skippedSentinel: boolean;
}

export interface AgentScanResult {
  agentDir: string;
  scannedFiles: string[];
  skippedSentinelFiles: string[];
  matches: ScannerMatch[];
  appliedSubstitutions: number;
}

export interface ScanOptions {
  /** When true, perform the safe literal substitutions in place. */
  apply?: boolean;
}

interface StalePattern {
  name: string;
  /** Predicate run per line — returns true when this pattern matches. */
  match: (line: string) => boolean;
  suggestion: string;
}

const STALE_PATTERNS: StalePattern[] = [
  {
    name: 'CronCreate',
    match: (line) => /\bCronCreate\b/.test(line),
    suggestion:
      "Use 'cortextos bus add-cron <agent> <name> <interval> <prompt>' for persistent crons. Keep CronCreate only for one-shot reminders (recurring: false).",
  },
  {
    name: '/loop create cron',
    match: (line) => /\/loop\s+create\s+cron\b/.test(line),
    suggestion:
      "Use 'cortextos bus add-cron'. /loop is session-only and dies on restart.",
  },
  {
    name: '/loop <interval> (cron creation form)',
    match: (line) => /`?\/loop\s+\d+[smhd]\b/.test(line),
    suggestion:
      "Use 'cortextos bus add-cron'. /loop is session-only.",
  },
  {
    name: '(configured in config.json)',
    match: (line) => /\(configured in config\.json\)/.test(line),
    suggestion:
      "Replace with '(configured via cortextos bus add-cron)'. config.json is no longer the cron source of truth.",
  },
  {
    name: 'edit config.json (cron context)',
    match: (line) =>
      /\bconfig\.json\b/.test(line) &&
      /\bcron(s|expr|s\.json|s array)?\b/i.test(line) &&
      /\b(edit|modify|add to|update|write to)\b/i.test(line),
    suggestion:
      "config.json no longer holds crons. Use 'cortextos bus add-cron' (the daemon owns crons.json directly).",
  },
];

/** Tokens whose presence on a line marks it as deprecation-teaching. */
const NEGATION_PATTERNS: RegExp[] = [
  /\bdo\s*NOT\b/,
  /\bdo\s+not\b/i,
  /\bdon'?t\s+(?:use|edit|write|call|put)\b/i,
  /\bnever\s+(?:use|write|edit|call|put)\b/i,
  /\bwon'?t\s+survive\b/i,
  /\bevaporate\b/i,
  /\bsession[-\s]only\b/i,
  /\bsession[-\s]local\b/i,
  /\brecurring:\s*false\b/i,
  /\bnot\s+(?:for\s+)?persistent\b/i,
  /\bdeprecated\b/i,
];

interface SafeSubstitution {
  /** Regex (with `g` flag) that matches the from-text. */
  from: RegExp;
  /** Replacement string. */
  to: string;
}

const SAFE_SUBSTITUTIONS: SafeSubstitution[] = [
  {
    from: /\(configured in config\.json\)/g,
    to: '(configured via cortextos bus add-cron)',
  },
];

function hasNegationContext(line: string): boolean {
  return NEGATION_PATTERNS.some((re) => re.test(line));
}

/** Scan a single file. Returns matches and (when `apply`) writes back. */
export function scanFile(filePath: string, opts: ScanOptions = {}): FileScanResult {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { file: filePath, matches: [], applied: 0, skippedSentinel: false };
  }

  if (content.includes(SENTINEL_MARKER)) {
    return { file: filePath, matches: [], applied: 0, skippedSentinel: true };
  }

  const lines = content.split(/\r?\n/);
  const matches: ScannerMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hasNegationContext(line)) continue;
    for (const p of STALE_PATTERNS) {
      if (p.match(line)) {
        matches.push({
          pattern: p.name,
          file: filePath,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
          suggestion: p.suggestion,
        });
      }
    }
  }

  let applied = 0;
  if (opts.apply) {
    let next = content;
    for (const sub of SAFE_SUBSTITUTIONS) {
      const m = next.match(sub.from);
      if (m && m.length > 0) {
        applied += m.length;
        next = next.replace(sub.from, sub.to);
      }
    }
    if (applied > 0 && next !== content) {
      writeFileSync(filePath, next, 'utf-8');
    }
  }

  return { file: filePath, matches, applied, skippedSentinel: false };
}

function walkSkillsDir(skillsRoot: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(skillsRoot, e.name);
    if (e.isDirectory()) {
      walkSkillsDir(full, out);
    } else if (e.isFile() && e.name === 'SKILL.md') {
      out.push(full);
    }
  }
}

/** Resolve the candidate file list for a single agent workspace. */
export function listAgentFiles(agentDir: string): string[] {
  const candidates: string[] = [];
  for (const top of AGENT_TOP_FILES) {
    const fp = join(agentDir, top);
    if (existsSync(fp)) candidates.push(fp);
  }
  const skillsRoot = join(agentDir, '.claude', 'skills');
  if (existsSync(skillsRoot)) {
    walkSkillsDir(skillsRoot, candidates);
  }
  return candidates;
}

/** Scan an entire agent workspace (CLAUDE/AGENTS/ONBOARDING + skills). */
export function scanAgentDir(
  agentDir: string,
  opts: ScanOptions = {},
): AgentScanResult {
  const scannedFiles: string[] = [];
  const skippedSentinelFiles: string[] = [];
  const matches: ScannerMatch[] = [];
  let appliedSubstitutions = 0;

  for (const fp of listAgentFiles(agentDir)) {
    const r = scanFile(fp, opts);
    if (r.skippedSentinel) {
      skippedSentinelFiles.push(fp);
      continue;
    }
    scannedFiles.push(fp);
    matches.push(...r.matches);
    appliedSubstitutions += r.applied;
  }

  return {
    agentDir,
    scannedFiles,
    skippedSentinelFiles,
    matches,
    appliedSubstitutions,
  };
}

/** Group matches by file for readable reporting. */
export function groupMatchesByFile(matches: ScannerMatch[]): Map<string, ScannerMatch[]> {
  const out = new Map<string, ScannerMatch[]>();
  for (const m of matches) {
    const arr = out.get(m.file) ?? [];
    arr.push(m);
    out.set(m.file, arr);
  }
  return out;
}
