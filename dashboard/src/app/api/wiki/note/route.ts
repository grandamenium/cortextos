import fs from 'fs';
import { NextRequest } from 'next/server';
import {
  getVaultStatus,
  parseFrontmatter,
  resolveVaultPath,
} from '@/lib/vault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const relPath = url.searchParams.get('path');

  if (!relPath) {
    return Response.json({ error: 'path query param required' }, { status: 400 });
  }

  const vaultStatus = getVaultStatus();
  if (vaultStatus.state !== 'ready') {
    return Response.json(
      {
        vaultStatus,
        error:
          vaultStatus.state === 'not-configured'
            ? 'Vault path is not configured'
            : `Configured vault path does not exist: ${vaultStatus.configuredPath}`,
      },
      { status: 409 },
    );
  }

  const vaultRoot = vaultStatus.root;
  const abs = resolveVaultPath(vaultRoot, relPath);
  if (!abs) {
    return Response.json(
      { error: 'Path must be inside one of the PARA dirs and contain no traversal' },
      { status: 400 },
    );
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return Response.json({ error: 'Note not found' }, { status: 404 });
  }

  const raw = fs.readFileSync(abs, 'utf-8');
  const stat = fs.statSync(abs);
  const { frontmatter, body } = parseFrontmatter(raw);

  return Response.json({
    relPath,
    raw,
    body,
    frontmatter,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  });
}
