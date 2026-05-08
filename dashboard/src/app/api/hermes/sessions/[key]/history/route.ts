import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getHermesHome } from '@/lib/agent-runtime';
import { proxyHermesDashboard } from '@/lib/hermes-dashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normalizeLine(line: string) {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      role: parsed.role ?? parsed.type ?? 'assistant',
      content: parsed.content ?? parsed.text ?? parsed.message ?? '',
      createdAt: parsed.created_at ?? parsed.timestamp ?? parsed.ts,
    };
  } catch {
    return null;
  }
}

async function fallbackHistory(key: string) {
  const sessionsDir = path.join(getHermesHome(), 'sessions');
  for (const ext of ['.jsonl', '.json']) {
    const file = path.join(sessionsDir, `${key}${ext}`);
    const raw = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!raw) continue;
    if (ext === '.jsonl') {
      return { messages: raw.split('\n').map((line) => line.trim()).filter(Boolean).map(normalizeLine).filter(Boolean) };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
  }
  return { messages: [] };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  try {
    return await proxyHermesDashboard(`/api/sessions/${encodeURIComponent(key)}/history`);
  } catch {
    return Response.json(await fallbackHistory(decodeURIComponent(key)), { status: 200 });
  }
}
