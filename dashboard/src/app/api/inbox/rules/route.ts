import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

interface EmailRule {
  id: string;
  trigger: { type: 'sender' | 'subject' | 'category'; value: string };
  action: string;
  note?: string;
  createdAt: string;
}

function getRulesPath(): string {
  const ctxRoot = process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default');
  return path.join(ctxRoot, 'state', 'data', 'email-rules.json');
}

function loadRules(): EmailRule[] {
  try {
    const raw = fs.readFileSync(getRulesPath(), 'utf8');
    return JSON.parse(raw) as EmailRule[];
  } catch {
    return [];
  }
}

function saveRules(rules: EmailRule[]): void {
  const p = getRulesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

export async function GET() {
  return Response.json(loadRules());
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { triggerType, triggerValue, action, note } = body as {
    triggerType?: string;
    triggerValue?: string;
    action?: string;
    note?: string;
  };

  if (!triggerType || !triggerValue || !action) {
    return Response.json({ error: 'triggerType, triggerValue, and action are required' }, { status: 400 });
  }
  if (!['sender', 'subject', 'category'].includes(triggerType)) {
    return Response.json({ error: 'Invalid triggerType' }, { status: 400 });
  }
  if (typeof action !== 'string' || action.length > 500) {
    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }

  const rules = loadRules();
  const newRule: EmailRule = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    trigger: { type: triggerType as 'sender' | 'subject' | 'category', value: String(triggerValue).slice(0, 200) },
    action: String(action).slice(0, 500),
    note: note ? String(note).slice(0, 500) : undefined,
    createdAt: new Date().toISOString(),
  };
  rules.unshift(newRule);
  saveRules(rules);

  return Response.json({ success: true, rule: newRule });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const id = searchParams.get('id');
  if (!id || !/^[a-z0-9]+$/.test(id)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }
  const rules = loadRules().filter((r) => r.id !== id);
  saveRules(rules);
  return Response.json({ success: true });
}
