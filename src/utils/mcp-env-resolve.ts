/**
 * mcp-env-resolve — substitute ${VAR} placeholders inside .mcp.json
 * mcpServers env blocks against the org's secrets.env + agent's .env.
 *
 * Goal: keep credentials canonical in `orgs/<org>/secrets.env` (gitignored,
 * single source of truth) instead of duplicated inline in each agent's
 * `.mcp.json`. Agents reference creds with `${VAR}` placeholders; this
 * resolver expands them at boot time.
 *
 * Standalone — no Claude inference, no network, just file IO + string
 * substitution. Exposed via `cortextos bus mcp-resolve` for testing and as
 * a building block for a future daemon-side integration.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync } from './atomic.js';

export interface ResolveResult {
  resolved: object;
  unresolved: string[]; // ${VAR} placeholders that didn't have a value
  substituted: string[]; // ${VAR} placeholders that DID resolve
  inputPath: string;
  outputPath: string | null;
}

const PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Parse a .env-style file. Tolerates `KEY=VALUE`, `KEY="VALUE"`,
 * `KEY='VALUE'`, comments (`#`) and blank lines. No `export` keyword or
 * variable interpolation in the .env itself — keep it boring.
 */
export function parseDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const raw = readFileSync(path, 'utf-8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Substitute ${VAR} or ${VAR:-default} placeholders inside a string.
 * Returns the new string + the set of placeholders encountered + the
 * subset that didn't resolve (no value AND no default).
 */
export function substituteString(
  input: string,
  values: Record<string, string>,
): { output: string; resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const output = input.replace(PLACEHOLDER_RE, (_match, name, defaultVal) => {
    if (values[name] !== undefined && values[name] !== '') {
      resolved.push(name);
      return values[name];
    }
    if (defaultVal !== undefined) {
      resolved.push(name);
      return defaultVal;
    }
    unresolved.push(name);
    return _match; // leave the placeholder as-is so the failure is visible
  });
  return { output, resolved, unresolved };
}

/**
 * Walk an object/array tree and substitute ${VAR} placeholders inside any
 * string leaf. Used to resolve mcpServers.*.env values.
 */
function substituteTree(
  node: unknown,
  values: Record<string, string>,
  resolved: Set<string>,
  unresolved: Set<string>,
): unknown {
  if (typeof node === 'string') {
    const { output, resolved: r, unresolved: u } = substituteString(node, values);
    r.forEach((x) => resolved.add(x));
    u.forEach((x) => unresolved.add(x));
    return output;
  }
  if (Array.isArray(node)) {
    return node.map((c) => substituteTree(c, values, resolved, unresolved));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = substituteTree(v, values, resolved, unresolved);
    }
    return out;
  }
  return node;
}

export interface ResolveOptions {
  agent: string;
  org: string;
  frameworkRoot: string;
  /** Where to write the resolved JSON. Default: <agentDir>/.mcp.resolved.json. */
  outputPath?: string;
  /** If true, write to outputPath. If false, only return the resolved object. */
  write?: boolean;
}

/**
 * Resolve an agent's .mcp.json against its org + agent .env files.
 *
 * Resolution order (later wins on collision):
 *   1. orgs/<org>/secrets.env (org-shared canonical secrets)
 *   2. orgs/<org>/agents/<agent>/.env (agent-specific overrides)
 *   3. process.env (live process env, highest precedence — useful for testing)
 */
export function resolveMcpEnv(opts: ResolveOptions): ResolveResult {
  const orgSecretsPath = join(opts.frameworkRoot, 'orgs', opts.org, 'secrets.env');
  const agentDir = join(opts.frameworkRoot, 'orgs', opts.org, 'agents', opts.agent);
  const agentEnvPath = join(agentDir, '.env');
  const inputPath = join(agentDir, '.mcp.json');

  if (!existsSync(inputPath)) {
    throw new Error(`No .mcp.json at ${inputPath}; nothing to resolve.`);
  }

  const merged: Record<string, string> = {
    ...parseDotenv(orgSecretsPath),
    ...parseDotenv(agentEnvPath),
    ...(process.env as Record<string, string>),
  };

  const raw = readFileSync(inputPath, 'utf-8');
  const parsed = JSON.parse(raw);

  const resolvedNames = new Set<string>();
  const unresolvedNames = new Set<string>();
  const tree = substituteTree(parsed, merged, resolvedNames, unresolvedNames);

  const outputPath =
    opts.outputPath ?? join(agentDir, '.mcp.resolved.json');

  if (opts.write) {
    atomicWriteSync(outputPath, JSON.stringify(tree, null, 2) + '\n', false);
  }

  return {
    resolved: tree as object,
    resolvedList: Array.from(resolvedNames).sort(),
    unresolved: Array.from(unresolvedNames).sort(),
    substituted: Array.from(resolvedNames).sort(),
    inputPath,
    outputPath: opts.write ? outputPath : null,
  } as ResolveResult & { resolvedList: string[] };
}
