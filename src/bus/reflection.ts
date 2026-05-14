import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

/**
 * Reflection + postmortem writers (Hermes Phase 1 — protocols #1 and #4).
 *
 * Both append a structured Markdown block to the agent's daily memory file
 * at {agentDir}/memory/YYYY-MM-DD.md. Chief decision (1778779877183): the
 * daily file is the unbounded sink; MEMORY.md (the index) is hand-curated.
 *
 * Each writer also logs a KPI event so the dashboard can surface reflection
 * coverage per agent per day.
 */

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeString(): string {
  // HH:MM UTC — matches the existing daily-memory entry style.
  return new Date().toISOString().slice(11, 16) + ' UTC';
}

function dailyMemoryPath(agentDir: string): string {
  return join(agentDir, 'memory', `${todayDateString()}.md`);
}

/**
 * Append a 3-line task reflection to today's daily memory file.
 * Idempotent per (agent, date, taskId): a second call for the same task on
 * the same day will throw, so callers can choose to ignore or surface the
 * collision. Atomic at the OS level via appendFileSync to one file.
 */
export interface TaskReflectionInput {
  taskId: string;
  worked: string;
  failed: string;
  change: string;
}

export function writeTaskReflection(
  paths: BusPaths,
  agentName: string,
  org: string,
  agentDir: string,
  input: TaskReflectionInput,
): { memoryPath: string; alreadyExists: boolean } {
  const memoryPath = dailyMemoryPath(agentDir);
  const dupeMarker = `## Task ${input.taskId} reflection`;

  if (existsSync(memoryPath)) {
    const existing = readFileSync(memoryPath, 'utf-8');
    if (existing.includes(dupeMarker)) {
      return { memoryPath, alreadyExists: true };
    }
  }

  mkdirSync(join(agentDir, 'memory'), { recursive: true });

  const block =
    `\n## Task ${input.taskId} reflection (${nowTimeString()})\n` +
    `- WORKED: ${input.worked}\n` +
    `- FAILED: ${input.failed}\n` +
    `- CHANGE: ${input.change}\n`;
  appendFileSync(memoryPath, block, 'utf-8');

  logEvent(paths, agentName, org, 'task', 'task_reflection', 'info', {
    agent: agentName,
    task_id: input.taskId,
  });

  return { memoryPath, alreadyExists: false };
}

/**
 * Append a structured postmortem entry (mistake / root cause / prevention)
 * to today's daily memory file. Unlike task reflections, postmortems are
 * NOT keyed to an ID — multiple per day are expected — so no dedupe.
 */
export interface PostmortemInput {
  mistake: string;
  rootCause: string;
  prevention: string;
  relatedEventId?: string;
}

export function writePostmortem(
  paths: BusPaths,
  agentName: string,
  org: string,
  agentDir: string,
  input: PostmortemInput,
): { memoryPath: string } {
  const memoryPath = dailyMemoryPath(agentDir);
  mkdirSync(join(agentDir, 'memory'), { recursive: true });

  const headerSuffix = input.relatedEventId ? ` (event ${input.relatedEventId})` : '';
  const block =
    `\n## Postmortem ${nowTimeString()}${headerSuffix}\n` +
    `- MISTAKE: ${input.mistake}\n` +
    `- ROOT CAUSE: ${input.rootCause}\n` +
    `- PREVENTION: ${input.prevention}\n`;
  appendFileSync(memoryPath, block, 'utf-8');

  logEvent(paths, agentName, org, 'action', 'postmortem_filed', 'info', {
    agent: agentName,
    ...(input.relatedEventId ? { related_event: input.relatedEventId } : {}),
  });

  return { memoryPath };
}
