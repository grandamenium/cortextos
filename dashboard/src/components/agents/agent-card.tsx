'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { AgentActions } from './agent-actions';
import {
  IconChecklist,
  IconAlertTriangle,
  IconPlayerPause,
  IconClock,
} from '@tabler/icons-react';
import type { HealthStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface AgentOpsData {
  crashesToday: number;
  maxCrashesPerDay: number;
  halted: boolean;
  rateLimited: boolean;
  rateLimitResetsAt: string | null;
  rateLimitResetsAtMs: number | null;
  weeklyUsagePct: number | null;
  restartsTodayTotal: number;
  lastRestart: string | null;
  model: string | null;
}

export interface AgentCardData {
  name: string;
  /** Filesystem / config key (e.g. "devbot"). Used for URL routing. */
  systemName: string;
  org: string;
  emoji: string;
  role: string;
  health: HealthStatus;
  currentTask?: string;
  tasksToday: number;
  ops?: AgentOpsData;
}

interface AgentCardProps {
  agent: AgentCardData;
}

export function AgentCard({ agent }: AgentCardProps) {
  const router = useRouter();

  const healthLabel =
    agent.health === 'healthy' ? 'Online' :
    agent.health === 'stale' ? 'Stale' : 'Offline';

  return (
    <Link href={`/agents/${encodeURIComponent(agent.systemName)}`}>
      <Card className="group relative h-full cursor-pointer transition-all hover:shadow-md hover:border-primary/20">
        <CardContent className="space-y-3">
          {/* Header: avatar + name + health */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <AgentAvatar name={agent.name} emoji={agent.emoji} size="md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold leading-tight">{agent.name}</p>
                  <HealthDot status={agent.health} />
                </div>
                {agent.systemName && agent.systemName !== agent.name && (
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {agent.systemName}
                  </p>
                )}
                {agent.role && (
                  <p className="text-[11px] text-muted-foreground truncate max-w-[180px] mt-0.5">
                    {agent.role}
                  </p>
                )}
              </div>
            </div>
            <AgentActions
              agentName={agent.systemName}
              org={agent.org}
              health={agent.health}
              onAction={() => router.refresh()}
            />
          </div>

          {/* Org badge */}
          {agent.org && <OrgBadge org={agent.org} />}

          {/* Current task */}
          {agent.currentTask ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground mb-0.5">Working on</p>
              <p className="text-xs leading-snug line-clamp-2">
                {agent.currentTask.replace(/^WORKING ON:\s*/i, '')}
              </p>
            </div>
          ) : (
            <div className="rounded-md bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">
                {agent.health === 'healthy' ? 'Idle' : healthLabel}
              </p>
            </div>
          )}

          {/* Ops status strip */}
          {agent.ops && (agent.ops.halted || agent.ops.rateLimited || agent.ops.crashesToday > 0) && (
            <div className="space-y-1">
              {agent.ops.halted && (
                <div className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-400">
                  <IconAlertTriangle size={13} />
                  <span className="font-medium">Halted</span>
                  <span className="text-red-500/70">
                    — {agent.ops.crashesToday}/{agent.ops.maxCrashesPerDay} crashes
                  </span>
                </div>
              )}
              {agent.ops.rateLimited && !agent.ops.halted && (
                <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <IconPlayerPause size={13} />
                  <span className="font-medium">Rate limited</span>
                  {agent.ops.rateLimitResetsAt && (
                    <span className="text-amber-500/70">
                      — resets {agent.ops.rateLimitResetsAt}
                    </span>
                  )}
                </div>
              )}
              {!agent.ops.halted && !agent.ops.rateLimited && agent.ops.crashesToday > 0 && (
                <div className="flex items-center gap-1.5 rounded-md bg-orange-500/10 px-2 py-1.5 text-xs text-orange-600 dark:text-orange-400">
                  <IconClock size={13} />
                  <span>
                    {agent.ops.crashesToday}/{agent.ops.maxCrashesPerDay} crashes today
                    {agent.ops.restartsTodayTotal > 0 && (
                      <span className="text-orange-500/60"> · {agent.ops.restartsTodayTotal} restarts</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Footer: tasks + usage */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <IconChecklist size={13} />
              <span>
                {agent.tasksToday} task{agent.tasksToday !== 1 ? 's' : ''} today
              </span>
            </div>
            {agent.ops?.weeklyUsagePct != null && (
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    'h-1.5 w-12 rounded-full bg-muted overflow-hidden',
                  )}
                >
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      agent.ops.weeklyUsagePct >= 90
                        ? 'bg-red-500'
                        : agent.ops.weeklyUsagePct >= 70
                          ? 'bg-amber-500'
                          : 'bg-emerald-500',
                    )}
                    style={{ width: `${Math.min(agent.ops.weeklyUsagePct, 100)}%` }}
                  />
                </div>
                <span className={cn(
                  agent.ops.weeklyUsagePct >= 90 ? 'text-red-500' :
                  agent.ops.weeklyUsagePct >= 70 ? 'text-amber-500' : '',
                )}>
                  {agent.ops.weeklyUsagePct}%
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
