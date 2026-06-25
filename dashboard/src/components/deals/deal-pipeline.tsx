'use client';

import { useState, useCallback } from 'react';
import { IconExternalLink, IconMapPin, IconRobot, IconEdit, IconCheck, IconX } from '@tabler/icons-react';
import { DealStatusBadge } from './deal-status-badge';
import { DealScore } from './deal-score';
import type { Deal, DealStatus } from '@/lib/types';

const PIPELINE_STAGES: { status: DealStatus; label: string }[] = [
  { status: 'screening',    label: 'Screening' },
  { status: 'underwriting', label: 'Underwriting' },
  { status: 'approved',     label: 'Approved' },
  { status: 'funded',       label: 'Funded' },
  { status: 'closed',       label: 'Closed' },
];

const ALL_STATUSES: DealStatus[] = ['screening', 'underwriting', 'approved', 'funded', 'closed', 'passed', 'monitoring'];
const SIDE_STAGES: DealStatus[] = ['passed', 'monitoring'];

async function patchDeal(id: string, org: string, update: Partial<Deal>): Promise<Deal | null> {
  try {
    const res = await fetch('/api/deals', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, org, ...update }),
    });
    if (!res.ok) return null;
    return res.json() as Promise<Deal>;
  } catch { return null; }
}

function DealCard({ deal, onUpdate }: { deal: Deal; onUpdate: (updated: Deal) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editStatus, setEditStatus] = useState<DealStatus>(deal.status);
  const [editNotes, setEditNotes] = useState(deal.notes ?? '');
  const [editStrategy, setEditStrategy] = useState(deal.strategy);

  const openEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditStatus(deal.status);
    setEditNotes(deal.notes ?? '');
    setEditStrategy(deal.strategy);
    setEditing(true);
    setExpanded(true);
  };

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  const saveEdit = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    const updated = await patchDeal(deal.id, deal.org, {
      status: editStatus,
      notes: editNotes || undefined,
      strategy: editStrategy,
    });
    setSaving(false);
    if (updated) {
      onUpdate(updated);
      setEditing(false);
    }
  }, [deal.id, deal.org, editStatus, editNotes, editStrategy, onUpdate]);

  return (
    <div
      className={`rounded-lg border bg-card shadow-sm transition-shadow ${expanded ? 'shadow-md' : 'hover:shadow-md cursor-pointer'}`}
      onClick={() => !editing && setExpanded(o => !o)}
    >
      {/* Header row — always visible */}
      <div className="flex items-start justify-between gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight truncate">{deal.address}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
            <IconMapPin size={11} />
            {deal.city}, {deal.state}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <DealScore score={deal.score} />
          <button
            onClick={openEdit}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Edit deal"
          >
            <IconEdit size={13} />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border/40 px-3 pb-3 pt-2 space-y-2.5" onClick={e => e.stopPropagation()}>
          {editing ? (
            /* Edit form */
            <div className="space-y-2">
              {/* Status */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</label>
                <select
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value as DealStatus)}
                  className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {ALL_STATUSES.map(s => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </div>
              {/* Strategy */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Strategy</label>
                <input
                  type="text"
                  value={editStrategy}
                  onChange={e => setEditStrategy(e.target.value)}
                  className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* Notes */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</label>
                <textarea
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  rows={3}
                  className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-xs text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* Actions */}
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  onClick={saveEdit}
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  <IconCheck size={12} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={cancelEdit}
                  className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <IconX size={12} />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* Read-only expanded view */
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <DealStatusBadge status={deal.status} />
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{deal.strategy}</span>
                {deal.source_agent && (
                  <span className="flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    <IconRobot size={10} />{deal.source_agent}
                  </span>
                )}
              </div>
              {deal.notes && <p className="text-xs text-muted-foreground">{deal.notes}</p>}
              {deal.drive_doc_url && (
                <a href={deal.drive_doc_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline">
                  <IconExternalLink size={11} />Drive doc
                </a>
              )}
              <p className="text-[10px] text-muted-foreground">Updated {new Date(deal.updated_at).toLocaleDateString()}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PipelineColumn({
  label,
  deals,
  onUpdate,
  muted = false,
}: {
  label: string;
  deals: Deal[];
  onUpdate: (updated: Deal) => void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-[200px]">
      <div className="flex items-center justify-between px-1">
        <span className={`text-xs font-semibold uppercase tracking-wide ${muted ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}>
          {label}
        </span>
        <span className="text-xs text-muted-foreground">{deals.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {deals.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground/50">
            No deals
          </p>
        ) : (
          deals.map((d) => <DealCard key={d.id} deal={d} onUpdate={onUpdate} />)
        )}
      </div>
    </div>
  );
}

export function DealPipeline({ deals: initialDeals }: { deals: Deal[] }) {
  const [deals, setDeals] = useState<Deal[]>(initialDeals);

  const handleUpdate = useCallback((updated: Deal) => {
    setDeals(prev => prev.map(d => d.id === updated.id ? updated : d));
  }, []);

  const byStatus = (status: DealStatus) => deals.filter((d) => d.status === status);
  const activeDeals = deals.filter((d) => !SIDE_STAGES.includes(d.status));
  const sideDeals = deals.filter((d) => SIDE_STAGES.includes(d.status));

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span><strong className="text-foreground">{deals.length}</strong> total deals</span>
        <span><strong className="text-foreground">{activeDeals.length}</strong> active</span>
        <span><strong className="text-foreground">{sideDeals.length}</strong> passed/monitoring</span>
      </div>

      {/* Active pipeline */}
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-4" style={{ minWidth: `${PIPELINE_STAGES.length * 220}px` }}>
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage.status} className="flex-1">
              <PipelineColumn label={stage.label} deals={byStatus(stage.status)} onUpdate={handleUpdate} />
            </div>
          ))}
        </div>
      </div>

      {/* Side rail: passed + monitoring */}
      {sideDeals.length > 0 && (
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground/50">
            Passed / Monitoring
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {sideDeals.map((d) => (
              <DealCard key={d.id} deal={d} onUpdate={handleUpdate} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function deal_label(deal: Deal): string {
  return deal.address !== deal.city ? deal.address : `${deal.city} (${deal.strategy})`;
}
