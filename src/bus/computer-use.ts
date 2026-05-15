/**
 * computer-use — bus command that dispatches a prompt to Codex on Greg's Mac
 * via SSH and the codex-dispatch.sh script, which runs Codex non-interactively
 * with the @Computer Use plugin.
 *
 * Usage (CLI):
 *   cortextos bus computer-use "take a screenshot and describe what you see"
 *   cortextos bus computer-use --no-plugin "just a regular Codex task"
 *   cortextos bus computer-use --workdir /path/to/repo "refactor this file"
 *   cortextos bus computer-use --timeout 120 "slow task"
 *
 * How it works:
 *   1. SSH to Greg's Mac (gregs-mac / 100.84.86.6 via Tailscale)
 *   2. Run ~/work/team-brain/scripts/codex-dispatch.sh with the prompt
 *   3. codex-dispatch.sh invokes `codex exec` with the Computer Use plugin
 *      reference ([@Computer Use](plugin://computer-use@openai-bundled))
 *   4. Codex runs the task non-interactively and writes the last message to stdout
 *   5. The result is returned and logged as a computer_use_task event
 *
 * Fallback chain (Mac SSH → localhost Codex CLI):
 *   When SSH to the Mac fails with a connection-level error (host unreachable,
 *   ConnectTimeout, EHOSTUNREACH, etc.), the function falls back to running
 *   `codex exec --json` locally on the cortex VM. This fallback only applies
 *   to code-only tasks (noPlugin=true). Tasks that require the @Computer Use
 *   plugin (screen capture, mouse, macOS GUI) fail fast with a clear error —
 *   running them locally would silently degrade without display access.
 *
 * Orgo-first gate:
 *   Mac SSH is now a fallback path, not the default path for browser/UI work.
 *   Calls targeting Greg's Mac must include a recent (<10 minutes) failed Orgo
 *   lease attempt artifact via --orgo-failure-artifact or
 *   CORTEXTOS_ORGO_FAILURE_ARTIFACT before SSH is attempted.
 *
 * Notes on Computer Use via SSH:
 *   Screen-capture and mouse tools require a macOS display session. When invoked
 *   over SSH, those specific calls fail gracefully and Codex falls back to shell
 *   commands. For most useful tasks (file ops, code, app control via shell) this
 *   works fine. Tasks needing actual screen pixels must be run in the Mac's GUI
 *   session (future: launchd wrapper).
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';

/**
 * Shell-safe single-quote escape for a string value used inside a remote
 * shell command. Wraps in single quotes and escapes any embedded single
 * quotes as '\''.
 */
function shellEscapeSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the remote shell command string sent to the Mac via SSH.
 *
 * The prompt is base64-encoded before embedding so that any content
 * (curly braces, single quotes, double quotes, $-variables, backticks,
 * newlines) survives the remote shell without interpretation.
 * base64 only contains [A-Za-z0-9+/=] — safe inside any shell context.
 *
 * Without this encoding, a prompt like 'do X with { type: object }' causes
 * zsh to throw "parse error near }" because SSH joins trailing arguments
 * into a single command string that the remote shell interprets literally.
 */
function buildRemoteCommand(
  dispatchScript: string,
  opts: Pick<ComputerUseOptions, 'noPlugin' | 'workdir' | 'timeout'>,
  prompt: string,
): string {
  const parts: string[] = [dispatchScript];
  if (opts.noPlugin) parts.push('--no-plugin');
  if (opts.workdir) parts.push('--workdir', shellEscapeSingleQuote(opts.workdir));
  parts.push('--timeout', String(opts.timeout ?? 300));
  // base64-encode the prompt; decode on the remote side with printf + base64 -d.
  // printf '%s' avoids the trailing-newline that `echo` would add.
  const promptB64 = Buffer.from(prompt, 'utf-8').toString('base64');
  parts.push(`"$(printf '%s' ${promptB64} | base64 -d)"`);
  return parts.join(' ');
}

export interface ComputerUseOptions {
  /** Skip the @Computer Use plugin prefix — send a plain Codex prompt */
  noPlugin?: boolean;
  /** Working directory for Codex on the Mac (or locally when fallback is used) */
  workdir?: string;
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** SSH host (default: gregs-mac) */
  sshHost?: string;
  /** Path to codex-dispatch.sh on the Mac */
  dispatchScript?: string;
  /** Disable localhost codex exec fallback when Mac SSH is unreachable (default: fallback enabled) */
  noFallback?: boolean;
  /** Path to recent failed Orgo lease attempt artifact required before Mac SSH fallback */
  orgoFailureArtifact?: string;
}

