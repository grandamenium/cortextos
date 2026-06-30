import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import { join } from 'path';
import type {
  AdapterContext,
  ExecInput,
  ExecResult,
  HealthResult,
  WorkerAdapter,
} from '../base.js';
import { excerpt } from '../base.js';

const BINARY = 'codex';

// safeModels(): gpt-5.3-codex and gpt-5.3-codex-spark are DELIBERATELY EXCLUDED
// — both are chatgpt-auth-unsafe (the tonight gpt-5.3-codex entitlement failure).
// This exclusion is the structural prevention; the first-turn classifier in
// execute() is the runtime catch.
const SAFE_MODELS = ['gpt-5.5', 'gpt-5-codex'];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killedByTimeout: boolean;
  spawnError: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (err && err.code === 'ENOENT') {
          resolve({ code: 127, stdout: stdout ?? '', stderr: stderr ?? '', killedByTimeout: false, spawnError: true });
          return;
        }
        const killedByTimeout = Boolean(err && err.killed);
        const code = err && typeof err.code === 'number'
          ? err.code
          : err
            ? 1
            : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', killedByTimeout, spawnError: false });
      }
    );
  });
}

/**
 * Resolve the codex-companion.mjs forwarder path using the same convention the
 * codex plugin's own agents/hooks use:  ${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs.
 * CLAUDE_PLUGIN_ROOT is injected into the agent session by the Claude Code plugin
 * runtime. We do NOT hardcode an absolute path (the plugin cache version dir
 * changes on every update).
 */
function resolveCompanionPath(): string | null {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  return join(root, 'scripts', 'codex-companion.mjs');
}

const MODEL_ENTITLEMENT_RE =
  /(not available|not supported|unsupported|does not have access|not entitled|unknown model|invalid model)/i;
const LOGGED_OUT_RE = /(logged out|not logged in|please run.*login|run `codex login`|no.*credentials|unauthenticated)/i;
const TRANSIENT_RE = /(-32001|ENOENT|ECONNREFUSED|rpc disconnect|disconnected|Timed out waiting for (turn|completed)|broker.busy)/i;

export const codexAdapter: WorkerAdapter = {
  id: 'codex',
  binary: BINARY,

  safeModels(): string[] {
    return [...SAFE_MODELS];
  },

  async health(model?: string): Promise<HealthResult> {
    const start = Date.now();
    const pinned = model ?? SAFE_MODELS[0];

    // 1. Binary present?
    const version = await run(BINARY, ['--version'], 8000);
    if (version.code === 127 || version.spawnError) {
      return {
        available: false,
        reason: 'no-binary',
        detail: excerpt(version.stderr || `${BINARY} not found on PATH`),
        checkedModel: pinned,
        latencyMs: Date.now() - start,
      };
    }

    // 2. Logged in? `codex login status`. Logged-out ⇒ no-auth (fix is /codex:setup,
    //    NOT a model swap).
    const login = await run(BINARY, ['login', 'status'], 10000);
    const loginText = `${login.stdout}\n${login.stderr}`;
    if (login.code !== 0 || LOGGED_OUT_RE.test(loginText)) {
      return {
        available: false,
        reason: 'no-auth',
        detail: excerpt(loginText || 'codex login status: logged out'),
        checkedModel: pinned,
        latencyMs: Date.now() - start,
      };
    }

    // 3. Logged in but requested model ∉ safeModels() ⇒ config-error (skip up front).
    //    This is the entitlement-allowlist gate — gpt-5.3-codex can never be attempted.
    if (!SAFE_MODELS.includes(pinned)) {
      return {
        available: false,
        reason: 'config-error',
        detail: `requested model '${pinned}' not in codex safeModels()=[${SAFE_MODELS.join(', ')}]`,
        checkedModel: pinned,
        latencyMs: Date.now() - start,
      };
    }

    return {
      available: true,
      checkedModel: pinned,
      detail: excerpt(version.stdout),
      latencyMs: Date.now() - start,
    };
  },

  async execute(input: ExecInput, ctx: AdapterContext): Promise<ExecResult> {
    const model = input.model ?? SAFE_MODELS[0];

    const companion = resolveCompanionPath();
    if (!companion) {
      // No plugin root means the forwarder is unreachable — treat as no-binary so
      // the chain skips/fails over rather than hanging.
      return {
        ok: false,
        failure: 'no-binary',
        retryable: false,
        stderrExcerpt: 'CLAUDE_PLUGIN_ROOT unset — codex-companion.mjs path unresolved',
        servedModel: model,
      };
    }

    void ctx;
    const args = [
      companion,
      'task',
      input.prompt,
      '--model',
      model,
      '--cwd',
      input.workdir,
      '--json',
    ];

    const r = await run('node', args, input.timeoutMs);
    const combined = `${r.stdout}\n${r.stderr}`;

    if (r.killedByTimeout) {
      return {
        ok: false,
        failure: 'timeout',
        retryable: true,
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(combined),
        servedModel: model,
      };
    }

    if (r.code === 127 || r.spawnError) {
      return {
        ok: false,
        failure: 'no-binary',
        retryable: false,
        exitCode: 127,
        stderrExcerpt: excerpt(r.stderr || 'node / codex-companion.mjs not found'),
        servedModel: model,
      };
    }

    // --- LOAD-BEARING failure classifier ------------------------------------
    // Precedence (spec §3.2 classification + the §6.1 before/after-usage boundary):
    //   1. Known transient signatures (broker-busy -32001, ECONNREFUSED, rpc
    //      disconnect, turn-timeout) ⇒ transient, position-independent.
    //   2. Model entitlement error (slug + phrase) ⇒ config-error ONLY when the
    //      turn never started (the error/phrase appears before any
    //      thread/tokenUsage/updated or item/agentMessage/delta). The SAME
    //      entitlement text AFTER token-usage is a mid-flight anomaly, not an
    //      entitlement gate ⇒ transient. This is the exact line separating
    //      tonight's deterministic gpt-5.3 failure from a flaky network.
    //   3. A generic error / non-completed status before any token-usage/delta
    //      (turn never truly started) ⇒ config-error.
    const outcome = classifyCodexOutcome(combined);
    if (outcome === 'config-error') {
      return {
        ok: false,
        failure: 'config-error',
        retryable: false, // entitlement / never-started errors never benefit from a retry.
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(combined),
        servedModel: model,
      };
    }
    if (outcome === 'transient') {
      return {
        ok: false,
        failure: 'transient',
        retryable: true,
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(combined),
        servedModel: model,
      };
    }

    if (r.code === 0) {
      const output = extractTaskOutput(r.stdout) ?? r.stdout.trim();
      // An exit 0 with no usable output and an error marker is a process failure.
      if (!output) {
        return {
          ok: false,
          failure: 'process-fail',
          retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
          exitCode: 0,
          stderrExcerpt: excerpt(combined || 'codex task: exit 0 but empty output'),
          servedModel: model,
        };
      }
      return {
        ok: true,
        output,
        retryable: false,
        exitCode: 0,
        servedModel: model,
      };
    }

    // Non-zero, unclassified ⇒ process-fail (failover, 1 retry per policy table).
    return {
      ok: false,
      failure: 'process-fail',
      retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
      exitCode: r.code ?? undefined,
      stderrExcerpt: excerpt(combined),
      servedModel: model,
    };
  },
};

