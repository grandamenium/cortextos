'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  IconSearch,
  IconFilter,
  IconLayoutGrid,
  IconTable,
  IconShieldCheck,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LaneHeader, StatCard } from '@/components/pulse/pulse-ui';
import type { SopIndexRow } from '@/lib/data/sop-model';
import { roleLabel } from './sop-chips';

export function SopLibrary({ rows }: { rows: SopIndexRow[] }) {
  const [search, setSearch] = useState('');
  const [subjectType, setSubjectType] = useState('all');
  const [agent, setAgent] = useState('all');
  const [view, setView] = useState<'grid' | 'table'>('grid');

  const subjectTypes = useMemo(
    () => ['all', ...Array.from(new Set(rows.map((r) => r.subject_type))).sort()],
    [rows],
  );
  const agents = useMemo(
    () => ['all', ...Array.from(new Set(rows.flatMap((r) => r.involved_roles))).sort()],
    [rows],
  );

  const filtered = rows.filter((row) => {
    if (subjectType !== 'all' && row.subject_type !== subjectType) return false;
    if (agent !== 'all' && !row.involved_roles.includes(agent)) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = `${row.name} ${row.description} ${row.slug}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const totalGated = rows.reduce((n, r) => n + r.gated_step_count, 0);
  const driftCount = rows.filter((r) => r.drift_detected).length;
  const unmappedCount = rows.filter((r) => r.has_unmapped_role).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <LaneHeader label="SOP Library" sub={`${rows.length} playbooks, every external action human-gated`} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center rounded-full border border-primary/40 bg-primary/10 px-3 text-[12px] font-medium text-primary">
              Library
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total SOPs" value={String(rows.length)} />
        <StatCard
          label="Gated actions"
          value={String(totalGated)}
          sub={totalGated === 0 ? 'none in this corpus yet' : undefined}
          accent={totalGated > 0}
        />
        <StatCard label="Drift flagged" value={String(driftCount)} negative={driftCount > 0} />
        <StatCard label="Unmapped roles" value={String(unmappedCount)} negative={unmappedCount > 0} />
      </div>

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <IconSearch size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, description, slug..."
                className="h-8 w-64 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Search SOPs"
              />
            </div>
            <div className="relative">
              <IconFilter size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <select
                value={subjectType}
                onChange={(e) => setSubjectType(e.target.value)}
                className="h-8 rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter by subject type"
              >
                {subjectTypes.map((t) => (
                  <option key={t} value={t}>
                    {t === 'all' ? 'All subject types' : t}
                  </option>
                ))}
              </select>
            </div>
            <div className="relative">
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="h-8 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label="Filter by involved agent"
              >
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a === 'all' ? 'All agents' : roleLabel(a)}
                  </option>
                ))}
              </select>
            </div>
            <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
              <button
                type="button"
                onClick={() => setView('grid')}
                className={`rounded p-1.5 ${view === 'grid' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                aria-label="Grid view"
                title="Grid view"
              >
                <IconLayoutGrid size={15} />
              </button>
              <button
                type="button"
                onClick={() => setView('table')}
                className={`rounded p-1.5 ${view === 'table' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}
                aria-label="Table view"
                title="Table view"
              >
                <IconTable size={15} />
              </button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              No SOPs match the current filters.
            </div>
          ) : view === 'grid' ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((row) => (
                <SopCard key={row.slug} row={row} />
              ))}
            </div>
          ) : (
            <SopTable rows={filtered} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SopCard({ row }: { row: SopIndexRow }) {
  return (
    <div
      className="flex h-full flex-col gap-2 rounded-lg border bg-secondary/10 p-3.5 transition-colors hover:border-primary/40 hover:bg-secondary/20"
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/sops/${row.slug}`} className="text-sm font-semibold leading-snug hover:underline">
          {row.name}
        </Link>
        {row.drift_detected && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
            <IconAlertTriangle size={10} />
            Drift
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">{row.subject_type}</Badge>
        {row.is_synthetic_demo && (
          <Badge variant="secondary" className="text-[10px]">Demo fixture</Badge>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {row.stage_count} stages &middot; {row.task_count} steps
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${
            row.gated_step_count > 0
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
              : 'border-border bg-secondary/30 text-muted-foreground'
          }`}
        >
          <IconShieldCheck size={11} />
          {row.gated_step_count}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {row.involved_roles.slice(0, 5).map((role) => (
          <span key={role} className="rounded-full border border-border bg-secondary/30 px-2 py-0.5 text-[10px] text-muted-foreground">
            {roleLabel(role)}
          </span>
        ))}
        {row.involved_roles.length > 5 && (
          <span className="text-[10px] text-muted-foreground">+{row.involved_roles.length - 5} more</span>
        )}
      </div>
    </div>
  );
}

function SopTable({ rows }: { rows: SopIndexRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Name</th>
            <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</th>
            <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Stages</th>
            <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</th>
            <th className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Gated</th>
            <th className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slug} className="border-b last:border-0 hover:bg-muted/40">
              <td className="py-2.5 pr-4">
                <Link href={`/sops/${row.slug}`} className="font-medium hover:underline">
                  {row.name}
                </Link>
              </td>
              <td className="py-2.5 pr-4 text-muted-foreground">{row.subject_type}</td>
              <td className="py-2.5 pr-4 tabular-nums">{row.stage_count}</td>
              <td className="py-2.5 pr-4 tabular-nums">{row.task_count}</td>
              <td className="py-2.5 pr-4 tabular-nums">{row.gated_step_count}</td>
              <td className="py-2.5">
                {row.drift_detected && (
                  <Badge variant="destructive" className="text-[10px]">Drift</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
