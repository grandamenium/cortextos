/**
 * hook-session-restore.ts — SessionStart hook.
 *
 * Injects the most recent compaction snapshot into the new session as
 * `additionalContext`. This restores working state automatically after a
 * context compaction without requiring the agent to explicitly call
 * `recall-facts` — the context arrives before the agent's first turn.
 *
 * Design:
 * - Only fires when source === 'compact'. Skips startup, resume, and clear.
 * - Reads the last N fact entries written by hook-extract-facts (PreCompact),
 *   sorted by timestamp (most recent last) across up to two days of files.
 * - Formats the most recent summary as a compact context block.
 * - Returns Claude Code's SessionStart hookSpecificOutput shape so the
 *   additionalContext is injected before the agent's first turn.
 * - Silent on any error — never blocks session start.
 *
 * Registered in settings.json under "SessionStart".
 * Compatible with agentmemory MCP: this hook handles short-term compaction
 * restore; agentmemory provides long-term semantic search across many sessions.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

interface FactEntry {
  ts: string;
  session_id: string;
  agent: string;
  org: string;
  source: string;
  summary: string;
  keywords: string[];
}

interface SessionStartPayload {
  session_id?: string;
  source?: string; // 'startup' | 'resume' | 'compact' | 'clear'
}

const MAX_SUMMARY_CHARS = 3000;
const MAX_AGE_HOURS = 6;

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    let payload: SessionStartPayload = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      // Non-JSON input — proceed with defaults
    }

    // Only restore on compaction. Skip startup, resume (user --continue), and
    // /clear (user explicitly cleared context — respect that intent).
    if (payload.source !== 'compact') {
      process.exit(0);
    }

    const env = loadEnv();
    const factsDir = join(env.ctxRoot, 'state', env.agentName, 'memory', 'facts');

    const entries: FactEntry[] = [];
    for (let d = 0; d < 2; d++) {
      const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${dateStr}.jsonl`);
      if (!existsSync(factsFile)) continue;
      try {
        const lines = readFileSync(factsFile, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as FactEntry;
            if (entry.source === 'precompact' && entry.summary) {
              entries.push(entry);
            }
          } catch { /* skip corrupt lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    if (entries.length === 0) {
      process.exit(0);
    }

    // Sort all entries by timestamp and take the most recent.
    // This is correct even across the day boundary where d=0 (today) and
    // d=1 (yesterday) entries are interleaved in the array.
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    const latest = entries[entries.length - 1];

    // Skip if the snapshot is too old (agent probably had a clean restart)
    const ageMs = Date.now() - new Date(latest.ts).getTime();
    if (ageMs > MAX_AGE_HOURS * 60 * 60 * 1000) {
      process.exit(0);
    }

    const ts = latest.ts.replace('T', ' ').replace('Z', ' UTC').slice(0, 16);
    const summary = latest.summary.slice(0, MAX_SUMMARY_CHARS);
    const keywordsLine = latest.keywords.length > 0
      ? `\nKey topics: ${latest.keywords.slice(0, 8).join(', ')}`
      : '';

    const additionalContext = [
      `## Context from Previous Session`,
      ``,
      `_Snapshot taken at ${ts} (before context compaction)_`,
      keywordsLine,
      ``,
      summary,
    ].join('\n');

    // Claude Code SessionStart hook output shape
    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);

  } catch {
    // Never fail — session start must not be blocked
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
