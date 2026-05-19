import fs from 'fs';
import path from 'path';
import { CTX_FRAMEWORK_ROOT, CTX_ROOT, getOrgs } from '@/lib/config';
import { getPendingCount } from '@/lib/data/approvals';
import { getTasks } from '@/lib/data/tasks';

type FleetHealth = 'green' | 'amber' | 'red';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface AgentConfigRecord {
  org?: string;
  enabled?: boolean;
}

interface RawAnalyticsEvent {
  id?: string;
  agent?: string;
  org?: string;
  timestamp?: string;
  category?: string;
  event?: string;
  severity?: string;
  metadata?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  message?: string;
}

export interface AgentListItem {
  name: string;
  org: string;
  role?: string;
  running?: boolean;
  lastHeartbeat?: string;
  currentTask?: string;
  mode?: string;
}

export interface AgentMission {
  agent: string;
  mission: string;
  phase?: string;
  next?: string;
  updatedAt: string;
}

export interface FleetPulseItem {
  name: string;
  lastVerb: string;
  sparkline: number[];
  health: FleetHealth;
  lastActiveAt?: string;
  href: string;
}

export interface MissionFeedRow {
  id: string;
  title: string;
  narrative: string;
  agents: string[];
  updatedAt?: string;
  href: string;
}

export interface HomeHealthSummary {
  agentCount: number;
  taskCount: number;
  approvalCount: number;
  blockedTaskCount: number;
  staleAgentCount: number;
}

const AGENT_LIST_TTL_MS = 60_000;

const agentCache = new Map<string, CacheEntry<AgentListItem[]>>();

function getOverrideHome(): string | null {
  const raw = process.env.CORTEXTOS_HOME?.trim();
  if (!raw) return null;
  return path.resolve(raw);
}

function getDefaultOrg(): string {
  const orgs = getOrgs();
  if (orgs.includes('clearworksai')) return 'clearworksai';
  return orgs[0] ?? 'clearworksai';
}

function getAgentsRoot(org: string): string {
  const override = getOverrideHome();
  if (override) {
    return path.join(override, 'orgs', org, 'agents');
  }
  return path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents');
}

function getEventsRoot(org: string): string {
  const override = getOverrideHome();
  if (override) {
    return path.join(override, 'orgs', org, 'analytics', 'events');
  }
  return path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events');
}

function readHeartbeatTimestamp(org: string, agent: string): string | undefined {
  const candidates = [
    path.join(getAgentsRoot(org), agent, 'state', 'heartbeat.json'),
    path.join(CTX_ROOT, 'state', agent, 'heartbeat.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        last_heartbeat?: string;
        timestamp?: string;
      };
      return parsed.last_heartbeat ?? parsed.timestamp;
    } catch {
      continue;
    }
  }

  return undefined;
}

