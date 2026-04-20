import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import type { AgentManager } from './agent-manager.js';
import type { AgentConfig } from '../types/index.js';

/**
 * Sleep Scheduler — saves tokens by stopping agents outside their work hours
 * and auto-waking them when a message arrives in their inbox.
 *
 * Each agent's config.json can specify:
 *   "schedule": "always"          — never sleep (default for orchestrator)
 *   "schedule": "day"             — active during day_mode hours (default)
 *   "schedule": "on-demand"       — only active when a message arrives
 *   "schedule_start": "09:00"     — custom day start
 *   "schedule_end": "22:00"       — custom day end
 *
 * When an agent is sleeping:
 *   - PTY is killed (zero Claude token usage)
 *   - FastChecker is stopped
 *   - Telegram poller is stopped (messages queue on Telegram's side)
 *   - SleepScheduler watches inbox dir for new files → triggers wake
 *   - On wake: agent starts fresh, Telegram poller catches up via getUpdates
 *
 * For Telegram messages to sleeping agents: the user can message anytime,
 * Telegram stores the messages server-side. When the agent wakes (by schedule
 * or manually), the Telegram poller picks up all unread messages.
 *
 * For urgent Telegram messages: the platform-director (schedule=always) receives
 * ALL Telegram messages and can wake other agents via send-message to their inbox.
 */

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export type AgentSchedule = 'always' | 'day' | 'on-demand';

interface ScheduleConfig {
  schedule: AgentSchedule;
  start: string; // HH:MM
  end: string;   // HH:MM
  timezone: string;
}

export class SleepScheduler {
  private agentManager: AgentManager;
  private ctxRoot: string;
  private frameworkRoot: string;
  private timer: NodeJS.Timeout | null = null;

  /** Agents currently sleeping (stopped by scheduler) */
  private sleepingAgents = new Set<string>();

  /** Inbox file counts when agent went to sleep — detect new messages */
  private inboxSnapshot = new Map<string, number>();

  /** Cached schedules per agent */
  private scheduleCache = new Map<string, ScheduleConfig>();

  constructor(agentManager: AgentManager, ctxRoot: string, frameworkRoot: string) {
    this.agentManager = agentManager;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
  }

