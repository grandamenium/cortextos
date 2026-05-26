#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_WARN = 0.80;
const DEFAULT_CRITICAL = 0.92;

function usage() {
  console.error(`Usage: provider-failover-policy-check.mjs --agent-config <path> [--ctx-root <path>] [--warn <0-1>] [--critical <0-1>] [--json]`);
}

function parseArgs(argv) {
  const args = {
    ctxRoot: process.env.CTX_ROOT || join(homedir(), '.cortextos', process.env.CTX_INSTANCE_ID || 'default'),
    warn: DEFAULT_WARN,
    critical: DEFAULT_CRITICAL,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent-config') args.agentConfig = argv[++i];
    else if (arg === '--ctx-root') args.ctxRoot = argv[++i];
    else if (arg === '--warn') args.warn = Number(argv[++i]);
    else if (arg === '--critical') args.critical = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.agentConfig) throw new Error('--agent-config is required');
  if (!Number.isFinite(args.warn) || args.warn <= 0 || args.warn >= 1) throw new Error('--warn must be between 0 and 1');
  if (!Number.isFinite(args.critical) || args.critical <= args.warn || args.critical > 1) {
    throw new Error('--critical must be greater than --warn and <= 1');
  }
  return args;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { error: `invalid json: ${err.message}` };
  }
}

function expandHome(path) {
  if (!path) return path;
  return path === '~' ? homedir() : path.replace(/^~(?=\/)/, homedir());
}

function normalizeCodexPool(config, ctxRoot, agentName) {
  const configured = Array.isArray(config.codex_account_pool) ? config.codex_account_pool : [];
  const statePath = join(ctxRoot, 'state', agentName, 'codex-account-pool-state.json');
  const state = readJson(statePath, { accounts: [] });
  const stateAccounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const unhealthyByLabel = new Map(stateAccounts.map((entry) => [entry.label, entry]));
  const now = Date.now();

  const accounts = configured
    .map((entry, index) => {
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const codexHome = typeof entry.codex_home === 'string' ? expandHome(entry.codex_home.trim()) : '';
      if (!label || !codexHome) return null;
      const health = unhealthyByLabel.get(label) || {};
      const unhealthyUntilMs = health.unhealthyUntil ? Date.parse(health.unhealthyUntil) : 0;
      return {
        label,
        priority: Number.isFinite(entry.priority) ? Number(entry.priority) : index + 1,
        workspace: entry.workspace || null,
        email: entry.email || null,
        codex_home_configured: Boolean(codexHome),
        codex_home_exists: existsSync(codexHome),
        status: unhealthyUntilMs > now ? 'unhealthy' : 'available',
        unhealthy_until: unhealthyUntilMs > now ? health.unhealthyUntil : null,
        failure_class: unhealthyUntilMs > now ? health.failureClass || null : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);

  return {
    configured: accounts.length > 0,
    state_path: statePath,
    active_label: state?.activeLabel || null,
    accounts,
    next_available_label: accounts.find((account) => account.status === 'available' && account.codex_home_exists)?.label || null,
  };
}

function runCommand(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 10000,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.stderr?.toString()?.trim() || err.message,
    };
  }
}

function readClaudeUsage() {
  const busUsage = runCommand('cortextos', ['bus', 'check-usage-api', '--json']);
  if (busUsage.ok) {
    try {
      const parsed = JSON.parse(busUsage.stdout);
      const fiveHour = parsed.five_hour?.utilization ?? parsed.five_hour_utilization ?? null;
      const sevenDay = parsed.seven_day?.utilization ?? parsed.seven_day_utilization ?? null;
      return {
        source: 'cortextos bus check-usage-api',
        available: true,
        five_hour_utilization: typeof fiveHour === 'number' ? fiveHour : null,
        five_hour_resets_at: parsed.five_hour?.resets_at || null,
        seven_day_utilization: typeof sevenDay === 'number' ? sevenDay : null,
        seven_day_resets_at: parsed.seven_day?.resets_at || null,
      };
    } catch (err) {
      return { source: 'cortextos bus check-usage-api', available: false, error: `invalid json: ${err.message}` };
    }
  }

  const ccusage = runCommand('ccusage', ['blocks', '--json']);
  if (!ccusage.ok) {
    return {
      source: 'none',
      available: false,
      error: busUsage.error || ccusage.error || 'Claude usage telemetry unavailable',
    };
  }
  try {
    const parsed = JSON.parse(ccusage.stdout);
    const active = Array.isArray(parsed.blocks) ? parsed.blocks.find((block) => block.isActive) : null;
    return {
      source: 'ccusage blocks --json',
      available: true,
      five_hour_utilization: null,
      five_hour_resets_at: active?.endTime || null,
      seven_day_utilization: null,
      seven_day_resets_at: null,
      active_block_cost_usd: active?.costUSD ?? null,
      active_block_projected_cost_usd: active?.projection?.totalCost ?? null,
    };
  } catch (err) {
    return { source: 'ccusage blocks --json', available: false, error: `invalid json: ${err.message}` };
  }
}

