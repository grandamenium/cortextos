import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import { platform } from 'os';
import type {
  AdapterContext,
  ExecInput,
  ExecResult,
  HealthResult,
  WorkerAdapter,
} from '../base.js';
import { excerpt } from '../base.js';

const BINARY = platform() === 'win32' ? 'claude.cmd' : 'claude';

const SAFE_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5'];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True iff the child was killed because it exceeded the wall-clock cap. */
  killedByTimeout: boolean;
  /** True when spawn itself failed (e.g. ENOENT — binary not found). */
  spawnError: boolean;
}

/**
 * Promise-wrapped child spawn. Never rejects for a process-level failure — a
 * non-zero exit, a kill, or a spawn ENOENT are all returned in RunResult so the
 * adapter can classify them. Only an unexpected internal error would reject.
 */
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
        // execFile sets err.killed === true when the timeout fired.
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

const AUTH_RE = /(unauthorized|authentication|invalid api key|no api key|not logged in|credential|401|403)/i;
const RATE_RE = /(rate.?limit|quota|429|overloaded|too many requests)/i;

export const claudeAdapter: WorkerAdapter = {
  id: 'claude',
  binary: BINARY,

  safeModels(): string[] {
    return [...SAFE_MODELS];
  },

  async health(model?: string): Promise<HealthResult> {
    const start = Date.now();
    const pinned = model ?? SAFE_MODELS[0];

    // 1. Binary present? Probe the binary via `--version`, which fails ENOENT
    //    (resolved to code 127) when the binary is absent — equivalent to an
    //    empty `command -v claude` but works through execFile (which cannot run
    //    the `command` shell builtin directly).
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

    // 2. Auth present in process env (loaded from secrets.env / agent .env by
    //    agent-pty.ts). health() pins the model explicitly — it never inherits config.
    const hasAuth = Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN
    );
    if (!hasAuth) {
      return {
        available: false,
        reason: 'no-auth',
        detail: 'ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN absent in env',
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

  async execute(input: ExecInput, _ctx: AdapterContext): Promise<ExecResult> {
    const model = input.model ?? SAFE_MODELS[0];

    // Spawn the claude binary directly. The wall-clock cap is enforced by the
    // execFile { timeout, killSignal: 'SIGKILL' } inside run() (which sets
    // killedByTimeout) — NOT a `timeout <secs> claude …` shell wrapper. That
    // wrapper depended on GNU coreutils `timeout`, which is ABSENT on macOS
    // (no `timeout`, no `gtimeout`), so execute() would ENOENT (rc 127) while
    // health() — which only probes the `claude` binary — passes, silently
    // disabling this backstop on a Mac deploy. Mirrors the gemini adapter.
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'json',
      '--model',
      model,
      '--dangerously-skip-permissions',
      '--add-dir',
      input.workdir,
    ];

    const r = await run(BINARY, args, input.timeoutMs);

    // killedByTimeout ⇒ our child_process backstop (SIGKILL) fired on the cap.
    if (r.killedByTimeout) {
      return {
        ok: false,
        failure: 'timeout',
        retryable: true,
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(r.stderr),
        servedModel: model,
      };
    }

    if (r.code === 127 || r.spawnError) {
      return {
        ok: false,
        failure: 'no-binary',
        retryable: false,
        exitCode: 127,
        stderrExcerpt: excerpt(r.stderr || `${BINARY} not found`),
        servedModel: model,
      };
    }

    if (r.code === 0) {
      // Parse the JSON envelope. is_error:true ⇒ process-fail EVEN on exit 0.
      let parsed: { is_error?: boolean; result?: string; usage?: unknown } | null = null;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        return {
          ok: false,
          failure: 'process-fail',
          retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
          exitCode: 0,
          stderrExcerpt: excerpt(r.stdout || r.stderr || 'claude exit 0 but unparseable JSON'),
          servedModel: model,
        };
      }
      if (parsed.is_error === true) {
        return {
          ok: false,
          failure: 'process-fail',
          retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
          exitCode: 0,
          stderrExcerpt: excerpt(typeof parsed.result === 'string' ? parsed.result : r.stdout),
          servedModel: model,
        };
      }
      const usage = extractUsage(parsed.usage);
      return {
        ok: true,
        output: typeof parsed.result === 'string' ? parsed.result : r.stdout,
        retryable: false,
        exitCode: 0,
        servedModel: model,
        ...(usage ? { usage } : {}),
      };
    }

    // rc ≠ 0 ⇒ scan stderr for a finer class.
    const stderr = r.stderr || r.stdout || '';
    if (AUTH_RE.test(stderr)) {
      return {
        ok: false,
        failure: 'no-auth',
        retryable: false,
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(stderr),
        servedModel: model,
      };
    }
    if (RATE_RE.test(stderr)) {
      return {
        ok: false,
        failure: 'rate-limit',
        retryable: true,
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(stderr),
        servedModel: model,
      };
    }
    return {
      ok: false,
      failure: 'process-fail',
      retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
      exitCode: r.code ?? undefined,
      stderrExcerpt: excerpt(stderr),
      servedModel: model,
    };
  },
};

function extractUsage(
  raw: unknown
): { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}
