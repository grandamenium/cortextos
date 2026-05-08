import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getHermesHome } from '@/lib/agent-runtime';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fallbackSessions(agent: string | null) {
  const sessionsDir = path.join(getHermesHome(), 'sessions');
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const sessions = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(sessionsDir, entry.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    const key = entry.name.replace(/\.(json|jsonl|md)$/i, '');
    return {
      key,
      id: key,
      title: key.replace(/[-_]/g, ' '),
      agent: agent ?? undefined,
      updatedAt: stat?.mtime.toISOString(),
      pinned: false,
    };
  }));
  return { sessions: sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
}

export async function GET(request: NextRequest) {
  const search = new URL(request.url).searchParams;
  const agent = search.get('agent');
  const q = search.get('q');
  const upstreamPath = `/api/sessions${search.toString() ? `?${search.toString()}` : ''}`;
  try {
    return await proxyHermesDashboard(upstreamPath, {}, agent ?? undefined);
  } catch {
    const payload = await fallbackSessions(agent);
    const filtered = q
      ? payload.sessions.filter((session) => JSON.stringify(session).toLowerCase().includes(q.toLowerCase()))
      : payload.sessions;
    return Response.json({ sessions: filtered, degraded: true });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    return await proxyHermesDashboard('/api/sessions', { method: 'POST', body });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.text();
  try {
    return await proxyHermesDashboard('/api/sessions', { method: 'PATCH', body });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const body = await request.text();
  try {
    return await proxyHermesDashboard('/api/sessions', { method: 'DELETE', body });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
