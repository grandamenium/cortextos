import { NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getFrameworkRoot, getAllAgents, getAgentDir } from '@/lib/config';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';

function resolveAgentConfigPath(frameworkRoot: string, name: string): string | null {
  // First check via getAllAgents (uses enabled-agents.json + filesystem scan)
  const allAgents = getAllAgents();
  const entry = allAgents.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (entry) {
    const agentDir = getAgentDir(entry.name, entry.org || undefined);
    const p = join(agentDir, 'config.json');
    if (existsSync(p)) return p;
  }

  // Fallback: search all orgs directories
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;
  for (const org of readdirSync(orgsDir)) {
    const p = join(orgsDir, org, 'agents', name, 'config.json');
    if (existsSync(p)) return p;
  }
  return null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const configPath = resolveAgentConfigPath(frameworkRoot, name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return Response.json({ config, name });
  } catch {
    return Response.json({ error: 'Failed to read config' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const frameworkRoot = getFrameworkRoot();
  const configPath = resolveAgentConfigPath(frameworkRoot, name);
  if (!configPath) {
    return Response.json({ error: 'Agent config not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const allowed = ['timezone', 'day_mode_start', 'day_mode_end', 'communication_style', 'approval_rules', 'runtime', 'max_session_seconds', 'max_crashes_per_day', 'startup_delay', 'model', 'ctx_warning_threshold', 'ctx_handoff_threshold', 'cron_mode', 'daily_restart_time'];
  const runtimeValues = ['claude-code', 'codex-app-server', 'hermes'] as const;
  const cronModeValues = ['inject', 'print'] as const;
  const timeRegex = /^\d{2}:\d{2}$/;
  if (body.day_mode_start && !timeRegex.test(body.day_mode_start as string)) {
    return Response.json({ error: 'day_mode_start must be HH:MM' }, { status: 400 });
  }
  if (body.day_mode_end && !timeRegex.test(body.day_mode_end as string)) {
    return Response.json({ error: 'day_mode_end must be HH:MM' }, { status: 400 });
  }

  if (body.runtime !== undefined) {
    if (typeof body.runtime !== 'string' || !runtimeValues.includes(body.runtime as typeof runtimeValues[number])) {
      return Response.json({ error: `runtime must be one of ${runtimeValues.join(', ')}` }, { status: 400 });
    }
  }

  if (body.cron_mode !== undefined) {
    if (typeof body.cron_mode !== 'string' || !cronModeValues.includes(body.cron_mode as typeof cronModeValues[number])) {
      return Response.json({ error: 'cron_mode must be one of inject, print' }, { status: 400 });
    }
  }

  if (body.daily_restart_time !== undefined) {
    if (body.daily_restart_time !== null && (typeof body.daily_restart_time !== 'string' || !/^\d{1,2}:\d{2}$/.test(body.daily_restart_time as string))) {
      return Response.json({ error: 'daily_restart_time must be HH:MM (UTC) or null to disable' }, { status: 400 });
    }
  }

  // Validate approval_rules shape
  if (body.approval_rules !== undefined) {
    const ar = body.approval_rules as Record<string, unknown>;
    const isStringArray = (v: unknown) => Array.isArray(v) && (v as unknown[]).every(el => typeof el === 'string' && el.length > 0);
    if (
      typeof ar !== 'object' || ar === null || Array.isArray(ar) ||
      !isStringArray(ar.always_ask) || !isStringArray(ar.never_ask)
    ) {
      return Response.json(
        { error: 'approval_rules must have shape { always_ask: string[], never_ask: string[] } with non-empty string elements' },
        { status: 400 },
      );
    }
  }

  // Validate context threshold fields: must be numbers between 50 and 95
  for (const pctField of ['ctx_warning_threshold', 'ctx_handoff_threshold'] as const) {
    if (body[pctField] !== undefined) {
      const val = body[pctField];
      if (typeof val !== 'number' || val < 50 || val > 95) {
        return Response.json({ error: `${pctField} must be a number between 50 and 95` }, { status: 400 });
      }
    }
  }
  if (body.ctx_warning_threshold !== undefined && body.ctx_handoff_threshold !== undefined) {
    if ((body.ctx_warning_threshold as number) >= (body.ctx_handoff_threshold as number)) {
      return Response.json({ error: 'ctx_warning_threshold must be less than ctx_handoff_threshold' }, { status: 400 });
    }
  }

  // Validate numeric fields: must be non-negative integers
  for (const numField of ['max_session_seconds', 'max_crashes_per_day', 'startup_delay'] as const) {
    if (body[numField] !== undefined) {
      const val = body[numField];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
        return Response.json(
          { error: `${numField} must be a non-negative integer` },
          { status: 400 },
        );
      }
    }
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    for (const key of allowed) {
      if (body[key] !== undefined) config[key] = body[key];
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    // Notify agent immediately (non-fatal if offline)
    try {
      const sendMsg = join(frameworkRoot, 'bus', 'send-message.sh');
      if (existsSync(sendMsg)) {
        spawnSync(
          'bash',
          [sendMsg, name, 'normal', 'Settings updated via dashboard. Re-read config.json and apply new operational settings.'],
          {
            env: { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_AGENT_NAME: name },
            timeout: 5000,
            stdio: 'pipe',
          },
        );
      }
    } catch (notifyErr) {
      console.error(`[api/agents/${name}/config] PATCH: send-message.sh failed (non-fatal):`, notifyErr);
    }

    return Response.json({ success: true, config, name });
  } catch {
    return Response.json({ error: 'Failed to write config' }, { status: 500 });
  }
}
