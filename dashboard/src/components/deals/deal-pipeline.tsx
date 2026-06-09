'use client';

import { IconExternalLink, IconMapPin, IconRobot } from '@tabler/icons-react';
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

const SIDE_STAGES: DealStatus[] = ['passed', 'monitoring'];

function DealCard({ deal }: { deal: Deal }) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm hover:shadow-md transition-shadow space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight truncate">
            {deal.address}
          </p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
            <IconMapPin size={11} />
            {deal.city}, {deal.state}
          </p>
        </div>
        <DealScore score={deal.score} />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {deal.strategy}
        </span>
        {deal.source_agent && (
          <span className="flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <IconRobot size={10} />
            {deal.source_agent}
          </span>
        )}
      </div>

      {deal.notes && (
        <p className="text-xs text-muted-foreground line-clamp-2">{deal.notes}</p>
      )}

      {deal.drive_doc_url && (
        <a
          href={deal.drive_doc_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <IconExternalLink size={11} />
          Drive doc
        </a>
      )}
    </div>
  );
}

function PipelineColumn({
  label,
  deals,
  muted = false,
}: {
  label: string;
  deals: Deal[];
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
          deals.map((d) => <DealCard key={d.id} deal={d} />)
        )}
      </div>
    </div>
  );
}

export function DealPipeline({ deals }: { deals: Deal[] }) {
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

      {/* Active pipeline — horizontal scroll on small screens */}
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-4" style={{ minWidth: `${PIPELINE_STAGES.length * 220}px` }}>
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage.status} className="flex-1">
              <PipelineColumn label={stage.label} deals={byStatus(stage.status)} />
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
              <div key={d.id} className="opacity-60 hover:opacity-100 transition-opacity">
                <div className="rounded-lg border bg-card p-3 shadow-sm space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{deal_label(d)}</p>
                      <p className="text-xs text-muted-foreground">{d.city}, {d.state}</p>
                    </div>
                    <DealStatusBadge status={d.status} />
                  </div>
                  {d.notes && <p className="text-xs text-muted-foreground line-clamp-1">{d.notes}</p>}
                </div>
              </div>
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
