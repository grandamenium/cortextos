'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { IconRobot, IconChevronRight } from '@tabler/icons-react';
import type { AgentSummary, Heartbeat } from '@/lib/types';

interface AgentStatusGridProps {
  agents: (AgentSummary & { emoji?: string; systemName?: string })[];
  heartbeats: Record<string, Heartbeat>;
}

export function AgentStatusGrid({ agents, heartbeats }: AgentStatusGridProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <IconRobot size={16} className="text-muted-foreground" />
          Agent Fleet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No agents discovered
          </p>
        ) : (
          agents.map((agent) => {
            const systemName = agent.systemName ?? agent.name;
            const hb = heartbeats[systemName];
            const currentTask = hb?.current_task || '';
            const taskPreview = currentTask
              .replace(/^WORKING ON:\s*/i, '')
              .slice(0, 60);

            return (
              <Link
                key={systemName}
                href={`/agents/${encodeURIComponent(systemName)}`}
                className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50 transition-colors"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-sm">
                  {agent.emoji || agent.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {agent.name}
                    </span>
                    <HealthDot status={agent.health} />
                  </div>
                  {taskPreview && (
                    <p className="text-[11px] text-muted-foreground truncate">
                      {taskPreview}
                    </p>
                  )}
                </div>
                <IconChevronRight
                  size={14}
                  className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors"
                />
              </Link>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
