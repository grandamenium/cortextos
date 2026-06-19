/**
 * Feature-Rollup (dashboard port).
 *
 * Canonical logic lives in the cortextos CLI at `src/bus/feature-rollup.ts`.
 * The dashboard is a separate package with its own Task type (uses `assignee`,
 * no `archived`/`cancelled`), so this is a focused port of the pure
 * classification + aggregation logic. Keep FEATURE_RULES in sync with the CLI.
 */

import type { Task } from '@/lib/types';

const DONE = new Set(['completed']);

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
  totals: { done: number; inProgress: number; pending: number; blocked: number; total: number };
  percentDone: number;
  urgentOpen: number;
  owners: string[];
}

export interface ProjectPulse {
  total: number; done: number; inProgress: number; pending: number; blocked: number; urgentOpen: number; percentDone: number;
}

export interface Overview {
  pulse: ProjectPulse;
  features: FeatureProgress[];
  inProgressNow: { id: string; title: string; agent: string; feature: string }[];
  blocked: { id: string; title: string; agent: string; feature: string }[];
}

export function stripTag(title: string): string {
  return (title || '').replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

export function classifyFeature(task: Task): string {
  const hay = task.title || '';
  for (const r of FEATURE_RULES) if (r.match.test(hay)) return r.feature;
  return FALLBACK_FEATURE;
}

const isDone = (s: string) => DONE.has(s);

export function buildOverview(tasks: Task[]): Overview {
  const live = tasks;

  const byFeature = new Map<string, Task[]>();
  for (const t of live) {
    const f = classifyFeature(t);
    if (!byFeature.has(f)) byFeature.set(f, []);
    byFeature.get(f)!.push(t);
  }

  const features: FeatureProgress[] = [];
  for (const [feature, ft] of byFeature) {
    const done = ft.filter((t) => isDone(t.status)).length;
    const inProgress = ft.filter((t) => t.status === 'in_progress').length;
    const pending = ft.filter((t) => t.status === 'pending').length;
    const blocked = ft.filter((t) => t.status === 'blocked').length;
    const total = ft.length;
    const urgentOpen = ft.filter((t) => !isDone(t.status) && t.priority === 'urgent').length;
    const owners = Array.from(new Set(ft.filter((t) => !isDone(t.status) && t.assignee).map((t) => t.assignee as string))).sort();
    features.push({ feature, totals: { done, inProgress, pending, blocked, total }, percentDone: total > 0 ? Math.round((done / total) * 100) : 0, urgentOpen, owners });
  }

  features.sort((a, b) => {
    if (a.feature === FALLBACK_FEATURE) return 1;
    if (b.feature === FALLBACK_FEATURE) return -1;
    const openA = a.totals.total - a.totals.done;
    const openB = b.totals.total - b.totals.done;
    if (openB !== openA) return openB - openA;
    return b.totals.total - a.totals.total;
  });

  const done = live.filter((t) => isDone(t.status)).length;
  const pulse: ProjectPulse = {
    total: live.length,
    done,
    inProgress: live.filter((t) => t.status === 'in_progress').length,
    pending: live.filter((t) => t.status === 'pending').length,
    blocked: live.filter((t) => t.status === 'blocked').length,
    urgentOpen: live.filter((t) => !isDone(t.status) && t.priority === 'urgent').length,
    percentDone: live.length > 0 ? Math.round((done / live.length) * 100) : 0,
  };

  const inProgressNow = live.filter((t) => t.status === 'in_progress').map((t) => ({ id: t.id, title: stripTag(t.title), agent: t.assignee || '(unassigned)', feature: classifyFeature(t) }));
  const blocked = live.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: stripTag(t.title), agent: t.assignee || '(unassigned)', feature: classifyFeature(t) }));

  return { pulse, features, inProgressNow, blocked };
}
