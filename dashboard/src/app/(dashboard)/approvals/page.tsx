'use client';

import { useEffect, useState, useCallback } from 'react';
import { useOrg } from '@/hooks/use-org';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ApprovalCard } from '@/components/approvals/approval-card';
import { ApprovalDetailDialog } from '@/components/approvals/approval-detail-dialog';
import { ApprovalHistoryList } from '@/components/approvals/approval-history-list';
import { IconUser, IconCheck, IconClock } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PriorityBadge, TimeAgo } from '@/components/shared';
import type { Approval, Task } from '@/lib/types';

export default function ApprovalsPage() {
  const { currentOrg } = useOrg();

  const [pending, setPending] = useState<Approval[]>([]);
  const [resolved, setResolved] = useState<Approval[]>([]);
  const [humanTasks, setHumanTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedApproval, setSelectedApproval] = useState<Approval | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // History filters
  const [historyFilters, setHistoryFilters] = useState({
    agent: 'all',
    category: 'all',
  });

  const fetchApprovals = useCallback(async () => {
    const orgParam = currentOrg !== 'all' ? `&org=${currentOrg}` : '';

    try {
      const [pendingRes, resolvedRes, humanRes] = await Promise.all([
        fetch(`/api/approvals?status=pending${orgParam}`),
        fetch(
          `/api/approvals?status=resolved${orgParam}${
            historyFilters.agent !== 'all' ? `&agent=${historyFilters.agent}` : ''
          }${
            historyFilters.category !== 'all' ? `&category=${historyFilters.category}` : ''
          }`
        ),
        fetch(`/api/tasks?agent=human${orgParam ? `&org=${currentOrg}` : ''}`),
      ]);

      if (pendingRes.ok) {
        setPending(await pendingRes.json());
      }
      if (resolvedRes.ok) {
        setResolved(await resolvedRes.json());
      }
      if (humanRes.ok) {
        const allHuman: Task[] = await humanRes.json();
        setHumanTasks(allHuman.filter(t => t.status !== 'completed'));
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [currentOrg, historyFilters]);

  useEffect(() => {
    setLoading(true);
    fetchApprovals();
  }, [fetchApprovals]);

  function handleApprovalClick(approval: Approval) {
    setSelectedApproval(approval);
    setDialogOpen(true);
  }

  async function handleResolve(id: string, decision: 'approved' | 'rejected', note?: string) {
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });

      if (res.ok) {
        fetchApprovals();
      }
    } catch {
      // Silently fail
    }
  }

  function handleHistoryFilterChange(key: string, value: string) {
    setHistoryFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleClearHistoryFilters() {
    setHistoryFilters({ agent: 'all', category: 'all' });
  }

  // Derive unique values for history filter dropdowns
  const historyAgents = [...new Set(resolved.map((a) => a.agent))];
  const historyCategories = [...new Set(resolved.map((a) => a.category))];

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <div className="space-y-4">
          <div className="h-10 w-48 rounded-lg bg-muted/30 animate-pulse" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Approvals</h1>

      <Tabs defaultValue={humanTasks.length > 0 ? 'human' : 'pending'}>
        <TabsList>
          <TabsTrigger value="human">
            <IconUser size={14} className="mr-1" />
            Your Tasks
            {humanTasks.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {humanTasks.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="pending">
            Approvals
            {pending.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {pending.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Human Tasks tab */}
        <TabsContent value="human">
          {humanTasks.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No tasks assigned to you right now.
            </p>
          ) : (
            <div className="grid gap-2 max-w-2xl">
              {humanTasks.map((task) => (
                <Card key={task.id} className="hover:bg-muted/20 transition-colors">
                  <CardContent className="flex items-start justify-between py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-medium">{task.title}</p>
                      {task.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <PriorityBadge priority={task.priority} />
                        <span>from {task.assignee ?? 'unknown'}</span>
                        <IconClock size={12} />
                        <TimeAgo date={task.created_at} />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-3 shrink-0"
                      onClick={async () => {
                        await fetch(`/api/tasks/${task.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ status: 'completed' }),
                        });
                        fetchApprovals();
                      }}
                    >
                      <IconCheck size={14} className="mr-1" />
                      Done
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Pending tab */}
        <TabsContent value="pending">
          {pending.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No pending approvals - you are all caught up.
            </p>
          ) : (
            <div className="grid gap-2 max-w-2xl">
              {pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onClick={handleApprovalClick}
                  onQuickResolve={handleResolve}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* History tab */}
        <TabsContent value="history">
          <ApprovalHistoryList
            approvals={resolved}
            agents={historyAgents}
            categories={historyCategories}
            filters={historyFilters}
            onFilterChange={handleHistoryFilterChange}
            onClearFilters={handleClearHistoryFilters}
            onApprovalClick={handleApprovalClick}
          />
        </TabsContent>
      </Tabs>

      {/* Approval detail dialog */}
      <ApprovalDetailDialog
        approval={selectedApproval}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onResolve={selectedApproval?.status === 'pending' ? handleResolve : undefined}
      />
    </div>
  );
}
