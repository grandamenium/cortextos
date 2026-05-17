/**
 * Task #57 — Per-agent enabledPlugins scoping (Wave-1 substrate).
 *
 * Covers:
 *   (a) ROLE_PLUGIN_MAP -> computeEnabledPluginsForRole produces the right
 *       allow/deny pattern for every role in agents.yaml.
 *   (b) renderAgentSettings + planScopePlugins are byte-idempotent — running
 *       twice without input changes produces identical disk content.
 *
 * Strategy: drive `planScopePlugins` with synthetic frameworkRoot + user
 * settings paths so we don't touch the real fleet during tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ROLE_PLUGIN_MAP,
  computeEnabledPluginsForRole,
  renderAgentSettings,
  planScopePlugins,
  applyScopeRun,
} from '../../../src/cli/scope-plugins';

const MASTER_KEYS = [
  'telegram@claude-plugins-official',
  'fakechat@claude-plugins-official',
  'imessage@claude-plugins-official',
  'fewer-permission-prompts@claude-plugins-official',
  'simplify@claude-plugins-official',
  'chrome-devtools-mcp@claude-plugins-official',
  'microsoft-docs@claude-plugins-official',
  'claude-api@claude-plugins-official',
  'pinecone@claude-plugins-official',
  'mongodb@claude-plugins-official',
  'expo@claude-plugins-official',
  'code-review@claude-plugins-official',
  'commit-commands@claude-plugins-official',
  'hookify@claude-plugins-official',
  'data-agent-kit-starter-pack@claude-plugins-official',
  'alloydb@claude-plugins-official',
  'cloud-sql-postgresql@claude-plugins-official',
  'context7@claude-plugins-official',
  'firecrawl@claude-plugins-official',
  'huggingface-skills@claude-plugins-official',
  // Plugins that no role uses — must end up false everywhere.
  'serena@claude-plugins-official',
  'kotlin-lsp@claude-plugins-official',
];

describe('Task #57: computeEnabledPluginsForRole', () => {
  it('telegram_orchestrator enables telegram/fakechat/imessage/fewer-permission-prompts/simplify only', () => {
    const out = computeEnabledPluginsForRole('telegram_orchestrator', MASTER_KEYS);
    expect(out['telegram@claude-plugins-official']).toBe(true);
    expect(out['fakechat@claude-plugins-official']).toBe(true);
    expect(out['imessage@claude-plugins-official']).toBe(true);
    expect(out['fewer-permission-prompts@claude-plugins-official']).toBe(true);
    expect(out['simplify@claude-plugins-official']).toBe(true);
    // Non-role plugins must be false.
    expect(out['chrome-devtools-mcp@claude-plugins-official']).toBe(false);
    expect(out['mongodb@claude-plugins-official']).toBe(false);
    expect(out['serena@claude-plugins-official']).toBe(false);
  });

  it('orchestrator (chief) shares telegram_orchestrator scope', () => {
    const chief = computeEnabledPluginsForRole('orchestrator', MASTER_KEYS);
    const sam = computeEnabledPluginsForRole('telegram_orchestrator', MASTER_KEYS);
    expect(chief).toEqual(sam);
  });

  it('personal_assistant gets telegram/imessage/fakechat', () => {
    const out = computeEnabledPluginsForRole('personal_assistant', MASTER_KEYS);
    expect(out['telegram@claude-plugins-official']).toBe(true);
    expect(out['imessage@claude-plugins-official']).toBe(true);
    expect(out['fakechat@claude-plugins-official']).toBe(true);
    // No simplify / fewer-permission-prompts for PA — that's an orchestrator perk.
    expect(out['simplify@claude-plugins-official']).toBe(false);
    expect(out['chrome-devtools-mcp@claude-plugins-official']).toBe(false);
  });

  it('builder gets the build-stack plugins, no comms', () => {
    const out = computeEnabledPluginsForRole('builder', MASTER_KEYS);
    for (const p of ['chrome-devtools-mcp', 'microsoft-docs', 'claude-api', 'pinecone', 'mongodb', 'expo']) {
      expect(out[`${p}@claude-plugins-official`]).toBe(true);
    }
    // No telegram/fakechat/imessage for forge.
    expect(out['telegram@claude-plugins-official']).toBe(false);
    expect(out['fakechat@claude-plugins-official']).toBe(false);
    expect(out['imessage@claude-plugins-official']).toBe(false);
  });

  it('code_writer (dev) gets dev-stack plugins', () => {
    const out = computeEnabledPluginsForRole('code_writer', MASTER_KEYS);
    for (const p of ['chrome-devtools-mcp', 'microsoft-docs', 'claude-api', 'code-review', 'commit-commands', 'hookify']) {
      expect(out[`${p}@claude-plugins-official`]).toBe(true);
    }
    expect(out['telegram@claude-plugins-official']).toBe(false);
  });

  it('data_analyst gets DB / data plugins', () => {
    const out = computeEnabledPluginsForRole('data_analyst', MASTER_KEYS);
    for (const p of ['pinecone', 'mongodb', 'data-agent-kit-starter-pack', 'alloydb', 'cloud-sql-postgresql']) {
      expect(out[`${p}@claude-plugins-official`]).toBe(true);
    }
    expect(out['telegram@claude-plugins-official']).toBe(false);
  });

  it.each(['researcher_claude', 'researcher_codex', 'research_lead'])(
    '%s gets research plugins',
    (role) => {
      const out = computeEnabledPluginsForRole(role, MASTER_KEYS);
      for (const p of ['context7', 'microsoft-docs', 'firecrawl', 'huggingface-skills']) {
        expect(out[`${p}@claude-plugins-official`]).toBe(true);
      }
      expect(out['telegram@claude-plugins-official']).toBe(false);
    },
  );

  it('host_guardian (warden) gets only meta-tooling', () => {
    const out = computeEnabledPluginsForRole('host_guardian', MASTER_KEYS);
    for (const p of ['fewer-permission-prompts', 'simplify', 'hookify']) {
      expect(out[`${p}@claude-plugins-official`]).toBe(true);
    }
    expect(out['telegram@claude-plugins-official']).toBe(false);
    expect(out['chrome-devtools-mcp@claude-plugins-official']).toBe(false);
  });

  it('unknown role defaults to no plugins enabled', () => {
    const out = computeEnabledPluginsForRole('this_role_does_not_exist', MASTER_KEYS);
    for (const key of MASTER_KEYS) {
      expect(out[key]).toBe(false);
    }
  });

  it('undefined role defaults to no plugins enabled', () => {
    const out = computeEnabledPluginsForRole(undefined, MASTER_KEYS);
    for (const key of MASTER_KEYS) {
      expect(out[key]).toBe(false);
    }
  });

  it('output keys are sorted (byte-idempotency precondition)', () => {
    const out = computeEnabledPluginsForRole('builder', MASTER_KEYS);
    const keys = Object.keys(out);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('renderAgentSettings produces stable JSON for the same input', () => {
    const out = computeEnabledPluginsForRole('builder', MASTER_KEYS);
    const a = renderAgentSettings(out);
    const b = renderAgentSettings(out);
    expect(a).toBe(b);
    // Sanity: it's valid JSON that round-trips.
    const parsed = JSON.parse(a);
    expect(parsed).toHaveProperty('enabledPlugins');
    expect(parsed.enabledPlugins).toEqual(out);
  });

  it('ROLE_PLUGIN_MAP covers every role present in the real agents.yaml', () => {
    // Belt-and-suspenders: catches the case where someone adds a new role to
    // agents.yaml but forgets to extend ROLE_PLUGIN_MAP. Test data list mirrors
    // the role values in /Users/hari/cortextos/agents.yaml at task time.
    const realRoles = [
      'telegram_orchestrator',
      'personal_assistant',
      'host_guardian',
      'orchestrator',
      'builder',
      'data_analyst',
      'code_writer',
      'researcher_claude',
      'researcher_codex',
      'research_lead',
    ];
    for (const role of realRoles) {
      expect(Object.keys(ROLE_PLUGIN_MAP)).toContain(role);
    }
  });
});

describe('Task #57: planScopePlugins / applyScopeRun — idempotent write', () => {
  let tmpRoot: string;
  let frameworkRoot: string;
  let userSettingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scope-plugins-'));
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(frameworkRoot, { recursive: true });

    // Minimal agents.yaml — only the parser-recognised fields, in the
    // exact shape parseAgentsYaml expects (2-space indent, agent map under
    // `agents:` at indent 0).
    const agentsYaml = [
      'version: 1',
      'agents:',
      '  sam:',
      '    host: macbook',
      '    org: subbu-ops',
      '    role: telegram_orchestrator',
      '  forge:',
      '    host: mac_mini',
      '    org: subbu-ops',
      '    role: builder',
      '  warden-mb:',
      '    host: macbook',
      '    org: subbu-ops',
      '    role: host_guardian',
      '',
    ].join('\n');
    writeFileSync(join(frameworkRoot, 'agents.yaml'), agentsYaml, 'utf-8');

    // Synthetic user settings.json with a known plugin set.
    const userClaudeDir = join(tmpRoot, '.claude');
    mkdirSync(userClaudeDir, { recursive: true });
    userSettingsPath = join(userClaudeDir, 'settings.json');
    writeFileSync(
      userSettingsPath,
      JSON.stringify({
        enabledPlugins: Object.fromEntries(MASTER_KEYS.map(k => [k, true])),
      }, null, 2),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('plan produces one run per agent in the manifest', () => {
    const runs = planScopePlugins({ frameworkRoot, userSettingsPath });
    expect(runs.map(r => r.agentName).sort()).toEqual(['forge', 'sam', 'warden-mb']);
  });

  it('plan writes ONLY enabledPlugins to the agent settings.json', () => {
    const runs = planScopePlugins({ frameworkRoot, userSettingsPath });
    const samRun = runs.find(r => r.agentName === 'sam')!;
    expect(samRun.settingsPath).toBe(
      join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam', '.claude', 'settings.json')
    );
    applyScopeRun(samRun);
    const written = JSON.parse(readFileSync(samRun.settingsPath, 'utf-8'));
    // Top-level shape — ONLY enabledPlugins, no hooks/permissions/theme.
    expect(Object.keys(written)).toEqual(['enabledPlugins']);
    // Sam (telegram_orchestrator) MUST have telegram enabled.
    expect(written.enabledPlugins['telegram@claude-plugins-official']).toBe(true);
    // Sam MUST NOT have chrome-devtools enabled.
    expect(written.enabledPlugins['chrome-devtools-mcp@claude-plugins-official']).toBe(false);
  });

  it('re-running planScopePlugins after applying once is a no-op (idempotent bytes)', () => {
    // First pass — apply all runs to disk.
    const firstRuns = planScopePlugins({ frameworkRoot, userSettingsPath });
    for (const run of firstRuns) applyScopeRun(run);

    // Snapshot bytes after first apply.
    const snapshots: Record<string, string> = {};
    for (const run of firstRuns) {
      snapshots[run.agentName] = readFileSync(run.settingsPath, 'utf-8');
    }

    // Second plan — every run should report noChange === true.
    const secondRuns = planScopePlugins({ frameworkRoot, userSettingsPath });
    for (const run of secondRuns) {
      expect(run.noChange).toBe(true);
    }

    // Bytes haven't drifted (applying a second time would also be a no-op).
    for (const run of secondRuns) applyScopeRun(run);
    for (const run of secondRuns) {
      expect(readFileSync(run.settingsPath, 'utf-8')).toBe(snapshots[run.agentName]);
    }
  });

  it('forge (builder) gets no comms plugins', () => {
    const runs = planScopePlugins({ frameworkRoot, userSettingsPath });
    const forgeRun = runs.find(r => r.agentName === 'forge')!;
    applyScopeRun(forgeRun);
    const written = JSON.parse(readFileSync(forgeRun.settingsPath, 'utf-8'));
    expect(written.enabledPlugins['telegram@claude-plugins-official']).toBe(false);
    expect(written.enabledPlugins['fakechat@claude-plugins-official']).toBe(false);
    expect(written.enabledPlugins['imessage@claude-plugins-official']).toBe(false);
    expect(written.enabledPlugins['chrome-devtools-mcp@claude-plugins-official']).toBe(true);
  });

  it('warden-mb (host_guardian) gets minimal scope (no comms, no DB, no build)', () => {
    const runs = planScopePlugins({ frameworkRoot, userSettingsPath });
    const wardenRun = runs.find(r => r.agentName === 'warden-mb')!;
    applyScopeRun(wardenRun);
    const written = JSON.parse(readFileSync(wardenRun.settingsPath, 'utf-8'));
    expect(written.enabledPlugins['fewer-permission-prompts@claude-plugins-official']).toBe(true);
    expect(written.enabledPlugins['simplify@claude-plugins-official']).toBe(true);
    expect(written.enabledPlugins['hookify@claude-plugins-official']).toBe(true);
    expect(written.enabledPlugins['telegram@claude-plugins-official']).toBe(false);
    expect(written.enabledPlugins['mongodb@claude-plugins-official']).toBe(false);
  });

  it('first apply against an unscoped agent dir creates the .claude directory and file', () => {
    const runs = planScopePlugins({ frameworkRoot, userSettingsPath });
    const samRun = runs.find(r => r.agentName === 'sam')!;
    // Pre-condition: .claude dir doesn't exist for sam in our tmp framework.
    expect(existsSync(samRun.settingsPath)).toBe(false);
    applyScopeRun(samRun);
    expect(existsSync(samRun.settingsPath)).toBe(true);
  });
});
