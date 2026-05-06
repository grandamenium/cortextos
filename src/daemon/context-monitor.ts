import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ContextMonitorConfig {
  check_interval_ms?: number;
  warn_pct?: number;
  alert_pct?: number;
  critical_pct?: number;
  max_session_tokens?: number;
}

export interface ContextEstimate {
  pct: number;
  tokens_est: number;
  max_tokens: number;
  signal: 'time' | 'output_size' | 'combined';
}

export type ContextThreshold = 'ok' | 'warn' | 'alert' | 'critical';

/**
 * Burn classification: is the context usage legitimate work or a
 * runaway loop? The orchestrator uses this to decide whether to
 * alert the user ("agent is working hard on a big task") vs
 * intervene ("agent is stuck in a loop burning tokens").
 */
export type BurnClassification = 'large_task' | 'runaway' | 'unknown';

export interface BurnAnalysis {
  classification: BurnClassification;
  has_active_task: boolean;
  heartbeat_fresh: boolean;
  log_entropy_low: boolean;
  reasons: string[];
}

const DEFAULT_CONFIG: Required<ContextMonitorConfig> = {
  check_interval_ms: 60_000,
  warn_pct: 40,
  alert_pct: 50,
  critical_pct: 60,
  max_session_tokens: 200_000,
};

// Rough heuristic: ~4 chars per token for English text in logs.
const CHARS_PER_TOKEN = 4;

/**
 * Monitors estimated context usage for an agent session and fires
 * callbacks at configurable thresholds. Uses two heuristic signals:
 *
 *   1. Session elapsed time as a fraction of max_session_seconds
 *   2. stdout.log growth since session start (proxy for output tokens)
 *
 * The combined estimate is the MAX of both signals — if either
 * suggests the session is running hot, the monitor fires.
 *
 * This is an estimation, not an exact measurement. Claude Code does
 * not expose a token-count API. The PreCompact hook (which fires when
 * Claude Code actually starts compaction) remains the only ground-
 * truth signal that context is at the limit.
 *
 * TODO: replace heuristics with exact token counts when Claude Code
 * exposes a session-level usage metric.
 */
export class ContextMonitor {
  private config: Required<ContextMonitorConfig>;
  private agentName: string;
  private stateDir: string;
  private logPath: string;
  private sessionStartTime: number;
  private sessionStartLogSize: number;
  private maxSessionMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastThreshold: ContextThreshold = 'ok';
  private onWarn: ((est: ContextEstimate, burn: BurnAnalysis) => void) | null = null;
  private onAlert: ((est: ContextEstimate, burn: BurnAnalysis) => void) | null = null;
  private onCritical: ((est: ContextEstimate, burn: BurnAnalysis) => void) | null = null;
  private taskDir: string | null = null;
  private heartbeatDir: string | null = null;
  private cronIntervalMs: number = 4 * 3600_000; // default 4h heartbeat interval

  constructor(
    agentName: string,
    stateDir: string,
    logPath: string,
    maxSessionSeconds: number,
    config?: ContextMonitorConfig,
  ) {
    this.agentName = agentName;
    this.stateDir = stateDir;
    this.logPath = logPath;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStartTime = Date.now();
    this.sessionStartLogSize = this.getLogSize();
    this.maxSessionMs = maxSessionSeconds * 1000;
  }

  setOnWarn(cb: (est: ContextEstimate, burn: BurnAnalysis) => void): void { this.onWarn = cb; }
  setOnAlert(cb: (est: ContextEstimate, burn: BurnAnalysis) => void): void { this.onAlert = cb; }
  setOnCritical(cb: (est: ContextEstimate, burn: BurnAnalysis) => void): void { this.onCritical = cb; }

