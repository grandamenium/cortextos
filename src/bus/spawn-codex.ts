/**
 * spawn-codex — run a scoped Codex session locally and persist proof.
 *
 * This is the primitive for replacing long-running agent REPLs with bounded
 * jobs: a cron or dispatcher writes a prompt file, calls this command, records
 * the artifact + JSON sidecar, and exits.
 */

import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import {
  appendAgentLiveLog,
  createAgentLiveStateHandle,
  mirrorAgentLiveState,
  writeAgentLiveManifest,
} from './agent-live-state.js';

export interface SpawnCodexOptions {
  workdir?: string;
  timeout?: number;
  agentName?: string;
  agentsRoot?: string;
  telegramChatId?: string;
  model?: string;
  effort?: string;
  mcpConfig?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  taskId?: string;
  requester?: string;
  replyTo?: string;
  priority?: string;
}

export interface SpawnCodexRunMetadata {
  ok: boolean;
  status: 'success' | 'failed' | 'timed_out';
  run_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  prompt_file: string;
  prompt_sha256: string;
  prompt_chars: number;
  artifact_path: string;
  sidecar_path: string;
  workdir: string;
  agent: string | null;
  task_id: string | null;
  requester: string | null;
  reply_to: string | null;
  priority: string | null;
  model: string | null;
  effort: string | null;
  mcp_config: string | null;
  sandbox: string | null;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timed_out: boolean;
  };
  timed_out: boolean;
  stdout_chars: number;
  stdout: string;
  stderr: string;
  stderr_excerpt: string | null;
  output_collision_guard: 'created' | 'renamed';
}

export interface SpawnCodexResult {
  ok: boolean;
  status: SpawnCodexRunMetadata['status'];
  outputPath: string;
  sidecarPath: string;
  output: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  metadata: SpawnCodexRunMetadata;
}

