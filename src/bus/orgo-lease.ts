import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

type FleetStatus = 'unknown' | 'ready' | 'busy' | 'idle' | 'offline' | 'blocked' | 'retired';

interface SupabaseConfig {
  url: string;
  key: string;
}

interface FleetNodeRow {
  id?: string;
  org_id?: string;
  node_key: string;
  display_name: string | null;
  runtime: string | null;
  status: FleetStatus;
  capabilities: string[] | null;
  app_readiness: Record<string, unknown> | null;
  current_task_id: string | null;
  last_heartbeat_at: string | null;
  last_assignment_at: string | null;
  last_release_at: string | null;
  idle_since: string | null;
  notes: string | null;
  updated_at: string | null;
}

interface TaskRow {
  id: string;
  result: string | null;
  result_links: unknown;
}

export interface OrgoLease {
  lease_id: string;
  holder: string;
  focus: string;
  preconditions: Record<string, unknown>;
  expected_artifact: string;
  release_condition: string;
  escalation_rule: string;
  artifact_ttl_minutes: number;
  started_at: string;
  expires_at: string;
  value_signal: string;
  result?: string;
  released_at?: string;
}

export interface LeaseClaimOptions {
  node: string;
  focus: string;
  holder?: string;
  preconditions?: string;
  artifact?: string;
  release?: string;
  escalation?: string;
  ttl?: number;
  value?: string;
  task?: string;
  force?: boolean;
}

export interface LeaseReleaseOptions {
  lease?: string;
  node?: string;
  result?: string;
}

export interface LeaseStatusOptions {
  node?: string;
  status?: 'busy' | 'idle' | 'all';
}

function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    out[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function candidateEnvFiles(): string[] {
  const files: string[] = [];
  if (process.env.CTX_AGENT_DIR) files.push(join(process.env.CTX_AGENT_DIR, '.env'));
  if (process.env.CTX_FRAMEWORK_ROOT && process.env.CTX_ORG) {
    files.push(join(process.env.CTX_FRAMEWORK_ROOT, 'orgs', process.env.CTX_ORG, 'secrets.env'));
  }
  if (process.env.CTX_AGENT_DIR) {
    files.push(join(dirname(dirname(process.env.CTX_AGENT_DIR)), 'secrets.env'));
  }
  return files;
}

function loadSupabaseConfig(): SupabaseConfig {
  const fileEnv: Record<string, string> = {};
  for (const file of candidateEnvFiles()) {
    Object.assign(fileEnv, readDotenv(file));
  }

  const url = process.env.SUPABASE_RGOS_URL || fileEnv.SUPABASE_RGOS_URL || '';
  const key =
    process.env.SUPABASE_RGOS_SERVICE_KEY ||
    process.env.RGOS_SUPABASE_SERVICE_KEY ||
    fileEnv.SUPABASE_RGOS_SERVICE_KEY ||
    fileEnv.RGOS_SUPABASE_SERVICE_KEY ||
    '';

  if (!url || !key) {
    throw new Error('SUPABASE_RGOS_URL and SUPABASE_RGOS_SERVICE_KEY are required for orgo lease commands');
  }

  return { url: url.replace(/\/$/, ''), key };
}

function headers(config: SupabaseConfig, prefer = 'return=representation'): Record<string, string> {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Prefer: prefer,
  };
}

