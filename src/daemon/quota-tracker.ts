import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface QuotaConfig {
  daily_budget_usd: number;
  soft_pct: number;
  hard_pct: number;
}

export interface QuotaState {
  date: string;
  spent_usd: number;
  soft_warned: boolean;
  hard_blocked: boolean;
}

export type QuotaCheckResult =
  | { status: 'ok' }
  | { status: 'soft_warning'; spent_usd: number; budget_usd: number; pct: number }
  | { status: 'hard_blocked'; spent_usd: number; budget_usd: number; pct: number };

const DEFAULT_CONFIG: QuotaConfig = {
  daily_budget_usd: 10,
  soft_pct: 80,
  hard_pct: 100,
};

/**
 * Per-agent daily API cost tracker with soft/hard threshold-based
 * load shedding. Inspired by instar's QuotaTracker pattern.
 *
 * State is persisted to `<stateDir>/quota-<date>.json` so it
 * survives daemon restarts within the same day.
 *
 * TODO: usage data is currently reported via `recordSpend()` which
 * must be called externally. When the Anthropic usage-reporting API
 * or a session-level token-count hook becomes available, replace the
 * manual reporting path with an automatic feed. Do not design around
 * the current stub — the tracker's threshold logic is independent of
 * how spend data arrives.
 */
export class QuotaTracker {
  private config: QuotaConfig;
  private stateDir: string;
  private agentName: string;
  private state: QuotaState;

  constructor(agentName: string, stateDir: string, config?: Partial<QuotaConfig>) {
    this.agentName = agentName;
    this.stateDir = stateDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.loadState();
  }

  recordSpend(amountUsd: number): QuotaCheckResult {
    this.ensureFreshDay();
    this.state.spent_usd += amountUsd;
    this.saveState();
    return this.check();
  }

  check(): QuotaCheckResult {
    this.ensureFreshDay();
    const pct = (this.state.spent_usd / this.config.daily_budget_usd) * 100;
    if (pct >= this.config.hard_pct && !this.state.hard_blocked) {
      this.state.hard_blocked = true;
      this.saveState();
      return { status: 'hard_blocked', spent_usd: this.state.spent_usd, budget_usd: this.config.daily_budget_usd, pct };
    }
    if (pct >= this.config.soft_pct && !this.state.soft_warned) {
      this.state.soft_warned = true;
      this.saveState();
      return { status: 'soft_warning', spent_usd: this.state.spent_usd, budget_usd: this.config.daily_budget_usd, pct };
    }
    return { status: 'ok' };
  }

  isBlocked(): boolean {
    this.ensureFreshDay();
    return this.state.hard_blocked;
  }

  getState(): Readonly<QuotaState> {
    this.ensureFreshDay();
    return { ...this.state };
  }

  reset(): void {
    this.state = this.freshState();
    this.saveState();
  }

  private ensureFreshDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.state.date !== today) {
      this.state = this.freshState();
      this.saveState();
    }
  }

  private freshState(): QuotaState {
    return {
      date: new Date().toISOString().split('T')[0],
      spent_usd: 0,
      soft_warned: false,
      hard_blocked: false,
    };
  }

  private statePath(): string {
    return join(this.stateDir, `quota-${this.state.date}.json`);
  }

  private loadState(): QuotaState {
    const today = new Date().toISOString().split('T')[0];
    const path = join(this.stateDir, `quota-${today}.json`);
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')) as QuotaState;
      } catch { /* corrupt — start fresh */ }
    }
    return this.freshState();
  }

  private saveState(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.statePath(), JSON.stringify(this.state) + '\n', { encoding: 'utf-8', mode: 0o600 });
    } catch { /* best-effort persistence */ }
  }
}