/**
 * Classify the codex companion's combined stdout+stderr into the failure classes
 * that need the output TEXT (transient vs config-error); returns null when the
 * text carries no such signal (the caller then handles exit-code paths).
 *
 * Precedence (spec §3.2 classification + the §6.1 before/after-usage boundary):
 *   1. Known transient signatures (-32001 / ECONNREFUSED / rpc disconnect /
 *      turn-timeout) ⇒ 'transient', position-independent.
 *   2. Model entitlement error (model slug + entitlement phrase): 'config-error'
 *      iff the turn never started (the phrase appears before any
 *      token-usage/delta marker, or there is no such marker at all); the SAME
 *      text AFTER token-usage ⇒ 'transient' (a mid-flight anomaly, not a gate).
 *   3. A generic error / non-`completed` status arriving before any
 *      token-usage/delta marker (turn never truly started) ⇒ 'config-error'.
 */
function classifyCodexOutcome(combined: string): 'config-error' | 'transient' | null {
  if (!combined) return null;
  const lower = combined.toLowerCase();

  // 1. Always-transient signatures win regardless of position.
  if (TRANSIENT_RE.test(combined)) return 'transient';

  const usageIdx = firstIndexOf(lower, [
    'thread/tokenusage/updated',
    'tokenusage',
    'item/agentmessage/delta',
    'agentmessage',
  ]);
  const turnStarted = usageIdx >= 0;

  // 2. Entitlement error: model slug + entitlement phrase, gated on turn-start.
  const entMatch = MODEL_ENTITLEMENT_RE.exec(combined);
  const hasModelSlug = /(gpt-[0-9])/i.test(combined);
  if (entMatch && hasModelSlug) {
    // entMatch.index is a position in `combined`; `lower` is the same length, so
    // it is directly comparable to usageIdx.
    if (!turnStarted || entMatch.index < usageIdx) return 'config-error';
    return 'transient';
  }

  // 3. Generic error / non-completed status BEFORE any usage ⇒ turn never started.
  const errorIdx = firstIndexOf(lower, [
    '"error"',
    "'error'",
    'error notification',
    'turn.failed',
    'turn_failed',
    '"failed"',
  ]);
  if (errorIdx >= 0 && (!turnStarted || errorIdx < usageIdx)) return 'config-error';

  return null;
}

function firstIndexOf(haystack: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const i = haystack.indexOf(n);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Pull the task deliverable from the companion's --json envelope. The companion
 * emits a JSON command-result object; we look for the common result-bearing
 * fields and fall back to the raw text if the shape is unexpected.
 */
function extractTaskOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The --json output may be a single object or NDJSON; try the last JSON line.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const candidate =
        (typeof obj.output === 'string' && obj.output) ||
        (typeof obj.result === 'string' && obj.result) ||
        (typeof obj.summary === 'string' && obj.summary) ||
        (typeof obj.message === 'string' && obj.message);
      if (candidate) return candidate;
    } catch {
      // not a JSON line — keep scanning.
    }
  }
  return null;
}
