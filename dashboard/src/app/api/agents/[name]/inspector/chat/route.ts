import { NextRequest } from 'next/server';
import { getAgentRuntime } from '@/lib/agent-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (agent.runtime !== 'hermes') {
    const text = typeof body.message === 'string' ? body.message : '';
    const response = await fetch(new URL('/api/messages/send', request.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: decodeURIComponent(name), text }),
    });
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sse({ type: 'message', content: response.ok ? 'Message queued on cortextOS bus.' : 'Failed to queue message.' })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const messages = Array.isArray(body.messages)
    ? body.messages
    : message
      ? [{ role: 'user', content: message }]
      : [];
  if (messages.length === 0) return Response.json({ error: 'message is required' }, { status: 400 });

  const upstream = await fetch(`${agent.hermesGateway}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.HERMES_API_TOKEN ? { Authorization: `Bearer ${process.env.HERMES_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      model: body.model || 'hermes',
      stream: true,
      ...(typeof body.sessionKey === 'string' ? { sessionKey: body.sessionKey, session_key: body.sessionKey } : {}),
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `Hermes gateway returned ${upstream.status}` }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
