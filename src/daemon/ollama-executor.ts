/**
 * ollama-executor.ts — Local Ollama model executor for lightweight cron tasks.
 *
 * Routes cron prompts to a locally-running Ollama instance instead of
 * injecting them into the Claude Code PTY. Gathers context via shell
 * commands, sends the assembled prompt to Ollama, parses output for
 * `cortextos bus` commands, and executes them.
 *
 * Only whitelisted commands (`cortextos bus ...`) are executed from
 * Ollama output — arbitrary shell commands are rejected.
 */

import { execSync } from 'child_process';
import type { CronDefinition } from '../types/index.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma4:e4b';
const REQUEST_TIMEOUT_MS = 120_000;

const ALLOWED_COMMAND_PREFIXES = [
  'cortextos bus update-heartbeat',
  'cortextos bus check-inbox',
  'cortextos bus ack-inbox',
  'cortextos bus read-all-heartbeats',
  'cortextos bus list-approvals',
  'cortextos bus list-tasks',
  'cortextos bus send-telegram',
  'cortextos bus send-message',
  'cortextos bus log-event',
  'cortextos bus update-task',
  'cortextos bus complete-task',
  'cortextos bus kb-ingest',
];

type LogFn = (msg: string) => void;

export interface OllamaExecutorOptions {
  ollamaUrl?: string;
  defaultModel?: string;
  logger?: LogFn;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export class OllamaExecutor {
  private readonly url: string;
  private readonly defaultModel: string;
  private readonly log: LogFn;

  constructor(opts: OllamaExecutorOptions = {}) {
    this.url = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.log = opts.logger ?? console.log;
  }

  async execute(cron: CronDefinition, agentName: string, env: Record<string, string> = {}): Promise<void> {
    const model = cron.ollama_model ?? this.defaultModel;
    this.log(`[ollama] Executing cron "${cron.name}" for ${agentName} via ${model}`);

    const context = this.gatherContext(cron.context_commands ?? [], env);

    const prompt = this.buildPrompt(cron, context, agentName);
    const systemPrompt = cron.system_prompt ?? this.defaultSystemPrompt(agentName);

    const response = await this.callOllama(model, systemPrompt, prompt);

    const commands = this.parseCommands(response);
    this.log(`[ollama] "${cron.name}" response: ${commands.length} command(s) extracted`);

    for (const cmd of commands) {
      this.executeCommand(cmd, env);
    }
  }

  private gatherContext(commands: string[], env: Record<string, string>): string {
    if (commands.length === 0) return '';

    const sections: string[] = [];
    for (const cmd of commands) {
      try {
        const output = execSync(cmd, {
          timeout: 30_000,
          encoding: 'utf-8',
          env: { ...process.env, ...env },
          maxBuffer: 512 * 1024,
        }).trim();
        sections.push(`$ ${cmd}\n${output}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sections.push(`$ ${cmd}\n[ERROR: ${msg}]`);
      }
    }
    return sections.join('\n\n');
  }

  private buildPrompt(cron: CronDefinition, context: string, agentName: string): string {
    const parts: string[] = [];
    parts.push(`CRON: ${cron.name}`);
    parts.push(`AGENT: ${agentName}`);
    parts.push(`TIME: ${new Date().toISOString()}`);
    parts.push('');
    parts.push(`TASK: ${cron.prompt}`);

    if (context) {
      parts.push('');
      parts.push('CONTEXT (command outputs):');
      parts.push(context);
    }

    parts.push('');
    parts.push('Respond with the bus commands to execute, each on its own line prefixed with $.');
    parts.push('Example: $ cortextos bus update-heartbeat "status summary here"');
    parts.push('Only use cortextos bus commands. Do not use any other shell commands.');

    return parts.join('\n');
  }

  private defaultSystemPrompt(agentName: string): string {
    return [
      `You are a lightweight task executor for the cortextOS agent "${agentName}".`,
      'You receive context from bus commands and respond with bus commands to execute.',
      'Keep responses brief. Only output $ command lines and short reasoning.',
      'Never output commands outside of the cortextos bus namespace.',
    ].join(' ');
  }

  private async callOllama(model: string, system: string, prompt: string): Promise<string> {
    const body = JSON.stringify({
      model,
      system,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 1024,
      },
    });

    const response = await fetch(`${this.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Ollama API returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    if (data.eval_count !== undefined) {
      this.log(`[ollama] tokens: ${data.eval_count}, duration: ${Math.round((data.total_duration ?? 0) / 1e6)}ms`);
    }

    return data.response;
  }

  parseCommands(response: string): string[] {
    const commands: string[] = [];
    const lines = response.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Match "$ cortextos bus ..." or "```\ncortextos bus ...\n```"
      let cmd: string | null = null;
      if (trimmed.startsWith('$ ')) {
        cmd = trimmed.slice(2).trim();
      } else if (trimmed.startsWith('cortextos bus ')) {
        cmd = trimmed;
      }

      if (!cmd) continue;

      if (this.isAllowedCommand(cmd)) {
        commands.push(cmd);
      } else {
        this.log(`[ollama] BLOCKED disallowed command: ${cmd.slice(0, 100)}`);
      }
    }

    return commands;
  }

  private isAllowedCommand(cmd: string): boolean {
    return ALLOWED_COMMAND_PREFIXES.some(prefix => cmd.startsWith(prefix));
  }

  private executeCommand(cmd: string, env: Record<string, string>): void {
    this.log(`[ollama] EXEC: ${cmd.slice(0, 120)}`);
    try {
      const output = execSync(cmd, {
        timeout: 30_000,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        maxBuffer: 512 * 1024,
      });
      if (output.trim()) {
        this.log(`[ollama]   -> ${output.trim().slice(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[ollama]   -> ERROR: ${msg.slice(0, 200)}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
