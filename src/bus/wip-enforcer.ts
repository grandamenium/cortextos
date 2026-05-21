/**
 * wip-enforcer — enforce per-agent WIP targets.
 *
 * Runs on a 15-minute cron from the orchestrator's config. Each tick:
 *  - Counts in_progress tasks per assigned_to from the org task store.
 *  - Compares to wip_target (read from
 *    `{ctxRoot}/orgs/{org}/goals.json`, per-agent override or top-level
 *    default; falls back to `DEFAULT_WIP_TARGET` when neither is set).
 *  - For each agent under target: sends a FORCE-SPAWN agent-bus message
 *    instructing them to claim the next approved task.
 *  - Persists a per-agent `ticks_under_target` counter at
 *    `{ctxRoot}/orgs/{org}/wip-enforcer-state.json`. When the counter
 *    reaches `ALERT_TICKS_THRESHOLD`, also pings the configured
 *    Telegram chat (CTX_TELEGRAM_CHAT_ID) so the persistent shortfall
 *    surfaces to the human operator instead of just chattering at the
 *    silent agent.
 *  - Logs a `wip_enforcer_tick` event for every run (severity info)
 *    even when no agent is under target, so the cron's liveness is
 *    visible in the analytics stream.
 *
 * Agents discovered for enforcement = union of agents currently holding
 * any task in the org task dir + any agent named in goals.json `agents`.
 * Agents with `wip_target: 0` are skipped (enforcement disabled).
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import type { BusPaths, Task } from '../types/index.js';
import { sendMessage } from './message.js';
import { logEvent } from './event.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';

const DEFAULT_WIP_TARGET = 3;
const ALERT_TICKS_THRESHOLD = 2;

interface OrgGoalsFile {
  wip_target?: number;
  agents?: Record<string, { wip_target?: number } | undefined>;
}

interface WipEnforcerTickState {
  updated_at: string;
  ticks_under_target: Record<string, number>;
}

export interface WipEnforcerAgentResult {
  agent: string;
  in_progress: number;
  wip_target: number;
  under_target: boolean;
  ticks_under_target: number;
  message_sent: boolean;
  telegram_alerted: boolean;
}

export interface WipEnforcerResult {
  generated_at: string;
  agents: WipEnforcerAgentResult[];
  telegram_chat_id: string | null;
  alert_threshold_ticks: number;
}

export interface WipEnforcerOptions {
  /** Telegram chat id for persistent-shortfall alerts. Defaults to `CTX_TELEGRAM_CHAT_ID`. */
  telegramChatId?: string;
  /** Bot token for Telegram alerts. Defaults to `BOT_TOKEN`. */
  botToken?: string;
  /** Skip agent message + Telegram side effects; still computes counters + state. */
  dryRun?: boolean;
}

function orgRoot(paths: BusPaths): string {
  return dirname(paths.taskDir);
}

