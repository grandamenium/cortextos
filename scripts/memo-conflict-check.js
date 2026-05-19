#!/usr/bin/env node
/**
 * memo-conflict-check.js
 *
 * Scans a PR diff against retired/deprecated/blocked patterns extracted from
 * the framework memory files. Called by auto-merge-pr.js before each merge.
 *
 * Pattern sources (in priority order):
 *   1. CRITICAL_PATTERNS — hardcoded from known critical memory rules
 *   2. Memory files — backtick tokens from "NEVER"/"do NOT"/"STALE"/"deprecated" lines
 *
 * Returns { hasConflict, conflicts } where each conflict is:
 *   { pattern, description, line, lineNum }
 */

'use strict';

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Hardcoded critical patterns (from known memory rules)
// ---------------------------------------------------------------------------

const CRITICAL_PATTERNS = [
  {
    regex: /gpt-5-codex\b/,
    description: 'Invalid Codex model slug — use gpt-5.3-codex, gpt-5.4-mini, etc. (MEMORY: Codex model slugs)',
  },
  {
    regex: /\bchromadb\b|\bChromaDB\b|\bchroma\b.*kb|kb.*\bchroma\b/i,
    description: 'ChromaDB KB deprecated since 2026-05-14 — use wiki-grep or qmd (MEMORY: KB ingestion DEPRECATED)',
  },
  {
    regex: /\bOPEN_BRAIN_KEY\b|\bopenBrain\b|\bopen_brain\b|\bopen brain\b/i,
    description: 'Open Brain is sunsetted — remove or rewire this reference',
  },
  {
    regex: /\bgrandamenium\/cortextos\b|\bgrandamenium\/rgos\b/,
    description: 'NEVER push/PR to grandamenium — fork only (RevOps-Global-GIT)',
  },
  {
    regex: /\bStartInterval\b.*\bLaunchAgent\b|\bLaunchAgent\b.*\bStartInterval\b|\bKeepAlive\s*=\s*true\b/,
    description: 'Retired LaunchAgent pattern — Mac agents use cortextos daemon, not launchd',
  },
  {
    regex: /\/v1\/realtime\/sessions\b/,
    description: 'OpenAI /v1/realtime/sessions is fully deprecated — use wss://api.openai.com/v1/realtime WS directly',
  },
];

// ---------------------------------------------------------------------------
// Pattern extraction from memory files
// ---------------------------------------------------------------------------

const MEMORY_ROOT = path.join(
  process.env.HOME,
  '.claude/projects/-home-cortextos-cortextos/memory',
);

/**
 * Extract backtick-quoted tokens from lines containing blocked keywords.
 * Returns array of { token, description }.
 */
function extractMemoryPatterns() {
  if (!fs.existsSync(MEMORY_ROOT)) return [];

  const results = [];
  const BLOCKED_LINE_RE = /\b(never|do not|stale|deprecated|retired|sunsetted|disabled)\b/i;
  const BACKTICK_RE = /`([^`]{3,40})`/g;

  let files;
  try {
    files = fs.readdirSync(MEMORY_ROOT).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(MEMORY_ROOT, file), 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!BLOCKED_LINE_RE.test(line)) continue;

      let match;
      BACKTICK_RE.lastIndex = 0;
      while ((match = BACKTICK_RE.exec(line)) !== null) {
        const token = match[1].trim();
        // Skip if it looks like a command, URL, or too generic
        if (token.includes(' ') && !token.includes('-')) continue;
        if (token.startsWith('http')) continue;
        if (token.length < 4) continue;
        // Skip duplicates
        if (results.some(r => r.token === token)) continue;

        results.push({
          token,
          description: `Memory flag: ${line.trim().slice(0, 120)}`,
          file,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Diff fetching
// ---------------------------------------------------------------------------

function fetchDiff(repo, prNumber) {
  try {
    return execFileSync('gh', ['pr', 'diff', String(prNumber), '-R', repo], {
      encoding: 'utf-8',
      timeout: 20000,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core checker
// ---------------------------------------------------------------------------

/**
 * Check a PR diff against all known blocked patterns.
 * Returns { hasConflict: boolean, conflicts: ConflictEntry[] }
 */
function checkDiff(diff) {
  if (!diff) return { hasConflict: false, conflicts: [] };

  const addedLines = [];
  let lineNum = 0;
  for (const raw of diff.split('\n')) {
    lineNum++;
    // Only check additions (lines starting with +, not ++)
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      addedLines.push({ text: raw.slice(1), lineNum });
    }
  }

  const memoryPatterns = exportedForTest._memoryPatternCache !== null
    ? exportedForTest._memoryPatternCache
    : (exportedForTest._memoryPatternCache = extractMemoryPatterns());

  const conflicts = [];

  for (const { text, lineNum: ln } of addedLines) {
    // Critical patterns (high-confidence, always flag)
    for (const { regex, description } of CRITICAL_PATTERNS) {
      if (regex.test(text)) {
        if (!conflicts.some(c => c.pattern === regex.source && c.line === text)) {
          conflicts.push({ pattern: regex.source, description, line: text.trim(), lineNum: ln, critical: true });
        }
      }
    }

    // Memory-extracted patterns (lower confidence — flag but annotate as "warning")
    for (const { token, description } of memoryPatterns) {
      // Exact-word match to reduce false positives
      const wordRe = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wordRe.test(text)) {
        if (!conflicts.some(c => c.pattern === token && c.line === text)) {
          conflicts.push({ pattern: token, description, line: text.trim(), lineNum: ln, critical: false });
        }
      }
    }
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}

/**
 * Check a PR (by repo + number) and return result.
 * Fetches diff automatically.
 */
function checkPR(repo, prNumber) {
  const diff = fetchDiff(repo, prNumber);
  return checkDiff(diff);
}

/**
 * Format a conflict result as a GitHub PR comment body.
 */
function formatComment(repo, prNumber, conflicts) {
  const critical = conflicts.filter(c => c.critical);
  const warnings = conflicts.filter(c => !c.critical);

  const lines = [
    '## ⚠️ Memo-Conflict Check',
    '',
    'This PR introduces patterns that conflict with active memory rules.',
    'Auto-merge has been **skipped** pending review.',
    '',
  ];

  if (critical.length > 0) {
    lines.push('### Critical (merge blocked)');
    lines.push('');
    for (const c of critical) {
      lines.push(`**Pattern:** \`${c.pattern}\``);
      lines.push(`**Rule:** ${c.description}`);
      lines.push(`**Line:** \`${c.line.slice(0, 120)}\``);
      lines.push('');
    }
  }

  if (warnings.length > 0) {
    lines.push('### Warnings (review recommended)');
    lines.push('');
    for (const c of warnings) {
      lines.push(`**Pattern:** \`${c.pattern}\``);
      lines.push(`**Context:** ${c.description}`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('*Posted by auto-merge-pr memo-conflict-check. Add `memo-conflict-ok` to PR body to suppress.*');

  return lines.join('\n');
}

/**
 * Post a comment on the PR via gh CLI. Non-fatal.
 */
function postComment(repo, prNumber, body) {
  try {
    execFileSync('gh', ['pr', 'comment', String(prNumber), '-R', repo, '--body', body], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports + cache management for testing
// ---------------------------------------------------------------------------

const exportedForTest = {
  _memoryPatternCache: null,
  clearCache() { this._memoryPatternCache = null; },
};

module.exports = {
  checkDiff,
  checkPR,
  formatComment,
  postComment,
  extractMemoryPatterns,
  CRITICAL_PATTERNS,
  MEMORY_ROOT,
  _test: exportedForTest,
};
