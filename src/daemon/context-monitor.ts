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

const DEFAULT_CONFIG: Required<ContextMonitorConfig> = {
  check_interval_ms: 60_000,
  warn_pct: 60,
  alert_pct: 80,
  critical_pct: 95,
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
  private onWarn: ((est: ContextEstimate) => void) | null = null;
  private onAlert: ((est: ContextEstimate) => void) | null = null;
  private onCritical: ((est: ContextEstimate) => void) | null = null;

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

  setOnWarn(cb: (est: ContextEstimate) => void): void { this.onWarn = cb; }
  setOnAlert(cb: (est: ContextEstimate) => void): void { this.onAlert = cb; }
  setOnCritical(cb: (est: ContextEstimate) => void): void { this.onCritical = cb; }

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
      this.writeContinuationFile(est);
      this.onWarn?.(est);
      this.lastThreshold = 'warn';
    } else if (threshold === 'alert' && this.lastThreshold !== 'alert' && this.lastThreshold !== 'critical') {
      this.writeContinuationFile(est);
      this.onAlert?.(est);
      this.lastThreshold = 'alert';
    } else if (threshold === 'critical' && this.lastThreshold !== 'critical') {
      this.writeContinuationFile(est);
      this.onCritical?.(est);
      this.lastThreshold = 'critical';
    }

    return threshold;
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
