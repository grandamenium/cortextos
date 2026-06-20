/**
 * Feature-Rollup — groups flat bus tasks into product features for an at-a-glance
 * progress overview (project → feature → status).
 *
 * Unlike bundle-status.ts (which parses a separate, drift-prone sprint-plan
 * markdown file), this module derives features purely from LIVE task state by
 * classifying each task's `[TAG]` title-prefix against a normalization table.
 * No external file → nothing to delete or let rot.
 *
 * Source of truth = the same task list `cortextos bus list-tasks` reads.
 */

import type { Task, TaskStatus } from '../types/index.js';

const DONE_STATUSES = new Set<TaskStatus>(['completed', 'cancelled']);

/**
 * Feature classification rules. First match wins, so order = priority.
 * Tested against the task title (which by convention starts with a `[TAG]`).
 * Extend this table when a new tag-family appears — it is the only thing to
 * maintain, and an unmatched task simply lands in "Sonstiges".
 */
export const FEATURE_RULES: { feature: string; match: RegExp }[] = [
  { feature: 'Termin-Buchung', match: /\bFF-\d|booking|termin|appointment|slot|videocall/i },
  { feature: 'B2B-Verträge & Hersteller', match: /B2B-SCHEMA|FOUNDER-B2B|manufacturer|hersteller|sponsoring/i },
  { feature: 'Rezeptgebühren', match: /REZEPT|prescription-fee|\bfee\b|gebühr/i },
  { feature: 'Apotheken-Dashboard', match: /APOTHEKE|pharmacy|apothek/i },
  { feature: 'Auth & Rollen', match: /CRITICAL-AUTH|role-switch|\bauth\b|\brolle|login|onboarding/i },
  { feature: 'Sync & Provider', match: /ARCH-CONVEX-SYNC|cannaleo|higreen|provider|normalization|offer/i },
  { feature: 'Infra & Kosten', match: /ARCH-CONVEX|\bCRON|stampede|convex|token|cost|kosten/i },
  { feature: 'Fleet-Selbstverbesserung', match: /CORTEXT-IMPROVE|cortextos|watchdog|cascade/i },
  { feature: 'Tech-Debt & Incidents', match: /TECH-DEBT|INCIDENT|POST-MORTEM|URGENT-INCIDENT|refactor|\bBUG\b|BUG-SWEEP/i },
  // --- appended buckets: only catch tasks that fall through the rules above ---
  { feature: 'Arzt & Verifizierung', match: /\barzt|\bärzt|doctor|verifizier|verification|arbeitszeit|approbation|\bLANR\b/i },
  { feature: 'Patient & Fragebogen', match: /patient|fragebogen|questionnaire|anamnese|notify-me|widerruf/i },
  { feature: 'Katalog & Produkte', match: /\bprodukt|\bproduct|katalog|catalog|\bCBD\b|\bsorte|strain|marketdata/i },
  { feature: 'Sammelbestellung', match: /sammelbestell|group-purchase|gruppenbestell/i },
  { feature: 'Analytics & KPIs', match: /cannametrics|\bKPI|marktanalyse|analytics|ranking|aggregation/i },
  { feature: 'Compliance & Recht', match: /DSGVO|GDPR|\bHWG\b|\bBTM|compliance|datenschutz|audit-log|\blegal\b/i },
  { feature: 'Marketing & SEO', match: /\bSEO|marketing|landing-page|\bblog\b/i },
  { feature: 'Tests & QA', match: /\bQA\b|\btests?\b|e2e|playwright|vitest/i },
  { feature: 'Audit & Qualität', match: /GAP-AUDIT|AUDIT-MASTER|A11Y|consistency-sweep/i },
];

export const FALLBACK_FEATURE = 'Sonstiges';

export interface FeatureProgress {
  feature: string;
  totals: {
    done: number;
    inProgress: number;
    pending: number;
    blocked: number;
    total: number;
  };
  percentDone: number;
  urgentOpen: number;            // open (non-done) tasks with priority urgent
  owners: string[];              // distinct assignees with open work, sorted
  inProgressTasks: { id: string; title: string; agent: string }[];
}

export interface ProjectPulse {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  blocked: number;
  urgentOpen: number;
  percentDone: number;
}

