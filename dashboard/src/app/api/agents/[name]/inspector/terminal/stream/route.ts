import { subscribeTerminalSession } from '@/lib/terminal-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = subscribeTerminalSession(sessionId, (chunk) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
        });
      } catch {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: '[session not found]\\r\\n' })}\n\n`));
        controller.close();
      }
      request.signal.addEventListener('abort', () => {
        unsubscribe?.();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
