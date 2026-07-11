'use client';

import type { ProspectEntry, ProspectStage } from '@/lib/data/properties';

export interface ProspectWithProperty extends ProspectEntry {
  property_name: string;
  property_id: string;
}

const STAGES: { key: ProspectStage; label: string }[] = [
  { key: 'applied', label: 'Applied' },
  { key: 'screening', label: 'Screening' },
  { key: 'approved', label: 'Approved' },
  { key: 'lease_signed', label: 'Lease Signed' },
  { key: 'moved_in', label: 'Moved In' },
];

const STAGE_COLORS: Record<ProspectStage, { bg: string; text: string; dot: string; border: string }> = {
  applied:      { bg: 'bg-blue-500/10',   text: 'text-blue-400',   dot: 'bg-blue-500',   border: 'border-blue-500/30' },
  screening:    { bg: 'bg-yellow-500/10', text: 'text-yellow-400', dot: 'bg-yellow-400', border: 'border-yellow-500/30' },
  approved:     { bg: 'bg-green-500/10',  text: 'text-green-400',  dot: 'bg-green-500',  border: 'border-green-500/30' },
  lease_signed: { bg: 'bg-purple-500/10', text: 'text-purple-400', dot: 'bg-purple-500', border: 'border-purple-500/30' },
  moved_in:     { bg: 'bg-slate-500/10',  text: 'text-slate-400',  dot: 'bg-slate-400',  border: 'border-slate-500/30' },
};

function StageBadge({ stage }: { stage: ProspectStage }) {
  const c = STAGE_COLORS[stage];
  const label = STAGES.find(s => s.key === stage)?.label ?? stage;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full border ${c.bg} ${c.text} ${c.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {label}
    </span>
  );
}

function StageProgressBar({ stage }: { stage: ProspectStage }) {
  const idx = STAGES.findIndex(s => s.key === stage);
  const pct = Math.round(((idx + 1) / STAGES.length) * 100);
  const c = STAGE_COLORS[stage];
  return (
    <div className="w-full bg-muted/30 rounded-full h-1 mt-2">
      <div
        className={`h-1 rounded-full transition-all ${c.dot}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ProspectCard({ p }: { p: ProspectWithProperty }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-sm text-foreground">{p.name}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {p.property_name}{p.room ? ` · ${p.room}` : ''}
          </div>
        </div>
        <StageBadge stage={p.stage} />
      </div>
      <StageProgressBar stage={p.stage} />
      {p.notes && (
        <div className="text-xs text-muted-foreground italic border-t border-border/50 pt-1">{p.notes}</div>
      )}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {p.applied_date && <span>Applied: {p.applied_date}</span>}
        {p.stage_updated && p.stage_updated !== p.applied_date && (
          <span>Updated: {p.stage_updated}</span>
        )}
        {p.contact?.phone && <span>{p.contact.phone}</span>}
        {p.contact?.email && <span className="truncate max-w-[160px]">{p.contact.email}</span>}
      </div>
    </div>
  );
}

interface Props {
  prospects: ProspectWithProperty[];
}

export function ProspectPipeline({ prospects }: Props) {
  if (prospects.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Prospect Pipeline</h3>
        <p className="text-xs text-muted-foreground italic">No active prospects in pipeline</p>
      </div>
    );
  }

  const byStage: Record<ProspectStage, ProspectWithProperty[]> = {
    applied: [],
    screening: [],
    approved: [],
    lease_signed: [],
    moved_in: [],
  };

  for (const p of prospects) {
    if (p.stage in byStage) byStage[p.stage].push(p);
  }

  const activeStages = STAGES.filter(s => byStage[s.key].length > 0);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Prospect Pipeline
        </h3>
        <span className="text-xs text-muted-foreground">{prospects.length} active</span>
      </div>

      {/* Stage column layout */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        {STAGES.map(stage => {
          const items = byStage[stage.key];
          const c = STAGE_COLORS[stage.key];
          return (
            <div key={stage.key} className="space-y-2">
              <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${c.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                {stage.label}
                {items.length > 0 && (
                  <span className={`ml-auto text-[10px] rounded-full px-1.5 py-0.5 ${c.bg} ${c.text} border ${c.border}`}>
                    {items.length}
                  </span>
                )}
              </div>
              {items.length === 0 ? (
                <div className="border border-dashed border-border/40 rounded-lg p-2 text-center">
                  <span className="text-[10px] text-muted-foreground/40">empty</span>
                </div>
              ) : (
                items.map((p, i) => <ProspectCard key={i} p={p} />)
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
