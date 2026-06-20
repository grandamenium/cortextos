/**
 * Feature-bundle manifest + decomposer (P1 phase A.2/A.3).
 *
 * A bundle manifest is one human-readable, dependency-free markdown file (lives
 * in the vault at agent-shared/bundles/<bundle_id>.md). It declares ONE shared
 * goal and one sub-task per affected product role. `decomposeBundle` turns it
 * into real bus tasks that all share the same `bundle_id` + carry their `role`,
 * with cross-role dependency edges, so agents can then pull them coordinated via
 * `claim-next --bundle`.
 *
 * Manifest format (no YAML dep — simple line parser):
 *
 *   bundle: B-2026-06-rezept-flow
 *   goal: Patient orders a prescribed product end-to-end across all roles
 *
 *   - role: manufacturer | assignee: backend-architect | title: createProduct sets draftStatus=pending
 *   - role: admin | assignee: backend-architect | title: approveProductDraft flips atomically | after: manufacturer
 *   - role: pharmacy | assignee: frontend-dev | title: einkauf uses the gated query | after: admin
 *   - role: patient | assignee: frontend-dev | title: catalog filters draftStatus=approved | after: admin
 *   - role: doctor | assignee: frontend-dev | title: review-only impact | after: admin
 *
 * `after:` is a comma-separated list of ROLES this sub-task depends on; it
 * becomes a blocked_by edge on the created task (the dep role's task must reach
 * `completed` first). Lines may appear in any order — decomposition is
 * topological.
 */

import type { BusPaths } from '../types/index.js';
import { createTask, listTasks } from './task.js';

export interface BundleSubtask {
  role: string;
  assignee?: string;
  title: string;
  after: string[];
}

export interface BundleManifest {
  bundle: string;
  goal: string;
  subtasks: BundleSubtask[];
}

export interface DecomposeResult {
  bundle: string;
  created: Array<{ role: string; taskId: string }>;
  skipped: boolean;
  existingCount: number;
}

/** Parse a bundle manifest markdown into its structured form. Tolerant of extra prose/headings. */
export function parseBundleManifest(markdown: string): BundleManifest {
  const lines = markdown.split('\n');
  let bundle = '';
  let goal = '';
  const subtasks: BundleSubtask[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!bundle) {
      const m = line.match(/^bundle:\s*(.+)$/i);
      if (m) { bundle = m[1].trim(); continue; }
    }
    if (!goal) {
      const m = line.match(/^goal:\s*(.+)$/i);
      if (m) { goal = m[1].trim(); continue; }
    }
    // Sub-task line: "- role: X | assignee: Y | title: Z | after: a,b"
    if (/^[-*]\s*role:/i.test(line)) {
      const body = line.replace(/^[-*]\s*/, '');
      const kv: Record<string, string> = {};
      for (const part of body.split('|')) {
        const idx = part.indexOf(':');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        const val = part.slice(idx + 1).trim();
        if (key) kv[key] = val;
      }
      if (!kv.role || !kv.title) continue; // skip malformed rows
      subtasks.push({
        role: kv.role,
        assignee: kv.assignee || undefined,
        title: kv.title,
        after: kv.after ? kv.after.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
    }
  }

  return { bundle, goal, subtasks };
}

/**
 * Decompose a bundle manifest into bus tasks (idempotent).
 *
 * - If tasks with this bundle_id already exist, does NOTHING (skipped=true) so
 *   re-running is safe and never duplicates sub-tasks (the duplicate-work class
 *   this whole engine exists to prevent).
 * - Creates sub-tasks in topological order so a task's `after` dependencies
 *   already exist when its blocked_by edge is written.
 * - Throws if an `after:` references a role not in the manifest, or if the
 *   dependency graph cannot be fully ordered (cycle / missing role).
 */
export function decomposeBundle(
  paths: BusPaths,
  agentName: string,
  org: string,
  markdown: string,
): DecomposeResult {
  const manifest = parseBundleManifest(markdown);
  if (!manifest.bundle) {
    throw new Error('Bundle manifest has no `bundle:` id line.');
  }
  if (manifest.subtasks.length === 0) {
    throw new Error(`Bundle ${manifest.bundle} manifest has no role sub-tasks (- role: ...).`);
  }

  const existing = listTasks(paths, { bundle: manifest.bundle });
  if (existing.length > 0) {
    return { bundle: manifest.bundle, created: [], skipped: true, existingCount: existing.length };
  }

  const roleToId: Record<string, string> = {};
  const created: Array<{ role: string; taskId: string }> = [];
  let remaining = [...manifest.subtasks];

  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (const st of [...remaining]) {
      // Ready when every `after` role has already been created.
      const ready = st.after.every((r) => roleToId[r]);
      if (!ready) continue;
      const blockedBy = st.after.map((r) => roleToId[r]);
      const taskId = createTask(paths, agentName, org, st.title, {
        bundle: manifest.bundle,
        role: st.role,
        assignee: st.assignee,
        blockedBy,
      });
      roleToId[st.role] = taskId;
      created.push({ role: st.role, taskId });
      remaining = remaining.filter((x) => x !== st);
      progressed = true;
    }
  }

  if (remaining.length > 0) {
    const stuck = remaining.map((r) => `${r.role} (after: ${r.after.join(',') || '-'})`).join('; ');
    throw new Error(
      `Bundle ${manifest.bundle}: could not order sub-tasks — an \`after:\` references a missing role or forms a cycle: ${stuck}`,
    );
  }

  return { bundle: manifest.bundle, created, skipped: false, existingCount: 0 };
}
