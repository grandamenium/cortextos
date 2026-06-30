/**
 * Vault helpers for the dashboard /wiki page.
 *
 * Resolves the org's Obsidian vault path, parses frontmatter, scopes file
 * reads to PARA-tree paths only (read-only — no writes from the dashboard).
 */
import fs from 'fs';
import path from 'path';
import { CTX_ROOT, CTX_FRAMEWORK_ROOT, getOrgs } from './config';

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

// Org-name validation. Mirrors VALID_NAME in the dashboard agent/org API routes
// (/^[a-z0-9_-]+$/) so an org that is addressable elsewhere in the dashboard is
// addressable in the wiki — underscores included (council: codex/mmax parity
// finding). Org names become a path segment under CTX_ROOT, so anything that
// could escape that path (traversal, separators, uppercase) is rejected.
const ORG_RE = /^[a-z0-9_-]+$/;

// True iff `p` is set and resolves to an existing directory. Single stat,
// swallowing ENOENT — avoids the existsSync()+statSync() TOCTOU race where the
// path is removed between the two calls (council: mmax medium).
function isExistingDir(p: string | undefined): p is string {
  if (!p) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// True iff `p` exists on disk as anything (file, dir, symlink target).
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the PARA skeleton for a vault root we own (the CTX_ROOT default
 * vault). Never called on user-declared paths (CTX_VAULT_PATH / knowledge.md)
 * — those are user-managed vaults and the dashboard must not write into them
 * (council: codex high — a stale or malicious declared path must not cause
 * directory creation outside CTX_ROOT).
 *
 * Returns false without writing anything if the target (or any PARA entry)
 * exists but is not a directory — e.g. a regular file squatting on the vault
 * path (council: mmax high). Uses recursive mkdir, which is idempotent and
 * safe to call concurrently; multiple wiki routes may race on first access.
 *
 * Fast path: when every PARA dir already exists we skip the mkdir calls, so
 * the steady-state case (every wiki request) does no filesystem writes.
 */
function ensureVaultSkeleton(vaultRoot: string): boolean {
  // Refuse to build a skeleton over (or report success for) a non-directory.
  // Checked BEFORE the fast path so a file squatting on the vault path can
  // never be reported as a valid vault (council: mmax medium).
  if (exists(vaultRoot) && !isExistingDir(vaultRoot)) return false;
  if (PARA_DIRS.every((dir) => isExistingDir(path.join(vaultRoot, dir)))) {
    return true;
  }
  try {
    fs.mkdirSync(vaultRoot, { recursive: true });
    for (const dir of PARA_DIRS) {
      const p = path.join(vaultRoot, dir);
      if (exists(p) && !isExistingDir(p)) return false;
      fs.mkdirSync(p, { recursive: true });
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Parse an "Obsidian vault" path declaration out of a knowledge.md body.
 * Accepts both the backtick-wrapped form and a plain markdown form, e.g.
 *   Obsidian vault: `/srv/notes/vault/`
 *   Obsidian vault: /srv/notes/vault
 *   The Obsidian vault lives at `/home/me/vault`.
 *
 * Paths containing spaces MUST use the backtick form — the plain form stops at
 * the first whitespace character (council: mmax high, documented limitation).
 *
 * Returns the path (trailing slash stripped) or null if no declaration found.
 */
function parseKnowledgeVaultPath(content: string): string | null {
  // Backtick-wrapped path wins (most explicit; required for paths with spaces).
  const backtick = content.match(/Obsidian vault[^\n]*?`([^`]+)`/i);
  if (backtick) return backtick[1].trim().replace(/\/+$/, '');
  // Plain form: an absolute path following "Obsidian vault" on the same line.
  // The region between the keyword and the path must not cross a backtick —
  // otherwise an unbalanced backtick declaration would be half-captured and
  // punctuation-stripped into the wrong path (council: mmax high).
  const plain = content.match(
    /Obsidian vault[^\n`]*?[:=]?\s*(\/[^\s`'"]+)/i,
  );
  if (plain) {
    // Strip trailing sentence punctuation (".", ",", ";", ":", ")") that a
    // prose declaration like "Obsidian vault: /srv/notes/vault." would capture,
    // then drop any trailing slash.
    return plain[1].trim().replace(/[.,;:)]+$/, '').replace(/\/+$/, '');
  }
  return null;
}

/**
 * Resolve the org's vault root. Resolution order:
 *   1. CTX_VAULT_PATH env override — returned as-is if it is an existing
 *      directory. User-managed: the dashboard never writes into it.
 *   2. An "Obsidian vault" path entry in orgs/<org>/knowledge.md (opt-in) —
 *      returned as-is if it is an existing directory. Also user-managed.
 *   3. Default: $CTX_ROOT/orgs/<org>/vault — auto-created with the PARA
 *      skeleton on first access, but ONLY when the org itself is already
 *      provisioned ($CTX_ROOT/orgs/<org>/ exists). A wiki GET must not be able
 *      to create directories for arbitrary org names (council: codex high).
 *
 * Returns null for: an invalid org name, an unprovisioned org with no
 * override, or a default-vault path obstructed by a non-directory.
 *
 * This is the fix for #41: on a fresh install the default org is provisioned
 * (orgs/<org>/ exists with context.json etc.) but has no vault/ — previously
 * the page 404'd; now the vault is created inside the existing org dir.
 */
export function getVaultRoot(org: string): string | null {
  // Org name becomes a path segment under CTX_ROOT — refuse anything unsafe.
  if (!ORG_RE.test(org)) return null;

  // 1. Explicit env override wins. User-managed — no skeleton creation.
  if (isExistingDir(process.env.CTX_VAULT_PATH)) {
    return process.env.CTX_VAULT_PATH;
  }

  // 2. Try parsing orgs/<org>/knowledge.md for an "Obsidian vault" path entry.
  //    User-managed — no skeleton creation.
  const knowledgePath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'knowledge.md');
  if (fs.existsSync(knowledgePath)) {
    try {
      const content = fs.readFileSync(knowledgePath, 'utf-8');
      const declared = parseKnowledgeVaultPath(content);
      if (declared && isExistingDir(declared)) {
        return declared;
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Default to the per-org vault under CTX_ROOT — but only for an org that
  //    actually exists. Org membership is resolved via getOrgs() (the same
  //    discovery the rest of the dashboard uses: framework root + state root,
  //    framework casing wins) so the wiki agrees with the org switcher about
  //    which orgs are real (council: codex high). This keeps the fresh-install
  //    fix (#41) while ensuring a read-only wiki request can never spray
  //    directories for arbitrary org names.
  if (!getOrgs().includes(org)) return null;

  const defaultVault = path.join(CTX_ROOT, 'orgs', org, 'vault');
  if (!ensureVaultSkeleton(defaultVault)) return null;
  return defaultVault;
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
