/**
 * Bundle-Status — aggregates task progress per feature-bundle.
 *
 * Reads a sprint-plan markdown file with the convention:
 *
 *   ## Bundle N — TITLE
 *   ... | `task_<prefix>` | description ... |
 *
 * Each table-row in the bundle section that contains a backticked task-ID
 * (or just `task_<digits>` token) is treated as a bundle-member. Status of each
 * member is looked up by prefix-match against the bus task-store.
 */

import { existsSync, readFileSync } from 'fs';
import type { Task, TaskStatus } from '../types/index.js';

export interface BundleMember {
  taskIdPrefix: string;
  fullId: string | null;          // resolved via prefix-match, null if not found
  title: string;                  // short label from plan
  status: TaskStatus | 'missing'; // status if resolved, 'missing' otherwise
  priority?: string;
}

export interface BundleProgress {
  number: number;
  title: string;
  owner: string;
  members: BundleMember[];
  totals: {
    done: number;
    inProgress: number;
    pending: number;
    blocked: number;
    missing: number;
    total: number;
  };
  percentDone: number;
}

const DONE_STATUSES = new Set<string>(['completed', 'done', 'cancelled']);
const IN_PROGRESS_STATUSES = new Set<string>(['in_progress']);
const BLOCKED_STATUSES = new Set<string>(['blocked']);

/**
 * Parse a sprint-plan markdown file into Bundle definitions.
 *
 * Looks for `## Bundle N — TITLE` headings, then collects each table-row in
 * the section that contains a `task_<digits>` token. Description is the row's
 * second markdown cell. Owner is parsed from `**Owner**: ...` line.
 */
export function parseBundlePlan(markdown: string): Omit<BundleProgress, 'totals' | 'percentDone'>[] {
  const lines = markdown.split('\n');
  const bundles: Omit<BundleProgress, 'totals' | 'percentDone'>[] = [];

  let current: Omit<BundleProgress, 'totals' | 'percentDone'> | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Bundle heading
    const bundleHeading = line.match(/^##\s+Bundle\s+(\d+)\s+[—–-]\s+(.+?)(?:\s+[\u{1F300}-\u{1FAFF}]+)?$/u);
    if (bundleHeading) {
      if (current) bundles.push(current);
      current = {
        number: parseInt(bundleHeading[1], 10),
        title: bundleHeading[2].trim(),
        owner: '',
        members: [],
      };
      continue;
    }

    // Next-level heading ends current bundle
    if (current && /^##\s+/.test(line) && !line.includes('Bundle')) {
      bundles.push(current);
      current = null;
      continue;
    }

    if (!current) continue;

    // Owner line
    const ownerMatch = line.match(/^\*\*Owner\*\*:\s*(.+)$/);
    if (ownerMatch) {
      current.owner = ownerMatch[1].trim();
      continue;
    }

    // Table row with task-id token. Skip rows that are commented-out / verschoben.
    if (line.startsWith('|') && line.includes('task_')) {
      // Skip rows where the first non-pipe column is `--` (marker for removed/deferred tasks)
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length >= 2 && cells[0] === '--') continue;

      // Find the task_id token (allow backticks)
      const idMatch = line.match(/`?(task_\d+(?:_[a-z0-9]+)?)`?/);
      if (!idMatch) continue;
      const taskIdPrefix = idMatch[1];

      // Title is typically last column or second column. Take the last cell (most descriptive).
      const title = cells[cells.length - 1].replace(/\*\*/g, '').slice(0, 80);

      current.members.push({
        taskIdPrefix,
        fullId: null,
        title,
        status: 'missing',
      });
    }
  }

  if (current) bundles.push(current);
  return bundles;
}

/**
 * Resolve bundle members against the live task list (prefix-match) and compute totals.
 */
export function computeBundleProgress(
  bundles: Omit<BundleProgress, 'totals' | 'percentDone'>[],
  tasks: Task[]
): BundleProgress[] {
  return bundles.map((bundle) => {
    const members = bundle.members.map((m) => {
      const match = tasks.find((t) => t.id.startsWith(m.taskIdPrefix));
      if (!match) return { ...m, status: 'missing' as const };
      return {
        ...m,
        fullId: match.id,
        status: match.status,
        priority: match.priority,
      };
    });

    const totals = {
      done: members.filter((m) => DONE_STATUSES.has(m.status)).length,
      inProgress: members.filter((m) => IN_PROGRESS_STATUSES.has(m.status)).length,
      pending: members.filter((m) => m.status === 'pending').length,
      blocked: members.filter((m) => BLOCKED_STATUSES.has(m.status)).length,
      missing: members.filter((m) => m.status === 'missing').length,
      total: members.length,
    };

    const percentDone = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

    return { ...bundle, members, totals, percentDone };
  });
}

/**
 * Render a compact text summary of all bundles. One line per bundle, plus a totals row.
 */
