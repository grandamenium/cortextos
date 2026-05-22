'use client';

/**
 * /workflows/new — Create a new cron page.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconArrowLeft, IconPlus } from '@tabler/icons-react';
import CronForm from '@/components/workflows/cron-form';

export default function NewCronPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preAgent = searchParams.get('agent') ?? undefined;

  const [agents, setAgents] = useState<string[]>(preAgent ? [preAgent] : []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents');
      if (res.ok) {
        const data: { name: string }[] = await res.json();
        setAgents(data.map(a => a.name));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleSuccess = () => {
    router.push('/workflows');
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Back nav */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/workflows')}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <IconArrowLeft size={15} />
          Workflows
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">New Cron</span>
      </div>

      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <IconPlus size={22} className="text-muted-foreground shrink-0" />
          New Cron
        </h1>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Configure Cron</CardTitle>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Loading agents...
            </p>
          ) : (
            <CronForm
              mode="create"
              initialValues={preAgent ? { agent: preAgent } : undefined}
              agents={agents}
              onSuccess={handleSuccess}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