function classifyUtilization(value, warn, critical) {
  if (typeof value !== 'number') return 'unknown';
  if (value >= critical) return 'critical';
  if (value >= warn) return 'warn';
  return 'ok';
}

function buildDecision(codex, claude, warn, critical) {
  const codexAvailable = codex.accounts.filter((account) => account.status === 'available' && account.codex_home_exists);
  const codexMissingHomes = codex.accounts.filter((account) => !account.codex_home_exists);
  const fiveHour = classifyUtilization(claude.five_hour_utilization, warn, critical);
  const sevenDay = classifyUtilization(claude.seven_day_utilization, warn, critical);
  const material = [];

  if (!codex.configured) material.push('Codex account pool is not configured.');
  if (codex.configured && codexAvailable.length === 0) material.push('No healthy Codex account home is available.');
  if (codexMissingHomes.length > 0) material.push(`Codex account homes missing: ${codexMissingHomes.map((a) => a.label).join(', ')}.`);
  if (!claude.available) material.push(`Claude usage telemetry unavailable: ${claude.error || 'unknown error'}.`);
  if (fiveHour === 'critical') material.push(`Claude five-hour usage is at or above ${Math.round(critical * 100)}%.`);
  if (sevenDay === 'critical') material.push(`Claude seven-day usage is at or above ${Math.round(critical * 100)}%.`);

  const warnings = [];
  if (fiveHour === 'warn') warnings.push(`Claude five-hour usage is at or above ${Math.round(warn * 100)}%.`);
  if (sevenDay === 'warn') warnings.push(`Claude seven-day usage is at or above ${Math.round(warn * 100)}%.`);

  return {
    status: material.length > 0 ? 'material_action_or_blocker' : warnings.length > 0 ? 'warn' : 'ok',
    material_reasons: material,
    warning_reasons: warnings,
    allowed_actions: [
      'Codex: runtime may rotate to next configured healthy CODEX_HOME on auth/quota failures and replay the preserved turn once.',
      'Claude: warn/pause/reroute non-critical Claude lanes before hard limits; do not mutate Anthropic accounts, billing, plans, or secrets without approval.',
      'Both: preserve cwd/project identity and permissions; if the fallback lacks project access, block and alert with owner/next action.',
    ],
    rollback: [
      'Codex: remove codex_account_pool from the agent config or clear the account health state file to return to primary-only selection.',
      'Claude: disable any cron invoking this checker or quota-watchdog; resume paused agents only after utilization resets above the resume threshold.',
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.agentConfig);
  const config = readJson(configPath);
  if (!config || config.error) throw new Error(`Cannot read agent config: ${config?.error || configPath}`);
  const agentName = config.name || config.agent || configPath.split('/').slice(-2, -1)[0] || 'orchestrator';
  const ctxRoot = resolve(expandHome(args.ctxRoot));

  const codex = normalizeCodexPool(config, ctxRoot, agentName);
  const claude = readClaudeUsage();
  const decision = buildDecision(codex, claude, args.warn, args.critical);
  const result = {
    generated_at: new Date().toISOString(),
    policy_version: '2026-05-25',
    thresholds: { warn: args.warn, critical: args.critical, resume: 0.50 },
    agent: agentName,
    codex,
    claude,
    decision,
    telegram_alert_text: decision.status === 'ok'
      ? null
      : `Provider failover policy ${decision.status}: ${[...decision.material_reasons, ...decision.warning_reasons].join(' ')} Next: keep front door on healthy Codex pool, pause/reroute non-critical Claude lanes if needed, and escalate before billing/plan/secret/provider-account changes.`,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`provider-failover-policy: ${result.decision.status}`);
    for (const reason of result.decision.material_reasons) console.log(`BLOCKER: ${reason}`);
    for (const reason of result.decision.warning_reasons) console.log(`WARN: ${reason}`);
    console.log(`Codex next account: ${result.codex.next_available_label || 'none'}`);
    console.log(`Claude telemetry: ${result.claude.available ? result.claude.source : `unavailable (${result.claude.error})`}`);
  }

  process.exit(decision.status === 'material_action_or_blocker' ? 2 : 0);
}

try {
  main();
} catch (err) {
  console.error(`provider-failover-policy-check: ${err.message}`);
  process.exit(1);
}
