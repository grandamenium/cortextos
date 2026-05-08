import Link from 'next/link';
import { getAgentDetail } from '@/lib/data/agents';
import { getTasksByAgent } from '@/lib/data/tasks';
import { getAllAgents } from '@/lib/config';
import { parseSoulMd } from '@/lib/markdown-parser';
import { AgentDetailTabs } from '@/components/agents/agent-detail-tabs';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { RuntimeBadge } from '@/components/shared/runtime-badge';
import { Button } from '@/components/ui/button';
import type { SoulFields } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  // Look up org from enabled-agents.json (case-insensitive to handle legacy URLs)
  const allAgentsList = getAllAgents();
  const agentEntry = allAgentsList.find(
    a => a.name.toLowerCase() === decoded.toLowerCase()
  );
  // Use the canonical system name from config, not the URL param
  const systemName = agentEntry?.name ?? decoded;
  const org = agentEntry?.org || undefined;

  const detail = await getAgentDetail(systemName, org);

  // Parse soul fields
  let soulFields: SoulFields = {
    autonomyRules: '',
    communicationStyle: '',
    dayMode: '',
    nightMode: '',
    coreTruths: '',
  };
  if (detail.soulRaw) {
    const { fields } = parseSoulMd(detail.soulRaw);
    soulFields = fields;
  }

  // Get tasks for this agent (use system name to match task assignee field)
  let tasks: import('@/lib/types').Task[] = [];
  try {
    tasks = getTasksByAgent(systemName, detail.org || undefined);
  } catch {
    tasks = [];
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <AgentAvatar
            name={detail.identity.name}
            emoji={detail.identity.emoji}
            size="lg"
          />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{detail.identity.name}</h1>
              <HealthDot status={detail.health} showLabel />
            </div>
            <p className="text-sm text-muted-foreground">
              {detail.identity.role || 'No role set'}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              {detail.org && <OrgBadge org={detail.org} />}
              {detail.runtime && <RuntimeBadge runtime={detail.runtime} />}
            </div>
          </div>
        </div>

        <Link href="/agents">
          <Button variant="outline" size="sm">
            Back to Roster
          </Button>
        </Link>
      </div>

      {/* Tabbed content */}
      <AgentDetailTabs
        detail={{ ...detail, systemName }}
        soulFields={soulFields}
        tasks={tasks}
      />
    </div>
  );
}
