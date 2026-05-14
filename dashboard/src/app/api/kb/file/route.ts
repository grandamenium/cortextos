import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getCTXRoot, getFrameworkRoot } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 512 * 1024; // 512 KB cap on returned file content

// Allow reading files only from these roots — ChromaDB-ingested source paths
// can point anywhere in the user's filesystem, so we whitelist trusted prefixes.
function trustedRoots(): string[] {
  return [getCTXRoot(), getFrameworkRoot()].map((p) => path.resolve(p));
}

function isUnderTrustedRoot(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  return trustedRoots().some((root) => {
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

/**
 * GET /api/kb/file?path=<absolute-source-path>
 *
 * Reads the full content of a knowledge-base source file. Used by the KB
 * search results UI to show the underlying memory/document a chunk came from.
 *
 * Only paths under CTX_ROOT or CTX_FRAMEWORK_ROOT are allowed.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('path');
  if (!raw) {
    return Response.json({ error: 'path parameter required' }, { status: 400 });
  }
  if (!path.isAbsolute(raw)) {
    return Response.json({ error: 'path must be absolute' }, { status: 400 });
  }
  if (!isUnderTrustedRoot(raw)) {
    return Response.json({ error: 'path is outside trusted roots' }, { status: 403 });
  }

  try {
    const stat = await fs.stat(raw);
    if (!stat.isFile()) {
      return Response.json({ error: 'not a regular file' }, { status: 400 });
    }
    const buf = await fs.readFile(raw);
    const truncated = buf.length > MAX_BYTES;
    const content = (truncated ? buf.subarray(0, MAX_BYTES) : buf).toString('utf-8');
    return Response.json({
      path: raw,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      truncated,
      content,
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Response.json({ error: 'file not found' }, { status: 404 });
    if (code === 'EACCES') return Response.json({ error: 'permission denied' }, { status: 403 });
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/kb/file] Error:', message);
    return Response.json({ error: 'failed to read file' }, { status: 500 });
  }
}
