import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getCTXRoot, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhook/zeus — secure inbound webhook for Bode's iPhone (iOS Shortcut).
 *
 * A remote-control channel INTO the orchestrator, so defense-in-depth:
 *   - Cloudflare Access service token gates the request at the edge (configured
 *     separately on the CF side) BEFORE it ever reaches this app.
 *   - This route then independently validates an app bearer token
 *     (ZEUS_WEBHOOK_TOKEN), constant-time, so two independent secrets must both
 *     hold.
 *
 * On success: drops {text} into ZEUS's bus inbox (same format as
 * /api/messages/send + bus/send-message.sh); the fast-checker delivers it within
 * ~1s and zeus replies via Telegram. Target agent is HARDCODED to `zeus` — no
 * arbitrary-agent injection. Body is `text` only, length-capped. Auth attempts
 * are logged for audit.
 */

const TARGET_AGENT = 'zeus';
const MAX_TEXT_LEN = 4000;

/** Constant-time string compare via fixed-length SHA-256 digests (never throws on length mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function audit(ctxRoot: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.join(ctxRoot, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'zeus-webhook.log'),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* best-effort audit; never block the request */
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const ctxRoot = getCTXRoot();
  const ip =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown';

  // 1. App bearer token — required, constant-time
  const expected = process.env.ZEUS_WEBHOOK_TOKEN;
  if (!expected) {
    audit(ctxRoot, { event: 'misconfigured_no_token', ip });
    return Response.json({ error: 'webhook not configured' }, { status: 503 });
  }
  const authz = request.headers.get('authorization') || '';
  const presented = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!presented || !constantTimeEqual(presented, expected)) {
    audit(ctxRoot, { event: 'auth_fail', ip });
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Body: { text } only, length-capped
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LEN) {
    return Response.json({ error: `text exceeds ${MAX_TEXT_LEN} chars` }, { status: 413 });
  }

  // 3. Target agent must exist (defense — even though it's hardcoded)
  if (!getAllAgents().some((a) => a.name === TARGET_AGENT)) {
    audit(ctxRoot, { event: 'target_missing', ip });
    return Response.json({ error: 'target agent unavailable' }, { status: 503 });
  }

  // 4. Write to zeus's inbox (atomic; same schema as bus/send-message.sh)
  const epochMs = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  const from = 'bode-iphone';
  const messageId = `${epochMs}-${from}-${rand}`;
  const filename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', TARGET_AGENT);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);

  const message = {
    id: messageId,
    from,
    to: TARGET_AGENT,
    priority: 'normal',
    timestamp: new Date().toISOString(),
    text,
    reply_to: null,
  };

  try {
    if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    audit(ctxRoot, { event: 'inbox_write_fail', ip, error: String(err) });
    return Response.json({ error: 'failed to enqueue' }, { status: 500 });
  }

  // Wake zeus's fast-checker instantly (SIGUSR1), same as messages/send
  const pidFile = path.join(ctxRoot, 'state', TARGET_AGENT, '.fast-checker.pid');
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) process.kill(pid, 'SIGUSR1');
    } catch {
      /* fast-checker may not be running; inbox is still picked up on next cycle */
    }
  }

  // History log + audit
  try {
    const logDir = path.join(ctxRoot, 'logs', TARGET_AGENT);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'inbound-messages.jsonl'),
      JSON.stringify({
        id: messageId,
        timestamp: message.timestamp,
        agent: TARGET_AGENT,
        direction: 'inbound',
        type: 'webhook',
        from,
        text,
      }) + '\n',
    );
  } catch {
    /* non-critical */
  }
  audit(ctxRoot, { event: 'delivered', ip, messageId, len: text.length });

  return Response.json({ ok: true, messageId });
}
