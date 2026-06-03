import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import {
  getVaultRoot,
  parseFrontmatter,
  firstMeaningfulLine,
} from '@/lib/vault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org') ?? 'sondre-hq';

  const vaultRoot = getVaultRoot(org);
  if (!vaultRoot) {
    return Response.json({ error: `Vault not found for org "${org}"` }, { status: 404 });
  }

  const inboxDir = path.join(vaultRoot, '00-inbox');
  if (!fs.existsSync(inboxDir)) {
    return Response.json({ vaultRoot, items: [] });
  }

  const items = [];
  for (const entry of fs.readdirSync(inboxDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name.startsWith('.')) continue;

    const abs = path.join(inboxDir, entry.name);
    const stat = fs.statSync(abs);
    let frontmatter = {};
    let excerpt = '';

    try {
      const raw = fs.readFileSync(abs, 'utf-8');
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.frontmatter;
      excerpt = firstMeaningfulLine(parsed.body);
    } catch {
      /* tolerate read errors — surface row anyway */
    }

    items.push({
      filename: entry.name,
      relPath: path.join('00-inbox', entry.name),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      frontmatter,
      excerpt,
    });
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return Response.json({ vaultRoot, items });
}
