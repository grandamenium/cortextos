/**
 * PATCH /api/workflows/crons/[agent]/[name] — update an existing cron
 * DELETE /api/workflows/crons/[agent]/[name] — remove a cron
 *
 * Both operations route through IPC to the daemon, which writes crons.json
 * atomically and triggers a scheduler reload.
 *
 * Error response shape: { error: string, field?: string }
 */

import { NextRequest } from 'next/server';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

const VALID_IDENT = /^[a-zA-Z0-9_-]+$/;

type RouteParams = Promise<{ agent: string; name: string }>;

// ---------------------------------------------------------------------------
// PATCH — update-cron
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: RouteParams },
) {
  const { agent, name } = await params;
  const decodedAgent = decodeURIComponent(agent);
  const decodedName = decodeURIComponent(name);

  if (!VALID_IDENT.test(decodedAgent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!VALID_IDENT.test(decodedName)) {
    return Response.json({ error: 'Invalid cron name' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { patch } = (body ?? {}) as { patch?: unknown };
  if (!patch || typeof patch !== 'object') {
    return Response.json({ error: 'patch is required', field: 'patch' }, { status: 400 });
  }

  const ipc = new IPCClient();
  try {
    const resp = await ipc.send({
      type: 'update-cron',
      agent: decodedAgent,
      data: {
        name: decodedName,
        patch: patch as Record<string, unknown>,
      },
      source: 'dashboard/api',
    } as Parameters<typeof ipc.send>[0]);

    if (resp.success) {
      return Response.json({ ok: true });
    }

    const errMsg = resp.error ?? 'update-cron failed';
    const detail = (resp.data ?? {}) as Record<string, unknown>;

    if (errMsg.includes('not found')) {
      return Response.json({ error: errMsg }, { status: 404 });
    }
    return Response.json(
      { error: errMsg, field: detail.field ?? undefined },
      { status: 400 },
    );
  } catch (err) {
    console.error(`[api/workflows/crons/${decodedAgent}/${decodedName}] PATCH error:`, err);
    return Response.json({ error: 'Failed to update cron (IPC error)' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove-cron
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: RouteParams },
) {
  const { agent, name } = await params;
  const decodedAgent = decodeURIComponent(agent);
  const decodedName = decodeURIComponent(name);

  if (!VALID_IDENT.test(decodedAgent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!VALID_IDENT.test(decodedName)) {
    return Response.json({ error: 'Invalid cron name' }, { status: 400 });
  }

  const ipc = new IPCClient();
  try {
    const resp = await ipc.send({
      type: 'remove-cron',
      agent: decodedAgent,
      data: { name: decodedName },
      source: 'dashboard/api',
    } as Parameters<typeof ipc.send>[0]);

    if (resp.success) {
      return Response.json({ ok: true });
    }

    const errMsg = resp.error ?? 'remove-cron failed';
    if (errMsg.includes('not found')) {
      return Response.json({ error: errMsg }, { status: 404 });
    }
    return Response.json({ error: errMsg }, { status: 400 });
  } catch (err) {
    console.error(`[api/workflows/crons/${decodedAgent}/${decodedName}] DELETE error:`, err);
    return Response.json({ error: 'Failed to delete cron (IPC error)' }, { status: 500 });
  }
}
