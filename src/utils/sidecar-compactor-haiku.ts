import type { SidecarCompactor, CompactionContext, CompactionSummary } from './sidecar-compactor.js';

const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a context compactor for an AI coding agent. Extract a structured compaction ledger from the conversation transcript.

Return ONLY valid JSON (no markdown, no explanation):
{
  "resolved": ["<completed item>", ...],
  "pending": ["<pending item>", ...],
  "key_facts": {
    "current_state": "<current state one paragraph>",
    "next_action": "<single concrete next step — required, never empty>",
    "active_files": ["<file>", ...],
    "blockers": ["<blocker>", ...]
  },
  "redaction_count": 0
}`;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

export class HaikuSidecarCompactor implements SidecarCompactor {
  async summarize(ctx: CompactionContext): Promise<CompactionSummary | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    // No per-turn truncation — splitTurnsByTokenBudget already bounds total size.
    // Truncating at \n\n boundaries breaks code blocks, JSON, and log output mid-thought.
    // Haiku 200K context handles the bounded token budget without per-turn clipping.
    const userContent = `Agent: ${ctx.agentName} | Context: ${ctx.contextPct}% | ${ctx.now}

=== OLDER TURNS ===
${ctx.middleTurnsText.slice(0, 40_000)}

=== RECENT TURNS ===
${ctx.recentTurnsText.slice(0, 12_000)}

Return ledger JSON.`;

    let resp: Response;
    try {
      resp = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      return null;
    }

    if (!resp.ok) return null;

    let body: AnthropicResponse;
    try {
      body = await resp.json() as AnthropicResponse;
    } catch {
      return null;
    }

    const text = body.content?.find(b => b.type === 'text')?.text ?? '';
    if (!text) return null;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]) as CompactionSummary;
    } catch {
      return null;
    }
  }
}

export function createCompactor(): SidecarCompactor {
  return new HaikuSidecarCompactor();
}
