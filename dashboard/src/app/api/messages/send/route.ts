import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/messages/send - Send a message to an agent
 *
 * Writes the message to the agent's inbox directory in the same format
 * as bus/send-message.sh. The agent's fast-checker daemon picks it up
 * on its next inbox check cycle (every 1 second).
 *
 * Body: { agent: string, text: string, type?: string }
 * Returns: { success: boolean, messageId: string }
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { agent, text, type } = body as {
    agent?: string;
    text?: string;
    type?: string;
  };

  if (!agent || typeof agent !== 'string') {
    return Response.json({ error: 'agent is required' }, { status: 400 });
  }
  if (!/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!text || typeof text !== 'string') {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }

  // Verify the agent actually exists in the registry (defense against
  // path traversal / arbitrary inbox creation even with a valid-looking name).
  const knownAgents = getAllAgents();
  if (!knownAgents.some((a) => a.name === agent)) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  const ctxRoot = getCTXRoot();

  // Sender identity: use the dashboard admin username so chat bar messages
  // land in the same channel as Telegram messages for the same user.
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const from = (process.env.ADMIN_USERNAME ?? 'user').toLowerCase();
  const messageId = `${epochMs}-${from}-${rand}`;

  // Priority 2 = normal (matches bus/send-message.sh mapping)
  const filename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', agent);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);

  try {
    // Ensure inbox directory exists
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    // Build message JSON (same schema as bus/send-message.sh)
    const message = {
      id: messageId,
      from: from,
      to: agent,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      text: text,
      reply_to: null,
    };

    // Atomic write: temp file then rename (same pattern as send-message.sh)
    fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
    fs.renameSync(tmpPath, finalPath);

    // Wake the target agent's fast-checker instantly via SIGUSR1
    const pidFile = path.join(ctxRoot, 'state', agent, '.fast-checker.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          process.kill(pid, 'SIGUSR1');
        }
      } catch {
        // Fast-checker may not be running
      }
    }

    // Log the inbound message for history
    const logDir = path.join(ctxRoot, 'logs', agent);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'inbound-messages.jsonl');
    const logEntry = JSON.stringify({
      id: messageId,
      timestamp: new Date().toISOString(),
      agent,
      direction: 'inbound',
      type: type || 'text',
      text,
      from_name: from,
      source: 'dashboard',
    });
    fs.appendFileSync(logFile, logEntry + '\n');

    return Response.json({ success: true, messageId }, { status: 200 });
  } catch (err: unknown) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/messages/send] Error:', message);
    return Response.json(
      { error: 'Failed to send message', details: message },
      { status: 500 }
    );
  }
}
