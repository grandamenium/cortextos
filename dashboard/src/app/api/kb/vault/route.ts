import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, relative } from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/vault
 *
 * Returns the Obsidian vault structure and metadata.
 */

interface VaultFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  modified: string;
  preview: string; // first 200 chars
}

interface VaultFolder {
  name: string;
  count: number;
}

function scanVault(vaultPath: string): { files: VaultFile[]; folders: VaultFolder[] } {
  const files: VaultFile[] = [];
  const folderCounts = new Map<string, number>();

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // skip .obsidian etc
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith('.md')) {
          const relPath = relative(vaultPath, fullPath);
          const folder = relPath.includes('/') ? relPath.split('/')[0] : '/';
          const stats = statSync(fullPath);

          let preview = '';
          try {
            const content = readFileSync(fullPath, 'utf-8');
            // Strip frontmatter and headings for preview
            const stripped = content
              .replace(/^---[\s\S]*?---\n?/, '')
              .replace(/^#+\s+.+$/gm, '')
              .trim();
            preview = stripped.slice(0, 200);
          } catch { /* ignore */ }

          files.push({
            path: relPath,
            name: entry.name.replace('.md', ''),
            folder,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            preview,
          });

          folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  walk(vaultPath);

  const folders = Array.from(folderCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return { files, folders };
}

export async function GET() {
  // Vault path is hardcoded — it's a system-level config, not per-org
  const vaultPath = join(process.env.HOME || '/Users/arndt', 'cortextos', 'obsidian-vault');

  if (!existsSync(vaultPath)) {
    return Response.json({
      configured: false,
      vaultPath,
      files: [],
      folders: [],
      totalFiles: 0,
    });
  }

  const { files, folders } = scanVault(vaultPath);

  return Response.json({
    configured: true,
    vaultPath,
    files,
    folders,
    totalFiles: files.length,
  });
}
