/**
 * scripts/migrate-runtime-field.ts
 *
 * One-shot migration that backfills the explicit `runtime` field into every
 * live agent's `config.json`. Pre-PR-10 the claude default was *implicit*
 * (absence of the field == claude-code) — the daemon understood that, but
 * humans inspecting config.json had to know the default. PR 10 makes the
 * field explicit in templates so new agents get it on scaffold; this script
 * brings the 17 already-deployed agents up to the same shape.
 *
 * Behavior:
 *   - Walk orgs/<org>/agents/<agent>/config.json across the workspace
 *   - If `runtime` is already set → leave the file alone (idempotent)
 *   - If `runtime` is missing → add `"runtime": "claude-code"`, positioned
 *     right after `enabled` (matching templates/agent-codex/config.json)
 *
 * Usage:
 *   npx tsx scripts/migrate-runtime-field.ts --dry-run   # preview diffs
 *   npx tsx scripts/migrate-runtime-field.ts             # apply changes
 *   npx tsx scripts/migrate-runtime-field.ts --root <path>   # custom root
 *
 * The dry-run mode is the recommended first invocation — it prints the
 * planned change set so a human can sign off before any file is written.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

interface MigrationResult {
  path: string;
  org: string;
  agent: string;
  action: 'skip-already-set' | 'skip-not-json' | 'add-runtime';
  before?: string | undefined;
  after?: string;
}

interface MigrationOptions {
  root: string;
  dryRun: boolean;
}

const DEFAULT_RUNTIME = 'claude-code' as const;

export function findAgentConfigs(root: string): string[] {
  const orgsDir = join(root, 'orgs');
  if (!existsSync(orgsDir)) return [];

  const configs: string[] = [];
  for (const orgEntry of readdirSync(orgsDir, { withFileTypes: true })) {
    if (!orgEntry.isDirectory()) continue;
    const agentsDir = join(orgsDir, orgEntry.name, 'agents');
    if (!existsSync(agentsDir)) continue;

    for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue;
      const cfgPath = join(agentsDir, agentEntry.name, 'config.json');
      if (existsSync(cfgPath) && statSync(cfgPath).isFile()) {
        configs.push(cfgPath);
      }
    }
  }
  return configs.sort();
}

/**
 * Reorder keys so `runtime` lands right after `enabled` for visual parity
 * with templates/agent-codex/config.json. If `enabled` is missing, the
 * field lands right after `agent_name`. If neither is present, runtime
 * goes first.
 */
export function injectRuntimeField(cfg: Record<string, unknown>): Record<string, unknown> {
  if ('runtime' in cfg) return cfg;

  const result: Record<string, unknown> = {};
  let injected = false;
  const anchor = 'enabled' in cfg ? 'enabled' : ('agent_name' in cfg ? 'agent_name' : null);

  if (anchor === null) {
    // No anchor — stick runtime at the front, then everything else.
    result.runtime = DEFAULT_RUNTIME;
    for (const [k, v] of Object.entries(cfg)) result[k] = v;
    return result;
  }

  for (const [k, v] of Object.entries(cfg)) {
    result[k] = v;
    if (!injected && k === anchor) {
      result.runtime = DEFAULT_RUNTIME;
      injected = true;
    }
  }
  return result;
}

export function migrateConfig(path: string, root: string): MigrationResult {
  // org / agent are derived from the path so the dry-run output is human-scannable.
  const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
  const parts = rel.split('/');
  const org = parts[1] ?? '?';
  const agent = parts[3] ?? '?';

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { path, org, agent, action: 'skip-not-json' };
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { path, org, agent, action: 'skip-not-json' };
  }

  if ('runtime' in cfg) {
    return {
      path, org, agent, action: 'skip-already-set',
      before: String(cfg.runtime),
    };
  }

  const next = injectRuntimeField(cfg);
  return {
    path, org, agent, action: 'add-runtime',
    after: JSON.stringify(next, null, 2) + '\n',
  };
}

export function runMigration(opts: MigrationOptions): { results: MigrationResult[]; summary: { total: number; willChange: number; alreadySet: number; skipped: number; } } {
  const configs = findAgentConfigs(opts.root);
  const results: MigrationResult[] = [];

  for (const path of configs) {
    const result = migrateConfig(path, opts.root);
    results.push(result);

    if (result.action === 'add-runtime' && !opts.dryRun && result.after) {
      writeFileSync(path, result.after, 'utf-8');
    }
  }

  const summary = {
    total: results.length,
    willChange: results.filter(r => r.action === 'add-runtime').length,
    alreadySet: results.filter(r => r.action === 'skip-already-set').length,
    skipped: results.filter(r => r.action === 'skip-not-json').length,
  };

  return { results, summary };
}

function formatResults(results: MigrationResult[], dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(dryRun ? '=== DRY RUN — no files written ===' : '=== MIGRATION APPLIED ===');
  lines.push('');

  for (const r of results) {
    const prefix = `[${r.org}/${r.agent}]`;
    if (r.action === 'add-runtime') {
      lines.push(`${prefix} ADD runtime="${DEFAULT_RUNTIME}"  ${r.path}`);
    } else if (r.action === 'skip-already-set') {
      lines.push(`${prefix} SKIP (already set: runtime="${r.before}")  ${r.path}`);
    } else {
      lines.push(`${prefix} SKIP (not parseable JSON)  ${r.path}`);
    }
  }
  return lines.join('\n');
}

// CLI entrypoint — only runs when executed directly, never on import (so
// the unit test can call runMigration() without spawning a CLI side-effect).
const isMain = (() => {
  try {
    // ESM-friendly main detection
    return Boolean(typeof require !== 'undefined' && require.main === module);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 && argv[rootIdx + 1]
    ? argv[rootIdx + 1]
    : (process.env.CTX_FRAMEWORK_ROOT || process.cwd());

  const { results, summary } = runMigration({ root, dryRun });
  console.log(formatResults(results, dryRun));
  console.log('');
  console.log(`Total configs scanned: ${summary.total}`);
  console.log(`Will add runtime:      ${summary.willChange}`);
  console.log(`Already set:           ${summary.alreadySet}`);
  console.log(`Skipped (parse err):   ${summary.skipped}`);

  if (dryRun && summary.willChange > 0) {
    console.log('');
    console.log('Re-run without --dry-run to apply.');
  }
}