export interface ComputerUseResult {
  ok: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  /** True if the localhost codex exec fallback was used instead of Mac SSH */
  usedFallback?: boolean;
}

const DEFAULT_SSH_HOST = 'gregs-mac';
const DEFAULT_DISPATCH_SCRIPT = '/Users/gregharned/work/team-brain/scripts/codex-dispatch.sh';
const DEFAULT_MAC_CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const GREGS_MAC_TAILSCALE_IP = '100.84.86.6';
const ORGO_FAILURE_ARTIFACT_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Patterns that indicate an SSH connection-level failure (not a task failure).
 * Only these errors should trigger the localhost fallback.
 */
const SSH_CONNECTION_ERROR_PATTERNS = [
  /connect to host .* port \d+: (Connection refused|No route to host|Network is unreachable)/i,
  /ssh: connect to host .* port \d+: Operation timed out/i,
  /ConnectTimeout/i,
  /Connection timed out/i,
  /No such host/i,
  /Temporary failure in name resolution/i,
  /EHOSTUNREACH/i,
  /ECONNREFUSED/i,
  /ssh_exchange_identification: Connection closed/i,
  /kex_exchange_identification: Connection closed/i,
];

function isSshConnectionError(msg: string): boolean {
  return SSH_CONNECTION_ERROR_PATTERNS.some((re) => re.test(msg));
}

function isMacSshHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === DEFAULT_SSH_HOST || normalized === GREGS_MAC_TAILSCALE_IP;
}

function validateRecentOrgoFailureArtifact(artifactPath?: string): string | null {
  if (!artifactPath) {
    return 'Mac SSH fallback blocked — provide --orgo-failure-artifact <path> pointing to a failed Orgo lease attempt from the last 10 minutes.';
  }

  try {
    const stat = statSync(artifactPath);
    if (!stat.isFile()) {
      return `Mac SSH fallback blocked — Orgo failure artifact is not a file: ${artifactPath}`;
    }

    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > ORGO_FAILURE_ARTIFACT_MAX_AGE_MS) {
      const ageMinutes = Math.round(ageMs / 60_000);
      return `Mac SSH fallback blocked — Orgo failure artifact is ${ageMinutes} minutes old; maximum age is 10 minutes: ${artifactPath}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Mac SSH fallback blocked — cannot read Orgo failure artifact ${artifactPath}: ${msg}`;
  }

  return null;
}

function resolveLocalCodexBin(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (existsSync(DEFAULT_MAC_CODEX_BIN)) return DEFAULT_MAC_CODEX_BIN;
  return 'codex';
}

function parseCodexExecOutput(raw: string): { output: string; exitCode: number } {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed) as { message?: string; exit_code?: number };
    return {
      output: parsed.message ?? trimmed,
      exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : 0,
    };
  } catch {
    // Newer Codex CLI --json emits newline-delimited events. Ignore non-JSON
    // warning lines and return the final agent message when one is present.
  }

  const messages: string[] = [];
  let exitCode = 0;
  let sawJsonEvent = false;

  for (const line of trimmed.split(/\r?\n/)) {
    const eventText = line.trim();
    if (!eventText) continue;

    try {
      const event = JSON.parse(eventText) as {
        exit_code?: number;
        message?: string;
        item?: { type?: string; text?: string };
      };
      sawJsonEvent = true;

      if (typeof event.exit_code === 'number') {
        exitCode = event.exit_code;
      }
      if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        messages.push(event.item.text);
      } else if (typeof event.message === 'string') {
        messages.push(event.message);
      }
    } catch {
      // Keep scanning; Codex may interleave warning lines with JSON events.
    }
  }

  if (messages.length > 0) {
    return { output: messages[messages.length - 1], exitCode };
  }

  return { output: trimmed, exitCode: sawJsonEvent ? exitCode : 0 };
}