function codexBin(): string {
  return process.env.CODEX_BIN ?? 'codex';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function slugFromPath(filePath: string): string {
  return basename(filePath)
    .replace(/\.(md|txt|prompt)$/i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'prompt';
}

function resolveOutputDir(agentsRoot?: string, agentName?: string): string {
  if (agentsRoot && agentName) {
    const dir = join(agentsRoot, 'agents', agentName, 'output');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = join(process.cwd(), 'output');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runId(startedAtMs: number, prompt: string): string {
  const timestamp = new Date(startedAtMs).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${sha256(`${timestamp}:${prompt}`).slice(0, 8)}`;
}

function outputPaths(outputDir: string, suffix: string): { outputPath: string; sidecarPath: string; guard: 'created' | 'renamed' } {
  let outputPath = join(outputDir, `${suffix}.md`);
  let sidecarPath = join(outputDir, `${suffix}.json`);
  if (!existsSync(outputPath) && !existsSync(sidecarPath)) {
    return { outputPath, sidecarPath, guard: 'created' };
  }

  for (let i = 2; i < 1000; i += 1) {
    outputPath = join(outputDir, `${suffix}-${i}.md`);
    sidecarPath = join(outputDir, `${suffix}-${i}.json`);
    if (!existsSync(outputPath) && !existsSync(sidecarPath)) {
      return { outputPath, sidecarPath, guard: 'renamed' };
    }
  }

  throw new Error(`Could not allocate unique spawn-codex output path for ${suffix}`);
}

function readPrompt(promptFileOrDash: string): { prompt: string; promptPath: string } {
  if (promptFileOrDash === '-') {
    return { prompt: readFileSync(process.stdin.fd, 'utf-8'), promptPath: '-' };
  }

  const promptPath = resolve(promptFileOrDash);
  if (!existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }
  return { prompt: readFileSync(promptPath, 'utf-8'), promptPath };
}

export function spawnCodex(promptFileOrDash: string, opts: SpawnCodexOptions = {}): SpawnCodexResult {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { prompt, promptPath } = readPrompt(promptFileOrDash);

  if (!prompt.trim()) {
    throw new Error('Prompt file is empty');
  }

  const timeoutSecs = opts.timeout ?? 300;
  const workdir = opts.workdir ?? process.cwd();
  const args = ['exec'];

  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.effort) {
    args.push('--effort', opts.effort);
  }
  if (opts.mcpConfig) {
    args.push('--mcp-config', opts.mcpConfig);
  }
  if (opts.sandbox) {
    args.push('--sandbox', opts.sandbox);
  }

  args.push(prompt);

  const run = spawnSync(codexBin(), args, {
    cwd: workdir,
    timeout: timeoutSecs * 1000,
    input: '',
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });

  const completedAtMs = Date.now();
  const durationMs = completedAtMs - startedAtMs;
  const stdout = (run.stdout ?? '').toString();
  const stderr = (run.stderr ?? '').toString();
  const timedOut = Boolean(run.error && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
  const exitCode = typeof run.status === 'number' ? run.status : null;
  const exitSignal = run.signal ?? null;
  const ok = !timedOut && exitCode === 0;
  const status: SpawnCodexRunMetadata['status'] = timedOut ? 'timed_out' : ok ? 'success' : 'failed';
  const id = runId(startedAtMs, prompt);

  const date = new Date().toISOString().slice(0, 10);
  const slug = promptFileOrDash === '-' ? 'stdin' : slugFromPath(promptFileOrDash);
  const suffix = `${date}-spawn-codex-${slug}-${id}`;
  const outputDir = resolveOutputDir(opts.agentsRoot, opts.agentName);
  const { outputPath, sidecarPath, guard } = outputPaths(outputDir, suffix);
  const liveState = createAgentLiveStateHandle({
    ctxRoot: process.env.CTX_ROOT,
    org: process.env.CTX_ORG,
    agent: opts.agentName,
    taskId: opts.taskId,
  });

  const metadata: SpawnCodexRunMetadata = {
    ok,
    status,
    run_id: id,
    started_at: startedAt,
    completed_at: new Date(completedAtMs).toISOString(),
    duration_ms: durationMs,
    prompt_file: promptPath,
    prompt_sha256: sha256(prompt),
    prompt_chars: prompt.length,
    artifact_path: outputPath,
    sidecar_path: sidecarPath,
    workdir,
    agent: opts.agentName ?? null,
    task_id: opts.taskId ?? null,
    requester: opts.requester ?? null,
    reply_to: opts.replyTo ?? null,
    priority: opts.priority ?? null,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    mcp_config: opts.mcpConfig ?? null,
    sandbox: opts.sandbox ?? null,
    exit_code: exitCode,
    exit_signal: exitSignal,
    exit: {
      code: exitCode,
      signal: exitSignal,
      timed_out: timedOut,
    },
    timed_out: timedOut,
    stdout_chars: stdout.length,
    stdout,
    stderr,
    stderr_excerpt: stderr.trim() ? stderr.trim().slice(0, 1000) : null,
    output_collision_guard: guard,
  };

  const artifact = [
    `# Codex Output - ${slug}`,
    '',
    `**Status:** ${status}`,
    `**Spawned:** ${metadata.started_at}`,
    `**Completed:** ${metadata.completed_at}`,
    `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
    `**Task:** ${opts.taskId ?? 'none'}`,
    `**Requester:** ${opts.requester ?? 'none'}`,
    `**Model:** ${opts.model ?? 'default'}`,
    `**Effort:** ${opts.effort ?? 'default'}`,
    `**Sandbox:** ${opts.sandbox ?? 'default'}`,
    `**Workdir:** ${workdir}`,
    '',
    '## Prompt',
    '',
    prompt.length > 2000 ? `${prompt.slice(0, 2000)}\n\n_(truncated; see prompt file for full text)_` : prompt,
    '',
    '## Output',
    '',
    stdout.trim() || '(no stdout)',
    '',
    ...(stderr.trim() ? ['## Stderr', '', stderr.trim().slice(0, 4000)] : []),
  ].join('\n');

  writeFileSync(outputPath, `${artifact}\n`, 'utf-8');
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  if (liveState) {
    writeFileSync(liveState.files.log, `${stdout.trim() || '(no stdout)'}\n`, 'utf-8');
    writeAgentLiveManifest(liveState, { status, completed_at: metadata.completed_at });
    void mirrorAgentLiveState(liveState);
  }

  return {
    ok,
    status,
    outputPath,
    sidecarPath,
    output: stdout.trim(),
    stderr,
    exitCode,
    timedOut,
    durationMs,
    metadata,
  };
}

/**
 * Async variant of spawnCodex — identical behaviour but uses child_process.spawn
 * instead of spawnSync so the Node.js event loop is NOT blocked while Codex runs.
 *
 * Use this from the daemon (cron-fire-dispatch) where blocking the main event loop
 * causes fleet-wide stall watchdog false-positives and IPC timeouts.
 */
export async function spawnCodexAsync(promptFileOrDash: string, opts: SpawnCodexOptions = {}): Promise<SpawnCodexResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { prompt, promptPath } = readPrompt(promptFileOrDash);

  if (!prompt.trim()) {
    throw new Error('Prompt file is empty');
  }

  const timeoutSecs = opts.timeout ?? 300;
  const workdir = opts.workdir ?? process.cwd();
  const args = ['exec'];
  const liveState = createAgentLiveStateHandle({
    ctxRoot: process.env.CTX_ROOT,
    org: process.env.CTX_ORG,
    agent: opts.agentName,
    taskId: opts.taskId,
  });
  if (liveState) {
    writeAgentLiveManifest(liveState, {
      status: 'running',
      started_at: startedAt,
      prompt_file: promptPath,
    });
    await mirrorAgentLiveState(liveState);
  }

  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  if (opts.sandbox) args.push('--sandbox', opts.sandbox);

  args.push(prompt);

  const { stdout, stderr, exitCode, exitSignal, timedOut } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const child = spawn(codexBin(), args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    child.stdin.end('');
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let lastMirrorAt = 0;
    const mirrorLive = () => {
      if (!liveState) return;
      const now = Date.now();
      if (now - lastMirrorAt < 2500) return;
      lastMirrorAt = now;
      void mirrorAgentLiveState(liveState);
    };
    child.stdout.on('data', (d: string) => {
      stdoutBuf += d;
      if (liveState) appendAgentLiveLog(liveState, d);
      mirrorLive();
    });
    child.stderr.on('data', (d: string) => {
      stderrBuf += d;
      if (liveState) appendAgentLiveLog(liveState, d);
      mirrorLive();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, exitSignal: null, timedOut: true });
      }
    }, timeoutSecs * 1000);

    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code,
          exitSignal: signal as NodeJS.Signals | null,
          timedOut: false,
        });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stderrBuf += `\nspawn error: ${err.message}`;
        resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: null, exitSignal: null, timedOut: false });
      }
    });
  });

  const completedAtMs = Date.now();
  const durationMs = completedAtMs - startedAtMs;
  const ok = !timedOut && exitCode === 0;
  const status: SpawnCodexRunMetadata['status'] = timedOut ? 'timed_out' : ok ? 'success' : 'failed';
  const id = runId(startedAtMs, prompt);

  const date = new Date().toISOString().slice(0, 10);
  const slug = promptFileOrDash === '-' ? 'stdin' : slugFromPath(promptFileOrDash);
  const suffix = `${date}-spawn-codex-${slug}-${id}`;
  const outputDir = resolveOutputDir(opts.agentsRoot, opts.agentName);
  const { outputPath, sidecarPath, guard } = outputPaths(outputDir, suffix);

  const metadata: SpawnCodexRunMetadata = {
    ok, status, run_id: id, started_at: startedAt,
    completed_at: new Date(completedAtMs).toISOString(), duration_ms: durationMs,
    prompt_file: promptPath, prompt_sha256: sha256(prompt), prompt_chars: prompt.length,
    artifact_path: outputPath, sidecar_path: sidecarPath, workdir,
    agent: opts.agentName ?? null, task_id: opts.taskId ?? null,
    requester: opts.requester ?? null, reply_to: opts.replyTo ?? null,
    priority: opts.priority ?? null, model: opts.model ?? null,
    effort: opts.effort ?? null, mcp_config: opts.mcpConfig ?? null,
    sandbox: opts.sandbox ?? null, exit_code: exitCode, exit_signal: exitSignal,
    exit: { code: exitCode, signal: exitSignal, timed_out: timedOut },
    timed_out: timedOut, stdout_chars: stdout.length, stdout, stderr,
    stderr_excerpt: stderr.trim() ? stderr.trim().slice(0, 1000) : null,
    output_collision_guard: guard,
  };

  const artifact = [
    `# Codex Output - ${slug}`, '',
    `**Status:** ${status}`, `**Spawned:** ${metadata.started_at}`,
    `**Completed:** ${metadata.completed_at}`,
    `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
    `**Task:** ${opts.taskId ?? 'none'}`, `**Requester:** ${opts.requester ?? 'none'}`,
    `**Model:** ${opts.model ?? 'default'}`, `**Effort:** ${opts.effort ?? 'default'}`,
    `**Sandbox:** ${opts.sandbox ?? 'default'}`, `**Workdir:** ${workdir}`, '',
    '## Prompt', '',
    prompt.length > 2000 ? `${prompt.slice(0, 2000)}\n\n_(truncated; see prompt file for full text)_` : prompt,
    '', '## Output', '', stdout.trim() || '(no stdout)', '',
    ...(stderr.trim() ? ['## Stderr', '', stderr.trim().slice(0, 4000)] : []),
  ].join('\n');

  writeFileSync(outputPath, `${artifact}\n`, 'utf-8');
  writeFileSync(sidecarPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
  if (liveState) {
    writeAgentLiveManifest(liveState, { status, completed_at: metadata.completed_at });
    await mirrorAgentLiveState(liveState);
  }

  return { ok, status, outputPath, sidecarPath, output: stdout.trim(), stderr, exitCode, timedOut, durationMs, metadata };
}
