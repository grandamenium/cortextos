/**
 * skill-instrument.ts — Log implicit skill invocations from bus subcommands.
 *
 * Bus commands like update-heartbeat, create-task, and log-event are canonical
 * entrypoints for skills (heartbeat, tasks, event-logging) but never go through
 * the Skill tool, so orch_skill_invocations stays at 0 for those skills even
 * though they fire 1000+ times per week.
 *
 * Call logImplicitInvocation(slug, agentDir, agentRole) at the end of each such
 * subcommand. The call is always fire-and-forget — errors are logged to stderr
 * and the bus command's own process.exit(0) is not delayed.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/** Maps bus subcommand names to their canonical skill slugs. */
export const SUBCOMMAND_SKILL_MAP: Record<string, string> = {
  'update-heartbeat': 'heartbeat',
  'create-approval': 'approvals',
  'log-event': 'event-logging',
  'send-message': 'comms',
  'create-task': 'tasks',
};

/**
 * Insert a row into orch_skill_invocations for an implicit bus-layer invocation.
 * Reads Supabase credentials from `agentDir/.env`. No-ops when credentials are
 * absent, and logs non-fatal telemetry errors to stderr.
 */
export type SkillInvocationSource = 'bus_implicit' | 'cron';

export interface LogImplicitInvocationOptions {
  source?: SkillInvocationSource;
}

function readEnvFileValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, 'utf-8');
  return content.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
}

function envValue(agentDir: string, key: string): string | undefined {
  const agentEnv = join(agentDir, '.env');
  const orgEnv = join(dirname(dirname(agentDir)), 'secrets.env');
  return process.env[key]?.trim()
    || readEnvFileValue(agentEnv, key)
    || readEnvFileValue(orgEnv, key);
}

async function responseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function warn(message: string): void {
  process.stderr.write(`skill-instrument: ${message}\n`);
}

export async function logImplicitInvocation(
  skillSlug: string,
  agentDir: string,
  agentRole?: string,
  options: LogImplicitInvocationOptions = {},
): Promise<void> {
  try {
    if (!agentDir) return;
    const sbUrl = envValue(agentDir, 'SUPABASE_RGOS_URL') || envValue(agentDir, 'RGOS_SUPABASE_URL');
    const sbKey = envValue(agentDir, 'SUPABASE_RGOS_SERVICE_KEY') || envValue(agentDir, 'RGOS_SUPABASE_SERVICE_KEY');
    if (!sbUrl || !sbKey) return;

    const headers = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

    // Resolve skill_id. Production orch_skill_invocations.skill_id is NOT NULL,
    // so unknown or falsely extracted slugs must be skipped instead of inserted.
    let skillId: string | null = null;
    const skillRes = await fetch(
      `${sbUrl}/rest/v1/orch_skills?slug=eq.${encodeURIComponent(skillSlug)}&select=id&limit=1`,
      { headers },
    );
    if (skillRes.ok) {
      const rows = (await skillRes.json()) as Array<{ id: string }>;
      skillId = rows[0]?.id ?? null;
    } else {
      warn(`skill lookup failed for "${skillSlug}" (${skillRes.status}): ${await responseText(skillRes)}`);
    }
    if (!skillId) return;

    // Resolve agent_id (nullable)
    let agentId: string | null = null;
    if (agentRole) {
      const agentRes = await fetch(
        `${sbUrl}/rest/v1/orch_agents?title=ilike.${encodeURIComponent(agentRole)}&select=id&limit=1`,
        { headers },
      );
      if (agentRes.ok) {
        const rows = (await agentRes.json()) as Array<{ id: string }>;
        agentId = rows[0]?.id ?? null;
      } else {
        warn(`agent lookup failed for "${agentRole}" (${agentRes.status}): ${await responseText(agentRes)}`);
      }
    }

    const body: Record<string, unknown> = {
      skill_slug: skillSlug,
      source: options.source ?? 'bus_implicit',
      succeeded: true,
    };
    body.skill_id = skillId;
    if (agentId) body.agent_id = agentId;
    if (agentRole) body.agent_role = agentRole;

    const insertRes = await fetch(`${sbUrl}/rest/v1/orch_skill_invocations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    if (!insertRes.ok) {
      warn(`insert failed for "${skillSlug}" (${insertRes.status}): ${await responseText(insertRes)}`);
    }
  } catch (err) {
    // Never throw — must not block the bus command that called us.
    warn(`error logging "${skillSlug}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
