import { join, resolve } from 'path';
import type { CronDefinition } from '../types/index.js';
import { spawnCodex, type SpawnCodexResult } from '../bus/spawn-codex.js';

type SpawnCodexFn = typeof spawnCodex;

export interface CronFireDispatchOptions {
  agentName: string;
  frameworkRoot: string;
  org: string;
  injectAgent: (agentName: string, message: string) => boolean;
  spawnCodexImpl?: SpawnCodexFn;
  now?: () => Date;
}

function metadataString(cron: CronDefinition, key: string): string | undefined {
  const value = cron.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataNumber(cron: CronDefinition, key: string): number | undefined {
  const value = cron.metadata?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function resolveOrgPath(frameworkRoot: string, org: string, pathValue: string): string {
  if (pathValue.startsWith('/')) return pathValue;
  if (pathValue.startsWith('orgs/')) return resolve(frameworkRoot, pathValue);
  return resolve(frameworkRoot, 'orgs', org, pathValue);
}

export function dispatchCronFire(cron: CronDefinition, opts: CronFireDispatchOptions): SpawnCodexResult | void {
  const runner = metadataString(cron, 'runner') ?? 'pty';

  if (runner === 'spawn-codex') {
    const promptFile = metadataString(cron, 'prompt_file');
    if (!promptFile) {
      throw new Error(`cron "${cron.name}" metadata.runner=spawn-codex requires metadata.prompt_file`);
    }

    const targetAgent = metadataString(cron, 'agent') ?? metadataString(cron, 'target_agent') ?? opts.agentName;
    const workdir = metadataString(cron, 'workdir');
    const timeout = metadataNumber(cron, 'timeout_seconds');
    const resolvedPrompt = resolveOrgPath(opts.frameworkRoot, opts.org, promptFile);
    const resolvedWorkdir = workdir ? resolveOrgPath(opts.frameworkRoot, opts.org, workdir) : undefined;
    const spawn = opts.spawnCodexImpl ?? spawnCodex;
    const result = spawn(resolvedPrompt, {
      agentName: targetAgent,
      agentsRoot: join(opts.frameworkRoot, 'orgs', opts.org),
      workdir: resolvedWorkdir,
      timeout,
      model: metadataString(cron, 'model'),
      effort: metadataString(cron, 'effort'),
      mcpConfig: metadataString(cron, 'mcp_config'),
      taskId: metadataString(cron, 'task_id') ?? `cron:${opts.agentName}:${cron.name}`,
      requester: opts.agentName,
      priority: metadataString(cron, 'priority') ?? 'cron',
    });

    if (!result.ok) {
      throw new Error(`spawn-codex cron "${cron.name}" failed with status ${result.status}; artifact: ${result.outputPath}`);
    }
    return result;
  }

  if (runner !== 'pty') {
    throw new Error(`cron "${cron.name}" has unsupported metadata.runner "${runner}"`);
  }

  const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
  const firedAt = (opts.now ?? (() => new Date()))().toISOString();
  const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
  const injected = opts.injectAgent(opts.agentName, injection);
  if (!injected) {
    throw new Error(`injectAgent returned false for agent "${opts.agentName}" — agent may not be running`);
  }
}
