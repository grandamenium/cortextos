// Task #57 — Per-agent enabledPlugins scoping
//
// Every cortextOS agent currently inherits Hari's heavy user-level
// `~/.claude/settings.json` enabledPlugins map (50+ plugins, all on). That
// bloats every agent's context window per turn and slows session startup.
// This command computes a per-agent plugin subset from a role-driven map
// and writes a *minimal* `.claude/settings.json` into each agent's working
// directory (= the daemon-spawn CWD), so Claude's settings-resolution chain
// picks up the scoped override before walking up to the user file.
//
// Idempotent: re-running produces byte-identical output when the inputs
// haven't changed (output keys are sorted, all known plugins emitted).
//
// Flow
//   1. Read `/Users/hari/cortextos/agents.yaml` for the agent → role map.
//   2. Read `~/.claude/settings.json` for the master `enabledPlugins` keys.
//   3. For each agent, compute role → allowed-plugin-name subset, then
//      filter the master keys to that subset (keys not in master are
//      silently dropped — protects against drift in the role map).
//   4. Emit `{"enabledPlugins": {plugin: true}}` into the per-agent
//      `.claude/settings.json`. In `--dry-run` print a per-agent diff;
//      in `--apply` actually write.
//
// Why minimal settings (no hooks / permissions copy-through):
//   Claude's settings resolution layers all settings files in order
//   (project → parents → user → enterprise). A small per-agent file with
//   ONLY `enabledPlugins` overrides just that field and inherits hooks /
//   permissions / theme from the user file — which is what every existing
//   agent already does today via the inherited config. Copying the entire
//   user settings into each agent dir would duplicate state and force the
//   operator to re-sync 9 files on every hook change.

import { Command } from 'commander';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';
import { loadAgentsManifest, type AgentManifestEntry } from '../daemon/agents-yaml.js';

/**
 * Role → list of allowed plugin *base names* (without the
 * `@claude-plugins-official` suffix). The actual key in the user's
 * settings.json is e.g. `telegram@claude-plugins-official` — we match by
 * the bare name and emit the full key. This insulates the role map from
 * marketplace-suffix churn.
 *
 * Roles not in this table get an empty plugin set (= every plugin disabled).
 * That's the safe default — operators add coverage when a new role appears
 * rather than silently inheriting a kitchen-sink default that defeats the
 * point of scoping.
 */
export const ROLE_PLUGIN_MAP: Record<string, readonly string[]> = {
  telegram_orchestrator: [
    'telegram',
    'fakechat',
    'imessage',
    'fewer-permission-prompts',
    'simplify',
  ],
  // chief is an `orchestrator` in agents.yaml but functions as a
  // telegram_orchestrator on the Mac mini side — same comms surface, same
  // tooling. Map it to the same role so its scope matches sam's.
  orchestrator: [
    'telegram',
    'fakechat',
    'imessage',
    'fewer-permission-prompts',
    'simplify',
  ],
  personal_assistant: [
    'telegram',
    'imessage',
    'fakechat',
  ],
  builder: [
    'chrome-devtools-mcp',
    'microsoft-docs',
    'claude-api',
    'pinecone',
    'mongodb',
    'expo',
  ],
  code_writer: [
    'chrome-devtools-mcp',
    'microsoft-docs',
    'claude-api',
    'code-review',
    'commit-commands',
    'hookify',
  ],
  data_analyst: [
    'pinecone',
    'mongodb',
    'data-agent-kit-starter-pack',
    'alloydb',
    'cloud-sql-postgresql',
  ],
  researcher_claude: [
    'context7',
    'microsoft-docs',
    'firecrawl',
    'huggingface-skills',
  ],
  researcher_codex: [
    'context7',
    'microsoft-docs',
    'firecrawl',
    'huggingface-skills',
  ],
  research_lead: [
    'context7',
    'microsoft-docs',
    'firecrawl',
    'huggingface-skills',
  ],
  host_guardian: [
    'fewer-permission-prompts',
    'simplify',
    'hookify',
  ],
};

