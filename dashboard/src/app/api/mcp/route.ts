/**
 * GET /api/mcp — enumerate MCP servers across all agent .mcp.json files
 * in the framework's orgs tree. Returns one row per unique MCP name with
 * the list of (org, agent) pairs that have it mounted, plus best-effort
 * version + source URL fields parsed from the source repo if available.
 *
 * v1 is read-only — no install/uninstall (MCP wiring needs server-side
 * process startup + agent restart, can't be done from a browser click).
 */
import fs from 'fs';
import path from 'path';
import { CTX_FRAMEWORK_ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

interface McpEntry {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  sourcePath: string | null;
  sourceUrl: string | null;
  version: string | null;
  language: 'node' | 'python' | 'unknown';
  mountedBy: Array<{ org: string; agent: string }>;
}

interface McpServerStanza {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function inferSourceFromArgs(
  command: string,
  args: string[],
): { sourcePath: string | null; language: McpEntry['language'] } {
  // Heuristic: find an absolute path in args that points at the MCP source dir
  for (const arg of args) {
    if (arg.startsWith('/')) {
      // Walk up to find a package.json or pyproject.toml
      let dir = path.dirname(arg);
      for (let i = 0; i < 6 && dir !== '/'; i++) {
        if (fs.existsSync(path.join(dir, 'pyproject.toml'))) {
          return { sourcePath: dir, language: 'python' };
        }
        if (fs.existsSync(path.join(dir, 'package.json'))) {
          return { sourcePath: dir, language: 'node' };
        }
        dir = path.dirname(dir);
      }
    }
  }
  // Fall back: command tells us language for npx/uvx/python wrappers
  if (command === 'npx' || command === 'node') return { sourcePath: null, language: 'node' };
  if (command === 'uvx' || command === 'python' || command === 'python3')
    return { sourcePath: null, language: 'python' };
  return { sourcePath: null, language: 'unknown' };
}

function parseSource(
  sourcePath: string | null,
  language: McpEntry['language'],
): { version: string | null; sourceUrl: string | null } {
  if (!sourcePath) return { version: null, sourceUrl: null };

  if (language === 'node') {
    const pkgPath = path.join(sourcePath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
          version?: string;
          repository?: string | { url?: string };
          homepage?: string;
        };
        const version = pkg.version ?? null;
        let sourceUrl: string | null = null;
        if (typeof pkg.repository === 'string') sourceUrl = pkg.repository;
        else if (pkg.repository?.url) sourceUrl = pkg.repository.url;
        else if (pkg.homepage) sourceUrl = pkg.homepage;
        if (sourceUrl) sourceUrl = sourceUrl.replace(/^git\+/, '').replace(/\.git$/, '');
        return { version, sourceUrl };
      } catch {
        return { version: null, sourceUrl: null };
      }
    }
  }

  if (language === 'python') {
    const tomlPath = path.join(sourcePath, 'pyproject.toml');
    if (fs.existsSync(tomlPath)) {
      try {
        const raw = fs.readFileSync(tomlPath, 'utf-8');
        const versionMatch = raw.match(/^version\s*=\s*["']([^"']+)["']/m);
        const urlMatch = raw.match(/^(?:Homepage|Repository|repository)\s*=\s*["']([^"']+)["']/im);
        return {
          version: versionMatch ? versionMatch[1] : null,
          sourceUrl: urlMatch ? urlMatch[1] : null,
        };
      } catch {
        return { version: null, sourceUrl: null };
      }
    }
  }

  return { version: null, sourceUrl: null };
}

export async function GET() {
  const orgsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs');
  if (!fs.existsSync(orgsDir)) return Response.json([]);

  const byName = new Map<string, McpEntry>();

  for (const orgEntry of fs.readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = path.join(orgsDir, orgEntry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;

    for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const mcpFile = path.join(agentsDir, agentEntry.name, '.mcp.json');
      if (!fs.existsSync(mcpFile)) continue;

      let parsed: { mcpServers?: Record<string, McpServerStanza> };
      try {
        parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
      } catch {
        continue;
      }
      if (!parsed.mcpServers) continue;

      for (const [name, stanza] of Object.entries(parsed.mcpServers)) {
        const command = stanza.command ?? '';
        const args = stanza.args ?? [];
        const envKeys = Object.keys(stanza.env ?? {});

        let entry = byName.get(name);
        if (!entry) {
          const { sourcePath, language } = inferSourceFromArgs(command, args);
          const { version, sourceUrl } = parseSource(sourcePath, language);
          entry = {
            name,
            command,
            args,
            envKeys,
            sourcePath,
            sourceUrl,
            version,
            language,
            mountedBy: [],
          };
          byName.set(name, entry);
        }
        entry.mountedBy.push({ org: orgEntry.name, agent: agentEntry.name });
      }
    }
  }

  const list = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return Response.json(list);
}
