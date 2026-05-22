/**
 * Vault helpers for the dashboard /wiki page.
 *
 * Resolves the org's Obsidian vault path, parses frontmatter, scopes file
 * reads to PARA-tree paths only (read-only — no writes from the dashboard).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CTX_FRAMEWORK_ROOT } from './config';

export const PARA_DIRS = [
  '00-inbox',
  '01-projects',
  '02-areas',
  '03-resources',
  '04-archive',
  '05-daily',
  '06-maps',
] as const;

export type ParaDir = (typeof PARA_DIRS)[number];

const VAULT_FALLBACK = process.env.CTX_VAULT_PATH
  ?? path.join(os.homedir(), 'storage', 'Documents', 'Github', 'sondres-orchestrator', 'vault');

export function getVaultRoot(org: string): string | null {
  // 1. Try parsing orgs/<org>/knowledge.md for an "Obsidian vault" path entry
  const knowledgePath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'knowledge.md');
  if (fs.existsSync(knowledgePath)) {
    try {
      const content = fs.readFileSync(knowledgePath, 'utf-8');
      // Match a code path like `/root/.../vault/` after "Obsidian vault" mentions
      const match = content.match(
        /Obsidian vault[^\n]*?`([^`]+vault\/?)`/i,
      );
      if (match) {
        const p = match[1].replace(/\/$/, '');
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Fallback to the known sondre-hq vault location
  if (fs.existsSync(VAULT_FALLBACK) && fs.statSync(VAULT_FALLBACK).isDirectory()) {
    return VAULT_FALLBACK;
  }

  return null;
}

export type Frontmatter = {
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  status?: string;
  agent?: string;
  session?: string;
  relates_to?: string[];
  [key: string]: unknown;
};

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };

  const fm: Frontmatter = {};
  const block = m[1];

  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value: unknown = kv[2].trim();
    const v = value as string;

    if (v === '') {
      value = '';
    } else if (v.startsWith('[') && v.endsWith(']')) {
      // Array — comma split inside the brackets, strip quotes
      value = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      value = v.replace(/^["']|["']$/g, '');
    }

    fm[key] = value;
  }

  return { frontmatter: fm, body: m[2] };
}

export function firstMeaningfulLine(body: string, max = 160): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // skip headings
    if (line.startsWith('```')) continue;
    if (line === '---') continue;
    return line.length > max ? line.slice(0, max).trimEnd() + '…' : line;
  }
  return '';
}

/**
 * Resolves a relative vault path safely. Refuses anything outside the vault
 * root or outside the PARA dirs.
 */
export function resolveVaultPath(
  vaultRoot: string,
  relPath: string,
): string | null {
  // Strip leading slashes; we want a relative path inside the vault
  const cleaned = relPath.replace(/^\/+/, '');
  // Reject any traversal attempts up front
  if (cleaned.includes('..')) return null;
  // Must start with one of the PARA dir names
  const top = cleaned.split('/')[0];
  if (!PARA_DIRS.includes(top as ParaDir)) return null;

  const abs = path.resolve(vaultRoot, cleaned);
  // Defense in depth — confirm resolved path is inside the vault root
  if (!abs.startsWith(path.resolve(vaultRoot) + path.sep)) return null;
  return abs;
}

/**
 * Walk all PARA dirs and collect every .md file. Used by search.
 */
export function listAllNotes(vaultRoot: string): Array<{
  relPath: string;
  absPath: string;
  mtimeMs: number;
}> {
  const out: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  for (const dir of PARA_DIRS) {
    const abs = path.join(vaultRoot, dir);
    if (!fs.existsSync(abs)) continue;
    walk(abs, vaultRoot, out);
  }
  return out;
}

function walk(
  abs: string,
  vaultRoot: string,
  out: Array<{ relPath: string; absPath: string; mtimeMs: number }>,
) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(child, vaultRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(child);
      out.push({
        relPath: path.relative(vaultRoot, child),
        absPath: child,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
}

/**
 * Resolve a wikilink slug (e.g. "20260506-dev-foo" or "foo/bar") to a vault
 * file path. Searches all PARA dirs for the first matching basename (with or
 * without .md extension).
 */
export function resolveWikilink(
  vaultRoot: string,
  slug: string,
): string | null {
  const normalized = slug.replace(/\.md$/, '');
  for (const note of listAllNotes(vaultRoot)) {
    const base = path.basename(note.relPath, '.md');
    if (base === normalized) return note.relPath;
  }
  // Also try exact relative path match (e.g. "01-projects/coliseum")
  for (const note of listAllNotes(vaultRoot)) {
    if (note.relPath.replace(/\.md$/, '') === normalized) return note.relPath;
  }
  return null;
}
