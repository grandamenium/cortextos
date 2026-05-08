import fs from 'fs/promises';
import { NextRequest } from 'next/server';
import { getAgentRuntime } from '@/lib/agent-runtime';
import { ensureInsideRoot, readTree, toRelative } from '@/lib/inspector-fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const filePath = request.nextUrl.searchParams.get('path');
  const root = agent.workingDir;

  if (filePath !== null) {
    const resolved = ensureInsideRoot(root, filePath);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return Response.json({ root, base: toRelative(root, resolved), entries: await readTree(root, filePath, 1) });
    }
    return Response.json({
      root,
      path: toRelative(root, resolved),
      content: await fs.readFile(resolved, 'utf-8'),
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  return Response.json({ root, base: '', entries: await readTree(root, '', 2) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const agent = await getAgentRuntime(name);
  const body = (await request.json().catch(() => ({}))) as { path?: string; content?: string };
  if (!body.path || typeof body.content !== 'string') {
    return Response.json({ error: 'path and content are required' }, { status: 400 });
  }
  const resolved = ensureInsideRoot(agent.workingDir, body.path);
  await fs.writeFile(resolved, body.content, 'utf-8');
  return Response.json({ ok: true, path: toRelative(agent.workingDir, resolved) });
}
