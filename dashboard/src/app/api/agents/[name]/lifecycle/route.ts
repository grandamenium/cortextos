import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getFrameworkRoot, getCTXRoot } from '@/lib/config';
import { IPCClient } from '@/lib/ipc-client';
import { mutateEnabledAgents } from '@/lib/enabled-agents';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

const VALID_ACTIONS =['enable', 'disable', 'restart', 'start', 'stop', 'restart_continue', 'restart_fresh'];

// Security (C4): Validate org and name against allowlist before use in shell commands or path.join.
function validateIdentifier(value: string | null | undefined, field: string): string {
  if (!value || !/^[a-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${field}: must match [a-z0-9_-]+`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// POST /api/agents/[name]/lifecycle - Enable, disable, or restart an agent
//
// Body: { action: "enable" | "disable" | "restart", org?: string, mode?: "continue" | "fresh" }
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action: rawAction, org } = body as {
    action?: string;
    org?: string;
  };

  if (!rawAction || !VALID_ACTIONS.includes(rawAction)) {
    return Response.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  // Normalize UI action names to IPC action names
  const action = rawAction === 'start' ? 'enable'
    : rawAction === 'stop' ? 'disable'
    : rawAction === 'restart_continue' || rawAction === 'restart_fresh' ? 'restart'
    : rawAction;
  const restartMode = rawAction === 'restart_continue' ? 'continue'
    : rawAction === 'restart_fresh' ? 'fresh'
    : undefined;

  // Security (C4): Validate org before use in shell commands.
  let safeOrg: string | undefined;
  if (org !== undefined) {
    try {
      safeOrg = validateIdentifier(org, 'org');
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 400 });
    }
  }

  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ipc = new IPCClient(instanceId);

  try {
    let ipcResult: { success: boolean; data?: unknown; error?: string };
    let registryMessage = '';

    switch (action) {
      case 'enable': {
        mutateEnabledAgents((enabledAgents) => {
          enabledAgents[decoded] = {
            ...(typeof enabledAgents[decoded] === 'object' && enabledAgents[decoded] !== null
              ? (enabledAgents[decoded] as object)
              : {}),
            enabled: true,
            ...(safeOrg ? { org: safeOrg } : {}),
          };
        });
        registryMessage = 'enabled in registry';
        ipcResult = await ipc.send({ type: 'start-agent', agent: decoded });
        break;
      }

      case 'disable': {
        ipcResult = await ipc.send({ type: 'stop-agent', agent: decoded });
        try {
          mutateEnabledAgents((enabledAgents) => {
            if (enabledAgents[decoded] && typeof enabledAgents[decoded] === 'object') {
              (enabledAgents[decoded] as Record<string, unknown>).enabled = false;
            }
          });
          registryMessage = 'disabled in registry';
        } catch {
          registryMessage = 'registry update failed (non-fatal)';
        }
        break;
      }

      case 'restart': {
        ipcResult = await ipc.send({ type: 'restart-agent', agent: decoded, ...(restartMode ? { mode: restartMode } : {}) });
        registryMessage = '';
        break;
      }

      default:
        return Response.json({ error: 'Invalid action' }, { status: 400 });
    }

    if (!ipcResult.success) {
      const isDaemonDown = ipcResult.error?.includes('Daemon is not running');
      if (isDaemonDown && action === 'enable') {
        return Response.json({
          success: true,
          action,
          agent: decoded,
          output: `${registryMessage}; daemon not running — agent will start when daemon starts`,
        });
      }
      console.error(`[api/agents/${decoded}/lifecycle] POST IPC error (${action}):`, ipcResult.error);
      return Response.json(
        { error: `Failed to ${action} agent: ${ipcResult.error ?? 'unknown IPC error'}` },
        { status: 500 },
      );
    }

    return Response.json({
      success: true,
      action,
      agent: decoded,
      output: [registryMessage, String(ipcResult.data ?? '')].filter(Boolean).join('; '),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/agents/${decoded}/lifecycle] POST error:`, message);
    return Response.json({ error: `Failed to ${action} agent` }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/agents/[name]/lifecycle - Remove an agent entirely
//
// Query params: ?deleteFiles=true to also remove agent directory
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  if (!isValidName(decoded)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const enabledAgentsPath = path.join(ctxRoot, 'config', 'enabled-agents.json');
  const deleteFiles = request.nextUrl.searchParams.get('deleteFiles') === 'true';

  // Look up org from enabled-agents.json
  let org = '';
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  try {
    const raw = await fs.readFile(enabledAgentsPath, 'utf-8');
    enabledAgents = JSON.parse(raw);
    if (enabledAgents[decoded]) {
      org = enabledAgents[decoded].org ?? '';
    }
  } catch {
    // File doesn't exist or is malformed
  }

  // Security (C4): Validate org from stored data before use in shell commands and path.join.
  let safeDeleteOrg = '';
  if (org) {
    try {
      safeDeleteOrg = validateIdentifier(org, 'org');
    } catch {
      // org stored in registry is malformed — skip shell/fs operations that use it
      safeDeleteOrg = '';
    }
  }

  // 1. Tell daemon to stop the agent (best-effort; agent may already be stopped)
  {
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
    const ipc = new IPCClient(instanceId);
    const stopResult = await ipc.send({ type: 'stop-agent', agent: decoded });
    if (!stopResult.success && !stopResult.error?.includes('Daemon is not running')) {
      console.warn(`[api/agents/${decoded}/lifecycle] stop during delete:`, stopResult.error);
    }
  }

  // 2. Remove from enabled-agents.json.
  //
  // The read above (for the org lookup) is deliberately NOT reused here: an IPC
  // round-trip has happened since, so that snapshot is stale, and writing it
  // back would silently revert anything the CLI or another request changed in
  // the meantime.  `mutateEnabledAgents` re-reads inside the lock.
  try {
    mutateEnabledAgents((agents) => {
      delete agents[decoded];
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/agents/${decoded}/lifecycle] failed to update enabled-agents.json:`, message);
    return Response.json(
      { error: 'Failed to update agent registry' },
      { status: 500 },
    );
  }

  // 3. Optionally remove agent directory
  if (deleteFiles && safeDeleteOrg) {
    try {
      const agentDir = path.join(getFrameworkRoot(), 'orgs', safeDeleteOrg, 'agents', decoded);
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[api/agents/${decoded}/lifecycle] failed to remove agent dir:`, message);
      // Non-fatal - agent is already deregistered
    }
  }

  return Response.json({ success: true, deleted: decoded });
}
