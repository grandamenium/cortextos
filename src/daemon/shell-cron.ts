/**
 * shell-cron.ts — F1-lite: daemon-level shell execution for engine:"shell" crons.
 *
 * WHY
 * ---
 * Before this module, EVERY cron — including ones whose prompt is just
 * `bash some-script.sh` — fired by injecting the prompt text into the agent's
 * Claude PTY session. The agent then burned a full model turn re-typing the
 * command into its Bash tool. For pure-script crons (uptime checks, budget
 * breaker, RSS monitor) the LLM adds nothing: the daemon can run the script
 * directly and save the turn entirely.
 *
 * A cron opts in by setting `"engine": "shell"` in config.json / crons.json.
 * Crons without the field (or with any other value) keep the existing PTY
 * injection path — this module is additive, not a behavior change.
 *
 * EXECUTION CONTRACT
 * ------------------
 * - The prompt is executed as `bash -c <prompt>` with the same CTX_* env,
 *   org secrets.env, and agent .env the PTY session would have, so scripts
 *   behave identically under either dispatch path.
 * - cwd = the agent directory (same default as the PTY).
 * - Exit 0  → resolves; scheduler logs status:"fired" to the execution log.
 * - Nonzero → throws with exit code + stderr tail; the scheduler's existing
 *   retry path (1s/4s/16s) handles it and logs "retried"/"failed" entries,
 *   so failures surface in the execution log and daemon log like any other
 *   failed fire. No new alerting surface.
 * - Timeout (default 5 min) → SIGTERM, then throws. A hung script must never
 *   wedge the scheduler tick.
 *
 * Output handling: stdout is capped and discarded (scripts talk to the world
 * via the bus, not via stdout); stderr's tail is preserved for the error
 * message because that is what you need to debug a failed fire.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, CtxEnv } from '../types/index.js';

/** Default wall-clock limit for a shell cron run. */
export const SHELL_CRON_TIMEOUT_MS = 5 * 60 * 1_000;

/** Max bytes of stderr retained for error reporting (tail wins). */
const STDERR_CAP_BYTES = 4_096;

/**
 * Parse a `KEY=value` env file into the target record (mutates target).
 * Mirrors the PTY loader: skips blanks/comments, first `=` splits key/value.
 */
function loadEnvFile(path: string, target: Record<string, string>): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      target[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
}

/**
 * Build the environment for a shell cron process.
 *
 * Mirrors AgentPTY's env construction (base vars + CTX_* + org secrets.env +
 * agent .env + CHAT_ID/timezone aliases) so a script moved from PTY dispatch
 * to shell dispatch sees the same world. Kept separate from agent-pty.ts on
 * purpose: the PTY builder is private, platform-heavy, and entangled with
 * node-pty concerns; this is the minimal daemon-side equivalent.
 */
export function buildShellCronEnv(env: CtxEnv, config: AgentConfig): Record<string, string> {
  const result: Record<string, string> = {};

  // Base vars a shell script legitimately needs (keychain access via
  // `security` requires HOME; brew-installed tools require PATH).
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']) {
    if (process.env[key]) result[key] = process.env[key]!;
  }

  result['CTX_INSTANCE_ID'] = env.instanceId;
  result['CTX_ROOT'] = env.ctxRoot;
  result['CTX_FRAMEWORK_ROOT'] = env.frameworkRoot;
  result['CTX_AGENT_NAME'] = env.agentName;
  result['CTX_ORG'] = env.org;
  result['CTX_AGENT_DIR'] = env.agentDir;
  result['CTX_PROJECT_ROOT'] = env.projectRoot;

  // Org-shared secrets first, agent .env second — agent-specific keys win
  // (same precedence as the PTY path).
  if (env.org && env.projectRoot) {
    loadEnvFile(join(env.projectRoot, 'orgs', env.org, 'secrets.env'), result);
  }
  if (env.agentDir) {
    loadEnvFile(join(env.agentDir, '.env'), result);
  }

  if (result['CHAT_ID']) {
    result['CTX_TELEGRAM_CHAT_ID'] = result['CHAT_ID'];
  }
  const tz = config.timezone ?? process.env.TZ;
  if (tz) {
    result['CTX_TIMEZONE'] = tz;
    result['TZ'] = tz;
  }

  // CTX_ORCHESTRATOR_AGENT from org context.json (parity with the PTY env —
  // scripts route escalations via `bus send-message $CTX_ORCHESTRATOR_AGENT`).
  if (env.org && env.projectRoot) {
    try {
      const contextPath = join(env.projectRoot, 'orgs', env.org, 'context.json');
      if (existsSync(contextPath)) {
        const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (ctx.orchestrator) {
          result['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
        }
      }
    } catch { /* leave unset if context.json is missing or malformed */ }
  }

  return result;
}

export interface ShellCronResult {
  exitCode: number;
  durationMs: number;
}

/**
 * Run a shell cron prompt to completion.
 *
 * Resolves on exit 0. Throws on nonzero exit, spawn failure, or timeout —
 * the error message carries the exit code and the stderr tail so the
 * scheduler's execution-log entry is debuggable on its own.
 */
export function executeShellCron(
  prompt: string,
  opts: {
    env: Record<string, string>;
    cwd: string;
    timeoutMs?: number;
  },
): Promise<ShellCronResult> {
  const timeoutMs = opts.timeoutMs ?? SHELL_CRON_TIMEOUT_MS;
  const start = Date.now();

  return new Promise<ShellCronResult>((resolve, reject) => {
    // detached:true puts bash in its OWN process group so kill paths can
    // signal the whole group (-pid) — otherwise grandchildren that survive
    // their parent are unkillable orphans (tez audit, PR #7 finding 1).
    const child = spawn('bash', ['-c', prompt], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });

    /** Signal the child's entire process group; fall back to the pid alone. */
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    let stderrTail = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Escalate if SIGTERM is ignored — the scheduler must get its thread back.
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-STDERR_CAP_BYTES);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`shell cron spawn failed: ${err.message}`));
    });

    // Settle on 'exit', NOT 'close' (tez audit, PR #7 finding 1): 'close'
    // additionally waits for the stdio pipes to drain, and a backgrounded
    // grandchild that inherits stderr holds the pipe open indefinitely —
    // bash exits, the promise never settles, the scheduler's `firing` flag
    // sticks, and the cron silently never fires again. 'exit' fires when
    // bash itself terminates, which is the contract we actually want.
    // One macrotask of grace lets already-delivered stderr chunks land
    // before we build the error message (best-effort tail, not a sync).
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (timedOut) {
          reject(new Error(
            `shell cron timed out after ${timeoutMs}ms (killed with ${signal ?? 'SIGTERM'})` +
            (stderrTail ? ` — stderr tail: ${stderrTail.trim()}` : ''),
          ));
          return;
        }
        if (code !== 0) {
          reject(new Error(
            `shell cron exited ${code ?? `signal:${signal}`}` +
            (stderrTail ? ` — stderr tail: ${stderrTail.trim()}` : ''),
          ));
          return;
        }
        resolve({ exitCode: 0, durationMs });
      }, 25);
    });
  });
}
