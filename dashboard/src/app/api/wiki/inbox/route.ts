import fs from 'fs';
import path from 'path';
import {
  getVaultStatus,
  parseFrontmatter,
  firstMeaningfulLine,
} from '@/lib/vault';

export const dynamic = 'force-dynamic';

export async function GET() {
  const vaultStatus = getVaultStatus();
  if (vaultStatus.state !== 'ready') {
    return Response.json({
      vaultRoot: null,
      items: [],
      vaultStatus,
      error:
        vaultStatus.state === 'not-configured'
          ? 'Vault path is not configured'
          : `Configured vault path does not exist: ${vaultStatus.configuredPath}`,
    });
  }

  const vaultRoot = vaultStatus.root;
  const inboxDir = path.join(vaultRoot, '00-inbox');
  if (!fs.existsSync(inboxDir)) {
    return Response.json({ vaultRoot, items: [], vaultStatus });
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

  return Response.json({ vaultRoot, items, vaultStatus });
}
