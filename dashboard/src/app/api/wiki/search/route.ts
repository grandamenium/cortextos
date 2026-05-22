import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { getVaultRoot, listAllNotes, parseFrontmatter } from '@/lib/vault';

export const dynamic = 'force-dynamic';

const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const org = url.searchParams.get('org') ?? 'sondre-hq';
  const q = (url.searchParams.get('q') ?? '').trim();

  if (q.length < 2) {
    return Response.json({ q, results: [] });
  }

  const vaultRoot = getVaultRoot(org);
  if (!vaultRoot) {
    return Response.json({ error: `Vault not found for org "${org}"` }, { status: 404 });
  }

  const needle = q.toLowerCase();
  const results: Array<{
    relPath: string;
    filename: string;
    matchedIn: 'filename' | 'content' | 'both';
    snippet: string;
    frontmatter: Record<string, unknown>;
    mtimeMs: number;
  }> = [];

  for (const note of listAllNotes(vaultRoot)) {
    if (results.length >= MAX_RESULTS) break;

    const filename = path.basename(note.relPath);
    const filenameMatches = filename.toLowerCase().includes(needle);

    let raw = '';
    try {
      raw = fs.readFileSync(note.absPath, 'utf-8');
    } catch {
      continue;
    }

    const idx = raw.toLowerCase().indexOf(needle);
    const contentMatches = idx !== -1;

    if (!filenameMatches && !contentMatches) continue;

    let snippet = '';
    if (contentMatches) {
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(raw.length, idx + needle.length + SNIPPET_RADIUS);
      snippet = (start > 0 ? '…' : '') + raw.slice(start, end).replace(/\s+/g, ' ').trim() + (end < raw.length ? '…' : '');
    }

    const { frontmatter } = parseFrontmatter(raw);

    results.push({
      relPath: note.relPath,
      filename,
      matchedIn: filenameMatches && contentMatches ? 'both' : filenameMatches ? 'filename' : 'content',
      snippet,
      frontmatter,
      mtimeMs: note.mtimeMs,
    });
  }

  // Filename matches first, then content matches; within each, newest first
  results.sort((a, b) => {
    const rank = (m: typeof a.matchedIn) => (m === 'both' ? 0 : m === 'filename' ? 1 : 2);
    const r = rank(a.matchedIn) - rank(b.matchedIn);
    return r !== 0 ? r : b.mtimeMs - a.mtimeMs;
  });

  return Response.json({ q, results });
}
