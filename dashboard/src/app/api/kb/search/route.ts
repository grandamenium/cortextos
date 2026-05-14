import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/search?q=<question>&org=<org>&agent=<agent>&scope=<scope>&limit=<n>
 *
 * Chroma/MMRAG/Gemini embeddings are deprecated. This endpoint searches the
 * version-controlled team-brain wiki plus the Open Brain thought mirror using
 * deterministic git grep.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const org = searchParams.get('org') ?? '';
  const agent = searchParams.get('agent') ?? '';
  const q = searchParams.get('q') ?? '';
  const scope = searchParams.get('scope') || 'all';
  const limit = parseInt(searchParams.get('limit') || '10', 10);

  if (org && !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }
  if (agent && !/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent' }, { status: 400 });
  }
  if (!q || q.trim().length === 0) {
    return Response.json({ error: 'q parameter required' }, { status: 400 });
  }
  if (q.length > 500) {
    return Response.json({ error: 'Query too long' }, { status: 400 });
  }
  if (!['shared', 'private', 'all'].includes(scope)) {
    return Response.json({ error: 'scope must be shared, private, or all' }, { status: 400 });
  }
  if (isNaN(limit) || limit < 1 || limit > 50) {
    return Response.json({ error: 'limit must be 1-50' }, { status: 400 });
  }

  const wikiDir = process.env.WIKI_PATH || path.join(os.homedir(), 'work', 'team-brain');
  if (!existsSync(wikiDir)) {
    return Response.json({ results: [], total: 0, query: q, collection: 'wiki-grep' });
  }

  const safeQuery = q.replace(/[^a-zA-Z0-9 _-]/g, '').trim().split(/\s+/).slice(0, 4).join(' ');
  if (!safeQuery) {
    return Response.json({ results: [], total: 0, query: q, collection: 'wiki-grep' });
  }

  let output = '';
  try {
    output = execSync(
      `git grep -i -r -n -C 2 --max-count=10 -- ${JSON.stringify(safeQuery)} docs wiki .claude 2>/dev/null | head -n 400 || true`,
      { cwd: wikiDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
    );
    if (!output.trim()) {
      const terms = safeQuery.split(/\s+/).filter((term) => term.length > 2).slice(0, 4);
      if (terms.length > 0) {
        const termArgs = terms.map((term) => `-e ${JSON.stringify(term)}`).join(' ');
        output = execSync(
          `git grep -i -r -n -C 2 --max-count=10 ${termArgs} -- docs wiki .claude 2>/dev/null | head -n 400 || true`,
          { cwd: wikiDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 },
        );
      }
    }
  } catch {
    output = '';
  }

  const blocks = output.split(/^--$/m).slice(0, limit);
  const results = blocks.map((block) => {
    const lines = block.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const firstLine = lines[0];
    const sourceMatch = firstLine.match(/^(.+?)(?::\d+:|-\d+-)/);
    const sourceFile = sourceMatch ? sourceMatch[1] : firstLine;

    return {
      content: lines.join('\n').substring(0, 500),
      source_file: path.join(wikiDir, sourceFile),
      agent_name: agent || undefined,
      org: org || '',
      score: 1,
      doc_type: sourceFile.includes('wiki/sources/thoughts/')
        ? 'open-brain-thought'
        : 'wiki-grep',
      filename: path.basename(sourceFile),
      collection: sourceFile.includes('wiki/sources/thoughts/')
        ? 'open-brain'
        : 'wiki-grep',
      chunk_index: null,
      total_chunks: null,
      content_full_length: null,
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  return Response.json({
    results,
    total: results.length,
    query: q,
    collection: 'wiki-grep',
  });
}
