import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { getVaultRoot, PARA_DIRS } from '@/lib/vault';

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

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org') ?? 'sondre-hq';

  const vaultRoot = getVaultRoot(org);
  if (!vaultRoot) {
    return Response.json({ error: `Vault not found for org "${org}"` }, { status: 404 });
  }

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

  return Response.json({ vaultRoot, root });
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