export interface Overview {
  pulse: ProjectPulse;
  features: FeatureProgress[];   // sorted: most open work first
  inProgressNow: { id: string; title: string; agent: string; feature: string }[];
  blocked: { id: string; title: string; agent: string; feature: string }[];
}

/** Extract the leading `[TAG]` from a title, or null. */
export function extractTag(title: string): string | null {
  const m = title.match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/** Strip the leading `[TAG]` for compact display. */
export function stripTag(title: string): string {
  return title.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

/** Classify a single task into a feature bucket (first matching rule wins). */
export function classifyFeature(task: Task): string {
  const hay = task.title || '';
  for (const r of FEATURE_RULES) {
    if (r.match.test(hay)) return r.feature;
  }
  return FALLBACK_FEATURE;
}

function isDone(status: TaskStatus): boolean {
  return DONE_STATUSES.has(status);
}

/** Build the full overview object from a flat task list. */
export function buildOverview(tasks: Task[]): Overview {
  // Exclude archived tasks from the rollup.
  const live = tasks.filter((t) => !t.archived);

  const byFeature = new Map<string, Task[]>();
  for (const t of live) {
    const f = classifyFeature(t);
    if (!byFeature.has(f)) byFeature.set(f, []);
    byFeature.get(f)!.push(t);
  }

  const features: FeatureProgress[] = [];
  for (const [feature, fTasks] of byFeature) {
    const done = fTasks.filter((t) => isDone(t.status)).length;
    const inProgress = fTasks.filter((t) => t.status === 'in_progress').length;
    const pending = fTasks.filter((t) => t.status === 'pending').length;
    const blocked = fTasks.filter((t) => t.status === 'blocked').length;
    const total = fTasks.length;
    const urgentOpen = fTasks.filter((t) => !isDone(t.status) && t.priority === 'urgent').length;

    const owners = Array.from(
      new Set(
        fTasks
          .filter((t) => !isDone(t.status) && t.assigned_to)
          .map((t) => t.assigned_to as string)
      )
    ).sort();

    const inProgressTasks = fTasks
      .filter((t) => t.status === 'in_progress')
      .map((t) => ({ id: t.id, title: stripTag(t.title), agent: t.assigned_to || '(unassigned)' }));

    features.push({
      feature,
      totals: { done, inProgress, pending, blocked, total },
      percentDone: total > 0 ? Math.round((done / total) * 100) : 0,
      urgentOpen,
      owners,
      inProgressTasks,
    });
  }

  // Sort: features with the most OPEN work first; "Sonstiges" always last.
  features.sort((a, b) => {
    if (a.feature === FALLBACK_FEATURE) return 1;
    if (b.feature === FALLBACK_FEATURE) return -1;
    const openA = a.totals.total - a.totals.done;
    const openB = b.totals.total - b.totals.done;
    if (openB !== openA) return openB - openA;
    return b.totals.total - a.totals.total;
  });

  const pulse: ProjectPulse = {
    total: live.length,
    done: live.filter((t) => isDone(t.status)).length,
    inProgress: live.filter((t) => t.status === 'in_progress').length,
    pending: live.filter((t) => t.status === 'pending').length,
    blocked: live.filter((t) => t.status === 'blocked').length,
    urgentOpen: live.filter((t) => !isDone(t.status) && t.priority === 'urgent').length,
    percentDone: live.length > 0 ? Math.round((live.filter((t) => isDone(t.status)).length / live.length) * 100) : 0,
  };

  const inProgressNow = live
    .filter((t) => t.status === 'in_progress')
    .map((t) => ({ id: t.id, title: stripTag(t.title), agent: t.assigned_to || '(unassigned)', feature: classifyFeature(t) }));

  const blocked = live
    .filter((t) => t.status === 'blocked')
    .map((t) => ({ id: t.id, title: stripTag(t.title), agent: t.assigned_to || '(unassigned)', feature: classifyFeature(t) }));

  return { pulse, features, inProgressNow, blocked };
}

function bar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return '[' + '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled)) + ']';
}

