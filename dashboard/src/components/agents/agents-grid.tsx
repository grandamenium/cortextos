'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentCard, type AgentCardData, type AgentOpsData } from './agent-card';
import { AddAgentCard } from './add-agent-card';
import { CreateAgentDialog } from './create-agent-dialog';
import { HealthDot } from '@/components/shared/health-dot';
import { IconUsers } from '@tabler/icons-react';
import { useSSE } from '@/hooks/use-sse';
import type { HealthStatus, SSEEvent } from '@/lib/types';

interface AgentsGridProps {
  initialAgents: AgentCardData[];
}

export function AgentsGrid({ initialAgents }: AgentsGridProps) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentCardData[]>(initialAgents);
  const [createOpen, setCreateOpen] = useState(false);

  // Fetch operational data (crashes, rate limits, usage) and refresh every 60s
  useEffect(() => {
    async function fetchOps() {
      try {
        const res = await fetch('/api/agents/ops');
        if (!res.ok) return;
        const opsMap: Record<string, AgentOpsData> = await res.json();
        setAgents(prev =>
          prev.map(a => ({
            ...a,
            ops: opsMap[a.systemName] ?? a.ops,
          })),
        );
      } catch {
        // ignore fetch errors
      }
    }

    fetchOps();
    const interval = setInterval(fetchOps, 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    if (event.type !== 'heartbeat') return;
    const agentName = event.data?.agent as string | undefined;
    if (!agentName) return;

    setAgents((prev) =>
      prev.map((a) => {
        if (a.systemName !== agentName && a.name !== agentName) return a;
        const health = (event.data?.health as HealthStatus) ?? a.health;
        const currentTask =
          (event.data?.current_task as string) ?? a.currentTask;
        return { ...a, health, currentTask };
      }),
    );
  }, []);

  useSSE({
    filter: (e) => e.type === 'heartbeat',
    onEvent: handleSSEEvent,
    bufferSize: 10,
  });

  return (
    <div className="space-y-4">
      {/* Health summary row */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <HealthDot status="healthy" />
          {agents.filter((a) => a.health === 'healthy' && !a.ops?.halted && !a.ops?.rateLimited).length} healthy
        </span>
        {agents.filter((a) => a.ops?.rateLimited).length > 0 && (
          <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            {agents.filter((a) => a.ops?.rateLimited).length} rate limited
          </span>
        )}
        {agents.filter((a) => a.ops?.halted).length > 0 && (
          <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            {agents.filter((a) => a.ops?.halted).length} halted
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <HealthDot status="stale" />
          {agents.filter((a) => a.health === 'stale').length} stale
        </span>
        <span className="flex items-center gap-1.5">
          <HealthDot status="down" />
          {agents.filter((a) => a.health === 'down').length} down
        </span>
      </div>

      {/* Grid */}
      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <IconUsers size={48} className="text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium mb-1">No agents configured</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-sm">
            Add your first agent to start monitoring and managing your AI fleet.
          </p>
          <AddAgentCard onClick={() => setCreateOpen(true)} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
          <AddAgentCard onClick={() => setCreateOpen(true)} />
        </div>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
