/**
 * POST /api/workflows/crons/[agent]/[name]/fire
 *
 * Manually trigger a cron immediately via IPC fire-cron.
 * Routes through the daemon which enforces:
 *   - manualFireDisabled opt-out (403)
 *   - 30-second cooldown between fires (409)
 *   - Agent must be running (500)
 *
 * Response shapes:
 *   200 { ok: true, firedAt: number }     — success
 *   403 { ok: false, error: string }      — manualFireDisabled
 *   409 { ok: false, error: string }      — cooldown active
 *   400 { ok: false, error: string }      — bad input (missing agent/name)
 *   404 { ok: false, error: string }      — cron or agent not found
 *   500 { ok: false, error: string }      — IPC failure / agent not running
 *
 * Subtask 4.5
 */

import { NextRequest } from 'next/server';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

const VALID_IDENT = /^[a-zA-Z0-9_-]+$/;

type RouteParams = Promise<{ agent: string; name: string }>;

export async function POST(
  _request: NextRequest,
  { params }: { params: RouteParams },
) {
  const { agent, name } = await params;
  const decodedAgent = decodeURIComponent(agent);
  const decodedName = decodeURIComponent(name);

  if (!VALID_IDENT.test(decodedAgent)) {
    return Response.json({ ok: false, error: 'Invalid agent name' }, { status: 400 });
  }
  if (!VALID_IDENT.test(decodedName)) {
    return Response.json({ ok: false, error: 'Invalid cron name' }, { status: 400 });
  }

  const ipc = new IPCClient();
  try {
    const resp = await ipc.send({
      type: 'fire-cron',
      agent: decodedAgent,
      data: { name: decodedName },
      source: 'dashboard/api/fire',
    } as Parameters<typeof ipc.send>[0]);

    if (resp.success) {
      const data = (resp.data ?? {}) as { ok?: boolean; firedAt?: number };
      return Response.json({ ok: true, firedAt: data.firedAt });
    }

    const errMsg = resp.error ?? 'fire-cron failed';

    // Map error messages to HTTP status codes
    if (errMsg.includes('Manual fire disabled')) {
      return Response.json({ ok: false, error: errMsg }, { status: 403 });
    }
    if (errMsg.includes('Cooldown active')) {
      return Response.json({ ok: false, error: errMsg }, { status: 409 });
    }
    // "not found or not running" = agent is offline (runtime error, not a 404)
    if (errMsg.includes('not found or not running')) {
      return Response.json({ ok: false, error: errMsg }, { status: 500 });
    }
    // "not found for agent" = cron definition does not exist (404)
    if (errMsg.includes('not found')) {
      return Response.json({ ok: false, error: errMsg }, { status: 404 });
    }

    // Other runtime errors
    return Response.json({ ok: false, error: errMsg }, { status: 500 });
  } catch (err) {
    console.error(
      `[api/workflows/crons/${decodedAgent}/${decodedName}/fire] POST error:`,
      err,
    );
    return Response.json(
      { ok: false, error: 'Failed to fire cron (IPC error)' },
      { status: 500 },
    );
  }
}