  /** Configure paths for burn classification (optional — without these, classification returns 'unknown'). */
  setBurnContext(opts: { taskDir?: string; heartbeatDir?: string; cronIntervalMs?: number }): void {
    if (opts.taskDir) this.taskDir = opts.taskDir;
    if (opts.heartbeatDir) this.heartbeatDir = opts.heartbeatDir;
    if (opts.cronIntervalMs) this.cronIntervalMs = opts.cronIntervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.config.check_interval_ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  estimate(): ContextEstimate {
    const elapsed = Date.now() - this.sessionStartTime;
    const timePct = this.maxSessionMs > 0 ? (elapsed / this.maxSessionMs) * 100 : 0;

    const currentLogSize = this.getLogSize();
    const logGrowth = Math.max(0, currentLogSize - this.sessionStartLogSize);
    const tokensFromLog = logGrowth / CHARS_PER_TOKEN;
    const outputPct = (tokensFromLog / this.config.max_session_tokens) * 100;

    const pct = Math.min(100, Math.max(timePct, outputPct));
    const signal: ContextEstimate['signal'] =
      timePct > outputPct ? 'time' : outputPct > timePct ? 'output_size' : 'combined';

    return {
      pct: Math.round(pct * 10) / 10,
      tokens_est: Math.round(tokensFromLog),
      max_tokens: this.config.max_session_tokens,
      signal,
    };
  }

  classify(est: ContextEstimate): ContextThreshold {
    if (est.pct >= this.config.critical_pct) return 'critical';
    if (est.pct >= this.config.alert_pct) return 'alert';
    if (est.pct >= this.config.warn_pct) return 'warn';
    return 'ok';
  }

  check(): ContextThreshold {
    const est = this.estimate();
    const threshold = this.classify(est);

    if (threshold === 'warn' && this.lastThreshold === 'ok') {
      const burn = this.classifyBurn();
      this.writeContinuationFile(est);
      this.onWarn?.(est, burn);
      this.lastThreshold = 'warn';
    } else if (threshold === 'alert' && this.lastThreshold !== 'alert' && this.lastThreshold !== 'critical') {
      const burn = this.classifyBurn();
      this.writeContinuationFile(est);
      this.onAlert?.(est, burn);
      this.lastThreshold = 'alert';
    } else if (threshold === 'critical' && this.lastThreshold !== 'critical') {
      const burn = this.classifyBurn();
      this.writeContinuationFile(est);
      this.onCritical?.(est, burn);
      this.lastThreshold = 'critical';
    }

    return threshold;
  }

  /**
   * Classify the context burn as legitimate work vs runaway loop.
   *
   * Heuristic:
   *   - has_active_task: at least one task file has status=in_progress
   *   - heartbeat_fresh: heartbeat updated within 2x cron interval
   *   - log_entropy_low: last 4KB of stdout.log has >40% duplicate lines
   *     (runaway loops produce repetitive output patterns)
   *
   * Classification:
   *   - large_task: has active task AND heartbeat fresh AND not low entropy
   *   - runaway: no active task OR low entropy (repetitive output)
   *   - unknown: insufficient data (no taskDir/heartbeatDir configured)
   */
  classifyBurn(): BurnAnalysis {
    if (!this.taskDir && !this.heartbeatDir) {
      return { classification: 'unknown', has_active_task: false, heartbeat_fresh: false, log_entropy_low: false, reasons: ['no context dirs configured'] };
    }

    const reasons: string[] = [];
    const hasActiveTask = this.checkActiveTask();
    const heartbeatFresh = this.checkHeartbeatFresh();
    const logEntropyLow = this.checkLogEntropy();

    if (hasActiveTask) reasons.push('in_progress task found');
    else reasons.push('no in_progress task');

    if (heartbeatFresh) reasons.push('heartbeat fresh');
    else reasons.push('heartbeat stale');

    if (logEntropyLow) reasons.push('log output repetitive (possible loop)');

    let classification: BurnClassification;
    if (logEntropyLow) {
      classification = 'runaway';
    } else if (!hasActiveTask && !heartbeatFresh) {
      classification = 'runaway';
    } else if (hasActiveTask) {
      classification = 'large_task';
    } else {
      classification = 'unknown';
    }

    return { classification, has_active_task: hasActiveTask, heartbeat_fresh: heartbeatFresh, log_entropy_low: logEntropyLow, reasons };
  }

  private checkActiveTask(): boolean {
    if (!this.taskDir) return false;
    try {
      const { readdirSync } = require('fs');
      const files = readdirSync(this.taskDir).filter((f: string) => f.startsWith('task_') && f.endsWith('.json'));
      for (const f of files) {
        try {
          const task = JSON.parse(readFileSync(join(this.taskDir!, f), 'utf-8'));
          if (task.status === 'in_progress' && task.assigned_to === this.agentName) return true;
        } catch { /* skip corrupt */ }
      }
    } catch { /* dir missing */ }
    return false;
  }

  private checkHeartbeatFresh(): boolean {
    if (!this.heartbeatDir) return false;
    try {
      // Heartbeat lives at state/<agent>/heartbeat.json
      const hbPath = join(this.heartbeatDir, this.agentName, 'heartbeat.json');
      if (!existsSync(hbPath)) return false;
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
      const lastHb = new Date(hb.last_heartbeat || hb.timestamp || 0).getTime();
      return (Date.now() - lastHb) < this.cronIntervalMs * 2;
    } catch { /* unreadable */ }
    return false;
  }

  private checkLogEntropy(): boolean {
    try {
      const size = this.getLogSize();
      if (size < 4096) return false; // too little data to judge
      const fd = require('fs').openSync(this.logPath, 'r');
      const buf = Buffer.alloc(4096);
      require('fs').readSync(fd, buf, 0, 4096, Math.max(0, size - 4096));
      require('fs').closeSync(fd);

      const lines = buf.toString('utf-8').split('\n').filter((l: string) => l.trim().length > 10);
      if (lines.length < 10) return false;
      const unique = new Set(lines);
      const dupeRatio = 1 - unique.size / lines.length;
      return dupeRatio > 0.4;
    } catch { /* can't read */ }
    return false;
  }

  /**
   * Write a continuation file summarizing session state at this point.
   * The next session (via --continue) can read this to resume context.
   */
  writeContinuationFile(est: ContextEstimate): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const content = [
        `# Continuation State — ${this.agentName}`,
        ``,
        `**Written at:** ${now}`,
        `**Context estimate:** ${est.pct}% (${est.signal} signal)`,
        `**Tokens estimated:** ~${est.tokens_est} / ${est.max_tokens}`,
        `**Session uptime:** ${Math.round((Date.now() - this.sessionStartTime) / 60000)} min`,
        ``,
        `## Resume Instructions`,
        ``,
        `This file was written by the context monitor when the session`,
        `approached a threshold. Read this on resume to restore context.`,
        `Check daily memory and task queue for specific work state.`,
        ``,
      ].join('\n');
      writeFileSync(join(this.stateDir, 'continuation.md'), content, 'utf-8');
    } catch { /* best-effort */ }
  }

  private getLogSize(): number {
    try {
      if (existsSync(this.logPath)) return statSync(this.logPath).size;
    } catch { /* ignore */ }
    return 0;
  }
}