async function rest<T>(
  config: SupabaseConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...headers(config),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Supabase ${init.method ?? 'GET'} ${path} failed ${response.status}: ${body.slice(0, 500)}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function parseJsonObject(raw: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!raw) return fallback;
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON option must be an object');
  }
  return parsed as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMinutes(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

function appReadiness(row: FleetNodeRow): Record<string, unknown> {
  return row.app_readiness && typeof row.app_readiness === 'object' ? row.app_readiness : {};
}

function activeLease(row: FleetNodeRow): OrgoLease | null {
  const readiness = appReadiness(row);
  const lease = readiness.lease;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return null;
  const maybe = lease as Partial<OrgoLease>;
  return typeof maybe.lease_id === 'string' ? maybe as OrgoLease : null;
}

async function readNodes(config: SupabaseConfig, opts: { node?: string } = {}): Promise<FleetNodeRow[]> {
  const filters = [
    'select=*',
    `org_id=eq.${ORG_ID}`,
    'runtime=eq.orgo',
    'status=neq.retired',
    'order=display_name.asc',
  ];
  if (opts.node) filters.push(`node_key=eq.${encodeURIComponent(opts.node)}`);
  else filters.push('node_key=neq.orgo-1');
  return rest<FleetNodeRow[]>(config, `orch_fleet_nodes?${filters.join('&')}`, { method: 'GET' });
}

async function patchNode(config: SupabaseConfig, nodeKey: string, patch: Record<string, unknown>): Promise<FleetNodeRow> {
  const rows = await rest<FleetNodeRow[]>(
    config,
    `orch_fleet_nodes?org_id=eq.${ORG_ID}&node_key=eq.${encodeURIComponent(nodeKey)}&select=*`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
  if (!rows[0]) throw new Error(`Node not found after patch: ${nodeKey}`);
  return rows[0];
}

async function resolveTaskId(config: SupabaseConfig, taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) return taskId;
  if (!/^[0-9a-f]{8,}$/i.test(taskId)) return null;

  const rows = await rest<Array<{ id: string }>>(
    config,
    'orch_tasks?select=id&order=created_at.desc&limit=1000',
    { method: 'GET' },
  );
  return rows.find((row) => row.id.startsWith(taskId))?.id ?? null;
}

async function completeLeaseTask(config: SupabaseConfig, taskId: string | null, lease: OrgoLease, releasedAt: string): Promise<void> {
  const resolvedTaskId = await resolveTaskId(config, taskId);
  if (!resolvedTaskId) return;

  const existing = await rest<TaskRow[]>(
    config,
    `orch_tasks?id=eq.${resolvedTaskId}&select=id,result,result_links`,
    { method: 'GET' },
  );
  const current = existing[0];
  const result = lease.result || `Orgo lease ${lease.lease_id} released.`;
  const resultLinks = Array.isArray(current?.result_links) ? [...current.result_links] : [];
  if (lease.expected_artifact && !resultLinks.includes(lease.expected_artifact)) {
    resultLinks.push(lease.expected_artifact);
  }

  await rest<unknown>(
    config,
    `orch_tasks?id=eq.${resolvedTaskId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        result,
        result_links: resultLinks,
        completed_at: releasedAt,
        updated_at: releasedAt,
      }),
    },
  );
}

export async function claimOrgoLease(opts: LeaseClaimOptions): Promise<{ node: FleetNodeRow; lease: OrgoLease }> {
  const config = loadSupabaseConfig();
  const [node] = await readNodes(config, { node: opts.node });
  if (!node) throw new Error(`No Orgo node found for node_key=${opts.node}`);

  const currentLease = activeLease(node);
  if (currentLease && !opts.force) {
    throw new Error(`Node ${opts.node} already has active lease ${currentLease.lease_id}; release it first or pass --force`);
  }
  if (!opts.force && node.status !== 'ready' && node.status !== 'idle') {
    throw new Error(`Node ${opts.node} status is ${node.status}; claim requires ready|idle unless --force is passed`);
  }

  const start = new Date();
  const ttl = Math.max(1, opts.ttl ?? 60);
  const lease: OrgoLease = {
    lease_id: randomUUID(),
    holder: opts.holder || process.env.CTX_AGENT_NAME || 'unknown',
    focus: opts.focus,
    preconditions: parseJsonObject(opts.preconditions, {}),
    expected_artifact: opts.artifact || '',
    release_condition: opts.release || 'manual release',
    escalation_rule: opts.escalation || `alert orchestrator after ${ttl}m without artifact`,
    artifact_ttl_minutes: ttl,
    started_at: start.toISOString(),
    expires_at: addMinutes(start, ttl),
    value_signal: opts.value || '',
  };

  const readiness = {
    ...appReadiness(node),
    lease,
    lease_source: 'cortextos-bus-orgo-lease',
  };

  const updated = await patchNode(config, opts.node, {
    status: 'busy',
    current_task_id: opts.task || node.current_task_id,
    last_assignment_at: lease.started_at,
    idle_since: null,
    app_readiness: readiness,
    notes: [node.notes, `lease=${lease.lease_id}; holder=${lease.holder}; focus=${lease.focus}`].filter(Boolean).join(' | '),
    updated_at: nowIso(),
  });

  return { node: updated, lease };
}

export async function releaseOrgoLease(opts: LeaseReleaseOptions): Promise<{ node: FleetNodeRow; released: OrgoLease }> {
  const config = loadSupabaseConfig();
  const nodes = await readNodes(config, opts.node ? { node: opts.node } : {});
  const node = nodes.find((candidate) => {
    const lease = activeLease(candidate);
    if (!lease) return false;
    if (opts.lease && lease.lease_id === opts.lease) return true;
    if (opts.node && candidate.node_key === opts.node) return true;
    return false;
  });
  if (!node) throw new Error(opts.lease ? `No active lease found for lease_id=${opts.lease}` : `No active lease found for node=${opts.node}`);

  const lease = activeLease(node);
  if (!lease) throw new Error(`Node ${node.node_key} has no active lease`);

  const releasedAt = nowIso();
  const releasedLease: OrgoLease = {
    ...lease,
    result: opts.result || '',
    released_at: releasedAt,
  };
  const readiness = {
    ...appReadiness(node),
    lease: null,
    last_released_lease: releasedLease,
    lease_source: 'cortextos-bus-orgo-lease',
  };

  const updated = await patchNode(config, node.node_key, {
    status: 'idle',
    current_task_id: null,
    last_release_at: releasedAt,
    idle_since: releasedAt,
    app_readiness: readiness,
    notes: [node.notes, `released_lease=${lease.lease_id}; result=${opts.result || 'none'}`].filter(Boolean).join(' | '),
    updated_at: releasedAt,
  });

  await completeLeaseTask(config, node.current_task_id, releasedLease, releasedAt);

  return { node: updated, released: releasedLease };
}

export async function listOrgoLeaseStatus(opts: LeaseStatusOptions = {}): Promise<Array<FleetNodeRow & { lease: OrgoLease | null; lease_time_remaining_seconds: number | null }>> {
  const config = loadSupabaseConfig();
  let nodes = await readNodes(config, { node: opts.node });
  if (opts.status && opts.status !== 'all') {
    nodes = nodes.filter((node) => opts.status === 'busy' ? Boolean(activeLease(node)) : !activeLease(node));
  }
  const now = Date.now();
  return nodes.map((node) => {
    const lease = activeLease(node);
    const remaining = lease ? Math.max(0, Math.floor((new Date(lease.expires_at).getTime() - now) / 1000)) : null;
    return { ...node, lease, lease_time_remaining_seconds: remaining };
  });
}

export async function checkOrgoLeaseWatchdog(): Promise<Array<{ node_key: string; display_name: string | null; lease: OrgoLease; expired_at: string }>> {
  const nodes = await listOrgoLeaseStatus({ status: 'busy' });
  const now = Date.now();
  return nodes
    .filter((node) => node.lease && new Date(node.lease.expires_at).getTime() < now)
    .map((node) => ({
      node_key: node.node_key,
      display_name: node.display_name,
      lease: node.lease!,
      expired_at: node.lease!.expires_at,
    }));
}

export function formatLeaseStatus(nodes: Awaited<ReturnType<typeof listOrgoLeaseStatus>>): string {
  if (nodes.length === 0) return 'No Orgo fleet nodes found.';
  const lines = ['Node                         Status   Lease Holder         TTL     Focus'];
  for (const node of nodes) {
    const ttl = node.lease_time_remaining_seconds == null
      ? '--'
      : `${Math.ceil(node.lease_time_remaining_seconds / 60)}m`;
    const holder = node.lease?.holder ?? '--';
    const focus = node.lease?.focus ?? appReadiness(node).current_workload as string ?? '--';
    lines.push([
      node.node_key.slice(0, 28).padEnd(28),
      node.status.padEnd(8),
      holder.slice(0, 18).padEnd(18),
      ttl.padEnd(6),
      String(focus).slice(0, 60),
    ].join('  '));
  }
  return lines.join('\n');
}
