import { readdirSync, realpathSync } from 'fs';
import { join } from 'path';

/**
 * Where Claude Code keeps a working directory's conversations: <config>/projects/<slug>.
 *
 * Mirrors Claude Code 2.1.268 exactly (verified against the shipped binary and a live run):
 *   - the input is the PHYSICAL cwd (symlinks resolved, e.g. /tmp -> /private/tmp);
 *   - every UTF-16 code unit outside [A-Za-z0-9] becomes "-" ("_", ".", space, "@", "+", "~",
 *     non-ASCII; an astral character is two units, so "--"), with no collapsing ("/." -> "--");
 *   - a slug longer than 200 is cut to 200 and suffixed with "-" + base-36 of the absolute
 *     32-bit Java-style string hash of the ORIGINAL path.
 * The engine used to join path segments with "-", which disagrees whenever the path contains
 * any other punctuation, so a Claude agent could never
 * detect its own conversation and always started fresh.
 */
export const CLAUDE_SLUG_MAX = 200;

export function javaStringHash(s: string): number {
  let e = 0;
  for (let i = 0; i < s.length; i++) e = ((e << 5) - e + s.charCodeAt(i)) | 0;
  return e;
}

export function claudeProjectSlug(physicalCwd: string): string {
  const n = physicalCwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (n.length <= CLAUDE_SLUG_MAX) return n;
  return `${n.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(javaStringHash(physicalCwd)).toString(36)}`;
}

/**
 * The existing conversation directory for `launchDir` under `projectsRoot`, or null.
 * Long paths also accept any directory named `<first 200>-...`, which Claude Code's own
 * lookup tolerates.
 */
export function findClaudeProjectDir(projectsRoot: string, launchDir: string): string | null {
  let physical = launchDir;
  try { physical = realpathSync(launchDir); } catch { /* not created yet: use as given */ }
  const slug = claudeProjectSlug(physical);
  let entries: string[];
  try { entries = readdirSync(projectsRoot); } catch { return null; }
  if (entries.includes(slug)) return join(projectsRoot, slug);
  if (slug.length > CLAUDE_SLUG_MAX) {
    const prefix = `${slug.slice(0, CLAUDE_SLUG_MAX)}-`;
    const match = entries.find((e) => e.startsWith(prefix));
    if (match) return join(projectsRoot, match);
  }
  return null;
}
