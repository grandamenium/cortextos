import { readFileSync, statSync } from 'fs';

/**
 * Deterministic pre-filter for Claude Code conversation transcripts (.jsonl).
 *
 * Ported from a proven Python prototype that achieved ~96% size reduction on a
 * real 8.98MB transcript. The goal is a fast, dependency-free pass that strips
 * zero-recall-value noise (file snapshots, attachments, API-error churn,
 * boilerplate back-online/reminder/compaction lines) BEFORE the transcript is
 * handed to a model for summarization — keeping only the signal-bearing text
 * plus a structured extraction of PR links, bus threads, and decision lines.
 *
 * Reversible by design: this only READS the transcript and returns a result;
 * it never mutates or deletes the source file.
 */

export interface BusThread {
  sender: string;
  snippet: string;
}

export interface DistillSignal {
  /** GitHub PR URLs found anywhere in the kept text. */
  prs: string[];
  /** `=== AGENT MESSAGE from <sender>` bus thread headers + a short snippet. */
  busThreads: BusThread[];
  /** Decision-ish lines (decided / going with / approved / chose to ...). */
  decisions: string[];
  /** Count of each tool_use by tool name. */
  tools: Record<string, number>;
}

export interface DistillResult {
  /** Size of the source .jsonl on disk, in bytes. */
  rawBytes: number;
  /** Total JSON records parsed (unparseable lines are skipped, not counted). */
  recordsTotal: number;
  /** Records dropped as zero-recall noise (snapshots, attachments, meta, ...). */
  droppedNoise: number;
  /** Records dropped as API-error churn. */
  apiErrors: number;
  /** Boilerplate categories collapsed to counts (e.g. { reminder: 4 }). */
  boilerplate: Record<string, number>;
  /** Number of records whose text survived into cleanText. */
  kept: number;
  /** The distilled text, newline-joined. */
  cleanText: string;
  /** Structured signal extracted from the kept text. */
  signal: DistillSignal;
}

/** Record types with zero recall value — dropped entirely. */
const NOISE_TYPES = new Set([
  'file-history-snapshot',
  'attachment',
  'mode',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'queue-operation',
]);

/**
 * Boilerplate categories: text matching one of these (and shorter than 400
 * chars) is COLLAPSED — counted by category, not kept verbatim.
 */
const BOILERPLATE_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'back-online', re: /back[- ]online/i },
  { key: 'reminder', re: /reminder/i },
  { key: 'compaction', re: /compact|session is being continued/i },
  { key: 'handoff', re: /handoff/i },
  { key: 'system-reminder', re: /system-reminder/i },
];

/** API-error churn matcher (only treated as error when text is short). */
const API_ERROR_RE = /Prompt is too long|rate limit|overloaded|API Error/i;

const PR_RE = /https?:\/\/github\.com\/\S+?\/pull\/\d+/g;
const BUS_HEADER_RE = /^=== AGENT MESSAGE from (\w+)/;
const DECISION_RE = /\b(decided|decision|we'll go with|going with|approved|chose to)\b/i;

/**
 * Extract a flat text representation from a record's message content.
 * Content may be a plain string, or an array of typed blocks. Tool blocks are
 * rendered as compact placeholders so they contribute structure without bulk.
 * `tools` is mutated in place to accumulate tool_use counts.
 */
function extractText(content: unknown, tools: Record<string, number>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b['type'];
    if (type === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text'] as string);
    } else if (type === 'tool_use') {
      const name = typeof b['name'] === 'string' ? (b['name'] as string) : 'unknown';
      tools[name] = (tools[name] || 0) + 1;
      parts.push(`[tool_use:${name}]`);
    } else if (type === 'tool_result') {
      parts.push('[tool_result]');
    }
  }
  return parts.join('\n');
}

/**
 * Distill a Claude Code .jsonl transcript into a deterministic pre-filtered
 * result. Pure read — never mutates the source file.
 */
export function distillTranscript(jsonlPath: string): DistillResult {
  const rawBytes = statSync(jsonlPath).size;
  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n');

  let recordsTotal = 0;
  let droppedNoise = 0;
  let apiErrors = 0;
  let kept = 0;
  const boilerplate: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const keptLines: string[] = [];

  const prs = new Set<string>();
  const busThreads: BusThread[] = [];
  const decisions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // skip unparseable lines
    }
    recordsTotal++;

    const type = rec['type'];

    // DROP zero-recall noise record types.
    if (typeof type === 'string' && NOISE_TYPES.has(type)) {
      droppedNoise++;
      continue;
    }
    // DROP system meta records.
    if (type === 'system' && rec['isMeta'] === true) {
      droppedNoise++;
      continue;
    }

    // Extract message text (also accumulates tool_use counts).
    const message = rec['message'] as Record<string, unknown> | undefined;
    const text = message ? extractText(message['content'], tools) : '';

    // DROP API-error churn: explicit flag, or short error-shaped text.
    if (rec['isApiErrorMessage'] === true) {
      apiErrors++;
      continue;
    }
    if (text.length < 120 && API_ERROR_RE.test(text)) {
      apiErrors++;
      continue;
    }

    // COLLAPSE boilerplate (short matching text → count, don't keep verbatim).
    if (text.length < 400) {
      const match = BOILERPLATE_PATTERNS.find((p) => p.re.test(text));
      if (match) {
        boilerplate[match.key] = (boilerplate[match.key] || 0) + 1;
        continue;
      }
    }

    // KEEP this record's text.
    if (text) {
      keptLines.push(text);
      kept++;

      // EXTRACT signal from the kept text.
      const prMatches = text.match(PR_RE);
      if (prMatches) for (const url of prMatches) prs.add(url);

      for (const ln of text.split('\n')) {
        const busMatch = ln.match(BUS_HEADER_RE);
        if (busMatch) {
          busThreads.push({
            sender: busMatch[1],
            snippet: ln.slice(0, 120).trim(),
          });
        }
        if (ln.length > 15 && ln.length < 200 && DECISION_RE.test(ln)) {
          decisions.push(ln.trim());
        }
      }
    }
  }

  const cleanText = keptLines.join('\n');

  return {
    rawBytes,
    recordsTotal,
    droppedNoise,
    apiErrors,
    boilerplate,
    kept,
    cleanText,
    signal: {
      prs: Array.from(prs),
      busThreads,
      decisions,
      tools,
    },
  };
}
