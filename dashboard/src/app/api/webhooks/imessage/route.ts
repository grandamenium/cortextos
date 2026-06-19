import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

const CTX_ROOT = process.env.CTX_ROOT || 'C:/Users/jenni/.cortextos/default';
const LOG_PATH = path.join(CTX_ROOT, 'logs/forge/imessage-webhook.jsonl');

// Simple secret to prevent unauthorized posts
const WEBHOOK_SECRET = process.env.IMESSAGE_WEBHOOK_SECRET || 'atlasos-imsg';

export async function POST(request: NextRequest) {
  // Verify secret header
  const secret = request.headers.get('x-webhook-secret') || request.nextUrl.searchParams.get('secret');
  if (secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const sender = (body.sender as string) || (body.from as string) || 'Unknown';
  const text = (body.text as string) || (body.body as string) || (body.message as string) || '';
  const timestamp = (body.timestamp as string) || new Date().toISOString();
  const isGroup = !!(body.group || body.groupName);
  const groupName = (body.groupName as string) || (body.group as string) || '';

  const entry = { ts: new Date().toISOString(), sender, text, timestamp, isGroup, groupName, raw: body };

  // Log to file
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }

  // Route to Atlas agent inbox
  const routeMsg = isGroup
    ? `iMessage (group: ${groupName}) from ${sender}: ${text}`
    : `iMessage from ${sender}: ${text}`;

  try {
    execSync(`cortextos bus send-message atlas normal ${JSON.stringify(routeMsg)}`, {
      cwd: path.join(CTX_ROOT, '../../cortext-test/cortextos'),
      timeout: 8000,
      stdio: 'pipe',
    });
  } catch { /* non-blocking */ }

  return NextResponse.json({ success: true, received: { sender, text: text.slice(0, 100) } });
}

// Health check
export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ status: 'ok', endpoint: '/api/webhooks/imessage' });
}