export async function computerUse(
  prompt: string,
  opts: ComputerUseOptions = {},
): Promise<ComputerUseResult> {
  const sshHost = opts.sshHost ?? DEFAULT_SSH_HOST;
  const dispatchScript = opts.dispatchScript ?? DEFAULT_DISPATCH_SCRIPT;
  const timeoutSec = opts.timeout ?? 300;
  const start = Date.now();
  const orgoFailureArtifact = opts.orgoFailureArtifact ?? process.env.CORTEXTOS_ORGO_FAILURE_ARTIFACT;

  if (isMacSshHost(sshHost)) {
    const artifactError = validateRecentOrgoFailureArtifact(orgoFailureArtifact);
    if (artifactError) {
      return {
        ok: false,
        error: artifactError,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    }
  }

  // Build the remote command with base64-encoded prompt (see buildRemoteCommand).
  const remoteCmd = buildRemoteCommand(dispatchScript, opts, prompt);

  // SSH options:
  //   StrictHostKeyChecking=accept-new — TOFU semantics (accepts new host keys,
  //     rejects changed ones); safer than =no which silently accepts MITM keys.
  //   ServerAliveInterval/CountMax — detect dead connections after ~60s instead
  //     of hanging silently for the full timeoutSec wall-clock window.
  const sshArgs = [
    '-n',  // do not read from stdin — prevents codex exec from blocking on piped stdin
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=2',
    sshHost,
    remoteCmd,
  ];

  try {
    const output = execFileSync('ssh', sshArgs, {
      timeout: timeoutSec * 1000, // honour caller's --timeout exactly
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      ok: true,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errObj = err as NodeJS.ErrnoException;
    const msg = errObj instanceof Error ? errObj.message : String(err);

    // Node execFileSync fires ETIMEDOUT when the caller-specified timeout expires.
    // This is a clean timeout, not an SSH connection error — return immediately
    // with a descriptive message so callers can distinguish timeout from failure.
    if (errObj.code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT')) {
      // Best-effort: kill orphaned codex-dispatch.sh + codex exec on the remote host.
      // Non-fatal — if SSH is unavailable the orphans will die when the Mac session ends.
      try {
        execFileSync('ssh', [
          '-n', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', sshHost,
          'pkill -f "codex-dispatch.sh" 2>/dev/null; pkill -f "codex exec --dangerously" 2>/dev/null; true',
        ], { timeout: 8_000, encoding: 'utf-8' });
      } catch { /* non-fatal */ }

      return {
        ok: false,
        error: `computer-use timed out after ${timeoutSec}s — remote codex exec may still be running on ${sshHost}`,
        durationMs: Date.now() - start,
      };
    }

    // Only attempt fallback on connection-level SSH failures
    if (!isSshConnectionError(msg)) {
      return {
        ok: false,
        error: msg,
        durationMs: Date.now() - start,
      };
    }

    // Log the SSH failure before attempting fallback
    try {
      execFileSync('cortextos', ['bus', 'log-event', 'action', 'computer_use_ssh_failure', 'warning',
        '--meta', JSON.stringify({ host: sshHost, reason: msg.slice(0, 200), promptLength: prompt.length })],
        { encoding: 'utf-8', timeout: 10_000 });
    } catch { /* non-fatal — continue to fallback decision */ }

    // Computer-use tasks (noPlugin=false) require a Mac display session.
    // Running locally would silently degrade — fail fast with a clear message.
    if (!opts.noPlugin) {
      return {
        ok: false,
        error: `Mac SSH unreachable (${sshHost}) — computer-use tasks require Mac display session. Use --no-plugin for code-only tasks that can run on cortex VM.`,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    }

    // Fallback disabled by caller
    if (opts.noFallback) {
      return {
        ok: false,
        error: `Mac SSH unreachable (${sshHost}) — fallback disabled.`,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    }

    // Fallback: run codex exec --json locally on the cortex VM
    try {
      const codexBin = resolveLocalCodexBin();
      const raw = execFileSync(codexBin, ['exec', '--json', prompt], {
        timeout: timeoutSec * 1000,
        encoding: 'utf-8',
        cwd: opts.workdir,
        maxBuffer: 10 * 1024 * 1024,
      });

      let output: string;
      const parsed = parseCodexExecOutput(raw);
      if (parsed.exitCode !== 0) {
        return {
          ok: false,
          error: `codex exec exited with code ${parsed.exitCode}: ${parsed.output}`,
          durationMs: Date.now() - start,
          usedFallback: true,
        };
      }
      output = parsed.output;

      // Log successful fallback use
      try {
        execFileSync('cortextos', ['bus', 'log-event', 'action', 'computer_use_fallback', 'info',
          '--meta', JSON.stringify({ promptLength: prompt.length, durationMs: Date.now() - start, ok: true })],
          { encoding: 'utf-8', timeout: 10_000 });
      } catch { /* non-fatal */ }

      return {
        ok: true,
        output,
        durationMs: Date.now() - start,
        usedFallback: true,
      };
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      return {
        ok: false,
        error: `Mac SSH unreachable; localhost codex exec also failed: ${fallbackMsg}`,
        durationMs: Date.now() - start,
        usedFallback: true,
      };
    }
  }
}