function readAgentListFromOverride(org?: string): AgentListItem[] {
  const override = getOverrideHome();
  if (!override) return [];

  const orgNames = org ? [org] : safeReadDir(path.join(override, 'orgs'));
  const items: AgentListItem[] = [];

  for (const orgName of orgNames) {
    const root = path.join(override, 'orgs', orgName, 'agents');
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      items.push({
        name: entry.name,
        org: orgName,
        lastHeartbeat: readHeartbeatTimestamp(orgName, entry.name),
      });
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function readRole(org: string, agentName: string): string | undefined {
  const identityPath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', agentName, 'IDENTITY.md');
  if (!fs.existsSync(identityPath)) return undefined;

  try {
    const content = fs.readFileSync(identityPath, 'utf-8');
    const match = content.match(/^## Role\s*\n(.+)/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function readAgentState(agentName: string): { currentTask?: string; mode?: string; running?: boolean } {
  const heartbeatPath = path.join(CTX_ROOT, 'state', agentName, 'heartbeat.json');
  if (!fs.existsSync(heartbeatPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8')) as {
      current_task?: string;
      mode?: string;
    };
    return {
      currentTask: parsed.current_task,
      mode: parsed.mode,
      running: true,
    };
  } catch {
    return {};
  }
}

function readAgentListFromFilesystem(org?: string): AgentListItem[] {
  const agentMap = new Map<string, AgentConfigRecord>();
  const enabledFile = path.join(CTX_ROOT, 'config', 'enabled-agents.json');

  if (fs.existsSync(enabledFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(enabledFile, 'utf-8')) as Record<string, AgentConfigRecord>;
      for (const [name, config] of Object.entries(parsed)) {
        agentMap.set(name, { org: config.org ?? '', enabled: config.enabled !== false });
      }
    } catch {
      // Ignore corrupt enabled-agent state and fall back to directory discovery.
    }
  }

  const orgNames = org ? [org] : safeReadDir(path.join(CTX_FRAMEWORK_ROOT, 'orgs'));
  for (const orgName of orgNames) {
    const agentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', orgName, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const entryName of fs.readdirSync(agentsDir)) {
      if (!agentMap.has(entryName)) {
        agentMap.set(entryName, { org: orgName, enabled: true });
      }
    }
  }

  return Array.from(agentMap.entries())
    .filter(([, config]) => !org || config.org === org)
    .map(([name, config]) => {
      const state = readAgentState(name);
      return {
        name,
        org: config.org ?? '',
        role: config.org ? readRole(config.org, name) : undefined,
        running: state.running,
        lastHeartbeat: config.org ? readHeartbeatTimestamp(config.org, name) : undefined,
        currentTask: state.currentTask,
        mode: state.mode,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeReadDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function readRecentAnalyticsEvents(org: string, agent: string): RawAnalyticsEvent[] {
  const root = path.join(getEventsRoot(org), agent);
  if (!fs.existsSync(root)) return [];

  try {
    const files = fs
      .readdirSync(root)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .slice(-3);

    const events: RawAnalyticsEvent[] = [];
    for (const file of files) {
      const filePath = path.join(root, file);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as RawAnalyticsEvent;
          events.push({
            ...parsed,
            agent: parsed.agent ?? agent,
            org: parsed.org ?? org,
          });
        } catch {
          continue;
        }
      }
    }

    return events.sort((a, b) => {
      const left = Date.parse(b.timestamp ?? '');
      const right = Date.parse(a.timestamp ?? '');
      return left - right;
    });
  } catch {
    return [];
  }
}

function parseMissionLine(line: string, fallbackUpdatedAt: string): AgentMission | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('MISSION:')) return null;

  const parts = trimmed.split('|').map((part) => part.trim());
  const mission = parts[0]?.replace(/^MISSION:\s*/, '') ?? '';
  let phase: string | undefined;
  let next: string | undefined;
  let updatedAt = fallbackUpdatedAt;

  for (const part of parts.slice(1)) {
    if (part.startsWith('Phase:')) phase = part.replace(/^Phase:\s*/, '');
    else if (part.startsWith('Next:')) next = part.replace(/^Next:\s*/, '');
    else if (part.startsWith('Updated:')) updatedAt = part.replace(/^Updated:\s*/, '');
  }

  if (!mission) return null;
  return {
    agent: '',
    mission,
    phase,
    next,
    updatedAt,
  };
}

function buildSparkline(events: RawAnalyticsEvent[]): number[] {
  const now = Date.now();
  const buckets = Array.from({ length: 60 }, () => 0);

  for (const event of events) {
    const timestamp = event.timestamp ? Date.parse(event.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) continue;
    const minutesAgo = Math.floor((now - timestamp) / 60_000);
    if (minutesAgo < 0 || minutesAgo >= 60) continue;
    const index = 59 - minutesAgo;
    buckets[index] += 1;
  }

  return buckets;
}

function toFleetHealth(lastActiveAt?: string): FleetHealth {
  if (!lastActiveAt) return 'red';

  const lastActiveMs = Date.parse(lastActiveAt);
  if (!Number.isFinite(lastActiveMs)) return 'red';

  const minutesAgo = (Date.now() - lastActiveMs) / 60_000;
  if (minutesAgo <= 5) return 'green';
  if (minutesAgo <= 30) return 'amber';
  return 'red';
}

function deriveLastVerb(events: RawAnalyticsEvent[]): string {
  const latest = events[0];
  if (!latest) return 'waiting';

  const eventName = latest.event ?? latest.category ?? '';
  if (eventName.includes('dispatch')) return 'dispatched';
  if (eventName.includes('merge')) return 'merging';
  if (eventName.includes('review')) return 'reviewing';
  if (eventName.includes('approval')) return 'awaiting approval';
  if (eventName.includes('build')) return 'building';
  if (eventName.includes('task')) return 'working';
  if (eventName.includes('heartbeat')) return 'steady';
  if (latest.category === 'error' || latest.severity === 'error') return 'recovering';
  return eventName ? eventName.replace(/_/g, ' ') : 'waiting';
}

function firstAgentActivity(org: string, agent: AgentListItem): { lastActiveAt?: string; events: RawAnalyticsEvent[] } {
  const events = readRecentAnalyticsEvents(org, agent.name);
  const eventTime = events[0]?.timestamp;
  const heartbeatTime = agent.lastHeartbeat ?? readHeartbeatTimestamp(org, agent.name);

  if (eventTime && heartbeatTime) {
    return {
      lastActiveAt: Date.parse(eventTime) >= Date.parse(heartbeatTime) ? eventTime : heartbeatTime,
      events,
    };
  }

  return {
    lastActiveAt: eventTime ?? heartbeatTime,
    events,
  };
}

export function getAgentsList(org?: string): AgentListItem[] {
  const cacheKey = `${getOverrideHome() ?? 'live'}:${org ?? 'all'}`;
  const cached = getCached(agentCache, cacheKey);
  if (cached) return cached;

  const roster = getOverrideHome()
    ? readAgentListFromOverride(org)
    : readAgentListFromFilesystem(org);

  return setCached(agentCache, cacheKey, roster, AGENT_LIST_TTL_MS);
}

export function readAgentMission(org: string, agent: string): AgentMission | null {
  const filePath = path.join(getAgentsRoot(org), agent, 'state', 'current-mission.txt');
  if (!fs.existsSync(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const firstLine = raw.split('\n').find((line) => line.trim().length > 0);
    if (!firstLine) return null;

    const parsed = parseMissionLine(firstLine, stat.mtime.toISOString());
    if (!parsed) return null;
    return { ...parsed, agent };
  } catch {
    return null;
  }
}

export function getTopMission(org: string = getDefaultOrg()): AgentMission | null {
  const missions = getAgentsList(org)
    .map((agent) => readAgentMission(org, agent.name))
    .filter((mission): mission is AgentMission => mission !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return missions[0] ?? null;
}

export function getFleetPulse(org: string = getDefaultOrg()): FleetPulseItem[] {
  return getAgentsList(org).map((agent) => {
    const activity = firstAgentActivity(org, agent);
    return {
      name: agent.name,
      lastVerb: deriveLastVerb(activity.events),
      sparkline: buildSparkline(activity.events),
      health: toFleetHealth(activity.lastActiveAt),
      lastActiveAt: activity.lastActiveAt,
      href: `/agents?agent=${encodeURIComponent(agent.name)}`,
    };
  });
}

export function getMissionFeed(org: string = getDefaultOrg()): MissionFeedRow[] {
  const groups = new Map<string, { mission: AgentMission; agents: string[] }>();

  for (const agent of getAgentsList(org)) {
    const mission = readAgentMission(org, agent.name);
    if (!mission) continue;
    const key = mission.mission;
    const current = groups.get(key);
    if (current) {
      current.agents.push(agent.name);
      if (Date.parse(mission.updatedAt) > Date.parse(current.mission.updatedAt)) {
        current.mission = mission;
      }
    } else {
      groups.set(key, { mission, agents: [agent.name] });
    }
  }

  const rows = Array.from(groups.values())
    .sort((a, b) => Date.parse(b.mission.updatedAt) - Date.parse(a.mission.updatedAt))
    .map((group, index) => ({
      id: `mission-${index}`,
      title: group.mission.mission,
      narrative: group.mission.next
        ? `${group.agents.join(' → ')} · Next: ${group.mission.next}`
        : `${group.agents.join(' → ')} · Active`,
      agents: group.agents,
      updatedAt: group.mission.updatedAt,
      href: `/agents?agent=${encodeURIComponent(group.agents[0] ?? '')}`,
    }));

  if (rows.length > 0) {
    return rows.slice(0, 7);
  }

  const fallbackRows = getAgentsList(org)
    .map((agent, index) => {
      const activity = firstAgentActivity(org, agent);
      return {
        id: `fallback-${index}`,
        title: `${agent.name} is ${deriveLastVerb(activity.events)}`,
        narrative: agent.currentTask || agent.role || 'Waiting for the next dispatch.',
        agents: [agent.name],
        updatedAt: activity.lastActiveAt,
        href: `/agents?agent=${encodeURIComponent(agent.name)}`,
      };
    })
    .slice(0, 7);

  return fallbackRows.length > 0
    ? fallbackRows
    : [{
        id: 'fallback-empty',
        title: 'All quiet',
        narrative: 'No recent missions are on deck right now.',
        agents: [],
        href: '/agents',
      }];
}

export async function getHomeHealth(org: string = getDefaultOrg()): Promise<HomeHealthSummary> {
  const fleet = getFleetPulse(org);
  const tasks = getTasks({ org });
  return {
    agentCount: getAgentsList(org).length,
    taskCount: tasks.length,
    approvalCount: getPendingCount(org),
    blockedTaskCount: tasks.filter((task) => task.status === 'blocked').length,
    staleAgentCount: fleet.filter((agent) => agent.health !== 'green').length,
  };
}

export function getHomeOrg(orgParam?: string | string[]): string {
  if (typeof orgParam === 'string' && orgParam.trim()) {
    return orgParam;
  }
  return getDefaultOrg();
}
