import fs from 'fs/promises';
import path from 'path';

export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;
  children?: FileEntry[];
};

const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', '.cache', '__pycache__']);

export function ensureInsideRoot(root: string, input = ''): string {
  const resolvedRoot = path.resolve(root);
  const resolved = input
    ? path.resolve(resolvedRoot, input.replace(/^[/\\]+/, ''))
    : resolvedRoot;
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the agent workspace');
  }
  return resolved;
}

export function toRelative(root: string, filePath: string): string {
  return path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/g, '/');
}

export async function readTree(root: string, relative = '', depth = 2): Promise<FileEntry[]> {
  const dir = ensureInsideRoot(root, relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const mapped: FileEntry[] = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.DS_Store')) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = await fs.stat(fullPath);
    const item: FileEntry = {
      name: entry.name,
      path: toRelative(root, fullPath),
      type: entry.isDirectory() ? 'folder' : 'file',
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
    if (entry.isDirectory() && depth > 0) {
      item.children = await readTree(root, item.path, depth - 1).catch(() => []);
    }
    mapped.push(item);
  }

  return mapped.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listMarkdownDays(dir: string): Promise<FileEntry[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            type: 'file' as const,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
    );
    return files.sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}
