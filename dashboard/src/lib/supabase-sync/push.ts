// Fleet box-side supabase-sync — push. Upserts collected rows to Supabase in dependency order,
// resolving the box's natural keys (org slug, agent name) to the schema's uuid PKs. Idempotent:
// orgs/agents upsert on their unique keys; heartbeats upsert on agent_id (one row/agent).
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrgRow, AgentRow, HeartbeatRow, CrashRow, CronHealthRow } from './types';

const nowIso = () => new Date().toISOString();

// crash_log / cron_health are `id uuid PK` with no natural unique constraint, so we derive a
// DETERMINISTIC id from the row's natural key — re-syncing the same crash/cron collides on the PK
// (idempotent) without needing a schema change. (Stable hash formatted as a uuid.)
function detId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Upsert orgs by slug; return slug -> org_id. */
export async function pushOrgs(db: SupabaseClient, rows: OrgRow[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!rows.length) return map;
  const { data, error } = await db
    .from('orgs')
    .upsert(rows.map((r) => ({ ...r, updated_at: nowIso() })), { onConflict: 'slug' })
    .select('id, slug');
  if (error) throw new Error(`pushOrgs: ${error.message}`);
  for (const o of data ?? []) map.set(o.slug as string, o.id as string);
  return map;
}

/** Upsert agents by (org_id, name); return `${org_slug}/${name}` -> agent_id. */
export async function pushAgents(db: SupabaseClient, rows: AgentRow[], orgIdBySlug: Map<string, string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const payload = rows
    .map((r) => {
      const org_id = orgIdBySlug.get(r.org_slug);
      if (!org_id) return null;
      return { org_id, name: r.name, display_name: r.display_name, role: r.role, enabled: r.enabled, runtime: r.runtime, model: r.model, timezone: r.timezone, updated_at: nowIso() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!payload.length) return map;
  const { data, error } = await db.from('agents').upsert(payload, { onConflict: 'org_id,name' }).select('id, org_id, name');
  if (error) throw new Error(`pushAgents: ${error.message}`);
  const slugByOrgId = new Map(Array.from(orgIdBySlug, ([slug, id]) => [id, slug]));
  for (const a of data ?? []) {
    const slug = slugByOrgId.get(a.org_id as string);
    if (slug) map.set(`${slug}/${a.name as string}`, a.id as string);
  }
  return map;
}

const agentId = (m: Map<string, string>, slug: string, name: string) => m.get(`${slug}/${name}`);

/** Heartbeats — one row per agent, upserted on agent_id. */
export async function pushHeartbeats(db: SupabaseClient, rows: HeartbeatRow[], agentIdMap: Map<string, string>, orgIdBySlug: Map<string, string>): Promise<number> {
  const payload = rows
    .map((r) => {
      const aid = agentId(agentIdMap, r.org_slug, r.agent_name);
      const oid = orgIdBySlug.get(r.org_slug);
      if (!aid || !oid) return null;
      return { agent_id: aid, org_id: oid, status: r.status, current_task: r.current_task, mode: r.mode, last_heartbeat: r.last_heartbeat, loop_interval: r.loop_interval, launch_path_canonical: r.launch_path_canonical ?? null, session_mb: r.session_mb ?? null, synced_at: nowIso() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!payload.length) return 0;
  const { error } = await db.from('heartbeats').upsert(payload, { onConflict: 'agent_id' });
  if (error) throw new Error(`pushHeartbeats: ${error.message}`);
  return payload.length;
}

/** Crash log — append-style; dedup on (agent_id, ts) so re-syncing the same tail is idempotent. */
export async function pushCrashLog(db: SupabaseClient, rows: CrashRow[], agentIdMap: Map<string, string>, orgIdBySlug: Map<string, string>): Promise<number> {
  const payload = rows
    .map((r) => {
      const aid = agentId(agentIdMap, r.org_slug, r.agent_name);
      const oid = orgIdBySlug.get(r.org_slug);
      if (!aid || !oid) return null;
      return { id: detId(aid, r.ts), org_id: oid, agent_id: aid, ts: r.ts, type: r.type, reason: r.reason, session_id: r.session_id, last_task: r.last_task, synced_at: nowIso() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!payload.length) return 0;
  const { error } = await db.from('crash_log').upsert(payload, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(`pushCrashLog: ${error.message}`);
  return payload.length;
}

/** Cron health — upsert on (agent_id, cron_name). */
export async function pushCronHealth(db: SupabaseClient, rows: CronHealthRow[], agentIdMap: Map<string, string>, orgIdBySlug: Map<string, string>): Promise<number> {
  const payload = rows
    .map((r) => {
      const aid = agentId(agentIdMap, r.org_slug, r.agent_name);
      const oid = orgIdBySlug.get(r.org_slug);
      if (!aid || !oid) return null;
      return { id: detId(aid, r.cron_name), org_id: oid, agent_id: aid, cron_name: r.cron_name, health_state: r.health_state, last_fired_at: r.last_fired_at, next_fire_at: r.next_fire_at, gap_ms: r.gap_ms, success_rate_24h: r.success_rate_24h, synced_at: nowIso() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!payload.length) return 0;
  const { error } = await db.from('cron_health').upsert(payload, { onConflict: 'id' });
  if (error) throw new Error(`pushCronHealth: ${error.message}`);
  return payload.length;
}
