import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { getFrameworkRoot, getCTXRoot, getAllAgents } from '@/lib/config';
import { IPCClient } from '@/lib/ipc-client';
import { getHeartbeat, getHealthStatus } from '@/lib/data/heartbeats';
import { mutateEnabledAgents } from '@/lib/enabled-agents';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_NAME = /^[a-z0-9_-]+$/;
const VALID_TEMPLATES = ['agent', 'agent-codex', 'orchestrator', 'analyst'];

/** Thrown inside the reservation's locked section; mapped to HTTP 409. */
class DuplicateAgentError extends Error {}

/**
 * How long a `status: 'creating'` reservation may sit before another create is
 * allowed to reclaim the name.
 *
 * Without reclaim, a worker killed mid-create would claim a name permanently:
 * the reservation blocks every retry and nothing ever clears it, so the only
 * recovery would be hand-editing the registry.  That would be worse than the
 * unlocked behaviour this replaces.  The window only has to exceed a genuine
 * create (a template copy and a handful of mkdirs — well under a second).
 */
const RESERVATION_STALE_MS = 10 * 60 * 1000;


// ---------------------------------------------------------------------------
// GET /api/agents - List all agents
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const agents = getAllAgents();
    const enriched = await Promise.all(
      agents.map(async (agent) => {
        const hb = await getHeartbeat(agent.name);
        const health = hb ? getHealthStatus(hb) : 'down';
        return {
          ...agent,
          health,
          lastHeartbeat: hb?.last_heartbeat ?? undefined,
          currentTask: hb?.current_task ?? undefined,
          status: hb?.status ?? undefined,
        };
      })
    );
    return Response.json(enriched);
  } catch (err) {
    console.error('[api/agents] GET error:', err);
    return Response.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/agents - Create a new agent
//
// Body: { name, org, template, botToken, chatId, allowedUser? }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, org, template, botToken, chatId, allowedUser } = body as {
    name?: string;
    org?: string;
    template?: string;
    botToken?: string;
    chatId?: string;
    allowedUser?: string;
  };

  // --- Validation ---

  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }
  if (!VALID_NAME.test(name)) {
    return Response.json(
      { error: 'name must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!org || typeof org !== 'string') {
    return Response.json({ error: 'org is required' }, { status: 400 });
  }
  // Security (C4): Validate org against allowlist before use in path.join and shell commands.
  if (!VALID_NAME.test(org)) {
    return Response.json(
      { error: 'org must match /^[a-z0-9_-]+$/' },
      { status: 400 },
    );
  }
  if (!template || !VALID_TEMPLATES.includes(template)) {
    return Response.json(
      { error: `template must be one of: ${VALID_TEMPLATES.join(', ')}` },
      { status: 400 },
    );
  }
  if (!botToken || typeof botToken !== 'string') {
    return Response.json({ error: 'botToken is required' }, { status: 400 });
  }
  if (!chatId || typeof chatId !== 'string') {
    return Response.json({ error: 'chatId is required' }, { status: 400 });
  }

  const frameworkRoot = getFrameworkRoot();
  const ctxRoot = getCTXRoot();
  const templateDir = path.join(frameworkRoot, 'templates', template);
  const agentDir = path.join(frameworkRoot, 'orgs', org, 'agents', name);

  // Creating an agent is a reserve -> build -> commit sequence.  The registry
  // lock is deliberately NOT held across the template copy or the IPC hop: it
  // blocks the thread via Atomics.wait, so holding it there would stall every
  // other request this worker is serving.  Instead the name is claimed up front
  // in one short critical section and confirmed in another.
  const createdAt = new Date().toISOString();
  const reservationToken = randomUUID();

  // --- 1. RESERVE the name -------------------------------------------------
  //
  // The duplicate check and the write that makes the name taken must happen in
  // the SAME critical section.  They used to be separated by the template copy,
  // six mkdirs and an IPC round-trip, so two concurrent creates of one name
  // both passed the check, both copied a template into the same directory, and
  // the second registry write silently won.
  //
  // The reservation is written `enabled: false` on purpose: an agent ABSENT
  // from the registry defaults to enabled (see
  // `agent-manager.ts#readInstanceEnableList`), so a daemon restart during the
  // copy below would otherwise discover and start a half-copied agent.
  try {
    mutateEnabledAgents((agents) => {
      const existing = agents[name];
      const reservedAt =
        existing && typeof existing === 'object' && existing.status === 'creating'
          ? Date.parse(existing.createdAt ?? '')
          : NaN;
      const reclaimable =
        Number.isFinite(reservedAt) && Date.now() - reservedAt > RESERVATION_STALE_MS;

      if (existing && !reclaimable) throw new DuplicateAgentError();

      // Registry-absent but present on disk is the other way a name is already
      // taken — such an agent defaults to enabled and may be running.  Skipped
      // when reclaiming, where the directory is leftover from the abandoned
      // attempt this reservation is replacing.
      if (!existing && existsSync(agentDir)) throw new DuplicateAgentError();

      agents[name] = {
        enabled: false,
        status: 'creating',
        org,
        template,
        createdAt,
        reservationToken,
      };
    });
  } catch (err: unknown) {
    if (err instanceof DuplicateAgentError) {
      return Response.json(
        { error: `Agent "${name}" already exists` },
        { status: 409 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/agents] POST: failed to reserve agent name:', message);
    return Response.json({ error: 'Failed to create agent' }, { status: 500 });
  }

  // --- 2. BUILD ------------------------------------------------------------
  try {
    // 2a. Copy template dir to orgs/{org}/agents/{name}/
    await fs.mkdir(agentDir, { recursive: true });
    await copyDir(templateDir, agentDir);

    // 2b. Write .env file
    const envLines = [
      `BOT_TOKEN=${botToken}`,
      `CHAT_ID=${chatId}`,
    ];
    if (allowedUser) {
      envLines.push(`ALLOWED_USER=${allowedUser}`);
    }
    await fs.writeFile(path.join(agentDir, '.env'), envLines.join('\n') + '\n', 'utf-8');

    // 2c. Create state dirs under CTX_ROOT
    const stateDirs = ['inbox', 'outbox', 'processed', 'inflight', 'logs', 'state'];
    for (const dir of stateDirs) {
      await fs.mkdir(path.join(ctxRoot, dir, name), { recursive: true });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/agents] POST error:', message);

    // Release the reservation so the name can be retried immediately, but only
    // if it is still ours — an unlocked CLI writer may have replaced it.  The
    // partially-created directory is left in place: removing a path that might
    // have pre-existed with real content is destructive, and dir-without-entry
    // is the same state a failed create left behind before this change.
    try {
      mutateEnabledAgents((agents) => {
        const cur = agents[name];
        if (cur && typeof cur === 'object' && cur.reservationToken === reservationToken) {
          delete agents[name];
        }
      });
    } catch (rollbackErr: unknown) {
      console.error(
        `[api/agents] POST: could not release reservation for "${name}"; it will be reclaimable in ${RESERVATION_STALE_MS}ms:`,
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      );
    }

    return Response.json({ error: 'Failed to create agent' }, { status: 500 });
  }

  // --- 3. COMMIT -----------------------------------------------------------
  //
  // NOT rolled back on failure.  The common failure here is the 250ms lock
  // timeout, which is transient — deleting the reservation would throw away a
  // fully-built agent because the registry was momentarily busy.  Leaving the
  // reservation keeps the work, and it becomes reclaimable on its own.
  try {
    mutateEnabledAgents((agents) => {
      const cur = agents[name];
      // Ownership check: sound against writers that take this lock, which the
      // CLI ones do not.  If the entry is no longer ours, someone else now owns
      // this name and overwriting them would be the very clobber being fixed.
      if (!cur || typeof cur !== 'object' || cur.reservationToken !== reservationToken) return;
      agents[name] = { enabled: true, org, template, createdAt };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[api/agents] POST: "${name}" was created on disk but the registry commit failed:`,
      message,
    );
    return Response.json({ error: 'Failed to create agent' }, { status: 500 });
  }

  // --- 4. Register with daemon via IPC -------------------------------------
  //
  // Runs AFTER the registry says enabled, matching the ordering the lifecycle
  // route's `enable` path uses.  Previously this ran before the registry write,
  // so a failed write left the agent running but unregistered; now a failed IPC
  // leaves it registered but not running, which the next daemon start heals.
  // Non-fatal either way — the agent exists and is registered.
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  const ipc = new IPCClient(instanceId);
  if (await ipc.isDaemonRunning()) {
    const ipcResult = await ipc.send({
      type: 'start-agent',
      agent: name,
      data: { dir: agentDir },
    });
    if (!ipcResult.success) {
      console.warn(`[api/agents] POST: daemon start-agent returned error for "${name}":`, ipcResult.error);
    }
  } else {
    console.info(`[api/agents] POST: daemon not running; "${name}" registered and will start with daemon.`);
  }

  return Response.json({ success: true, agent: { name, org } }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Recursive directory copy
// ---------------------------------------------------------------------------

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
