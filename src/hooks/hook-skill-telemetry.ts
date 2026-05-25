/**
 * hook-skill-telemetry.ts — PostToolUse hook (matcher: Skill|Read).
 *
 * Fires after every Skill tool call and after Read calls that load a SKILL.md.
 * Inserts a row into orch_skill_invocations via PostgREST (direct REST API).
 *
 * Two paths:
 *   1. tool_name === 'Skill'  → source='agent', slug from tool_input.skill
 *   2. tool_name === 'Read'   → source='read',  slug extracted from file_path
 *      matching /.claude/skills/<slug>/SKILL.md
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
 *
 * Hot-loop safety: this hook runs in a subprocess and uses only readFileSync +
 * fetch — it never invokes the Read tool, so no recursive firing can occur.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { readStdin, parseHookInput } from './index.js';

// Matches .claude/skills/<slug>/SKILL.md anywhere in a path
const SKILL_MD_RE = /\.claude\/skills\/([^/]+)\/SKILL\.md$/;

async function main(): Promise<void> {
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  let slug: string;
  let source: 'agent' | 'read';

  if (tool_name === 'Skill') {
    // Explicit Skill tool invocation
    const s: string | undefined = tool_input?.skill;
    if (!s || typeof s !== 'string') {
      process.stderr.write('hook-skill-telemetry: no skill slug in tool_input — skipping\n');
      return;
    }
    slug = s;
    source = 'agent';
  } else if (tool_name === 'Read') {
    // Read tool loading a SKILL.md file
    const filePath: string | undefined = tool_input?.file_path;
    if (!filePath || typeof filePath !== 'string') return;
    const match = SKILL_MD_RE.exec(filePath);
    if (!match) return; // not a SKILL.md read — ignore
    slug = match[1];
    source = 'read';
  } else {
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
    // Look up skill_id. Production orch_skill_invocations.skill_id is NOT NULL,
    // so unknown slugs must be skipped instead of inserted.
    let skillId: string | null = null;
    const skillRes = await fetch(
      `${sbUrl}/rest/v1/orch_skills?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } },
    );
    if (skillRes.ok) {
      const skillRows = (await skillRes.json()) as Array<{ id: string }>;
      skillId = skillRows[0]?.id ?? null;
    }
    if (!skillId) return;

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
      source,
      succeeded: true,
    };
    body.skill_id = skillId;
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
      process.stderr.write(
        `hook-skill-telemetry: logged invocation for skill "${slug}" (source=${source}, succeeded=true)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`hook-skill-telemetry: error — ${err}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`hook-skill-telemetry: error — ${err}\n`);
  process.exit(0); // always exit 0 — never block tool execution
});
