import { NextRequest } from 'next/server';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/collections?org=<org>
 *
 * ChromaDB is deprecated. Report the active file-backed retrieval sources:
 * team-brain wiki-grep and the Open Brain thought mirror.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || '';

  if (!org || !/^[a-z0-9_-]+$/.test(org)) {
    return Response.json({ error: 'org parameter required (lowercase alphanumeric, hyphens, underscores)' }, { status: 400 });
  }

  const wikiDir = process.env.WIKI_PATH || path.join(os.homedir(), 'work', 'team-brain');
  if (!existsSync(wikiDir)) {
    return Response.json({ collections: [], org });
  }

  const countFiles = (target: string): number => {
    try {
      const out = execSync(`find ${target} -type f -name '*.md' 2>/dev/null | wc -l`, {
        cwd: wikiDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      return parseInt(out.trim(), 10) || 0;
    } catch {
      return 0;
    }
  };

  return Response.json({
    collections: [
      { name: 'wiki-grep', count: countFiles('docs wiki .claude') },
      { name: 'open-brain', count: countFiles('wiki/sources/thoughts') },
    ],
    org,
  });
}
