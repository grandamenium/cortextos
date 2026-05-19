import { NextRequest } from 'next/server';
import { dispatchMessage, checkDispatchRateLimit, extractJwtSubject } from '@/lib/dispatch';
import { getAgentsList } from '@/lib/agents';

export const dynamic = 'force-dynamic';

interface DispatchBody {
  agent?: string;
  text?: string;
}

export async function POST(request: NextRequest) {
  const subject = await extractJwtSubject(request.headers.get('Authorization'));
  if (!subject) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = checkDispatchRateLimit(subject);
  if (!limit.allowed) {
    return Response.json(
      { error: 'Rate limited' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds ?? 1) } },
    );
  }

  let body: DispatchBody;
  try {
    body = await request.json() as DispatchBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.agent || !body.text) {
    return Response.json({ error: 'agent and text are required' }, { status: 400 });
  }

  if (!/^[a-z0-9_.-]+$/i.test(body.agent)) {
    return Response.json({ error: 'Invalid agent' }, { status: 400 });
  }

  const whitelist = new Set(getAgentsList().map((agent) => agent.name));
  if (!whitelist.has(body.agent)) {
    return Response.json({ error: 'Unknown agent' }, { status: 400 });
  }

  try {
    const result = await dispatchMessage(body.agent, body.text);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[api/home/dispatch] failed:', message);
    return Response.json({ error: 'Dispatch failed' }, { status: 500 });
  }
}
