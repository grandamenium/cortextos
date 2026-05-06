/**
 * hook-skill-telemetry.ts — PostToolUse hook (matcher: Skill).
 *
 * Fires after every Skill tool call. Extracts the skill slug from tool_input
 * and inserts a row into orch_skill_invocations via PostgREST (direct REST API).
 *
 * Previously this called a Supabase Edge Function (/functions/v1/skill-telemetry)
 * that was never deployed, causing all agent-sourced skill invocations to be
 * silently dropped (404). Now writes directly to orch_skill_invocations so
 * the dashboard's "top skills" panel reflects real invocation counts.
 *
 * The hook always exits 0 — it never blocks the agent. All errors are
 * logged to stderr and silently ignored.
 *
 * Credentials are read from the agent's .env file (SUPABASE_RGOS_URL +
 * SUPABASE_RGOS_SERVICE_KEY). If absent, the hook exits silently.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readStdin, parseHookInput } from './index.js';

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  // Only handle Skill tool calls
  if (tool_name !== 'Skill') return;

  const slug: string | undefined = tool_input?.skill;
  if (!slug || typeof slug !== 'string') {
    process.stderr.write('hook-skill-telemetry: no skill slug in tool_input — skipping\n');
    return;
  }

  // Read Supabase credentials from agent .env (CTX_AGENT_DIR env or cwd-relative)
  const agentDir = process.env.CTX_AGENT_DIR ?? process.cwd();
  const envFile = join(agentDir, '.env');
  if (!existsSync(envFile)) {
    process.stderr.write('hook-skill-telemetry: no .env found — skipping\n');
    return;
  }
  const envContent = readFileSync(envFile, 'utf-8');
  const sbUrl = envContent.match(/^SUPABASE_RGOS_URL=(.+)$/m)?.[1]?.trim();
  const sbKey = envContent.match(/^SUPABASE_RGOS_SERVICE_KEY=(.+)$/m)?.[1]?.trim();
  if (!sbUrl || !sbKey) {
    process.stderr.write('hook-skill-telemetry: SUPABASE_RGOS_URL/KEY not set — skipping\n');
    return;
  }

  const agentRole = process.env.CTX_AGENT_NAME ?? undefined;

  try {
    // Look up skill_id from orch_skills by slug (nullable — graceful if skill not in catalog)
    let skillId: string | null = null;
    const skillRes = await fetch(
      `${sbUrl}/rest/v1/orch_skills?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } },
    );
    if (skillRes.ok) {
      const skillRows = (await skillRes.json()) as Array<{ id: string }>;
      skillId = skillRows[0]?.id ?? null;
    }

    // Look up agent UUID from orch_agents by role_id or title
    let agentId: string | null = null;
    if (agentRole) {
      const agentRes = await fetch(
        `${sbUrl}/rest/v1/orch_agents?title=ilike.${encodeURIComponent(agentRole)}&select=id&limit=1`,
        { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } },
      );
      if (agentRes.ok) {
        const agentRows = (await agentRes.json()) as Array<{ id: string }>;
        agentId = agentRows[0]?.id ?? null;
      }
    }

    // Insert directly into orch_skill_invocations via PostgREST
    const body: Record<string, unknown> = {
      skill_slug: slug,
      source: 'agent',
      succeeded: true,
    };
    if (skillId) body.skill_id = skillId;
    if (agentId) body.agent_id = agentId;
    if (agentRole) body.agent_role = agentRole;

    const res = await fetch(`${sbUrl}/rest/v1/orch_skill_invocations`, {
      method: 'POST',
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      process.stderr.write(`hook-skill-telemetry: INSERT failed (${res.status}): ${errBody}\n`);
    } else {
      process.stderr.write(`hook-skill-telemetry: logged invocation for skill "${slug}" (succeeded=true)\n`);
    }
  } catch (err) {
    process.stderr.write(`hook-skill-telemetry: error — ${err}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`hook-skill-telemetry: error — ${err}\n`);
  process.exit(0); // always exit 0 — never block tool execution
});
