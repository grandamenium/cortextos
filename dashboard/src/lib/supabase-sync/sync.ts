// Fleet box-side supabase-sync — orchestration. Collect every M1 source on the box and push in
// dependency order (orgs -> agents -> heartbeats/crash/cron). Idempotent; safe to run repeatedly.
import { getSyncClient } from './client';
import { collectOrgs, collectAgents, collectHeartbeats, collectCrashLog, collectCronHealth } from './collectors';
import { pushOrgs, pushAgents, pushHeartbeats, pushCrashLog, pushCronHealth } from './push';
import type { SyncCounts } from './types';

export async function syncAll(): Promise<SyncCounts> {
  const db = getSyncClient();

  // 1. orgs -> org_id, 2. agents -> agent_id (both needed to resolve fleet-row FKs).
  const orgs = collectOrgs();
  const orgIdBySlug = await pushOrgs(db, orgs);
  const agents = collectAgents();
  const agentIdMap = await pushAgents(db, agents, orgIdBySlug);

  // agent name -> org slug, so crash/cron collectors can resolve an agent's org.
  const orgByAgent = new Map(agents.map((a) => [a.name, a.org_slug]));

  // 3. fleet rows.
  const heartbeats = collectHeartbeats();
  const crashes = collectCrashLog(orgByAgent);
  const cron = collectCronHealth(agents.map((a) => a.name), orgByAgent);

  const counts: SyncCounts = {
    orgs: orgs.length,
    agents: agentIdMap.size,
    heartbeats: await pushHeartbeats(db, heartbeats, agentIdMap, orgIdBySlug),
    crashes: await pushCrashLog(db, crashes, agentIdMap, orgIdBySlug),
    cron_health: await pushCronHealth(db, cron, agentIdMap, orgIdBySlug),
  };
  return counts;
}
