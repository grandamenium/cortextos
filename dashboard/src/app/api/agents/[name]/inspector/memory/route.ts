import fs from 'fs/promises';
import path from 'path';
import { NextRequest } from 'next/server';
import { getAgentRuntime, getHermesHome } from '@/lib/agent-runtime';
import { ensureInsideRoot, listMarkdownDays } from '@/lib/inspector-fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function fetchHermesMemory(base: string): Promise<string | null> {
  try {
    const response = await fetch(`${base}/api/memory`, {
      headers: process.env.HERMES_API_TOKEN ? { Authorization: `Bearer ${process.env.HERMES_API_TOKEN}` } : {},
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { content?: string; memory?: string };
      return json.content ?? json.memory ?? text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const selected = request.nextUrl.searchParams.get('path');
  const rootFile = agent.runtime === 'hermes'
    ? path.join(getHermesHome(), 'memory.md')
    : path.join(agent.home, 'MEMORY.md');
  const memoryDir = path.join(agent.home, 'memory');

  if (selected) {
    const safe = ensureInsideRoot(memoryDir, selected);
    return Response.json({ content: await fs.readFile(safe, 'utf-8').catch(() => ''), path: selected });
  }

  const hermesContent = agent.runtime === 'hermes' && agent.hermesDashboard
    ? await fetchHermesMemory(agent.hermesDashboard)
    : null;
  const content = hermesContent ?? await fs.readFile(rootFile, 'utf-8').catch(() => '');

  return Response.json({
    content,
    path: rootFile,
    daily: await listMarkdownDays(memoryDir),
    runtime: agent.runtime,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const body = (await request.json().catch(() => ({}))) as { content?: string; path?: string };
  if (typeof body.content !== 'string') {
    return Response.json({ error: 'content is required' }, { status: 400 });
  }

  const rootFile = agent.runtime === 'hermes'
    ? path.join(getHermesHome(), 'memory.md')
    : path.join(agent.home, 'MEMORY.md');
  const target = body.path ? ensureInsideRoot(path.join(agent.home, 'memory'), body.path) : rootFile;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body.content, 'utf-8');
  return Response.json({ ok: true, path: target });
}