/**
 * Compute the per-agent `enabledPlugins` object.
 *
 * Output shape exactly matches the user-level settings.json:
 * `{ "plugin-name@suffix": true, ... }`. Plugins not in the role's allowed
 * list are OMITTED (not set to false) — Claude treats absent keys as
 * "respect the parent file's value", but because we always emit a complete
 * fixed set (one entry per master-file key, true xor false), we get
 * deterministic disable behaviour without depending on Claude's merge order.
 *
 * Returns an entries object with keys in sorted order so diffs/idempotency
 * checks are stable.
 */
export function computeEnabledPluginsForRole(
  role: string | undefined,
  masterKeys: string[],
): Record<string, boolean> {
  const allowedBases = role && ROLE_PLUGIN_MAP[role]
    ? new Set(ROLE_PLUGIN_MAP[role])
    : new Set<string>();

  const out: Record<string, boolean> = {};
  // Sort to make idempotent: same input → byte-identical output.
  const sortedKeys = [...masterKeys].sort();
  for (const fullKey of sortedKeys) {
    // Strip `@marketplace` suffix — split on first `@` (plugin names don't
    // contain `@` themselves in the official marketplace).
    const base = fullKey.split('@')[0];
    out[fullKey] = allowedBases.has(base);
  }
  return out;
}

/**
 * Serialize the per-agent settings.json content. Stable JSON (sorted keys
 * by virtue of `computeEnabledPluginsForRole`) so re-runs without input
 * changes produce identical bytes.
 */
export function renderAgentSettings(enabledPlugins: Record<string, boolean>): string {
  return JSON.stringify({ enabledPlugins }, null, 2);
}

/** Read master enabledPlugins keys from the user-level settings.json. */
function loadMasterPluginKeys(userSettingsPath: string): string[] {
  if (!existsSync(userSettingsPath)) {
    throw new Error(`User settings.json not found at ${userSettingsPath}`);
  }
  const raw = readFileSync(userSettingsPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`User settings.json at ${userSettingsPath} is not valid JSON: ${(err as Error).message}`);
  }
  const settings = parsed as { enabledPlugins?: Record<string, boolean> };
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    throw new Error(`User settings.json has no enabledPlugins map`);
  }
  return Object.keys(settings.enabledPlugins);
}

/**
 * Diff for dry-run display. Returns a list of `+plugin` / `-plugin` /
 * `=plugin` lines comparing existing vs proposed enabledPlugins. Plugins
 * that don't change state (true→true or false→false) are summarised as a
 * single count line so the operator can scan a 60-plugin diff at a glance.
 */
export function diffEnabledPlugins(
  existing: Record<string, boolean> | undefined,
  proposed: Record<string, boolean>,
): { changed: string[]; unchangedCount: number } {
  const existingMap = existing ?? {};
  const changed: string[] = [];
  let unchangedCount = 0;
  const allKeys = new Set([...Object.keys(existingMap), ...Object.keys(proposed)]);
  for (const key of [...allKeys].sort()) {
    const before = existingMap[key];
    const after = proposed[key];
    if (before === after) {
      unchangedCount++;
    } else if (after === true) {
      changed.push(`  +${key}`);
    } else if (after === false && before === true) {
      changed.push(`  -${key}`);
    } else if (after === false) {
      // Was undefined / not in existing — net new disable. Mark distinctly.
      changed.push(`  -${key}  (newly tracked)`);
    } else if (after === undefined) {
      changed.push(`  ?${key}  (in existing but not proposed)`);
    }
  }
  return { changed, unchangedCount };
}

/**
 * Compute target settings.json path for one agent: respects manifest's
 * `org` field, falling back to subbu-ops (the only org in the fleet today).
 */
function agentSettingsPath(frameworkRoot: string, agentName: string, entry: AgentManifestEntry): string {
  const org = entry.org ?? 'subbu-ops';
  return join(frameworkRoot, 'orgs', org, 'agents', agentName, '.claude', 'settings.json');
}

/** Read existing settings.json (if present) — returns null on missing or invalid. */
function readExistingSettings(path: string): { enabledPlugins?: Record<string, boolean> } | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export interface ScopePluginsOptions {
  apply?: boolean;
  dryRun?: boolean;
  /** Override for tests / scripts; defaults to CTX_FRAMEWORK_ROOT env or ~/cortextos */
  frameworkRoot?: string;
  /** Override for tests; defaults to `~/.claude/settings.json` */
  userSettingsPath?: string;
}

