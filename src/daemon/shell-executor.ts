/**
 * shell-executor.ts — Direct shell execution for mechanical cron tasks.
 *
 * Runs the cron prompt as a shell script. No LLM involved.
 * For crons that are pure if/then logic with bus commands.
 */

import { execSync } from 'child_process';
import type { CronDefinition } from '../types/index.js';

type LogFn = (msg: string) => void;

export interface ShellExecutorOptions {
  logger?: LogFn;
}

export class ShellExecutor {
  private readonly log: LogFn;

  constructor(opts: ShellExecutorOptions = {}) {
    this.log = opts.logger ?? console.log;
  }

  async execute(cron: CronDefinition, agentName: string, env: Record<string, string> = {}): Promise<void> {
    this.log(`[shell] Executing cron "${cron.name}" for ${agentName}`);
    const script = cron.prompt;

    try {
      const output = execSync(script, {
        timeout: 60_000,
        encoding: 'utf-8',
        shell: '/bin/bash',
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      });

      if (output.trim()) {
        this.log(`[shell] "${cron.name}" output: ${output.trim().slice(0, 500)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Shell cron "${cron.name}" failed: ${msg.slice(0, 300)}`);
    }
  }
}