  start(): void {
    if (this.timer) return;
    this.loadSchedules();

    const summary = this.formatScheduleSummary();
    console.log(`[sleep-scheduler] Started. ${summary}`);

    // Initial check after 30s (let agents boot first)
    setTimeout(() => {
      this.check().catch(err => console.error(`[sleep-scheduler] Error: ${err.message}`));
    }, 30_000);

    this.timer = setInterval(() => {
      this.check().catch(err => console.error(`[sleep-scheduler] Error: ${err.message}`));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[sleep-scheduler] Stopped');
    }
  }

  /** Check if an agent is currently sleeping */
  isSleeping(name: string): boolean {
    return this.sleepingAgents.has(name);
  }

  /**
   * Manually wake an agent. Used by IPC (cortextos start <name>).
   */
  manualWake(name: string): void {
    this.sleepingAgents.delete(name);
    this.inboxSnapshot.delete(name);
  }

  // ─── Core loop ───────────────────────────────────────────────────────────

  private async check(): Promise<void> {
    // First: check if any sleeping agent has new inbox messages → wake
    for (const name of this.sleepingAgents) {
      if (this.hasNewInboxMessages(name)) {
        console.log(`[sleep-scheduler] ${name} has new inbox messages → waking`);
        await this.wakeAgent(name);
        continue;
      }
    }

    const statuses = this.agentManager.getAllStatuses();
    const runningNames = new Set(statuses.filter(s => s.status === 'running').map(s => s.name));

    for (const [name, config] of this.scheduleCache) {
      // 'always' agents never sleep
      if (config.schedule === 'always') continue;

      const shouldBeActive = this.isActiveHours(config);

      if (shouldBeActive && config.schedule !== 'on-demand') {
        // Should be active — wake if sleeping
        if (this.sleepingAgents.has(name)) {
          console.log(`[sleep-scheduler] ${name} active hours started (${config.start}) → waking`);
          await this.wakeAgent(name);
        }
      } else {
        // Outside active hours or on-demand — put to sleep if running
        if (runningNames.has(name) && !this.sleepingAgents.has(name)) {
          console.log(
            `[sleep-scheduler] ${name} outside active hours ` +
            `(${config.start}-${config.end}) → sleeping`
          );
          await this.sleepAgent(name);
        }
      }
    }
  }

  private async sleepAgent(name: string): Promise<void> {
    try {
      // Snapshot inbox before sleeping — used to detect new messages
      this.inboxSnapshot.set(name, this.countInboxMessages(name));
      await this.agentManager.stopAgent(name);
      this.sleepingAgents.add(name);
    } catch (err) {
      console.error(`[sleep-scheduler] Failed to sleep ${name}: ${(err as Error).message}`);
    }
  }

  private async wakeAgent(name: string): Promise<void> {
    this.sleepingAgents.delete(name);
    this.inboxSnapshot.delete(name);
    try {
      await this.agentManager.startAgent(name, '');
      console.log(`[sleep-scheduler] ${name} woken`);
    } catch (err) {
      console.error(`[sleep-scheduler] Failed to wake ${name}: ${(err as Error).message}`);
    }
  }

  // ─── Inbox watching ──────────────────────────────────────────────────────

  private hasNewInboxMessages(name: string): boolean {
    const snapshot = this.inboxSnapshot.get(name) ?? 0;
    const current = this.countInboxMessages(name);
    return current > snapshot;
  }

  private countInboxMessages(name: string): number {
    const inboxDir = join(this.ctxRoot, 'messages', name, 'inbox');
    try {
      if (!existsSync(inboxDir)) return 0;
      return readdirSync(inboxDir).filter(f => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  // ─── Time logic ──────────────────────────────────────────────────────────

  private isActiveHours(config: ScheduleConfig): boolean {
    if (config.schedule === 'on-demand') return false;

    const [sh, sm] = config.start.split(':').map(Number);
    const [eh, em] = config.end.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;

    const now = new Date();
    let currentMin: number;
    try {
      const timeStr = now.toLocaleTimeString('en-GB', {
        timeZone: config.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
      const [h, m] = timeStr.split(':').map(Number);
      currentMin = h * 60 + m;
    } catch {
      return true; // parse failed → assume active (safe)
    }

    if (startMin <= endMin) {
      return currentMin >= startMin && currentMin < endMin;
    } else {
      // Wraps midnight (e.g. 22:00-06:00)
      return currentMin >= startMin || currentMin < endMin;
    }
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  private loadSchedules(): void {
    this.scheduleCache.clear();
    try {
      const orgsDir = join(this.frameworkRoot, 'orgs');
      if (!existsSync(orgsDir)) return;

      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        if (!existsSync(agentsDir)) continue;

        for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agent.isDirectory()) continue;
          const configPath = join(agentsDir, agent.name, 'config.json');
          try {
            const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
            const tz = raw.timezone ?? 'Europe/Berlin';
            const schedule: AgentSchedule = raw.schedule ?? 'day';
            const start = raw.schedule_start ?? raw.day_mode_start ?? '09:00';
            const end = raw.schedule_end ?? raw.day_mode_end ?? '22:00';

            this.scheduleCache.set(agent.name, { schedule, start, end, timezone: tz });
          } catch {
            // Use defaults for this agent
          }
        }
      }
    } catch {
      // orgs dir unreadable
    }
  }

  private formatScheduleSummary(): string {
    const always: string[] = [];
    const day: string[] = [];
    const onDemand: string[] = [];

    for (const [name, cfg] of this.scheduleCache) {
      if (cfg.schedule === 'always') always.push(name);
      else if (cfg.schedule === 'on-demand') onDemand.push(name);
      else day.push(`${name}(${cfg.start}-${cfg.end})`);
    }

    const parts: string[] = [];
    if (always.length) parts.push(`24/7: ${always.join(', ')}`);
    if (day.length) parts.push(`Day: ${day.join(', ')}`);
    if (onDemand.length) parts.push(`On-demand: ${onDemand.join(', ')}`);
    return parts.join(' | ') || 'No schedules configured (all agents use default 09:00-22:00)';
  }
}
