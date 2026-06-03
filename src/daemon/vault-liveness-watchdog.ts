/**
 * VaultLivenessWatchdog — keeps the cross-agent coordination layer alive.
 *
 * Two root causes made the fleet "go dead": (A) the vault board's updater (a
 * cron-injected agent prompt) died, freezing agent-shared/active-tasks.md on its
 * placeholder; (B) nothing noticed when the narrative state went stale. This
 * watchdog fixes both, modeled on src/daemon/stale-watchdog.ts (setInterval +
 * a `tick` that never throws):
 *
 *   1. Self-heal — every cycle it regenerates active-tasks.md from the live bus
 *      task list (deterministic TS, not an agent), so the board can never freeze.
 *   2. Watch — it checks the human/agent-authored project-state.md and alerts
 *      (best-effort, with a cooldown) when it goes stale or missing. Narrative
 *      files are NEVER auto-written, only watched.
 *
 * Every filesystem / clock / alert seam is injectable so `tick()` is unit-testable
 * without a live daemon, real vault, network, or wall clock.
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { Task } from '../types/index.js';
import { listTasks } from '../bus/task.js';
import { resolvePaths } from '../utils/paths.js';
import { writeActiveTasksBoard, PROJECT_STATE_REL } from '../bus/active-tasks.js';
import { sendOperatorAlertBestEffort } from './operator-alert.js';

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;   // regenerate the board every 5 min
const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // narrative file older than 60 min → alert
const DEFAULT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;  // at most one alert per key per 30 min

export interface VaultLivenessOptions {
  checkIntervalMs?: number;
  staleThresholdMs?: number;
  alertCooldownMs?: number;
  /** Vault root; defaults to <frameworkRoot>/obsidian-vault. */
  vaultRoot?: string;
  /** Task source; defaults to listTasks(resolvePaths('daemon', instanceId, org)). */
  loadTasks?: () => Task[];
  /** Alert sink; defaults to a best-effort Telegram send. Injected in tests. */
  alert?: (message: string) => void;
  /** Clock; defaults to Date.now. Injected in tests. */
  now?: () => number;
  /** Logger; defaults to console.log. Injected in tests. */
  log?: (message: string) => void;
}

export class VaultLivenessWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly alertCooldownMs: number;
  private readonly vaultRoot: string;
  private readonly loadTasks: () => Task[];
  private readonly alert: (message: string) => void;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(instanceId: string, org: string, frameworkRoot: string, options: VaultLivenessOptions = {}) {
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.alertCooldownMs = options.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.vaultRoot = options.vaultRoot ?? join(frameworkRoot, 'obsidian-vault');
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((m) => console.log(m));
    this.loadTasks = options.loadTasks ?? (() => listTasks(resolvePaths('daemon', instanceId, org)));
    this.alert = options.alert ?? ((message) => { sendOperatorAlertBestEffort(frameworkRoot, message); });
  }

  start(): void {
    if (this.timer) return;
    this.log(
      `[vault-liveness] started: regenerate active-tasks.md every ${this.checkIntervalMs / 60000}m, ` +
      `alert on narrative state older than ${this.staleThresholdMs / 60000}m (vault: ${this.vaultRoot})`,
    );
    // Run immediately so the board is fresh on boot (heals the placeholder at once),
    // then on the interval.
    this.tick();
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs);
    // Do not hold the event loop open for this timer alone.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('[vault-liveness] stopped');
    }
  }

  /**
   * One liveness cycle. Regenerates the board, then checks narrative freshness.
   * Never throws — a failure in one step still runs the others and alerts.
   */
  tick(): void {
    const nowMs = this.now();
    const renderedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

    // 1. Self-heal active-tasks.md — always rewrite fresh from the live bus.
    try {
      const tasks = this.loadTasks();
      writeActiveTasksBoard(this.vaultRoot, tasks, renderedAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.maybeAlert(
        'active-tasks-regen',
        `⚠️ cortextos: failed to regenerate active-tasks.md — ${msg}. The coordination board may be stale.`,
        nowMs,
      );
    }

    // 2. project-state.md is narrative (human/agent authored) — never auto-write, only watch.
    this.checkNarrativeFreshness(PROJECT_STATE_REL, nowMs);
  }

  private checkNarrativeFreshness(relPath: string, nowMs: number): void {
    const full = join(this.vaultRoot, relPath);
    if (!existsSync(full)) {
      this.maybeAlert(relPath, `⚠️ cortextos: ${relPath} is missing from the vault — coordination layer not initialized.`, nowMs);
      return;
    }
    let ageMs: number;
    try {
      ageMs = nowMs - statSync(full).mtimeMs;
    } catch {
      return; // transient stat failure — try again next cycle
    }
    if (ageMs > this.staleThresholdMs) {
      const ageMin = Math.round(ageMs / 60000);
      this.maybeAlert(
        relPath,
        `⚠️ cortextos: ${relPath} is stale (last updated ${ageMin}m ago) — the fleet coordination layer may be dead.`,
        nowMs,
      );
    }
  }

  /** Emit an alert unless one for this key fired within the cooldown window. */
  private maybeAlert(key: string, message: string, nowMs: number): void {
    const last = this.lastAlertAt.get(key);
    if (last !== undefined && nowMs - last < this.alertCooldownMs) return;
    this.lastAlertAt.set(key, nowMs);
    this.log(`[vault-liveness] ALERT ${message}`);
    try {
      this.alert(message);
    } catch {
      /* best-effort — alerting must never crash the watchdog */
    }
  }
}
