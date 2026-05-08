import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentManager } from './agent-manager.js';
import type { AgentConfig } from '../types/index.js';

/**
 * Sleep Scheduler — saves tokens without killing agent sessions.
 *
 * Two modes:
 *
 * 1. **"day" agents**: Stay alive 24/7 but cron gap-detection nudges are
 *    suppressed outside active hours. The agent keeps its conversation
 *    context and the heartbeat cron (~100 tokens/4h) keeps the session
 *    alive. No cold boot penalty in the morning.
 *
 * 2. **"on-demand" agents**: Actually stopped when idle. Only started
 *    when a message arrives in their inbox. These agents have no
 *    ongoing work and cold boot cost is acceptable for rare activations.
 *
 * Config per agent (config.json):
 *   "schedule": "always"       — never suppress anything (orchestrator)
 *   "schedule": "day"          — suppress nudges outside hours (default)
 *   "schedule": "on-demand"    — stop entirely when idle, wake on inbox
 *   "schedule_start": "09:00"  — custom start (defaults to day_mode_start)
 *   "schedule_end": "22:00"    — custom end (defaults to day_mode_end)
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

  /** on-demand agents that are currently stopped */
  private stoppedAgents = new Set<string>();

  /** Inbox message count snapshot (for wake-on-message detection) */
  private inboxSnapshot = new Map<string, number>();

  /** Cached schedules */
  private scheduleCache = new Map<string, ScheduleConfig>();

  /** Agents currently in quiet hours (gap detection suppressed) */
  private quietAgents = new Set<string>();

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

    // First check after 60s (let agents boot first)
    setTimeout(() => {
      this.check().catch(err => console.error(`[sleep-scheduler] Error: ${err.message}`));
    }, 60_000);

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

  /**
   * Called by AgentProcess.runGapDetectionLoop() before sending a nudge.
   * Returns true if the agent is in quiet hours → nudge should be suppressed.
   */
  isQuiet(name: string): boolean {
    return this.quietAgents.has(name);
  }

  /** Check if an on-demand agent is currently stopped */
  isStopped(name: string): boolean {
    return this.stoppedAgents.has(name);
  }

  /** Manual wake (via cortextos start) */
  manualWake(name: string): void {
    this.stoppedAgents.delete(name);
    this.inboxSnapshot.delete(name);
  }

  // ─── Core loop ───────────────────────────────────────────────────────────

  private async check(): Promise<void> {
    // 1. Check on-demand agents for new inbox messages → wake
    for (const name of this.stoppedAgents) {
      if (this.hasNewInboxMessages(name)) {
        console.log(`[sleep-scheduler] ${name} has new inbox messages → waking`);
        this.stoppedAgents.delete(name);
        this.inboxSnapshot.delete(name);
        try {
          await this.agentManager.startAgent(name, '');
          console.log(`[sleep-scheduler] ${name} woken`);
        } catch (err) {
          console.error(`[sleep-scheduler] Failed to wake ${name}: ${(err as Error).message}`);
        }
      }
    }

    // 2. Update quiet/active status for day agents
    for (const [name, config] of this.scheduleCache) {
      if (config.schedule === 'always') {
        this.quietAgents.delete(name);
        continue;
      }

      const active = this.isActiveHours(config);

      if (config.schedule === 'on-demand') {
        // On-demand: actually stop when no active work
        if (!active && !this.stoppedAgents.has(name)) {
          const statuses = this.agentManager.getAllStatuses();
          const isRunning = statuses.find(s => s.name === name)?.status === 'running';
          if (isRunning) {
            console.log(`[sleep-scheduler] ${name} (on-demand) → stopping`);
            this.inboxSnapshot.set(name, this.countInboxMessages(name));
            try {
              await this.agentManager.stopAgent(name);
              this.stoppedAgents.add(name);
            } catch (err) {
              console.error(`[sleep-scheduler] Failed to stop ${name}: ${(err as Error).message}`);
            }
          }
        }
        continue;
      }

      // Day schedule: toggle quiet mode (suppress gap nudges)
      if (active) {
        if (this.quietAgents.has(name)) {
          console.log(`[sleep-scheduler] ${name} active hours started → resuming cron nudges`);
          this.quietAgents.delete(name);
        }
      } else {
        if (!this.quietAgents.has(name)) {
          console.log(`[sleep-scheduler] ${name} quiet hours started → suppressing cron nudges`);
          this.quietAgents.add(name);
        }
      }
    }
  }

  // ─── Inbox watching (for on-demand agents) ───────────────────────────────

  private hasNewInboxMessages(name: string): boolean {
    const snapshot = this.inboxSnapshot.get(name) ?? 0;
    return this.countInboxMessages(name) > snapshot;
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

  // ─── Time ────────────────────────────────────────────────────────────────

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
      return true; // parse failed → assume active
    }

    if (startMin <= endMin) {
      return currentMin >= startMin && currentMin < endMin;
    } else {
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
          } catch { /* use defaults */ }
        }
      }
    } catch { /* orgs dir unreadable */ }
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
    if (day.length) parts.push(`Quiet outside: ${day.join(', ')}`);
    if (onDemand.length) parts.push(`On-demand: ${onDemand.join(', ')}`);
    return parts.join(' | ') || 'No schedules configured';
  }
}
