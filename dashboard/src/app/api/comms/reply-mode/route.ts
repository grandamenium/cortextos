import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

const VALID_MODES = new Set(['text', 'voice', 'both']);

function replyModeFilePath(ctxRoot: string, agent: string): string {
  return path.join(ctxRoot, 'state', agent, 'reply-mode');
}

function readMode(ctxRoot: string, agent: string): 'text' | 'voice' | 'both' {
  const p = replyModeFilePath(ctxRoot, agent);
  try {
    const v = fs.readFileSync(p, 'utf-8').trim();
    if (VALID_MODES.has(v)) return v as 'text' | 'voice' | 'both';
  } catch { /* default */ }
  return 'text';
}

function validateAgent(agent: string): string | null {
  if (!agent || !/^[a-z0-9_-]+$/.test(agent)) return 'Invalid agent name';
  const known = getAllAgents();
  if (!known.some((a) => a.name === agent)) return 'Agent not found';
  return null;
}

export async function GET(request: NextRequest) {
  const agent = request.nextUrl.searchParams.get('agent') ?? '';
  const err = validateAgent(agent);
  if (err) return Response.json({ error: err }, { status: 400 });
  return Response.json({ agent, mode: readMode(getCTXRoot(), agent) });
}

export async function PUT(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const agent = typeof body.agent === 'string' ? body.agent : '';
  const mode = typeof body.mode === 'string' ? body.mode : '';
  const err = validateAgent(agent);
  if (err) return Response.json({ error: err }, { status: 400 });
  if (!VALID_MODES.has(mode)) {
    return Response.json({ error: 'mode must be text, voice, or both' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const dir = path.join(ctxRoot, 'state', agent);
  fs.mkdirSync(dir, { recursive: true });
  const p = replyModeFilePath(ctxRoot, agent);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, mode);
  fs.renameSync(tmp, p);
  return Response.json({ agent, mode });
}