interface ScopeRun {
  agentName: string;
  role?: string;
  org: string;
  settingsPath: string;
  proposed: Record<string, boolean>;
  diff: { changed: string[]; unchangedCount: number };
  /** True if the new file equals the existing one — nothing to do. */
  noChange: boolean;
}

/**
 * Main entry — exported so the test suite can drive it without parsing argv.
 * Returns the planned per-agent runs (useful for test assertions); caller
 * decides whether to write.
 */
export function planScopePlugins(opts: ScopePluginsOptions = {}): ScopeRun[] {
  const frameworkRoot = opts.frameworkRoot
    ?? process.env.CTX_FRAMEWORK_ROOT
    ?? join(homedir(), 'cortextos');
  const userSettingsPath = opts.userSettingsPath
    ?? join(homedir(), '.claude', 'settings.json');

  const manifest = loadAgentsManifest(frameworkRoot);
  if (!manifest) {
    throw new Error(`Could not load agents.yaml from ${frameworkRoot}`);
  }
  const masterKeys = loadMasterPluginKeys(userSettingsPath);

  const runs: ScopeRun[] = [];
  for (const [agentName, entry] of Object.entries(manifest.agents)) {
    const role = entry.role;
    const proposed = computeEnabledPluginsForRole(role, masterKeys);
    const settingsPath = agentSettingsPath(frameworkRoot, agentName, entry);
    const existing = readExistingSettings(settingsPath);
    const diff = diffEnabledPlugins(existing?.enabledPlugins, proposed);
    const proposedSerialized = renderAgentSettings(proposed);
    const existingSerialized = existing
      ? renderAgentSettings(existing.enabledPlugins ?? {})
      : null;
    const noChange = existingSerialized === proposedSerialized;
    runs.push({
      agentName,
      role,
      org: entry.org ?? 'subbu-ops',
      settingsPath,
      proposed,
      diff,
      noChange,
    });
  }
  return runs;
}

/** Apply a planned run to disk (atomic write). */
export function applyScopeRun(run: ScopeRun): void {
  mkdirSync(join(run.settingsPath, '..'), { recursive: true });
  atomicWriteSync(run.settingsPath, renderAgentSettings(run.proposed));
}

export const scopePluginsCommand = new Command('scope-plugins')
  .description('Compute and write per-agent enabledPlugins overrides (default: dry-run).')
  .option('--apply', 'Write settings.json files for each agent')
  .option('--dry-run', 'Show per-agent diff without writing (default)')
  .action((options: { apply?: boolean; dryRun?: boolean }) => {
    // Default: dry-run. --apply is the only way to actually write.
    const apply = options.apply === true;

    let runs: ScopeRun[];
    try {
      runs = planScopePlugins();
    } catch (err) {
      console.error(`scope-plugins: ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    let wroteAny = false;
    for (const run of runs) {
      const header = `\n${run.agentName} (role=${run.role ?? 'UNKNOWN'}, org=${run.org})`;
      console.log(header);
      console.log(`  target: ${run.settingsPath}`);
      if (run.noChange) {
        console.log(`  no change — already scoped`);
        continue;
      }
      if (run.diff.changed.length === 0 && run.diff.unchangedCount > 0) {
        console.log(`  (no plugin-state changes; file content differs)`);
      } else {
        for (const line of run.diff.changed) console.log(line);
      }
      console.log(`  unchanged plugins: ${run.diff.unchangedCount}`);
      if (apply) {
        applyScopeRun(run);
        wroteAny = true;
        console.log(`  wrote ${run.settingsPath}`);
      }
    }

    if (!apply) {
      console.log(`\ndry-run only — re-run with --apply to write changes.`);
    } else if (wroteAny) {
      console.log(
        `\nReload affected agents to pick up new plugin scope: ` +
        `\`cortextos restart <name>\` or \`pm2 reload ecosystem.config.js\`.`
      );
    } else {
      console.log(`\nNo files needed updating.`);
    }
  });
