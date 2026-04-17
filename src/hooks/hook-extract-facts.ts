/**
 * hook-extract-facts.ts — PreCompact hook.
 *
 * Captures the session summary produced by Claude Code at compaction time
 * and stores it as a structured fact entry in memory/facts/YYYY-MM-DD.jsonl.
 *
 * This gives agents persistent, token-free cross-session memory:
 * - Facts are written at compaction time (not just end-of-day)
 * - On next session start, agents recall recent facts via `cortextos bus recall-facts`
 * - Zero live-context tokens consumed — facts are indexed files, not conversation history
 *
 * Registered in settings.json under "PreCompact". Fires and returns immediately
 * — never blocks compaction.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { loadEnv, readStdin } from './index.js';

interface PreCompactPayload {
  session_id?: string;
  summary?: string;
  transcript?: string;
  turns?: Array<{ role: string; content: string }>;
}

interface FactEntry {
  ts: string;              // ISO 8601
  session_id: string;
  agent: string;
  org: string;
  source: 'precompact';
  summary: string;         // The compaction summary text
  keywords: string[];      // Extracted topic keywords for lightweight filtering
}

/**
 * Extract topic keywords from a summary string.
 * Simple word-frequency approach — no LLM call, no external deps.
 * Exported for unit testing.
 */
export function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'that', 'this', 'these', 'those', 'it', 'its',
    'i', 'we', 'you', 'he', 'she', 'they', 'my', 'our', 'your', 'their',
    'not', 'no', 'so', 'if', 'then', 'than', 'as', 'also', 'just', 'now',
    'up', 'out', 'what', 'which', 'who', 'when', 'where', 'how', 'about',
    'after', 'before', 'into', 'through', 'during', 'each', 'some', 'any',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopwords.has(w));

  const freq: Record<string, number> = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([word]) => word);
}

async function main(): Promise<void> {
  const env = loadEnv();

  try {
    // Read PreCompact payload from stdin with a 10s timeout — if Claude Code
    // does not close stdin, readStdin() hangs and hits the settings.json
    // 15s timeout, which aborts compaction. Race against a timer so we always
    // exit cleanly with whatever data arrived.
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 10_000)),
    ]);
    let payload: PreCompactPayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        // If not JSON, treat raw text as the summary directly
        payload = { summary: raw.trim() };
      }
    }

    // Extract the summary text — could be in summary, transcript, or turns
    let summaryText = payload.summary || '';
    if (!summaryText && payload.turns && payload.turns.length > 0) {
      // Last assistant turn as fallback
      const lastAssistant = [...payload.turns].reverse().find(t => t.role === 'assistant');
      if (lastAssistant) summaryText = lastAssistant.content;
    }

    // No usable content — exit silently, don't block compaction
    if (!summaryText || summaryText.trim().length < 20) return;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const org = process.env.CTX_ORG || '';
    const factsDir = join(env.ctxRoot, 'state', env.agentName, 'memory', 'facts');

    if (!existsSync(factsDir)) {
      mkdirSync(factsDir, { recursive: true });
    }

    const entry: FactEntry = {
      ts,
      session_id: payload.session_id || `session-${Date.now()}`,
      agent: env.agentName,
      org,
      source: 'precompact',
      summary: summaryText.slice(0, 8000), // Cap at 8k chars
      keywords: extractKeywords(summaryText),
    };

    const factsFile = join(factsDir, `${dateStr}.jsonl`);
    appendFileSync(factsFile, JSON.stringify(entry) + '\n', 'utf-8');

  } catch {
    // Never fail — compaction must not be blocked
  }
}

main().catch(() => process.exit(0));
