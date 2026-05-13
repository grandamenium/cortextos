import fs from 'fs';
import { NextRequest } from 'next/server';
import {
  getVaultRoot,
  parseFrontmatter,
  resolveVaultPath,
} from '@/lib/vault';

export const dynamic = 'force-dynamic';

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org') ?? 'sondre-hq';
  const relPath = url.searchParams.get('path');

  if (!ORG_RE.test(org)) {
    return Response.json({ error: 'Invalid org parameter' }, { status: 400 });
  }

  if (!relPath) {
    return Response.json({ error: 'path query param required' }, { status: 400 });
  }

  const vaultRoot = getVaultRoot(org);
  if (!vaultRoot) {
    return Response.json({ error: `Vault not found for org "${org}"` }, { status: 404 });
  }

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
