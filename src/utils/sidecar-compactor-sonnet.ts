import type { SidecarCompactor, CompactionContext, CompactionSummary } from './sidecar-compactor.js';

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are a context compactor for an AI coding agent. Given a conversation transcript, extract structured information for a compaction ledger.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "resolved": ["<completed task 1>", ...],
  "pending": ["<pending task 1>", ...],
  "key_facts": {
    "current_state": "<one paragraph describing where things stand right now>",
    "next_action": "<the single most important next action the agent should take>",
    "active_files": ["<file1>", ...],
    "blockers": ["<blocker1>", ...]
  },
  "redaction_count": 0
}

Rules:
- resolved: tasks/items that were completed in the transcript
- pending: tasks/items still in progress or not yet started
- key_facts.current_state: factual description of current state (not a plan)
- key_facts.next_action: must be non-empty — the single concrete next step
- active_files: files that were recently modified or are relevant to pending work
- blockers: anything blocking progress
- If no resolved/pending/active_files/blockers, use empty arrays
- redaction_count: 0 (the caller updates this)`;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

export class ClaudeSidecarCompactor implements SidecarCompactor {
  async summarize(ctx: CompactionContext): Promise<CompactionSummary | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return null;
    }

    const userContent = `Agent: ${ctx.agentName}
Compacted at: ${ctx.now}
Context: ${ctx.contextPct}%

=== OLDER TURNS (summarize these) ===
${ctx.middleTurnsText.slice(0, 60_000)}

=== RECENT TURNS (preserve context for these) ===
${ctx.recentTurnsText.slice(0, 20_000)}

Extract the compaction ledger JSON now.`;

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
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      return null;
    }

    if (!resp.ok) {
      return null;
    }

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
  return new ClaudeSidecarCompactor();
}
