import { closeTerminalSession } from '@/lib/terminal-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
  if (!body.sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });
  return Response.json({ ok: closeTerminalSession(body.sessionId) });
}
