import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// USD per million tokens for known Claude models
const PRICING: Record<string, { inp: number; out: number; cw: number; cr: number }> = {
  'claude-sonnet-4-6':         { inp: 3.00,  out: 15.00, cw: 3.75,  cr: 0.30 },
  'claude-opus-4-7':           { inp: 15.00, out: 75.00, cw: 18.75, cr: 1.50 },
  'claude-opus-4-6':           { inp: 15.00, out: 75.00, cw: 18.75, cr: 1.50 },
  'claude-haiku-4-5':          { inp: 0.80,  out: 4.00,  cw: 1.00,  cr: 0.08 },
  'claude-haiku-4-5-20251001': { inp: 0.80,  out: 4.00,  cw: 1.00,  cr: 0.08 },
};
const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];

function calcCost(model: string, inp: number, out: number, cw: number, cr: number): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (inp * p.inp + out * p.out + cw * p.cw + cr * p.cr) / 1_000_000;
}

/**
 * Sum the USD cost of all assistant messages logged in a Claude Code session
 * JSONL file.  Used by updateTask/completeTask to attribute API spend to
 * specific task lifecycles.
 *
 * The session JSONL lives at:
 *   ~/.claude/projects/<cwd-with-slashes-as-hyphens>/<sessionId>.jsonl
 *
 * Returns 0 if the file cannot be found or read — cost attribution is
 * best-effort and must never block task operations.
 *
 * @param claudeProjectsDir  Override the ~/.claude/projects base (useful in tests)
 */
export function snapshotSessionCost(
  sessionId: string = process.env['CLAUDE_CODE_SESSION_ID'] ?? '',
  cwd: string = process.cwd(),
  claudeProjectsDir: string = join(homedir(), '.claude', 'projects'),
): number {
  if (!sessionId) return 0;

  const projectDirName = cwd.replace(/\//g, '-');
  const jsonlPath = join(claudeProjectsDir, projectDirName, `${sessionId}.jsonl`);

  if (!existsSync(jsonlPath)) return 0;

  let content: string;
  try {
    content = readFileSync(jsonlPath, 'utf-8');
  } catch {
    return 0;
  }

  let total = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      if (entry['type'] !== 'assistant') continue;

      // Prefer pre-computed costUSD if present (newer Claude Code versions)
      if (typeof entry['costUSD'] === 'number') {
        total += entry['costUSD'];
        continue;
      }

      // Fall back to computing from token usage
      const msg = entry['message'] as Record<string, unknown> | undefined;
      if (!msg) continue;
      const usage = msg['usage'] as Record<string, number> | undefined;
      if (!usage) continue;

      const model = typeof msg['model'] === 'string' ? msg['model'] : '';
      const inp = usage['input_tokens'] ?? 0;
      const out = usage['output_tokens'] ?? 0;
      const cw  = usage['cache_creation_input_tokens'] ?? 0;
      const cr  = usage['cache_read_input_tokens'] ?? 0;

      if (inp === 0 && out === 0 && cw === 0 && cr === 0) continue;
      total += calcCost(model, inp, out, cw, cr);
    } catch {
      // skip corrupt lines
    }
  }

  return total;
}
