import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute } from 'path';
import { atomicWriteSync } from './atomic.js';

/**
 * Allowed-roots config layer for the deliverables system.
 *
 * The config file at {ctxRoot}/config/allowed-roots.json lists ADDITIONAL
 * absolute directories that the dashboard /api/media route is permitted to
 * serve from, beyond the implicit CTX_ROOT default.
 *
 * On a fresh install the file is missing and the additional list is empty,
 * which means snapshot-only is enforced (the existing CTX_ROOT-prefix-check
 * behavior). The user adds entries via the Settings > Allowed Roots tab.
 */

export interface AllowedRootsFile {
  additional_roots: string[];
}

export interface AddAllowedRootResult {
  success: boolean;
  error?: string;
  config?: AllowedRootsFile;
}

export interface RemoveAllowedRootResult {
  success: boolean;
  error?: string;
  config?: AllowedRootsFile;
}

/**
 * System directories that should never be added as allowed roots. Adding any
 * of these would let the dashboard serve files from places like /etc, ~/.ssh,
 * or the entire root of the drive.
 */
export const SYSTEM_BLOCKLIST: ReadonlyArray<string> = [
  '/',
  'C:/',
  'D:/',
  'E:/',
  '/usr',
  '/etc',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/dev',
  '/root',
  '/System',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
];

/**
 * Read the allowed-roots config from disk. Returns an empty config if the
 * file is missing or unreadable.
 */
export function readAllowedRoots(configPath: string): AllowedRootsFile {
  const empty: AllowedRootsFile = { additional_roots: [] };
  if (!existsSync(configPath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    const roots = Array.isArray(parsed.additional_roots) ? parsed.additional_roots : [];
    return {
      additional_roots: roots
        .filter((r: unknown): r is string => typeof r === 'string')
        .map((r: string) => normalizePath(r)),
    };
  } catch {
    return empty;
  }
}

/**
 * Append a new allowed root after validating it.
 */
export function addAllowedRoot(
  configPath: string,
  rawPath: string,
): AddAllowedRootResult {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { success: false, error: 'Path is required' };
  }

  if (!isAbsolute(trimmed)) {
    return { success: false, error: 'Path must be absolute (start with / or a drive letter)' };
  }

  const normalized = normalizePath(trimmed);

  if (isSystemBlocklisted(normalized)) {
    return {
      success: false,
      error: `Cannot add system directory: ${normalized}. This path is on the security blocklist.`,
    };
  }

  if (!existsSync(normalized)) {
    return { success: false, error: `Path does not exist: ${normalized}` };
  }

  const current = readAllowedRoots(configPath);
  if (current.additional_roots.includes(normalized)) {
    return { success: false, error: `Path is already in the allowed roots list: ${normalized}` };
  }

  const updated: AllowedRootsFile = {
    additional_roots: [...current.additional_roots, normalized],
  };

  ensureConfigDir(configPath);
  atomicWriteSync(configPath, JSON.stringify(updated, null, 2));

  return { success: true, config: updated };
}

/**
 * Remove an allowed root by exact path match.
 */
export function removeAllowedRoot(
  configPath: string,
  rawPath: string,
): RemoveAllowedRootResult {
  const normalized = normalizePath(rawPath.trim());
  const current = readAllowedRoots(configPath);
  const updated: AllowedRootsFile = {
    additional_roots: current.additional_roots.filter((r) => r !== normalized),
  };

  ensureConfigDir(configPath);
  atomicWriteSync(configPath, JSON.stringify(updated, null, 2));

  return { success: true, config: updated };
}

/**
 * Compute the full set of valid roots: CTX_ROOT plus any additional entries.
 */
export function computeValidRoots(
  ctxRoot: string,
  configPath: string,
): string[] {
  const config = readAllowedRoots(configPath);
  const set = new Set<string>([
    normalizePath(ctxRoot),
    ...config.additional_roots,
  ]);
  return Array.from(set);
}

/**
 * Check whether a given absolute path falls within any of the supplied roots.
 */
export function isPathUnderRoots(
  normalizedPath: string,
  roots: string[],
): boolean {
  for (const root of roots) {
    const rootWithSep = root.endsWith('/') ? root : root + '/';
    if (normalizedPath === root || normalizedPath.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function isSystemBlocklisted(normalizedPath: string): boolean {
  for (const blocked of SYSTEM_BLOCKLIST) {
    const normalizedBlocked = normalizePath(blocked);
    if (normalizedPath === normalizedBlocked) return true;
  }
  return false;
}

function ensureConfigDir(configPath: string): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
