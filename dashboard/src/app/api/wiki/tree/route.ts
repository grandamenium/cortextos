import fs from 'fs';
import path from 'path';
import { getVaultStatus, PARA_DIRS } from '@/lib/vault';

export const dynamic = 'force-dynamic';

type TreeNode =
  | {
      kind: 'dir';
      name: string;
      relPath: string;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      relPath: string;
      mtimeMs: number;
    };

export async function GET() {
  const vaultStatus = getVaultStatus();
  if (vaultStatus.state !== 'ready') {
    return Response.json({
      vaultRoot: null,
      root: [],
      vaultStatus,
      error:
        vaultStatus.state === 'not-configured'
          ? 'Vault path is not configured'
          : `Configured vault path does not exist: ${vaultStatus.configuredPath}`,
    });
  }

  const vaultRoot = vaultStatus.root;
  const root: TreeNode[] = [];
  for (const dir of PARA_DIRS) {
    const abs = path.join(vaultRoot, dir);
    if (!fs.existsSync(abs)) continue;
    if (!fs.statSync(abs).isDirectory()) continue;

    root.push({
      kind: 'dir',
      name: dir,
      relPath: dir,
      children: walkDir(abs, vaultRoot, /* sortByMtime */ dir === '00-inbox'),
    });
  }

  return Response.json({ vaultRoot, root, vaultStatus });
}

function walkDir(
  abs: string,
  vaultRoot: string,
  sortByMtime: boolean,
): TreeNode[] {
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs: TreeNode[] = [];
  const files: Array<{ node: TreeNode; mtimeMs: number; name: string }> = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childAbs = path.join(abs, entry.name);
    const relPath = path.relative(vaultRoot, childAbs);

    if (entry.isDirectory()) {
      dirs.push({
        kind: 'dir',
        name: entry.name,
        relPath,
        children: walkDir(childAbs, vaultRoot, /* nested dirs always alpha */ false),
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(childAbs);
      files.push({
        node: {
          kind: 'file',
          name: entry.name,
          relPath,
          mtimeMs: stat.mtimeMs,
        },
        mtimeMs: stat.mtimeMs,
        name: entry.name,
      });
    }
  }

  // Dirs alphabetical
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  // Files: 00-inbox sorts newest-first; other dirs alphabetical
  if (sortByMtime) files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  else files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files.map((f) => f.node)];
}