function readGoals(paths: BusPaths): OrgGoalsFile {
  const path = join(orgRoot(paths), 'goals.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OrgGoalsFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function wipTargetFor(agent: string, goals: OrgGoalsFile): number {
  const perAgent = goals.agents?.[agent]?.wip_target;
  if (typeof perAgent === 'number' && Number.isFinite(perAgent) && perAgent >= 0) {
    return Math.floor(perAgent);
  }
  if (typeof goals.wip_target === 'number' && Number.isFinite(goals.wip_target) && goals.wip_target >= 0) {
    return Math.floor(goals.wip_target);
  }
  return DEFAULT_WIP_TARGET;
}

function tickStatePath(paths: BusPaths): string {
  return join(orgRoot(paths), 'wip-enforcer-state.json');
}

function readTickState(paths: BusPaths): WipEnforcerTickState {
  const path = tickStatePath(paths);
  if (!existsSync(path)) {
    return { updated_at: new Date(0).toISOString(), ticks_under_target: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WipEnforcerTickState>;
    return {
      updated_at: parsed.updated_at || new Date(0).toISOString(),
      ticks_under_target: { ...(parsed.ticks_under_target || {}) },
    };
  } catch {
    return { updated_at: new Date(0).toISOString(), ticks_under_target: {} };
  }
}

function writeTickState(paths: BusPaths, state: WipEnforcerTickState): void {
  ensureDir(orgRoot(paths));
  atomicWriteSync(tickStatePath(paths), JSON.stringify(state, null, 2));
}

function readInProgressByAgent(paths: BusPaths): Map<string, number> {
  const counts = new Map<string, number>();
  let files: string[];
  try {
    files = readdirSync(paths.taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return counts;
  }

  for (const file of files) {
    try {
      const task: Task = JSON.parse(readFileSync(join(paths.taskDir, file), 'utf-8'));
      if (task.archived) continue;
      if (task.status !== 'in_progress') continue;
      const agent = task.assigned_to;
      if (!agent) continue;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    } catch {
      // Skip corrupt files — the same forgiving behavior as listTasks().
    }
  }
  return counts;
}

function knownAgents(goals: OrgGoalsFile, counts: Map<string, number>): string[] {
  const set = new Set<string>();
  for (const agent of counts.keys()) set.add(agent);
  if (goals.agents) {
    for (const agent of Object.keys(goals.agents)) set.add(agent);
  }
  return Array.from(set).sort();
}

export async function runWipEnforcer(
  paths: BusPaths,
  agentName: string,
  org: string,
  options: WipEnforcerOptions = {},
): Promise<WipEnforcerResult> {
  const generatedAt = new Date().toISOString();
  const goals = readGoals(paths);
  const counts = readInProgressByAgent(paths);
  const tickState = readTickState(paths);

  const nextTickState: WipEnforcerTickState = {
    updated_at: generatedAt,
    ticks_under_target: {},
  };

  const telegramChatId = options.telegramChatId ?? process.env.CTX_TELEGRAM_CHAT_ID ?? '';
  const botToken = options.botToken ?? process.env.BOT_TOKEN ?? '';

  const agents: WipEnforcerAgentResult[] = [];
  for (const name of knownAgents(goals, counts)) {
    if (name === agentName) continue;
    const inProgress = counts.get(name) ?? 0;
    const target = wipTargetFor(name, goals);
    if (target <= 0) continue;

    const under = inProgress < target;
    const prior = tickState.ticks_under_target[name] ?? 0;
    const ticks = under ? prior + 1 : 0;
    nextTickState.ticks_under_target[name] = ticks;

    let messageSent = false;
    let telegramAlerted = false;

    if (under && !options.dryRun) {
      try {
        sendMessage(
          paths,
          agentName,
          name,
          'high',
          `FORCE-SPAWN: you have ${inProgress}/${target} in-progress tasks. Claim next approved task immediately.`,
        );
        messageSent = true;
      } catch {
        messageSent = false;
      }

      if (ticks >= ALERT_TICKS_THRESHOLD && telegramChatId && botToken) {
        const text =
          `wip-enforcer alert: ${name} under WIP target ` +
          `(${inProgress}/${target}) for ${ticks} consecutive ticks.`;
        try {
          const api = new TelegramAPI(botToken);
          await api.sendMessage(telegramChatId, text, undefined, { parseMode: null });
          telegramAlerted = true;
        } catch {
          telegramAlerted = false;
        }
      }
    }

    agents.push({
      agent: name,
      in_progress: inProgress,
      wip_target: target,
      under_target: under,
      ticks_under_target: ticks,
      message_sent: messageSent,
      telegram_alerted: telegramAlerted,
    });
  }

  if (!options.dryRun) {
    writeTickState(paths, nextTickState);
  }

  logEvent(paths, agentName, org, 'action', 'wip_enforcer_tick', 'info', {
    agents_checked: agents.length,
    agents_under_target: agents.filter(a => a.under_target).length,
    messages_sent: agents.filter(a => a.message_sent).length,
    telegram_alerts: agents.filter(a => a.telegram_alerted).length,
    dry_run: !!options.dryRun,
  });

  return {
    generated_at: generatedAt,
    agents,
    telegram_chat_id: telegramChatId || null,
    alert_threshold_ticks: ALERT_TICKS_THRESHOLD,
  };
}
