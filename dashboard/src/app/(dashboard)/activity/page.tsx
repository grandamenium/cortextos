import { getOrgs, getAllAgents } from '@/lib/config';
import { getRecentEvents } from '@/lib/data/events';
import { ActivityPageClient } from './client';

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : undefined;

  // Initial load: most recent 100 events
  const initialEvents = await getRecentEvents(100, org);

  // Get unique agent names for the filter dropdown
  const allAgents = getAllAgents();
  const agentNames = [...new Set(allAgents.map((a) => a.name))];

  return (
    <ActivityPageClient
      initialEvents={initialEvents}
      agents={agentNames}
      orgs={orgs}
    />
  );
}
