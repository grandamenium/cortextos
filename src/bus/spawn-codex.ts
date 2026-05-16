/**
 * spawn-codex — bus command that runs a scoped Codex session locally.
 *
 * Usage (CLI):
 *   cortextos bus spawn-codex prompt.md
 *   cortextos bus spawn-codex prompt.md --workdir /path/to/repo --timeout 600
 *   cortextos bus spawn-codex prompt.md --telegram 8567114601 --agent dev
 *
 * How it works:
 *   1. Read the prompt from <prompt-file> (or stdin when `-` is passed)
 *   2. Spawn `codex exec` locally with the prompt piped via stdin
 *   3. Capture stdout as the Codex output
 *   4. Write the result to agents/<agent>/output/<date>-spawn-codex-<slug>.md
 *   5. Optionally send the artifact path to a Telegram chat
 *   6. Emit a `spawn_codex_task` bus event
 *
 * This is the primitive that backs the strip-Claude migration plan: instead of
 * long-running Claude sessions, crons and Telegram dispatchers spawn a fresh
 * Codex session per task via this command.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';

export interface SpawnCodexOptions {
  /** Working directory for the Codex process (defaults to cwd) */
  workdir?: string;
  /** Timeout in seconds (default: 300) */
  timeout?: number;
  /** Agent name — used to determine the output directory */
  agentName?: string;
  /** Root directory containing the agents/ tree (e.g. /home/cortextos/cortextos/orgs/revops-global) */
  agentsRoot?: string;
  /** Optional Telegram chat_id to send the artifact path after completion */
  telegramChatId?: string;
  /** Optional model override — passed as --model (e.g. "o4-mini", "claude-sonnet-4-6") */
  model?: string;
  /** Optional effort level — passed as --effort (e.g. "high", "medium", "low") */
  effort?: string;
  /** Optional MCP config file path — passed as --mcp-config */
  mcpConfig?: string;
}

export interface SpawnCodexResult {
  ok: boolean;
  outputPath?: string;
  output?: string;
  error?: string;
  durationMs: number;
}

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';

/**
 * Derive a short slug from a file path to use in the output filename.
 * e.g. "/tmp/morning-review-prompt.md" → "morning-review-prompt"
 */
function slugFromPath(filePath: string): string {
  return basename(filePath)
    .replace(/\.(md|txt|prompt)$/i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
}

/**
 * Determine the output directory for a given agent.
 * Tries: agentsRoot/agents/<agentName>/output/
 * Falls back to: <cwd>/output/
 */
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

/**
 * Run a scoped Codex session with the given prompt, capture output,
 * write it to the agent's output directory, and return the artifact path.
 */
export function spawnCodex(
  promptFileOrDash: string,
  opts: SpawnCodexOptions = {},
): SpawnCodexResult {
  const start = Date.now();

  // --- Read prompt -------------------------------------------------------
  let prompt: string;
  try {
    if (promptFileOrDash === '-') {
      prompt = readFileSync(process.stdin.fd, 'utf-8');
    } else {
      const absPath = resolve(promptFileOrDash);
      if (!existsSync(absPath)) {
        return { ok: false, error: `Prompt file not found: ${absPath}`, durationMs: 0 };
      }
      prompt = readFileSync(absPath, 'utf-8');
    }
  } catch (err) {
    return { ok: false, error: `Failed to read prompt: ${(err as Error).message}`, durationMs: 0 };
  }

  if (!prompt.trim()) {
    return { ok: false, error: 'Prompt file is empty', durationMs: 0 };
  }

  // --- Build codex exec args ---------------------------------------------
  const timeoutSecs = opts.timeout ?? 300;
  const args: string[] = ['exec'];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.effort) {
    args.push('--effort', opts.effort);
  }

  if (opts.mcpConfig) {
    args.push('--mcp-config', opts.mcpConfig);
  }

  // Allow full disk read access so Codex can read files in the workdir
  args.push('-c', "sandbox_permissions=[\"disk-full-read-access\"]");

  // Prompt as positional argument (avoids stdin-pipe complexity with timeout)
  args.push(prompt);

  // --- Spawn Codex -------------------------------------------------------
  let rawOutput: string;
  try {
    rawOutput = execFileSync(CODEX_BIN, args, {
      cwd: opts.workdir ?? process.cwd(),
      timeout: timeoutSecs * 1000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      encoding: 'utf-8',
      // Close stdin so codex does not wait for interactive input
      input: '',
      env: { ...process.env },
    }) as unknown as string;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) {
      return { ok: false, error: `Codex timed out after ${timeoutSecs}s`, durationMs: Date.now() - start };
    }
    // If Codex exited non-zero but produced stdout, treat it as a partial result
    const stdout = e.stdout ?? '';
    if (!stdout.trim()) {
      const stderr = (e.stderr ?? '').slice(0, 500);
      return { ok: false, error: `codex exec failed: ${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`, durationMs: Date.now() - start };
    }
    rawOutput = stdout;
  }

  const durationMs = Date.now() - start;
  const output = rawOutput.trim();

  // --- Write artifact ----------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  const slug = promptFileOrDash === '-' ? 'stdin' : slugFromPath(promptFileOrDash);
  const filename = `${date}-spawn-codex-${slug}.md`;
  const outputDir = resolveOutputDir(opts.agentsRoot, opts.agentName);
  const outputPath = join(outputDir, filename);

  const header = [
    `# Codex Output — ${slug}`,
    `**Spawned:** ${new Date().toISOString()}`,
    `**Duration:** ${(durationMs / 1000).toFixed(1)}s`,
    `**Model:** ${opts.model ?? 'default'}`,
    `**Workdir:** ${opts.workdir ?? process.cwd()}`,
    '',
    '## Prompt',
    '',
    prompt.length > 2000 ? prompt.slice(0, 2000) + '\n\n_(truncated — see prompt file for full text)_' : prompt,
    '',
    '## Output',
    '',
    output,
  ].join('\n');

  try {
    writeFileSync(outputPath, header, 'utf-8');
  } catch (err) {
    return { ok: false, error: `Failed to write output file: ${(err as Error).message}`, durationMs };
  }

  return { ok: true, outputPath, output, durationMs };
}
