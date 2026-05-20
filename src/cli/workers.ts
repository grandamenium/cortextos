import { Command } from 'commander';
import { resolve } from 'path';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';

export const spawnWorkerCommand = new Command('spawn-worker')
  .description('Spawn an ephemeral worker Claude Code session for a parallelized task')
  .argument('<name>', 'Worker name (used for bus identity)')
  .requiredOption('--dir <path>', 'Working directory for the worker session')
  .requiredOption('--prompt <text>', 'Task prompt to inject at session start')
  .option('--parent <agent>', 'Parent agent name (for bus reply routing)')
  .option('--model <model>', 'Claude model to use (defaults to org default)')
  .option('--base-url <url>', 'Override ANTHROPIC_BASE_URL for this worker (cheap-LLM lane: DeepSeek / OpenRouter / Ollama). Requires --api-key-env. Spec: agents/analyst/reports/cheap-llm-lanes-spec-2026-05-20.md')
  .option('--api-key-env <name>', 'Env var name (read from the calling agent .env or org secrets.env) whose value becomes ANTHROPIC_API_KEY in the worker PTY. Pairs with --base-url.')
  .action(async (name: string, opts: { dir: string; prompt: string; parent?: string; model?: string; baseUrl?: string; apiKeyEnv?: string }) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);
    const dir = resolve(opts.dir);

    // Cheap-LLM lane validation: --base-url and --api-key-env are paired.
    // Either pass both or neither - mismatched usage is almost always a typo.
    if ((opts.baseUrl && !opts.apiKeyEnv) || (!opts.baseUrl && opts.apiKeyEnv)) {
      console.error('Error: --base-url and --api-key-env must be passed together (cheap-LLM lane requires both).');
      process.exit(1);
    }

    const response = await client.send({
      type: 'spawn-worker',
      data: {
        name,
        dir,
        prompt: opts.prompt,
        parent: opts.parent,
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKeyEnv: opts.apiKeyEnv,
      },
    });

    if (response.success) {
      console.log(`Worker "${name}" spawning in ${dir}`);
      console.log(`Monitor: cortextos list-workers`);
      console.log(`Inject:  cortextos inject-worker ${name} "<text>"`);
      console.log(`Stop:    cortextos terminate-worker ${name}`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const terminateWorkerCommand = new Command('terminate-worker')
  .description('Terminate a running worker session')
  .argument('<name>', 'Worker name')
  .action(async (name: string) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'terminate-worker',
      data: { name },
    });

    if (response.success) {
      console.log(`Worker "${name}" terminating`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });

export const listWorkersCommand = new Command('list-workers')
  .description('List active and recently completed worker sessions')
  .action(async () => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({ type: 'list-workers' });

    if (!response.success) {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }

    const workers = response.data as Array<{
      name: string; status: string; pid?: number; dir: string;
      parent?: string; spawnedAt: string; exitCode?: number;
    }>;

    if (!workers || workers.length === 0) {
      console.log('No active workers');
      return;
    }

    for (const w of workers) {
      const pid = w.pid ? ` (pid ${w.pid})` : '';
      const parent = w.parent ? ` ← ${w.parent}` : '';
      const exit = w.exitCode !== undefined ? ` exit=${w.exitCode}` : '';
      const age = Math.round((Date.now() - new Date(w.spawnedAt).getTime()) / 1000);
      console.log(`${w.name}  ${w.status}${pid}${exit}${parent}  ${age}s  ${w.dir}`);
    }
  });

export const injectWorkerCommand = new Command('inject-worker')
  .description('Inject text into a running worker session (nudge / stuck-state recovery)')
  .argument('<name>', 'Worker name')
  .argument('<text>', 'Text to inject into the worker PTY')
  .action(async (name: string, text: string) => {
    const env = resolveEnv();
    const client = new IPCClient(env.instanceId);

    const response = await client.send({
      type: 'inject-worker',
      data: { name, text },
    });

    if (response.success) {
      console.log(`Injected into worker "${name}"`);
    } else {
      console.error(`Error: ${response.error}`);
      process.exit(1);
    }
  });
