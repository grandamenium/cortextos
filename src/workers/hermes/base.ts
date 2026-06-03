import type { AgentConfig, CtxEnv } from '../../types/index.js';

export type BackendId = 'claude' | 'codex' | 'gemini';

/** Why a backend did not produce a usable result. Drives retry-vs-failover. */
export type Unavailability =
  | 'no-binary'      // exit 127 / ENOENT / `command -v` empty               → skip at health
  | 'no-auth'        // missing/invalid creds, logged-out                    → failover, 0 retries
  | 'config-error'   // model unentitled/unknown — the tonight gpt-5.3-codex → failover, 0 retries
  | 'rate-limit'     // 429 / RESOURCE_EXHAUSTED / quota                     → retry then failover
  | 'transient'      // broker-busy -32001, ECONNREFUSED, rpc disconnect     → retry then failover
  | 'timeout'        // wall-clock exceeded (hang on prompt)                 → retry once then failover
  | 'process-fail';  // non-zero exit, no finer class                       → failover, 1 retry

/** Shared context, reused verbatim from the PTY path (gives CTX_*, secrets.env, agent .env). */
export interface AdapterContext {
  config: AgentConfig;
  env: CtxEnv;
}

export interface HealthResult {
  available: boolean;
  reason?: Unavailability;   // set iff !available ('no-binary' | 'no-auth' | 'config-error')
  detail?: string;           // first 200 chars of evidence (binary path / error excerpt)
  checkedModel?: string;     // the model the probe would use
  latencyMs: number;
}

export interface ExecInput {
  prompt: string;
  workdir: string;
  model?: string;            // explicit pin; adapter MUST NOT silently inherit config
  systemPrompt?: string;
  timeoutMs: number;         // wall-clock cap — a hung headless run never exits on its own
}

export interface ExecResult {
  ok: boolean;
  output?: string;           // the task result payload (the served deliverable)
  failure?: Unavailability;  // set iff !ok
  retryable: boolean;        // adapter's verdict: is the SAME backend worth retrying?
  exitCode?: number;
  stderrExcerpt?: string;    // first 200 chars, for triage/telemetry
  servedModel?: string;      // the model that ACTUALLY ran (resolved, not requested)
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface WorkerAdapter {
  readonly id: BackendId;
  readonly binary: string;

  /**
   * Cheap liveness + entitlement probe. MUST be fast and MUST NOT run the task.
   * Pins safeModels()[0] (or the passed model) and classifies failure as
   * 'no-binary' | 'no-auth' | 'config-error' so the chain can skip a dead/unentitled
   * backend instead of burning a full timeout on it.
   */
  health(model?: string): Promise<HealthResult>;

  /**
   * Run one task headlessly; capture a structured result; classify any failure.
   * MUST NOT throw for an expected backend failure — encode it in ExecResult.
   * MUST honor input.timeoutMs and classify a timeout as 'timeout'.
   */
  execute(input: ExecInput, ctx: AdapterContext): Promise<ExecResult>;

  /**
   * Backend-safe model allowlist, preference-ordered. Index 0 = default pin.
   * Codex MUST exclude gpt-5.3-codex / gpt-5.3-codex-spark (chatgpt-auth-unsafe).
   * A requested model outside this list ⇒ health() returns config-error (skip).
   */
  safeModels(): string[];
}

/** Clamp arbitrary evidence text to the 200-char excerpt the interface promises. */
export function excerpt(text: string | undefined | null, max = 200): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
