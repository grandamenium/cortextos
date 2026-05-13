/**
 * Phase 10 — Mock P&L data (Jan–May 2026).
 *
 * Mental model:
 *   Revenue  = monthly retainers Rob charges clients (YOUR money)
 *   Costs    = agency ops only: AI subscriptions, APIs, software, Rob's time
 *   Margin   = Revenue - Costs
 *
 *   Client ad spend = pass-through (THEIR money) — tracked separately, NOT in P&L.
 */

export interface MonthlyPnL {
  month: string;
  label: string;
  revenue: number;       // retainers collected
  costs: number;         // agency ops costs
  margin: number;        // revenue - costs
  managedAdSpend: number; // pass-through, informational only
}

export interface AgencyOpsCost {
  name: string;
  category: 'ai' | 'api' | 'software' | 'labor';
  monthly: number;
}

export const AGENCY_OPS_COSTS: AgencyOpsCost[] = [
  { name: 'Claude Max (fleet)',     category: 'ai',       monthly: 200 },
  { name: 'OpenAI API',             category: 'api',      monthly: 120 },
  { name: 'Firecrawl',              category: 'api',      monthly: 49 },
  { name: 'Apollo.io',              category: 'api',      monthly: 99 },
  { name: 'Trigger.dev self-host',  category: 'software', monthly: 30 },
  { name: 'Vercel',                 category: 'software', monthly: 20 },
  { name: 'Supabase',               category: 'software', monthly: 25 },
  { name: "Rob's time (est 20h/mo @$50)", category: 'labor', monthly: 1000 },
];

export const TOTAL_MONTHLY_OPS = AGENCY_OPS_COSTS.reduce((s, c) => s + c.monthly, 0); // ~$1,543

// 5 clients × $2k/mo retainer baseline, growing ~5%/mo
const BASE_RETAINER = 10_000;

export const MOCK_PNL: MonthlyPnL[] = [
  { month: '2026-01', label: 'Jan 2026', revenue: 8_500,  costs: 1_300, margin: 7_200,  managedAdSpend: 32_000 },
  { month: '2026-02', label: 'Feb 2026', revenue: 9_000,  costs: 1_380, margin: 7_620,  managedAdSpend: 35_500 },
  { month: '2026-03', label: 'Mar 2026', revenue: 9_500,  costs: 1_430, margin: 8_070,  managedAdSpend: 38_200 },
  { month: '2026-04', label: 'Apr 2026', revenue: 10_000, costs: 1_490, margin: 8_510,  managedAdSpend: 41_000 },
  { month: '2026-05', label: 'May 2026', revenue: 10_500, costs: 1_543, margin: 8_957,  managedAdSpend: 44_500 },
];

export function getPnLSummary() {
  const latest = MOCK_PNL[MOCK_PNL.length - 1];
  const prior  = MOCK_PNL[MOCK_PNL.length - 2];
  function pct(a: number, b: number) { return b === 0 ? 0 : Math.round(((a - b) / b) * 1000) / 10; }
  return {
    revenue:        { value: latest.revenue,        pct: pct(latest.revenue,        prior.revenue) },
    costs:          { value: latest.costs,           pct: pct(latest.costs,          prior.costs) },
    margin:         { value: latest.margin,          pct: pct(latest.margin,         prior.margin) },
    managedAdSpend: { value: latest.managedAdSpend,  pct: pct(latest.managedAdSpend, prior.managedAdSpend) },
    margin_pct: Math.round((latest.margin / latest.revenue) * 1000) / 10,
  };
}
