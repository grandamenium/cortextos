import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      vars[key] = val;
    }
  } catch { /* unreadable */ }
  return vars;
}

function getEnabledAgentsPath(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'config', 'enabled-agents.json');
}

function readEnabledAgents(instanceId: string): Record<string, any> {
  const path = getEnabledAgentsPath(instanceId);
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * BUG-036 fix: write a `.user-disable` marker before the agent's PTY is killed,
 * so the SessionEnd crash-alert hook (src/hooks/hook-crash-alert.ts) knows the
 * disable was intentional and does not fire a false 🚨 CRASH alarm.
 * Pattern matches src/cli/bus.ts:1285-1289.
 */
export function writeDisableMarker(instanceId: string, agent: string, reason: string): void {
  try {
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const stateDir = join(ctxRoot, 'state', agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-disable'), reason);
  } catch { /* don't block disable on marker-write failure */ }
}

function writeEnabledAgents(instanceId: string, agents: Record<string, any>): void {
  const path = getEnabledAgentsPath(instanceId);
  const dir = join(homedir(), '.cortextos', instanceId, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(agents, null, 2) + '\n', 'utf-8');
}

export const enableAgentCommand = new Command('enable')
  .argument('<agent>', 'Agent name to enable')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <org>', 'Organization name')
  .description('Enable an agent (register and start)')
  .action(async (agent: string, options: { instance: string; org?: string }) => {
    // Becky bug preflight: verify .env has BOT_TOKEN and CHAT_ID before registering.
    // Without this, the agent starts, inherits parent-process credentials silently,
    // appears alive on the dashboard but cannot receive any Telegram messages.
    const projectRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();

    // Auto-detect org if not specified by scanning orgs/ for this agent
    if (!options.org) {
      const orgsDir = join(projectRoot, 'orgs');
      if (existsSync(orgsDir)) {
        try {
          const { readdirSync } = require('fs');
          const orgs = readdirSync(orgsDir, { withFileTypes: true })
            .filter((d: any) => d.isDirectory())
            .map((d: any) => d.name);
          for (const o of orgs) {
            if (existsSync(join(orgsDir, o, 'agents', agent))) {
              options.org = o;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    }

    const orgDir = options.org ? join(projectRoot, 'orgs', options.org) : null;

    // Locate agent dir — try org-scoped path first, then flat agents/ fallback
    let agentEnvPath: string | null = null;
    if (orgDir) {
      const candidate = join(orgDir, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }
    if (!agentEnvPath) {
      const candidate = join(projectRoot, 'agents', agent, '.env');
      if (existsSync(candidate)) agentEnvPath = candidate;
    }

    if (!agentEnvPath) {
      console.error(`Error: No .env found for agent "${agent}". Create one with BOT_TOKEN and CHAT_ID before enabling.`);
      process.exit(1);
    }

    const env = parseEnvFile(agentEnvPath);
    const missing = (['BOT_TOKEN', 'CHAT_ID'] as const).filter(k => !env[k]);
    if (missing.length > 0) {
      console.error(`Error: .env for agent "${agent}" is missing required values: ${missing.join(', ')}`);
      console.error(`Edit ${agentEnvPath} and set BOT_TOKEN and CHAT_ID before enabling.`);
      process.exit(1);
    }

    const agents = readEnabledAgents(options.instance);
    agents[agent] = {
      enabled: true,
      status: 'configured',
      ...(options.org ? { org: options.org } : {}),
    };
    writeEnabledAgents(options.instance, agents);

    // Create per-agent state directories
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    const agentDirs = [
      join(ctxRoot, 'inbox', agent),
      join(ctxRoot, 'inflight', agent),
      join(ctxRoot, 'processed', agent),
      join(ctxRoot, 'outbox', agent),
      join(ctxRoot, 'logs', agent),
      join(ctxRoot, 'state', agent),
    ];
    for (const dir of agentDirs) {
      mkdirSync(dir, { recursive: true });
    }

    console.log(`Agent "${agent}" enabled.`);

    // Try to start via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      const response = await ipc.send({ type: 'start-agent', agent });
      if (response.success) {
        console.log(`  Started via daemon: ${response.data}`);
      }
    } else {
      console.log('  Daemon not running. Start with: cortextos start');
    }
  });

export const disableAgentCommand = new Command('disable')
  .argument('<agent>', 'Agent name to disable')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Disable an agent (stop and deregister)')
  .action(async (agent: string, options: { instance: string }) => {
    const agents = readEnabledAgents(options.instance);
    if (agents[agent]) {
      agents[agent].enabled = false;
    }
    writeEnabledAgents(options.instance, agents);

    // Try to stop via daemon IPC
    const ipc = new IPCClient(options.instance);
    const running = await ipc.isDaemonRunning();
    if (running) {
      // BUG-036 fix: write .user-disable marker BEFORE the stop, so the
      // SessionEnd crash-alert hook in src/hooks/hook-crash-alert.ts knows
      // this was an intentional disable and not a crash. Without this,
      // the hook defaults to "crash" and the user gets a false 🚨 CRASH alarm.
      // Pattern matches src/cli/bus.ts:1285-1289.
      writeDisableMarker(options.instance, agent, 'disabled via cortextos disable');

      const response = await ipc.send({ type: 'stop-agent', agent });
      if (response.success) {
        console.log(`Agent "${agent}" disabled and stopped.`);
      } else {
        console.log(`Agent "${agent}" disabled. Stop failed: ${response.error}`);
      }
    } else {
      console.log(`Agent "${agent}" disabled.`);
    }
  });
