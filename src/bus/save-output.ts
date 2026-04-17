import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from 'fs';
import { basename, extname, join, posix, relative, sep } from 'path';
import type { BusPaths, Task, TaskOutput } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

export interface SaveOutputOptions {
  /** Source file to copy or move into the deliverables tree. */
  sourcePath: string;
  /** Target task ID. The task must already exist. */
  taskId: string;
  /** Optional human-readable label for the linked output. Defaults to the basename. */
  label?: string;
  /**
   * If true, delete the source file after a successful copy.
   * Defaults to false (copy semantics).
   */
  move?: boolean;
  /**
   * If true, skip appending the entry to task.outputs[].
   * The file is still saved into the deliverables tree.
   */
  noLink?: boolean;
}

export interface SaveOutputResult {
  /** Absolute path of the saved file inside the deliverables tree. */
  targetPath: string;
  /**
   * Path stored in task.outputs[].value when linked.
   * Always relative to ctxRoot, always forward-slash separated for cross-platform
   * dashboard rendering (the /api/media route accepts forward-slash paths on every OS).
   */
  storedPath: string;
  /** True if the entry was appended to task.outputs[]. */
  linked: boolean;
}

/**
 * Copy a file into the per-task deliverables tree and (by default) link it
 * to the task as a `file` output entry. Single atomic surface so callers
 * cannot forget the link half of the operation.
 *
 * Layout (under CTX_ROOT so /api/media can serve it):
 *   {ctxRoot}/orgs/{org}/deliverables/{agent}/{task_id}/{filename}
 *
 * Filename collisions append `-1`, `-2`, ... before the extension until unique.
 */
export function saveOutput(
  paths: BusPaths,
  options: SaveOutputOptions,
): SaveOutputResult {
  const { sourcePath, taskId, label, move = false, noLink = false } = options;

  if (!existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  const taskFile = join(paths.taskDir, `${taskId}.json`);
  if (!existsSync(taskFile)) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const task: Task = JSON.parse(readFileSync(taskFile, 'utf-8'));

  const taskDir = join(paths.deliverablesDir, task.assigned_to, taskId);
  ensureDir(taskDir);

  const sourceName = basename(sourcePath);
  const targetPath = resolveCollision(taskDir, sourceName);

  copyFileSync(sourcePath, targetPath);
  if (move) {
    try {
      unlinkSync(sourcePath);
    } catch (err) {
      throw new Error(
        `Copied to ${targetPath} but failed to remove source ${sourcePath}: ${(err as Error).message}`,
      );
    }
  }

  const storedPath = toPosixRelative(paths.ctxRoot, targetPath);

  if (noLink) {
    return { targetPath, storedPath, linked: false };
  }

  const entry: TaskOutput = {
    type: 'file',
    value: storedPath,
    label: label ?? basename(targetPath),
  };
  task.outputs = [...(task.outputs ?? []), entry];
  task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  atomicWriteSync(taskFile, JSON.stringify(task, null, 2));

  return { targetPath, storedPath, linked: true };
}

/**
 * Find a non-colliding filename inside `dir` for `desiredName`.
 * Strategy: if `foo.png` exists, try `foo-1.png`, `foo-2.png`, ...
 */
function resolveCollision(dir: string, desiredName: string): string {
  const candidate = join(dir, desiredName);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  for (let i = 1; i < 10_000; i++) {
    const next = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(next)) return next;
  }
  throw new Error(`Could not resolve unique filename in ${dir} for ${desiredName}`);
}

/**
 * Convert an absolute path under `root` to a forward-slash relative path,
 * suitable for storing in task.outputs[].value and serving via /api/media.
 */
function toPosixRelative(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel.split(sep).join(posix.sep);
}