/** Compact terminal summary — used by the CLI default format and by me in chat. */
export function renderOverviewText(o: Overview): string {
  const out: string[] = [];
  const p = o.pulse;
  out.push('');
  out.push(`  PhytoMedic — Projekt-Puls`);
  out.push(`  ${bar(p.percentDone, 16)} ${p.percentDone}%  (${p.done}/${p.total} Tasks fertig)`);
  out.push(`  🟡 ${p.inProgress} in Arbeit · ○ ${p.pending} offen · 🔴 ${p.blocked} blockiert · ⚡ ${p.urgentOpen} urgent offen`);
  out.push('');
  out.push(`  Feature                          Fortschritt        offen  Owner`);
  out.push('  ' + '-'.repeat(74));
  for (const f of o.features) {
    const name = f.feature.slice(0, 30).padEnd(31);
    const frac = `${f.totals.done}/${f.totals.total}`.padStart(6);
    const b = bar(f.percentDone, 10);
    const pct = `${f.percentDone}%`.padStart(4);
    const open = String(f.totals.total - f.totals.done).padStart(5);
    const flags = (f.totals.inProgress ? `${f.totals.inProgress}🟡` : '') + (f.totals.blocked ? ` ${f.totals.blocked}🔴` : '') + (f.urgentOpen ? ` ${f.urgentOpen}⚡` : '');
    const owners = f.owners.slice(0, 2).join(',');
    out.push(`  ${name}${b} ${pct} ${frac} ${open}  ${flags.padEnd(8)} ${owners}`);
  }
  out.push('');
  out.push(`  Was läuft JETZT (${o.inProgressNow.length}):`);
  if (o.inProgressNow.length === 0) {
    out.push('    (nichts in Arbeit — Agenten idle oder zwischen Tasks)');
  } else {
    for (const t of o.inProgressNow.slice(0, 15)) {
      out.push(`    🟡 ${t.agent.padEnd(20)} ${t.title.slice(0, 50)}`);
    }
  }
  if (o.blocked.length > 0) {
    out.push('');
    out.push(`  🔴 Blockiert (${o.blocked.length}):`);
    for (const t of o.blocked.slice(0, 10)) {
      out.push(`    ${t.agent.padEnd(20)} ${t.title.slice(0, 50)}`);
    }
  }
  out.push('');
  return out.join('\n');
}

/** Telegram-friendly digest (stays well under 4096 chars). */
export function renderOverviewTelegram(o: Overview): string {
  const p = o.pulse;
  const lines: string[] = [];
  lines.push(`📊 *PhytoMedic — Fortschritt* ${new Date().toISOString().slice(0, 16)}Z`);
  lines.push(`${bar(p.percentDone, 12)} *${p.percentDone}%* (${p.done}/${p.total})`);
  lines.push(`🟡 ${p.inProgress} in Arbeit · ○ ${p.pending} offen · 🔴 ${p.blocked} blockiert · ⚡ ${p.urgentOpen} urgent`);
  lines.push('');
  for (const f of o.features) {
    const inP = f.totals.inProgress ? ` ${f.totals.inProgress}🟡` : '';
    const bl = f.totals.blocked ? ` ${f.totals.blocked}🔴` : '';
    const ur = f.urgentOpen ? ` ${f.urgentOpen}⚡` : '';
    lines.push(`*${f.feature}* — ${f.percentDone}% (${f.totals.done}/${f.totals.total})${inP}${bl}${ur}`);
  }
  lines.push('');
  if (o.inProgressNow.length === 0) {
    lines.push(`_Gerade nichts in Arbeit (Agenten idle/zwischen Tasks)._`);
  } else {
    lines.push(`*Läuft gerade:*`);
    for (const t of o.inProgressNow.slice(0, 8)) {
      lines.push(`🟡 ${t.agent}: ${t.title.slice(0, 55)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Diff two overviews — for "nur bei Änderung"-style change detection and for
 * the evening digest to show what moved since morning.
 */
export function diffOverview(prev: Overview, next: Overview): string[] {
  const changes: string[] = [];
  const prevByF = new Map(prev.features.map((f) => [f.feature, f]));
  for (const f of next.features) {
    const p = prevByF.get(f.feature);
    if (!p) continue;
    const dDone = f.totals.done - p.totals.done;
    if (dDone !== 0) changes.push(`${f.feature}: ${dDone > 0 ? '+' : ''}${dDone} fertig`);
  }
  const dBlocked = next.pulse.blocked - prev.pulse.blocked;
  if (dBlocked !== 0) changes.push(`Blockiert: ${dBlocked > 0 ? '+' : ''}${dBlocked}`);
  return changes;
}
