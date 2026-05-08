import Link from 'next/link';
import { getAgentDetail } from '@/lib/data/agents';
import { getAgentRuntime } from '@/lib/agent-runtime';
import { AgentInspectorTabs } from '@/components/inspector/AgentInspectorTabs';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export default async function AgentInspectorLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const runtime = await getAgentRuntime(decoded);
  const detail = await getAgentDetail(decoded, runtime.org).catch(() => null);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar
            name={detail?.identity.name ?? decoded}
            emoji={detail?.identity.emoji ?? ''}
            size="lg"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold">{detail?.identity.name ?? decoded}</h1>
              {detail ? <HealthDot status={detail.health} showLabel /> : null}
              <span className="rounded-full border px-2 py-0.5 text-xs font-medium">{runtime.runtime}</span>
            </div>
            <p className="truncate text-sm text-muted-foreground">{detail?.identity.role || runtime.workingDir}</p>
            {runtime.org ? <OrgBadge org={runtime.org} className="mt-1" /> : null}
          </div>
        </div>
        <Link href="/agents">
          <Button variant="outline" size="sm">Back to Roster</Button>
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border bg-background">
        <AgentInspectorTabs agentName={decoded} />
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
