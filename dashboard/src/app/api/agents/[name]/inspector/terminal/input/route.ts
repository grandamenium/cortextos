import { writeTerminalSession } from '@/lib/terminal-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { sessionId?: string; data?: string };
  if (!body.sessionId || typeof body.data !== 'string') {
    return Response.json({ error: 'sessionId and data are required' }, { status: 400 });
  }
  return Response.json({ ok: writeTerminalSession(body.sessionId, body.data) });
}