export function renderBundleSummary(progress: BundleProgress[]): string {
  if (progress.length === 0) return '  No bundles found in sprint-plan.\n';

  const out: string[] = ['', `  Bundle-Status (${progress.length} bundles)`, ''];

  const header = '  #  Bundle                                    Done  Progress    Owner';
  out.push(header);
  out.push('  ' + '-'.repeat(header.length - 2));

  for (const b of progress) {
    const num = String(b.number).padEnd(3);
    const title = b.title.slice(0, 41).padEnd(42);
    const doneFrac = `${b.totals.done}/${b.totals.total}`.padStart(5);
    const bar = renderBar(b.percentDone, 10);
    const pct = `${b.percentDone}%`.padStart(4);
    const owner = b.owner.slice(0, 36);
    out.push(`  ${num}${title}${doneFrac}  ${bar} ${pct}  ${owner}`);
  }

  // Aggregate
  const total = progress.reduce((acc, b) => acc + b.totals.total, 0);
  const done = progress.reduce((acc, b) => acc + b.totals.done, 0);
  const inProg = progress.reduce((acc, b) => acc + b.totals.inProgress, 0);
  const pending = progress.reduce((acc, b) => acc + b.totals.pending, 0);
  const missing = progress.reduce((acc, b) => acc + b.totals.missing, 0);

  out.push('');
  out.push(`  Totals: ${done}/${total} done · ${inProg} in_progress · ${pending} pending · ${missing} missing-in-bus`);
  out.push('');
  return out.join('\n');
}

/**
 * Render detailed per-bundle view: list members with status icon.
 */
export function renderBundleDetail(progress: BundleProgress[], filterBundle?: number): string {
  const STATUS_ICON: Record<string, string> = {
    pending: '○',
    in_progress: '●',
    blocked: '◑',
    completed: '✓',
    done: '✓',
    cancelled: '✗',
    missing: '?',
  };

  const out: string[] = [''];
  const selected = filterBundle != null ? progress.filter((b) => b.number === filterBundle) : progress;
  if (selected.length === 0) return `  No bundle #${filterBundle} found.\n`;

  for (const b of selected) {
    out.push(`  Bundle ${b.number} — ${b.title}`);
    out.push(`  Owner: ${b.owner || '(unassigned)'}`);
    out.push(`  Progress: ${b.totals.done}/${b.totals.total} (${b.percentDone}%) · in_progress: ${b.totals.inProgress} · pending: ${b.totals.pending} · missing: ${b.totals.missing}`);
    out.push('');
    if (b.members.length === 0) {
      out.push('    (no members)');
    } else {
      for (const m of b.members) {
        const icon = STATUS_ICON[m.status] || '?';
        const id = (m.fullId || m.taskIdPrefix).slice(0, 32).padEnd(33);
        const title = m.title.slice(0, 70);
        out.push(`    ${icon} ${id}${title}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

function renderBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + ']';
}

/**
 * Compact Telegram-friendly one-line-per-bundle summary. Keeps under Telegram's
 * 4096-char limit even with 20+ bundles. Uses emoji status icons so the message
 * renders well in mobile clients.
 */
export function renderBundleTelegram(progress: BundleProgress[]): string {
  if (progress.length === 0) return '📦 No bundles found in sprint-plan.';

  const lines: string[] = [`📊 *Bundle-Status* — ${new Date().toISOString().slice(0, 16)}Z`, ''];

  for (const b of progress) {
    const pct = `${b.percentDone}%`.padStart(4);
    const inProg = b.totals.inProgress > 0 ? ` · ${b.totals.inProgress}🟡` : '';
    const blocked = b.totals.blocked > 0 ? ` · ${b.totals.blocked}🔴` : '';
    const missing = b.totals.missing > 0 ? ` · ${b.totals.missing}❓` : '';
    const title = b.title.slice(0, 36);
    lines.push(`*B${b.number}* ${pct} ${b.totals.done}/${b.totals.total} — ${title}${inProg}${blocked}${missing}`);
  }

  const total = progress.reduce((acc, b) => acc + b.totals.total, 0);
  const done = progress.reduce((acc, b) => acc + b.totals.done, 0);
  const inProg = progress.reduce((acc, b) => acc + b.totals.inProgress, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  lines.push('');
  lines.push(`*TOTAL* ${pct}% (${done}/${total}) · ${inProg} in_progress`);
  return lines.join('\n');
}

/**
 * Diff two snapshots — used by watch mode to highlight what changed since last poll.
 * Returns null-when-equal so the caller can suppress no-op redraws.
 */
export function diffBundleSnapshots(
  prev: BundleProgress[],
  next: BundleProgress[]
): { bundle: number; field: 'done' | 'inProgress' | 'pending'; delta: number; title: string }[] {
  const changes: { bundle: number; field: 'done' | 'inProgress' | 'pending'; delta: number; title: string }[] = [];
  for (const n of next) {
    const p = prev.find((x) => x.number === n.number);
    if (!p) continue;
    const fields: Array<'done' | 'inProgress' | 'pending'> = ['done', 'inProgress', 'pending'];
    for (const f of fields) {
      const delta = n.totals[f] - p.totals[f];
      if (delta !== 0) changes.push({ bundle: n.number, field: f, delta, title: n.title });
    }
  }
  return changes;
}

/**
 * Load + parse the sprint-plan from a file path. Returns empty list on missing file.
 */
export function loadBundlePlan(path: string): Omit<BundleProgress, 'totals' | 'percentDone'>[] {
  if (!existsSync(path)) return [];
  const md = readFileSync(path, 'utf-8');
  return parseBundlePlan(md);
}
