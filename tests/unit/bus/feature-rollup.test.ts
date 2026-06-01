import { describe, it, expect } from 'vitest';
import {
  classifyFeature,
  extractTag,
  stripTag,
  buildOverview,
  renderOverviewText,
  renderOverviewTelegram,
  diffOverview,
  FALLBACK_FEATURE,
} from '../../../src/bus/feature-rollup.js';
import type { Task } from '../../../src/types/index.js';

function mkTask(id: string, title: string, status: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    status: status as Task['status'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('extractTag / stripTag', () => {
  it('extracts a leading [TAG]', () => {
    expect(extractTag('[B2B-SCHEMA-1] manufacturerPharmacyContracts')).toBe('B2B-SCHEMA-1');
    expect(extractTag('no tag here')).toBeNull();
  });
  it('strips the leading [TAG] for display', () => {
    expect(stripTag('[FF-02-B] PaymentConfirmModal')).toBe('PaymentConfirmModal');
    expect(stripTag('plain title')).toBe('plain title');
  });
});

describe('classifyFeature', () => {
  it('maps known tag families to clean features', () => {
    expect(classifyFeature(mkTask('1', '[B2B-SCHEMA-3] pharmacyPlatformAgreements', 'pending'))).toBe('B2B-Verträge & Hersteller');
    expect(classifyFeature(mkTask('2', '[FF-02-B] booking modal', 'pending'))).toBe('Termin-Buchung');
    expect(classifyFeature(mkTask('3', '[ARCH-CONVEX-CRONS-AUDIT] reduce crons', 'pending'))).toBe('Infra & Kosten');
    expect(classifyFeature(mkTask('4', '[CRITICAL-AUTH] Role-Switch Race', 'pending'))).toBe('Auth & Rollen');
    expect(classifyFeature(mkTask('5', '[CORTEXT-IMPROVE] bus-view divergence', 'pending'))).toBe('Fleet-Selbstverbesserung');
    expect(classifyFeature(mkTask('6', '[REZEPT] Gebühren 11.90', 'pending'))).toBe('Rezeptgebühren');
    expect(classifyFeature(mkTask('7', '[APOTHEKE] dashboard Einkauf', 'pending'))).toBe('Apotheken-Dashboard');
  });
  it('maps the appended domain buckets', () => {
    expect(classifyFeature(mkTask('a1', '[ARZT-VERIFY] Arbeitszeiten fehlen', 'pending'))).toBe('Arzt & Verifizierung');
    expect(classifyFeature(mkTask('a2', '[PATIENT] Fragebogen Anamnese', 'pending'))).toBe('Patient & Fragebogen');
    expect(classifyFeature(mkTask('a3', '[CATALOG] Produkte CBD Sorten', 'pending'))).toBe('Katalog & Produkte');
    expect(classifyFeature(mkTask('a4', '[ORDER] Sammelbestellung deadline', 'pending'))).toBe('Sammelbestellung');
    expect(classifyFeature(mkTask('a5', '[ANALYTICS] Marktanalyse KPI ranking', 'pending'))).toBe('Analytics & KPIs');
    expect(classifyFeature(mkTask('a6', '[DSGVO] Löschrecht HWG audit-log', 'pending'))).toBe('Compliance & Recht');
    expect(classifyFeature(mkTask('a7', '[SEO] landing-page marketing', 'pending'))).toBe('Marketing & SEO');
    expect(classifyFeature(mkTask('a8', '[QA] e2e playwright tests', 'pending'))).toBe('Tests & QA');
    expect(classifyFeature(mkTask('a9', '[BUG-SWEEP] fix broken images', 'pending'))).toBe('Tech-Debt & Incidents');
    expect(classifyFeature(mkTask('a10', '[GAP-AUDIT-N-PLUS-1-QUERIES] fix queries', 'pending'))).toBe('Audit & Qualität');
    expect(classifyFeature(mkTask('a11', '[FOUNDER-LIVE-AUDIT-MASTER] sweep', 'pending'))).toBe('Audit & Qualität');
  });

  it('appended rules do not steal from earlier buckets (first-match wins)', () => {
    // "pharmacy" must stay Apotheken-Dashboard even though Analytics has no claim;
    // "manufacturer" stays B2B even though it is also a catalog-ish word.
    expect(classifyFeature(mkTask('p1', '[APOTHEKE] pharmacy product list', 'pending'))).toBe('Apotheken-Dashboard');
    expect(classifyFeature(mkTask('p2', '[B2B-SCHEMA-1] manufacturer contracts', 'pending'))).toBe('B2B-Verträge & Hersteller');
  });

  it('falls back to Sonstiges for unknown/untagged', () => {
    expect(classifyFeature(mkTask('8', 'zzz quux blorp', 'pending'))).toBe(FALLBACK_FEATURE);
  });
});

describe('buildOverview', () => {
  const tasks: Task[] = [
    mkTask('a', '[B2B-SCHEMA-1] contracts', 'completed', { assigned_to: 'backend-architect' }),
    mkTask('b', '[B2B-SCHEMA-2] agreements', 'in_progress', { assigned_to: 'backend-architect', priority: 'urgent' }),
    mkTask('c', '[B2B-SCHEMA-3] listing', 'pending', { assigned_to: 'backend-architect', priority: 'urgent' }),
    mkTask('d', '[FF-02-B] booking', 'pending', { assigned_to: 'frontend-dev' }),
    mkTask('e', '[FF-01] slot picker', 'blocked', { assigned_to: 'frontend-dev' }),
    mkTask('f', 'untagged misc', 'completed', { assigned_to: 'product-owner' }),
    mkTask('g', '[ARCH-CONVEX] crons', 'completed', { assigned_to: 'backend-architect' }),
    mkTask('h', 'archived old', 'pending', { archived: true }),
  ];

  it('computes the project pulse, excluding archived', () => {
    const o = buildOverview(tasks);
    expect(o.pulse.total).toBe(7); // archived 'h' excluded
    expect(o.pulse.done).toBe(3); // a, f, g
    expect(o.pulse.inProgress).toBe(1); // b
    expect(o.pulse.blocked).toBe(1); // e
    expect(o.pulse.urgentOpen).toBe(2); // b, c (urgent + not done)
    expect(o.pulse.percentDone).toBe(Math.round((3 / 7) * 100));
  });

  it('groups tasks into features with correct totals', () => {
    const o = buildOverview(tasks);
    const b2b = o.features.find((f) => f.feature === 'B2B-Verträge & Hersteller')!;
    expect(b2b.totals.total).toBe(3);
    expect(b2b.totals.done).toBe(1);
    expect(b2b.totals.inProgress).toBe(1);
    expect(b2b.urgentOpen).toBe(2);
    expect(b2b.owners).toEqual(['backend-architect']);
  });

  it('lists what is in progress now', () => {
    const o = buildOverview(tasks);
    expect(o.inProgressNow).toHaveLength(1);
    expect(o.inProgressNow[0]).toMatchObject({ agent: 'backend-architect', title: 'agreements', feature: 'B2B-Verträge & Hersteller' });
  });

  it('lists blocked tasks', () => {
    const o = buildOverview(tasks);
    expect(o.blocked).toHaveLength(1);
    expect(o.blocked[0].title).toBe('slot picker');
  });

  it('sorts Sonstiges last', () => {
    const o = buildOverview(tasks);
    expect(o.features[o.features.length - 1].feature).toBe(FALLBACK_FEATURE);
  });

  it('handles empty task list', () => {
    const o = buildOverview([]);
    expect(o.pulse.total).toBe(0);
    expect(o.pulse.percentDone).toBe(0);
    expect(o.features).toHaveLength(0);
  });
});

describe('renderers', () => {
  const o = buildOverview([
    mkTask('a', '[B2B-SCHEMA-1] contracts', 'completed', { assigned_to: 'backend-architect' }),
    mkTask('b', '[FF-02-B] booking', 'in_progress', { assigned_to: 'frontend-dev' }),
  ]);
  it('text render mentions pulse + feature + in-progress', () => {
    const s = renderOverviewText(o);
    expect(s).toContain('Projekt-Puls');
    expect(s).toContain('B2B-Verträge');
    expect(s).toContain('frontend-dev');
  });
  it('telegram render stays under 4096 chars and uses markdown', () => {
    const s = renderOverviewTelegram(o);
    expect(s.length).toBeLessThan(4096);
    expect(s).toContain('PhytoMedic');
  });
  it('empty in-progress shows honest idle message', () => {
    const idle = buildOverview([mkTask('a', '[FF-01] x', 'pending')]);
    expect(renderOverviewText(idle)).toContain('idle');
  });
});

describe('diffOverview', () => {
  it('reports feature done-deltas', () => {
    const prev = buildOverview([mkTask('a', '[FF-01] x', 'pending')]);
    const next = buildOverview([mkTask('a', '[FF-01] x', 'completed')]);
    const d = diffOverview(prev, next);
    expect(d.some((c) => c.includes('Termin-Buchung') && c.includes('+1'))).toBe(true);
  });
});
