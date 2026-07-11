'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import {
  IconHome,
  IconAlertTriangle,
  IconClock,
  IconExternalLink,
  IconChevronDown,
  IconShield,
  IconReceipt,
  IconUser,
} from '@tabler/icons-react';
import { ProspectPipeline } from '@/components/shared/prospect-pipeline';
import type { ProspectWithProperty } from '@/components/shared/prospect-pipeline';

interface PropertyUnit {
  name: string;
  status: 'occupied' | 'vacant';
  rent: number | null;
  tenant: string | null;
  lease_expiration?: string;
  notes?: string;
}

interface RoomRosterEntry {
  room: string;
  tenant: string | null;
  lease_expiration?: string;
  payment_status: 'current' | 'late' | 'delinquent' | 'vacant' | 'eviction' | string;
  amount_due: number | null;
  eviction_status?: string;
  notes?: string;
}

interface PropertyNeed {
  item: string;
  unit?: string;
  vendor?: string;
  cost: number | null;
  status: string;
  priority: string;
  expected_completion_date?: string;
  notes?: string;
}

interface BalanceOwed {
  to: string;
  amount: number | null;
  reason: string;
  status: string;
  notes?: string;
}

interface PastOrder {
  date: string;
  item: string;
  vendor: string;
  cost: number | null;
}

interface Property {
  id: string;
  name: string;
  city: string;
  state: string;
  owner: string;
  entity: string;
  manager?: string;
  type: string;
  room_roster?: RoomRosterEntry[];
  units: PropertyUnit[];
  needs: PropertyNeed[];
  balances_owed: BalanceOwed[];
  past_orders: PastOrder[];
  quotes: Array<{ date: string; item: string; vendor: string; amount?: number; amount_range?: string; notes?: string }>;
  insurance?: { renewal_date: string; carrier?: string; amount?: number };
  taxes?: { due_date: string; amount?: number; status?: string };
  spreadsheet_url?: string;
  original_budget?: number;
  total_budget?: number;
  lender?: string;
  total_committed?: {
    total: number;
    purchase_price: number;
    closing_costs: { total: number; items: Array<{ item: string; amount: number }> };
    rehab_released: number;
    outstanding_debts: { total: number; items: Array<{ item: string; amount: number | null; status: string }> };
  };
  draws?: {
    loan_total: number;
    total_approved: number;
    total_released: number;
    remaining_balance: number;
    source_url?: string;
    line_items?: Array<{ line: string; item: string; budget: number; released: number; approved?: number; status: string; notes?: string }>;
  };
  financials?: {
    target_sale_price: number;
    total_obligations: number;
    projected_net: number;
    note?: string;
  };
  status_note?: string;
  last_report?: string;
  last_report_by?: string;
  updated_at: string;
  prospect_pipeline?: Array<{
    name: string;
    stage: 'applied' | 'screening' | 'approved' | 'lease_signed' | 'moved_in';
    room?: string;
    applied_date?: string;
    stage_updated?: string;
    notes?: string;
    contact?: { email?: string; phone?: string };
  }>;
}

