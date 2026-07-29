import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI, formatValidateError } from '../telegram/api.js';
import { mutateEnabledAgents } from '../utils/enabled-agents.js';

/**
 * BUG-035 fix: discover the cortextOS framework root without depending on
 * `process.cwd()`. Order of precedence:
 *   1. CTX_FRAMEWORK_ROOT env var (explicit, set by ecosystem.config.js)
 *   2. CTX_PROJECT_ROOT env var (legacy alias)
 *   3. ~/cortextos/ (the canonical install location from install.mjs)
 *   4. process.cwd() (last-resort legacy fallback)
 *
 * Without this, `cortextos enable` and similar CLI commands silently fail
 * outside ~/cortextos with a misleading "no .env found" error, even when
 * the .env exists at the canonical location. The error message is then
 * misleading because it doesn't list the paths that were checked.
 */
export function discoverProjectRoot(): string {
  if (process.env.CTX_FRAMEWORK_ROOT) return process.env.CTX_FRAMEWORK_ROOT;
  if (process.env.CTX_PROJECT_ROOT) return process.env.CTX_PROJECT_ROOT;
  // Canonical install location (install.mjs always installs to ~/cortextos)
  const canonical = join(homedir(), 'cortextos');
  if (existsSync(join(canonical, 'orgs')) || existsSync(join(canonical, 'agents'))) {
    return canonical;
  }
  return process.cwd();
}

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

function ctxRootFor(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId);
}

/**
 * Apply `mutate` to the instance registry under the registry lock, and turn any
 * failure into a clean CLI error instead of a raw stack through commander.
 *
 * Replaces the old unlocked `readEnabledAgents()` / `writeEnabledAgents()`
 * pair. BUG-013 gave that pair the right instinct — never destroy a corrupt
 * registry silently, back it up and warn — but it still continued with `{}`
 * and wrote that back, so it was an atomic wipe with a receipt. The shared
 * helper keeps the backup and the warning and then refuses to write at all.
 * That matters more than it looks: a lost registry does not deregister agents
 * (`AgentManager.readInstanceEnableList` treats a missing entry as enabled), it
 * drops the `enabled: false` flags — so the next daemon discovery pass starts
 * every agent the user deliberately disabled.
 */
function updateRegistry(
  instanceId: string,
  agent: string,
  verb: string,
  mutate: (agents: Record<string, any>) => boolean | void,
): void {
  try {
    mutateEnabledAgents(ctxRootFor(instanceId), mutate);
  } catch (err) {
    console.error(`Error: could not ${verb} "${agent}" — the agent registry could not be updated.`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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

export const enableAgentCommand = new Command('enable')
  .argument('<agent>', 'Agent name to enable')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <org>', 'Organization name')
  .description('Enable an agent (register and start)')
  .action(async (agent: string, options: { instance: string; org?: string }) => {
    // Becky bug preflight: verify .env has BOT_TOKEN and CHAT_ID before registering.
    // Without this, the agent starts, inherits parent-process credentials silently,
    // appears alive on the dashboard but cannot receive any Telegram messages.
    const projectRoot = discoverProjectRoot();

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
      // BUG-035 fix: list the paths we actually checked so users can debug
      // path-discovery failures without reading the source code.
      console.error(`Error: No .env found for agent "${agent}". Checked:`);
      if (orgDir) console.error(`  - ${join(orgDir, 'agents', agent, '.env')}`);
      console.error(`  - ${join(projectRoot, 'agents', agent, '.env')}`);
      console.error(`Project root: ${projectRoot}`);
      console.error(`(Set CTX_FRAMEWORK_ROOT to override path discovery, or run from inside ~/cortextos.)`);
      console.error(`Create the .env with BOT_TOKEN and CHAT_ID before enabling.`);
      process.exit(1);
    }

    const env = parseEnvFile(agentEnvPath);
    const missing = (['BOT_TOKEN', 'CHAT_ID'] as const).filter(k => !env[k]);
    if (missing.length > 0) {
      console.error(`Error: .env for agent "${agent}" is missing required values: ${missing.join(', ')}`);
      console.error(`Edit ${agentEnvPath} and set BOT_TOKEN and CHAT_ID before enabling.`);
      process.exit(1);
    }

    // self-chat trap preflight: validate BOT_TOKEN + CHAT_ID against the live
    // Telegram API before registering. Catches bad tokens, unreachable chats,
    // bot-recipient configs, and the self_chat trap (CHAT_ID == bot's own
    // user id) BEFORE the agent boots up on a silently broken config. Without
    // this, the first real sendMessage call fails with a cryptic 401/400/403
    // buried in the agent's stdout log, and the dashboard happily shows the
    // agent as alive.
    //
    // Hard-fails on config-level reasons (bad_token, chat_not_found,
    // bot_recipient, self_chat). Warns but does not block on transient
    // reasons (network_error, rate_limited) so offline enable and burst
    // enables during the morning cascade still succeed.
    try {
      const telegramApi = new TelegramAPI(env.BOT_TOKEN);
      const validation = await telegramApi.validateCredentials(env.CHAT_ID);
      if (validation.ok) {
        const label = validation.chatTitle ? ` (${validation.chatTitle})` : '';
        console.log(
          `Telegram validated: bot=@${validation.botUsername} chat=${env.CHAT_ID} type=${validation.chatType}${label}`,
        );
      } else if (validation.reason === 'network_error' || validation.reason === 'rate_limited') {
        console.error(`Warning: could not verify Telegram credentials (${validation.reason}).`);
        console.error(`  ${formatValidateError(validation)}`);
        console.error('  Continuing anyway — re-run enable after connectivity is restored to confirm.');
      } else {
        console.error(`Error: Telegram credentials for agent "${agent}" failed validation.`);
        console.error(`  ${formatValidateError(validation)}`);
        console.error(`  Edit ${agentEnvPath} and re-run: cortextos enable ${agent}`);
        process.exit(1);
      }
    } catch (err) {
      // Defensive: validateCredentials should never throw, but if it does,
      // fall through with a warning rather than blocking enable on a bug in
      // the validator itself.
      console.error(`Warning: Telegram credential validation crashed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('  Continuing enable. Investigate the validator if this recurs.');
    }

    updateRegistry(options.instance, agent, 'enable', (agents) => {
      agents[agent] = {
        enabled: true,
        status: 'configured',
        ...(options.org ? { org: options.org } : {}),
      };
    });

    // Create per-agent state directories
    const ctxRoot = ctxRootFor(options.instance);
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
      const response = await ipc.send({ type: 'start-agent', agent, source: 'cortextos enable' });
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
    updateRegistry(options.instance, agent, 'disable', (agents) => {
      if (agents[agent]) {
        agents[agent].enabled = false;
      }
    });

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

      const response = await ipc.send({ type: 'stop-agent', agent, source: 'cortextos disable' });
      if (response.success) {
        console.log(`Agent "${agent}" disabled and stopped.`);
      } else {
        console.log(`Agent "${agent}" disabled. Stop failed: ${response.error}`);
      }
    } else {
      console.log(`Agent "${agent}" disabled.`);
    }
  });
