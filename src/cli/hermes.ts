import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { resolveEnv } from '../utils/env.js';
import { resolvePaths } from '../utils/paths.js';
import { findTaskFile } from '../bus/task.js';
import {
  runHermesDispatch,
  makeBusBinding,
} from '../workers/hermes/orchestrator.js';
import { createHermesLogger, defaultLogPath } from '../workers/hermes/logger.js';
import type { AdapterContext, BackendId } from '../workers/hermes/base.js';
import type { AgentConfig, Task } from '../types/index.js';

const BACKENDS: readonly BackendId[] = ['claude', 'codex', 'gemini'];

/**
 * Resolve who the served/exhausted result is reported to. The task's CREATOR
 * (delegator) is the right target — on a delegated task `assigned_to` is the
 * Hermes worker itself, so replying there would notify our own inbox and the
 * delegator would never hear the outcome. Falls back to assigned_to, then this
 * worker's own identity, only when created_by is unset (malformed task).
 * Extracted as a pure fn so the exact created_by-over-assigned_to precedence is
 * directly unit-testable (the inline commander action is not).
 */
export function resolveReplyTarget(task: Task, self: string): string {
  return task.created_by || task.assigned_to || self;
}

interface HermesRunOpts {
  task: string;
  preferred?: string;
  model?: string;
  maxTotalMs?: number;
  workdir?: string;
}

/**
 * In-process dispatch verb (spec §4.1). The Hermes worker agent shells out to
 * this per dispatched task: it locates the task, runs it through the
 * health-gated Claude/Codex/Gemini fallback chain, and ALWAYS reports back
 * (completeTask + a send-message reply to the parent) — never silent.
 */
export const hermesRunCommand = new Command('hermes-run')
  .description(
    'Run a dispatched task through the Hermes multi-backend fallback chain (in-process).',
  )
  .requiredOption('--task <id>', 'Task id to dispatch')
  .option(
    '--preferred <backend>',
    'Hoist a backend to the front of the chain (claude|codex|gemini)',
  )
  .option(
    '--model <model>',
    'Pin a specific model (must be in the chosen backend safeModels())',
  )
  .option(
    '--max-total-ms <ms>',
    'Total wall-clock budget across the chain',
    (v) => parseInt(v, 10),
  )
  .option('--workdir <path>', 'Working directory for the task (default: cwd)')
  .action(async (opts: HermesRunOpts) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // ---- Locate + read the task ----
    const file = findTaskFile(paths, opts.task);
    if (!file) {
      console.error(`Task ${opts.task} not found`);
      process.exit(1);
    }
    const task = JSON.parse(readFileSync(file, 'utf-8')) as Task;
    const prompt = task.description || task.title;
    // Reply to the task's creator/delegator (see resolveReplyTarget) — never
    // assigned_to, which on a delegated task is this worker itself.
    const parent = resolveReplyTarget(task, env.agentName);

    // ---- Validate --preferred ----
    let preferred: BackendId | undefined;
    if (opts.preferred !== undefined) {
      if (!BACKENDS.includes(opts.preferred as BackendId)) {
        console.error(
          `Invalid --preferred '${opts.preferred}' (must be one of: ${BACKENDS.join('|')})`,
        );
        process.exit(1);
      }
      preferred = opts.preferred as BackendId;
    }

    // ---- Wire real effect surfaces ----
    const bus = makeBusBinding(paths, env.agentName, env.org);
    const log = createHermesLogger(defaultLogPath(env.ctxRoot, env.agentName));
    // AdapterContext: env = the resolved CtxEnv (adapters read ctx.env.projectRoot
    // as a cwd fallback). config is unused by the v1 adapters (they take cwd from
    // ExecInput.workdir), so an empty AgentConfig is sufficient; see base.ts.
    const ctx: AdapterContext = { config: {} as AgentConfig, env };

    const outcome = await runHermesDispatch(
      {
        taskId: opts.task,
        prompt,
        workdir: opts.workdir ? resolve(opts.workdir) : process.cwd(),
        preferred,
        model: opts.model,
        maxTotalMs: opts.maxTotalMs,
        parent,
        // No originating msg id at the CLI — replyTo left undefined.
      },
      { ctx, bus, log },
    );

    // ---- One-line human summary ----
    if (outcome.status === 'served') {
      console.log(`SERVED by ${outcome.backend}/${outcome.servedModel ?? 'unknown'}`);
    } else {
      console.error('HERMES_EXHAUSTED');
      process.exit(1);
    }
  });