const priorityColors: Record<string, string> = {
  urgent: 'bg-red-500/15 text-red-400 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  low: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

const statusColors: Record<string, string> = {
  needed: 'bg-red-500/15 text-red-400',
  in_progress: 'bg-blue-500/15 text-blue-400',
  on_hold: 'bg-yellow-500/15 text-yellow-400',
  quote_pending: 'bg-purple-500/15 text-purple-400',
  pending: 'bg-yellow-500/15 text-yellow-400',
  done: 'bg-green-500/15 text-green-400',
};

function formatCurrency(amount: number | null): string {
  if (amount === null) return 'TBD';
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

type DateLevel = 'green' | 'orange' | 'red' | 'unknown';

function dateLevel(dateStr: string | undefined): DateLevel {
  if (!dateStr) return 'unknown';
  const ms = new Date(dateStr).getTime() - Date.now();
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 0) return 'red';
  if (days <= 30) return 'red';
  if (days <= 60) return 'orange';
  return 'green';
}

const levelClasses: Record<DateLevel, { bg: string; text: string; dot: string }> = {
  green:   { bg: 'bg-green-500/10',  text: 'text-green-400',  dot: 'bg-green-500' },
  orange:  { bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-500' },
  red:     { bg: 'bg-red-500/10',    text: 'text-red-400',    dot: 'bg-red-500' },
  unknown: { bg: 'bg-muted/30',      text: 'text-muted-foreground', dot: 'bg-slate-500' },
};

function formatDateShort(dateStr: string | undefined): string {
  if (!dateStr) return 'Not set';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntilLabel(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const ms = new Date(dateStr).getTime() - Date.now();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'due today';
  return `${days}d`;
}

// ComplianceSection merged into TenantRosterSection below

function TotalCommittedSection({ tc }: { tc: NonNullable<Property['total_committed']> }) {
  const [ccOpen, setCcOpen] = useState(false);
  const [debtOpen, setDebtOpen] = useState(false);
  return (
    <div className="mb-4 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Committed</h4>
        <span className="text-sm font-bold">{formatCurrency(tc.total)}</span>
      </div>
      <div className="space-y-1 text-xs">
        {/* Purchase price */}
        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5">
          <span className="text-muted-foreground">Purchase Price</span>
          <span className="font-medium">{formatCurrency(tc.purchase_price)}</span>
        </div>
        {/* Closing costs — expandable */}
        <div className="rounded-md bg-muted/40 overflow-hidden">
          <button onClick={() => setCcOpen(o => !o)}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-muted/60 cursor-pointer text-left">
            <span className="text-muted-foreground">Closing Costs</span>
            <div className="flex items-center gap-1.5">
              <span className="font-medium">{formatCurrency(tc.closing_costs.total)}</span>
              <IconChevronDown size={11} className={`text-muted-foreground transition-transform ${ccOpen ? 'rotate-180' : ''}`} />
            </div>
          </button>
          {ccOpen && (
            <div className="px-3 pb-2 space-y-0.5 border-t border-border/40">
              {tc.closing_costs.items.map((it, i) => (
                <div key={i} className="flex items-center justify-between text-muted-foreground py-0.5">
                  <span>{it.item}</span>
                  <span>{formatCurrency(it.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Rehab released */}
        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5">
          <span className="text-muted-foreground">Rehab Released (Draws 1+2)</span>
          <span className="font-medium">{formatCurrency(tc.rehab_released)}</span>
        </div>
        {/* Outstanding debts — expandable */}
        <div className="rounded-md bg-orange-500/10 border border-orange-500/20 overflow-hidden">
          <button onClick={() => setDebtOpen(o => !o)}
            className="flex items-center justify-between w-full px-3 py-1.5 hover:bg-orange-500/15 cursor-pointer text-left">
            <span className="text-orange-400">Outstanding Debts</span>
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-orange-400">{formatCurrency(tc.outstanding_debts.total)}</span>
              <IconChevronDown size={11} className={`text-orange-400 transition-transform ${debtOpen ? 'rotate-180' : ''}`} />
            </div>
          </button>
          {debtOpen && (
            <div className="px-3 pb-2 space-y-0.5 border-t border-orange-500/20">
              {tc.outstanding_debts.items.map((it, i) => (
                <div key={i} className="flex items-center justify-between text-muted-foreground py-0.5">
                  <div className="flex items-center gap-1.5">
                    <span>{it.item}</span>
                    {it.status === 'estimated' && (
                      <span className="text-[9px] rounded-full bg-yellow-500/15 text-yellow-400 px-1.5 py-0.5">est.</span>
                    )}
                    {it.status === 'pending' && (
                      <span className="text-[9px] rounded-full bg-blue-500/15 text-blue-400 px-1.5 py-0.5">pending</span>
                    )}
                  </div>
                  <span>{it.amount != null ? formatCurrency(it.amount) : 'TBD'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QuoteRow({ quote }: { quote: Property['quotes'][number] }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!quote.notes;
  return (
    <div className="rounded-md bg-muted/30 text-xs overflow-hidden">
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`flex items-center justify-between w-full px-3 py-1.5 text-left ${hasDetail ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{quote.date}</span>
          <span className="font-medium">{quote.item}</span>
          {quote.vendor && quote.vendor !== 'TBD' && (
            <span className="text-muted-foreground">{quote.vendor}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {quote.amount != null
              ? formatCurrency(quote.amount)
              : quote.amount_range ?? 'TBD'}
          </span>
          {hasDetail && (
            <IconChevronDown
              size={13}
              className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            />
          )}
        </div>
      </button>
      {open && quote.notes && (
        <div className="px-3 pb-3 pt-1 border-t border-border/50">
          <p className="whitespace-pre-wrap text-muted-foreground leading-relaxed">{quote.notes}</p>
        </div>
      )}
    </div>
  );
}

const paymentStatusConfig: Record<string, { label: string; classes: string }> = {
  current:     { label: 'Current',     classes: 'bg-green-500/15 text-green-400' },
  late:        { label: 'Late',        classes: 'bg-orange-500/15 text-orange-400' },
  delinquent:  { label: 'Delinquent', classes: 'bg-red-500/15 text-red-400' },
  vacant:      { label: 'Vacant',     classes: 'bg-slate-500/15 text-slate-400' },
  eviction:    { label: 'Eviction',   classes: 'bg-red-600/20 text-red-400' },
};

function TenantRosterSection({ property, roster }: { property: Property; roster: RoomRosterEntry[] }) {
  const hasEviction = roster.some(r => r.eviction_status && r.eviction_status !== 'none' && r.eviction_status !== 'n/a');
  const delinquentCount = roster.filter(r => r.payment_status === 'delinquent' || r.payment_status === 'eviction').length;
  const insurLevel = dateLevel(property.insurance?.renewal_date);
  const taxLevel = dateLevel(property.taxes?.due_date);
  const insurCls = levelClasses[insurLevel];
  const taxCls = levelClasses[taxLevel];

  return (
    <div className="mb-4 rounded-md border bg-muted/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b border-border/50">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <IconUser size={12} /> Tenants & Compliance
        </h4>
        <div className="flex items-center gap-2">
          {delinquentCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold rounded-full bg-red-500/15 text-red-400 px-2 py-0.5">
              <IconAlertTriangle size={9} />{delinquentCount} delinquent
            </span>
          )}
          {hasEviction && (
            <span className="text-[10px] font-semibold rounded-full bg-red-600/20 text-red-400 px-2 py-0.5">Eviction active</span>
          )}
        </div>
      </div>

      {/* Roster table — horizontally scrollable on mobile */}
      <div className="overflow-x-auto">
        <div style={{ minWidth: '580px' }}>
          {/* Header */}
          <div className="grid grid-cols-[0.8fr_1fr_0.9fr_0.75fr_0.65fr_0.75fr_1.2fr] gap-x-2 px-3 py-1.5 border-b border-border/30 bg-muted/10">
            {['Room', 'Tenant', 'Lease Exp.', 'Payment', 'Amt Due', 'Eviction', 'Notes'].map(h => (
              <div key={h} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</div>
            ))}
          </div>

          {/* Roster rows */}
          <div className="divide-y divide-border/20">
            {roster.map((row, i) => {
              const ps = paymentStatusConfig[row.payment_status] ?? { label: row.payment_status, classes: 'bg-muted/30 text-muted-foreground' };
              const leaseLevel = dateLevel(row.lease_expiration);
              const leaseCls = levelClasses[leaseLevel];
              const isVacant = !row.tenant || row.payment_status === 'vacant';
              const prospectInProcess = isVacant
                ? (property.prospect_pipeline ?? []).find(
                    pr => pr.room === row.room && pr.stage !== 'moved_in'
                  )
                : undefined;
              const stageLabel: Record<string, string> = { applied: 'Applied', screening: 'Screening', approved: 'Approved', lease_signed: 'Lease Signed', moved_in: 'Moved In' };
              return (
                <div key={i} className={`grid grid-cols-[0.8fr_1fr_0.9fr_0.75fr_0.65fr_0.75fr_1.2fr] gap-x-2 px-3 py-2 text-xs items-start ${isVacant && !prospectInProcess ? 'opacity-60' : ''} ${prospectInProcess ? 'bg-blue-500/5' : ''}`}>
                  <div className="font-semibold truncate pt-px">{row.room}</div>
                  <div className="truncate text-muted-foreground pt-px">
                    {row.tenant || (
                      prospectInProcess
                        ? <span className="inline-flex items-center gap-1 text-[10px] text-blue-400 font-medium"><span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />{prospectInProcess.name}</span>
                        : <span className="italic text-slate-500">Vacant</span>
                    )}
                  </div>
                  <div className="pt-px">
                    {row.lease_expiration ? (
                      <div>
                        <span className={`text-[10px] font-medium ${leaseCls.text}`}>{formatDateShort(row.lease_expiration)}</span>
                        <span className={`ml-1 text-[9px] ${leaseCls.text} opacity-70`}>{daysUntilLabel(row.lease_expiration)}</span>
                      </div>
                    ) : <span className="text-[10px] text-muted-foreground">—</span>}
                  </div>
                  <div className="pt-px">
                    {prospectInProcess
                      ? <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-blue-500/15 text-blue-400">{stageLabel[prospectInProcess.stage] ?? prospectInProcess.stage}</span>
                      : <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${ps.classes}`}>{ps.label}</span>
                    }
                  </div>
                  <div className={`font-semibold pt-px ${row.amount_due && row.amount_due > 0 ? 'text-orange-400' : 'text-muted-foreground'}`}>
                    {row.amount_due != null && row.amount_due > 0 ? formatCurrency(row.amount_due) : '—'}
                  </div>
                  <div className="pt-px truncate">
                    {row.eviction_status && row.eviction_status !== 'none' && row.eviction_status !== 'n/a'
                      ? <span className="text-[10px] font-semibold text-red-400">{row.eviction_status}</span>
                      : <span className="text-[10px] text-muted-foreground">—</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-relaxed">
                    {prospectInProcess && !row.notes
                      ? <span className="text-blue-400/70 italic">Prospect in process</span>
                      : row.notes || '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Insurance + Taxes footer */}
      {(property.insurance || property.taxes) && (
        <div className="border-t border-border/40 grid grid-cols-2 gap-2 p-2.5">
          <div className={`rounded-md px-2.5 py-2 ${property.insurance ? insurCls.bg : 'bg-muted/30'}`}>
            <div className="flex items-center gap-1 mb-0.5">
              <IconShield size={10} className={property.insurance ? insurCls.text : 'text-muted-foreground'} />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Insurance</span>
            </div>
            {property.insurance ? (
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${insurCls.text}`}>{formatDateShort(property.insurance.renewal_date)}</span>
                <span className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 ${insurCls.bg} ${insurCls.text}`}>{daysUntilLabel(property.insurance.renewal_date)}</span>
              </div>
            ) : <div className="text-xs text-muted-foreground">Not set</div>}
          </div>
          <div className={`rounded-md px-2.5 py-2 ${property.taxes ? taxCls.bg : 'bg-muted/30'}`}>
            <div className="flex items-center gap-1 mb-0.5">
              <IconReceipt size={10} className={property.taxes ? taxCls.text : 'text-muted-foreground'} />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Property Tax</span>
            </div>
            {property.taxes ? (
              <div className="flex items-center justify-between">
                <span className={`text-xs font-semibold ${taxCls.text}`}>{formatDateShort(property.taxes.due_date)}</span>
                <span className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 ${taxCls.bg} ${taxCls.text}`}>{daysUntilLabel(property.taxes.due_date)}</span>
              </div>
            ) : <div className="text-xs text-muted-foreground">Not set</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function PropertyCard({ property }: { property: Property }) {
  const [expanded, setExpanded] = useState(false);
  const occupiedCount = property.units.filter((u) => u.status === 'occupied').length;
  const vacantCount = property.units.filter((u) => u.status === 'vacant').length;
  const urgentNeeds = property.needs.filter((n) => n.priority === 'urgent' || n.priority === 'high').length;
  const totalOwed = property.balances_owed.reduce((sum, b) => sum + (b.amount ?? 0), 0);
  const hasCollectionsRisk = property.balances_owed.some((b) => b.status === 'collections_risk');

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Collapse header — always visible */}
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <IconHome size={16} className="text-primary shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{property.name}</span>
              {urgentNeeds > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-semibold rounded-full bg-red-500/15 text-red-400 px-2 py-0.5">
                  <IconAlertTriangle size={9} />{urgentNeeds} urgent
                </span>
              )}
              {hasCollectionsRisk && (
                <span className="text-[10px] font-semibold rounded-full bg-red-500/15 text-red-400 px-2 py-0.5">collections risk</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {property.city}, {property.state} &middot; {property.entity} &middot; {property.type}
              {property.manager && ` · PM: ${property.manager}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          <span className="text-xs text-muted-foreground">
            {occupiedCount}/{property.units.length} occ
            {totalOwed > 0 ? ` · ${formatCurrency(totalOwed)} owed` : ''}
          </span>
          {property.spreadsheet_url && (
            <a href={property.spreadsheet_url} target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <IconExternalLink size={11} />Sheet
            </a>
          )}
          <IconChevronDown size={15} className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Expandable body */}
      {expanded && (
      <div className="px-5 pb-5 border-t border-border/40">

      {/* Budget comparison */}
      {(property.original_budget != null || property.total_budget != null) && (
        <div className="grid grid-cols-2 gap-3 mb-3 mt-4">
          {property.original_budget != null && (
            <div className="rounded-md bg-muted/50 border px-3 py-2.5">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Original Budget</div>
              <div className="text-base font-semibold">{formatCurrency(property.original_budget)}</div>
            </div>
          )}
          {property.total_budget != null && (
            <div className={`rounded-md border px-3 py-2.5 ${
              property.original_budget != null && property.total_budget > property.original_budget
                ? 'bg-orange-500/10 border-orange-500/30'
                : 'bg-muted/50'
            }`}>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Current Estimate</div>
              <div className={`text-base font-semibold flex items-center gap-2 ${
                property.original_budget != null && property.total_budget > property.original_budget
                  ? 'text-orange-400'
                  : ''
              }`}>
                {formatCurrency(property.total_budget)}
                {property.original_budget != null && property.total_budget > property.original_budget && (
                  <span className="text-[10px] font-normal text-orange-400">
                    +{formatCurrency(property.total_budget - property.original_budget)} over
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Total Committed */}
      {property.total_committed && (
        <TotalCommittedSection tc={property.total_committed} />
      )}

      {/* Draw Progress */}
      {property.draws && (
        <div className="mb-4 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">PPF Draw Progress</h4>
            {property.draws.source_url && (
              <a href={property.draws.source_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                <IconExternalLink size={10} /> Loan Budget
              </a>
            )}
          </div>
          {/* Progress bar */}
          <div className="relative h-2 rounded-full bg-muted mb-2 overflow-hidden">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-blue-500"
              style={{ width: `${Math.min(100, (property.draws.total_released / property.draws.loan_total) * 100).toFixed(1)}%` }}
            />
            {property.draws.total_approved > property.draws.total_released && (
              <div
                className="absolute top-0 h-full rounded-full bg-blue-300/60"
                style={{
                  left: `${((property.draws.total_released / property.draws.loan_total) * 100).toFixed(1)}%`,
                  width: `${Math.min(100 - (property.draws.total_released / property.draws.loan_total) * 100, ((property.draws.total_approved - property.draws.total_released) / property.draws.loan_total) * 100).toFixed(1)}%`,
                }}
              />
            )}
          </div>
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs font-semibold text-blue-400">{formatCurrency(property.draws.total_released)}</div>
              <div className="text-[10px] text-muted-foreground">Released</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-blue-300">{formatCurrency(property.draws.total_approved)}</div>
              <div className="text-[10px] text-muted-foreground">Approved</div>
            </div>
            <div>
              <div className="text-xs font-semibold">{formatCurrency(property.draws.remaining_balance)}</div>
              <div className="text-[10px] text-muted-foreground">Remaining</div>
            </div>
          </div>
          {/* Line items */}
          {property.draws.line_items && property.draws.line_items.length > 0 && (
            <div className="mt-2 space-y-1">
              {property.draws.line_items.map((li, i) => {
                const pct = li.budget > 0 ? Math.min(100, (li.released / li.budget) * 100) : 0;
                const isOver = (li.approved ?? li.released) > li.budget;
                return (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground w-6 shrink-0">#{li.line}</span>
                    <span className="truncate flex-1 font-medium">{li.item}</span>
                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
                      <div
                        className={`h-full rounded-full ${isOver ? 'bg-orange-400' : li.status === 'complete' ? 'bg-green-500' : 'bg-blue-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={`shrink-0 w-16 text-right ${isOver ? 'text-orange-400' : 'text-muted-foreground'}`}>
                      {formatCurrency(li.released)}{isOver ? '⚠' : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Project Financials */}
      {property.financials && (
        <div className="mb-4 rounded-md border bg-muted/30 p-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Project Financials</h4>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-green-500/10 p-2">
              <div className="text-xs font-semibold text-green-400">{formatCurrency(property.financials.target_sale_price)}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Target Sale</div>
            </div>
            <div className="rounded-md bg-red-500/10 p-2">
              <div className="text-xs font-semibold text-red-400">{formatCurrency(property.financials.total_obligations)}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Obligations</div>
            </div>
            <div className="rounded-md bg-blue-500/10 p-2">
              <div className="text-xs font-semibold text-blue-400">{formatCurrency(property.financials.projected_net)}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Proj. Net</div>
            </div>
          </div>
          {property.financials.note && (
            <p className="text-[10px] text-muted-foreground mt-1.5">{property.financials.note}</p>
          )}
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-md bg-muted/50 p-2.5 text-center">
          <div className="text-lg font-semibold">{property.units.length}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Units</div>
        </div>
        <div className="rounded-md bg-green-500/10 p-2.5 text-center">
          <div className="text-lg font-semibold text-green-400">{occupiedCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Occupied</div>
        </div>
        <div className="rounded-md bg-red-500/10 p-2.5 text-center">
          <div className="text-lg font-semibold text-red-400">{vacantCount}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Vacant</div>
        </div>
        <div className={`rounded-md p-2.5 text-center ${hasCollectionsRisk ? 'bg-red-500/10' : 'bg-orange-500/10'}`}>
          <div className={`text-lg font-semibold ${hasCollectionsRisk ? 'text-red-400' : 'text-orange-400'}`}>
            {totalOwed > 0 ? formatCurrency(totalOwed) : 'TBD'}
          </div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Owed</div>
        </div>
      </div>

      {/* Unified tenant roster + compliance — explicit room_roster or derived from units */}
      {(() => {
        const roster: RoomRosterEntry[] = property.room_roster
          ? property.room_roster
          : property.units.map(u => ({
              room: u.name,
              tenant: u.tenant,
              lease_expiration: u.lease_expiration,
              payment_status: u.status === 'vacant' ? 'vacant' : 'current',
              amount_due: null,
              eviction_status: undefined,
              notes: u.notes,
            }));
        return (roster.length > 0 || property.insurance || property.taxes)
          ? <TenantRosterSection property={property} roster={roster} />
          : null;
      })()}

      {/* Needs / Open Issues */}
      {property.needs.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Open Issues
            {urgentNeeds > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-500/15 text-red-400 px-2 py-0.5 text-[10px]">
                <IconAlertTriangle size={10} />
                {urgentNeeds} urgent
              </span>
            )}
          </h4>
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 bg-muted/40">
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Issue</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Unit</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Vendor</th>
                  <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Cost</th>
                  <th className="px-3 py-2 text-center font-semibold text-muted-foreground">Status</th>
                  <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Est. Completion</th>
                </tr>
              </thead>
              <tbody>
                {property.needs.map((need, i) => (
                  <tr key={i} className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? 'bg-muted/10' : ''}`}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${priorityColors[need.priority] ?? ''}`}>
                          {need.priority}
                        </span>
                        <span className="font-medium">{need.item}</span>
                      </div>
                      {need.notes && <p className="mt-0.5 text-[10px] text-muted-foreground pl-10">{need.notes}</p>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{need.unit ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{need.vendor ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {need.cost !== null ? formatCurrency(need.cost) : <span className="text-muted-foreground">TBD</span>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusColors[need.status] ?? ''}`}>
                        {need.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {need.expected_completion_date
                        ? <span className={dateLevel(need.expected_completion_date) === 'red' ? 'text-red-400 font-medium' : dateLevel(need.expected_completion_date) === 'orange' ? 'text-orange-400' : ''}>{formatDateShort(need.expected_completion_date)}</span>
                        : <span className="text-muted-foreground/50">—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Balances Owed */}
      {property.balances_owed.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Outstanding Balances</h4>
          <div className="space-y-1">
            {property.balances_owed.map((bal, i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  {bal.status === 'collections_risk' && <IconAlertTriangle size={12} className="text-red-400" />}
                  <span className="font-medium">{bal.to}</span>
                  <span className="text-muted-foreground">{bal.reason}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${bal.status === 'collections_risk' ? 'text-red-400' : ''}`}>
                    {formatCurrency(bal.amount)}
                  </span>
                  {bal.status === 'collections_risk' && (
                    <span className="rounded-full bg-red-500/15 text-red-400 px-1.5 py-0.5 text-[10px] font-medium">collections risk</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quotes */}
      {property.quotes.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quotes</h4>
          <div className="space-y-1">
            {property.quotes.map((q, i) => (
              <QuoteRow key={i} quote={q} />
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Owner: {property.owner}</span>
        {property.last_report && (
          <span className="flex items-center gap-1">
            <IconClock size={11} />
            Last report: {property.last_report} by {property.last_report_by}
          </span>
        )}
      </div>
      </div>
      )}
    </div>
  );
}

export default function PropertiesPage() {
  const { currentOrg } = useOrg();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProperties = useCallback(async () => {
    const params = new URLSearchParams();
    if (currentOrg && currentOrg !== 'all') params.set('org', currentOrg);
    try {
      const res = await fetch(`/api/properties?${params.toString()}`);
      const data = await res.json();
      setProperties(Array.isArray(data) ? data : []);
    } catch {
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => { fetchProperties(); }, [fetchProperties]);

  const [activeClient, setActiveClient] = useState<string>('All');

  // Derive sorted client list from owner field
  const clients = ['All', ...Array.from(new Set(properties.map((p) => p.owner).filter(Boolean))).sort()];

  const visibleProperties = activeClient === 'All'
    ? properties
    : properties.filter((p) => p.owner === activeClient);

  const totalUnits = visibleProperties.reduce((s, p) => s + p.units.length, 0);
  const occupied = visibleProperties.reduce((s, p) => s + p.units.filter((u) => u.status === 'occupied').length, 0);
  const vacant = visibleProperties.reduce((s, p) => s + p.units.filter((u) => u.status === 'vacant').length, 0);
  const totalNeeds = visibleProperties.reduce((s, p) => s + p.needs.length, 0);
  const urgentNeeds = visibleProperties.reduce((s, p) => s + p.needs.filter((n) => n.priority === 'urgent' || n.priority === 'high').length, 0);

  // Compliance alerts across portfolio
  const complianceAlerts = visibleProperties.flatMap((p) => {
    const alerts: { property: string; type: string; date: string; level: DateLevel }[] = [];
    p.units.forEach((u) => {
      if (u.status === 'occupied' && u.tenant && u.lease_expiration) {
        const lv = dateLevel(u.lease_expiration);
        if (lv === 'red' || lv === 'orange') alerts.push({ property: p.name, type: `Lease — ${u.tenant}`, date: u.lease_expiration, level: lv });
      }
    });
    if (p.insurance) {
      const lv = dateLevel(p.insurance.renewal_date);
      if (lv === 'red' || lv === 'orange') alerts.push({ property: p.name, type: 'Insurance renewal', date: p.insurance.renewal_date, level: lv });
    }
    if (p.taxes) {
      const lv = dateLevel(p.taxes.due_date);
      if (lv === 'red' || lv === 'orange') alerts.push({ property: p.name, type: 'Property tax', date: p.taxes.due_date, level: lv });
    }
    return alerts;
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Timberline Management LLC</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Property management &mdash; properties, units, maintenance, and financials
          </p>
        </div>
        <button
          onClick={fetchProperties}
          className="rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Client tabs */}
      {!loading && clients.length > 2 && (
        <div className="flex gap-1 border-b">
          {clients.map((client) => {
            const count = client === 'All' ? properties.length : properties.filter((p) => p.owner === client).length;
            const isActive = activeClient === client;
            return (
              <button
                key={client}
                onClick={() => setActiveClient(client)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
                }`}
              >
                {client}
                <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 ${isActive ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Portfolio Summary */}
      {!loading && visibleProperties.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold">{visibleProperties.length}</div>
            <div className="text-xs text-muted-foreground mt-1">Properties</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold">{totalUnits}</div>
            <div className="text-xs text-muted-foreground mt-1">Total Units</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold text-green-400">{occupied}</div>
            <div className="text-xs text-muted-foreground mt-1">Occupied</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className="text-2xl font-bold text-red-400">{vacant}</div>
            <div className="text-xs text-muted-foreground mt-1">Vacant</div>
          </div>
          <div className="rounded-lg border bg-card p-4 text-center">
            <div className={`text-2xl font-bold ${urgentNeeds > 0 ? 'text-orange-400' : 'text-muted-foreground'}`}>{totalNeeds}</div>
            <div className="text-xs text-muted-foreground mt-1">Open Needs</div>
          </div>
        </div>
      )}

      {/* Compliance Alerts Banner */}
      {!loading && complianceAlerts.length > 0 && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <IconAlertTriangle size={15} className="text-orange-400 shrink-0" />
            <span className="text-sm font-semibold text-orange-400">Compliance Attention Required ({complianceAlerts.length})</span>
          </div>
          <div className="space-y-1.5">
            {complianceAlerts.map((alert, i) => {
              const cls = levelClasses[alert.level];
              return (
                <div key={i} className={`flex items-center justify-between rounded-md px-3 py-1.5 text-xs ${cls.bg}`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${cls.dot}`} />
                    <span className="font-medium">{alert.property}</span>
                    <span className="text-muted-foreground">{alert.type}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] ${cls.text}`}>{formatDateShort(alert.date)}</span>
                    <span className={`text-[9px] font-semibold rounded-full px-1.5 py-0.5 border ${cls.text} border-current/20`}>
                      {daysUntilLabel(alert.date)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Prospect Pipeline */}
      {!loading && (() => {
        const allProspects: ProspectWithProperty[] = visibleProperties.flatMap(p =>
          (p.prospect_pipeline ?? []).map(pr => ({
            ...pr,
            property_name: p.name,
            property_id: p.id,
          }))
        );
        if (allProspects.length === 0) return null;
        return <ProspectPipeline prospects={allProspects} />;
      })()}

      {/* Property Cards */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          Loading properties...
        </div>
      ) : visibleProperties.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          No properties found.
        </div>
      ) : (
        <div className="space-y-4">
          {visibleProperties.map((property) => (
            <PropertyCard key={property.id} property={property} />
          ))}
        </div>
      )}
    </div>
  );
}
