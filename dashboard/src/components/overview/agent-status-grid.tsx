'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { IconRobot } from '@tabler/icons-react';
import type { AgentSummary, Heartbeat, HealthStatus } from '@/lib/types';

interface AgentStatusGridProps {
  agents: (AgentSummary & { emoji?: string; systemName?: string })[];
  heartbeats: Record<string, Heartbeat>;
}

function shortTimeAgo(iso?: string): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 90_000) return 'just now';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

const BORDER_CLASS: Record<HealthStatus, string> = {
  healthy: 'border-l-emerald-500',
  stale: 'border-l-amber-400',
  down: 'border-l-rose-400',
};

const GROUP_ORDER: HealthStatus[] = ['healthy', 'stale', 'down'];
const GROUP_LABEL: Record<HealthStatus, string> = {
  healthy: 'Active',
  stale: 'Stale',
  down: 'Offline',
};

export function AgentStatusGrid({ agents, heartbeats }: AgentStatusGridProps) {
  const grouped = GROUP_ORDER
    .map((health) => ({
      health,
      label: GROUP_LABEL[health],
      items: agents.filter((a) => a.health === health),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <IconRobot size={16} className="text-muted-foreground" />
            Agent Fleet
          </span>
          {/* Legend */}
          <span className="flex items-center gap-3 text-[11px] font-normal text-muted-foreground">
            <span className="flex items-center gap-1"><HealthDot status="healthy" />Active</span>
            <span className="flex items-center gap-1"><HealthDot status="stale" />Stale</span>
            <span className="flex items-center gap-1"><HealthDot status="down" />Offline</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {agents.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No agents discovered</p>
        ) : (
          grouped.map(({ health, label, items }) => (
            <div key={health}>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label} · {items.length}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {items.map((agent) => {
                  const systemName = agent.systemName ?? agent.name;
                  const hb = heartbeats[systemName];
                  const snippet = hb?.current_task
                    ? hb.current_task.replace(/^WORKING ON:\s*/i, '').slice(0, 72)
                    : null;
                  const timeAgo = shortTimeAgo(hb?.last_heartbeat);

                  return (
                    <Link
                      key={systemName}
                      href={`/agents/${encodeURIComponent(systemName)}`}
                      className={`group flex flex-col gap-1 rounded-md border border-l-4 bg-card p-2 transition-colors hover:bg-muted/50 ${BORDER_CLASS[health]}`}
                    >
                      <div className="flex items-start gap-1.5">
                        <HealthDot status={health} className="mt-0.5 shrink-0" />
                        <span className="break-words text-[11px] font-medium leading-snug">
                          {agent.name}
                        </span>
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">{timeAgo}</span>
                      <p className="line-clamp-1 text-[10px] leading-snug text-muted-foreground">
                        {snippet ?? <span className="italic opacity-60">Idle</span>}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
