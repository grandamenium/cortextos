#!/usr/bin/env node
/**
 * backfill-task-brief.js
 *
 * Walks open (pending/in_progress/blocked) tasks in the revops-global org,
 * adds meta.brief with all 9 contract fields. Fields derivable from prose
 * description are extracted; others default to "field-not-applicable: <why>".
 *
 * Atomic write: write to .tmp then rename (same pattern as src/utils/atomic.ts).
 * Skips completed/cancelled tasks (escalation rule: do not touch 269 completed).
 */

const { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const TASK_DIR = '/home/cortextos/.cortextos/cortextos1/orgs/revops-global/tasks';
const OPEN_STATUSES = new Set(['pending', 'in_progress', 'blocked']);

// Atomic write: write to .tmp then rename
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp.' + process.pid;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

// Extract a value from description matching a label pattern
function extractFromDesc(description, patterns) {
  for (const pattern of patterns) {
    const re = new RegExp(pattern + '[:\\s]+([^.\\n]{10,200})', 'i');
    const m = description.match(re);
    if (m) return m[1].trim().replace(/\.$/, '');
  }
  return null;
}

// Migrate top-level meta fields into brief (some tasks already have them in meta root)
function migrateFromMeta(meta, field) {
  if (meta && meta[field] !== undefined) {
    const val = meta[field];
    return Array.isArray(val) ? val : String(val);
  }
  return null;
}

function buildBrief(task) {
  const desc = task.description || '';
  const meta = task.meta || {};
  const existingBrief = (meta.brief && typeof meta.brief === 'object') ? meta.brief : {};

  // success_criteria
  const success_criteria =
    existingBrief.success_criteria ||
    extractFromDesc(desc, ['success criteria', 'success_criteria', 'done when', 'complete when', 'proof required']) ||
    'field-not-applicable: success condition embedded in task description prose';

  // out_of_scope
  const out_of_scope =
    existingBrief.out_of_scope ||
    extractFromDesc(desc, ['out of scope', 'out_of_scope', 'not in scope', 'excluded from']) ||
    'field-not-applicable: scope boundaries not explicitly stated';

  // escalation_triggers
  const escalation_triggers =
    existingBrief.escalation_triggers ||
    extractFromDesc(desc, ['escalate if', 'escalation trigger', 'escalate when', 'block if']) ||
    'field-not-applicable: escalate to orchestrator on any unrecoverable blocker';

  // source_hierarchy (migrate from meta root if present)
  const source_hierarchy =
    existingBrief.source_hierarchy ||
    migrateFromMeta(meta, 'source_hierarchy') ||
    extractFromDesc(desc, ['source hierarchy', 'authority']) ||
    'field-not-applicable: no explicit source ordering defined';

  // preferred_runtime (migrate from meta root if present)
  const preferred_runtime =
    existingBrief.preferred_runtime ||
    migrateFromMeta(meta, 'preferred_runtime') ||
    task.assigned_to ||
    'field-not-applicable: use default assigned agent';

  // required_capabilities (migrate from meta root if present)
  const required_capabilities =
    existingBrief.required_capabilities ||
    migrateFromMeta(meta, 'required_capabilities') ||
    'field-not-applicable: no special capabilities required beyond assigned agent defaults';

  // fallback_proof
  const fallback_proof =
    existingBrief.fallback_proof ||
    extractFromDesc(desc, ['fallback', 'if.*fails', 'alternative']) ||
    'field-not-applicable: no explicit fallback path defined; escalate to orchestrator on failure';

  // artifact_expectations
  const artifact_expectations =
    existingBrief.artifact_expectations ||
    extractFromDesc(desc, ['artifact', 'output', 'deliverable', 'proof artifact', 'produce']) ||
    'field-not-applicable: no structured artifact required; task result is the completion note';

  // goal_ancestry (migrate from meta root if present)
  const goal_ancestry =
    existingBrief.goal_ancestry ||
    migrateFromMeta(meta, 'goal_ancestry') ||
    extractFromDesc(desc, ['goal', 'objective', 'derived from']) ||
    'field-not-applicable: goal lineage not captured';

  return {
    success_criteria,
    out_of_scope,
    escalation_triggers,
    source_hierarchy,
    preferred_runtime,
    required_capabilities,
    fallback_proof,
    artifact_expectations,
    goal_ancestry,
  };
}

function main() {
  const files = readdirSync(TASK_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  const results = { backfilled: [], skipped: [], errors: [] };

  for (const file of files) {
    const filePath = join(TASK_DIR, file);
    let task;
    try {
      task = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err) {
      results.errors.push({ file, reason: `parse error: ${err}` });
      continue;
    }

    if (!OPEN_STATUSES.has(task.status)) {
      results.skipped.push({ id: task.id, status: task.status, reason: 'not open' });
      continue;
    }

    const brief = buildBrief(task);
    const updatedMeta = {
      ...(task.meta || {}),
      brief,
    };

    // Remove migrated top-level meta fields (now in brief)
    delete updatedMeta.source_hierarchy;
    delete updatedMeta.preferred_runtime;
    delete updatedMeta.required_capabilities;
    delete updatedMeta.goal_ancestry;

    const updatedTask = { ...task, meta: updatedMeta };

    try {
      atomicWrite(filePath, JSON.stringify(updatedTask));
      results.backfilled.push({ id: task.id, title: task.title, status: task.status });
    } catch (err) {
      results.errors.push({ file, reason: `write error: ${err}` });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  return results;
}

main();
