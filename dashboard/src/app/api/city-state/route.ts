import { NextRequest } from 'next/server';
import { createConnection } from 'net';
import { homedir } from 'os';
import fs from 'fs';
import path from 'path';
import {
  getCTXRoot,
  getAllAgents,
  getTaskDir,
  getApprovalDir,
  getAgentDir,
  getOrgs,
} from '@/lib/config';
import { getHeartbeat } from '@/lib/data/heartbeats';

export const dynamic = 'force-dynamic';

/**
 * GET /api/city-state - live state document for the Agent City scene.
 *
 * Design law (city/SIGNALS.md §2): every field carries its own `source` and
 * `resolution`. A renderer that cannot tell a monitored fact from a sampled one
 * animates them identically, and then the honest half is indistinguishable from
 * the fabricated half.
 *
 * Two deliberate departures from the rest of this API surface:
 *
 *   1. It does NOT use `@/lib/db` (nor `@/lib/data/events|tasks|approvals`,
 *      which wrap it). That SQLite cache is refreshed by `syncAll()`, called
 *      only from the tasks/, approvals/ and sync/ routes — so `events` there was
 *      measured 3 days stale while the JSONL log held 1538 fresh rows. A scene
 *      fed from it renders a DEAD FLEET during a busy night and looks plausible
 *      doing it, because quiet is a legitimate fleet state. Source files only.
 *
 *   2. Anything unmeasurable is ABSENT, never defaulted. `null` renders as
 *      "unknown"; a `false` or a `0` renders as a fact. This matters most for
 *      liveness: if the daemon socket is unreachable we cannot distinguish a
 *      stopped agent from an unmeasured one, so the whole field goes unknown.
 */

/* Resolve the org from the environment, then from what is actually installed.
   It previously fell back to a hardcoded org name, which was wrong twice over:
   it published one deployment's private org name into a shipped file, and it
   made every OTHER install silently query an org that does not exist there —
   returning empty roster/tasks/events that are indistinguishable from a quiet
   fleet. Absent is renderable as unknown; a wrong-org empty is renderable as a
   lie, which is the same failure this whole endpoint is built to avoid. */
function resolveOrg(): string | null {
  return process.env.CTX_ORG || getOrgs()[0] || null;
}
const INSTANCE = process.env.CTX_INSTANCE_ID || 'default';

/* Heartbeat is written by a cron plus incidental session activity, so its
   freshness is a SAMPLE of unknown cadence — never presence. Bands are coarse on
   purpose: the renderer must not imply knowledge finer than the source has. */
const HEARTBEAT_BANDS: Array<{ id: string; maxMin: number }> = [
  { id: 'fresh', maxMin: 60 },
  { id: 'aging', maxMin: 60 * 5 },
  { id: 'stale', maxMin: 60 * 12 },
  { id: 'cold', maxMin: Infinity },
];

interface DaemonStatus {
  name: string;
  status: string;
  pid?: number;
  uptime?: number;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
}

/**
 * True liveness, and the only monitor in this document.
 *
 * The daemon holds the PTY processes and pid-checks them with the signal-0
 * idiom before reporting `running`, so this is real OS process state at seconds
 * resolution. Note that `bus list-agents`'s `running` field is NOT this: it is
 * `heartbeat age < 10min` (src/bus/agents.ts), a sample wearing a monitor's
 * name. See city/SIGNALS.md row 2 amendment.
 *
 * Returns null — not an empty list — when the daemon cannot be reached.
 */
function daemonStatuses(timeoutMs = 2000): Promise<DaemonStatus[] | null> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\cortextos-${INSTANCE}`
      : path.join(homedir(), '.cortextos', INSTANCE, 'daemon.sock');

  return new Promise((resolve) => {
    let settled = false;
    const done = (v: DaemonStatus[] | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let socket: ReturnType<typeof createConnection>;
    try {
      socket = createConnection(socketPath, () => {
        socket.write(JSON.stringify({ type: 'status' }));
      });
    } catch {
      return done(null);
    }

    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
    });
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(buf);
        done(parsed?.success && Array.isArray(parsed.data) ? parsed.data : null);
      } catch {
        done(null);
      }
    });
    socket.on('error', () => {
      socket.destroy();
      done(null);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done(null);
    });
  });
}

/** Emoji + role from IDENTITY.md — scene labelling, not a signal. */
function identityOf(name: string, org: string): { role: string | null; emoji: string | null } {
  try {
    const raw = fs.readFileSync(path.join(getAgentDir(name, org), 'IDENTITY.md'), 'utf-8');
    const lines = raw.split('\n');
    const section = (heading: string): string | null => {
      const i = lines.findIndex((l) => l.trim().startsWith(heading));
      if (i < 0) return null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line || line.startsWith('<!--')) continue;
        if (line.startsWith('##')) return null;
        return line;
      }
      return null;
    };
    return { role: section('## Role'), emoji: section('## Emoji') };
  } catch {
    return { role: null, emoji: null };
  }
}

const minutesSince = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 60000;
};
const bandOf = (min: number | null): string | null =>
  min === null ? null : (HEARTBEAT_BANDS.find((b) => min <= b.maxMin) as { id: string }).id;

/* ---------- rows 1 + 2: roster, liveness, heartbeat ---------- */
async function agents(org: string) {
  const roster = getAllAgents().filter((a) => a.org === org);
  if (roster.length === 0) return null;

  const statuses = await daemonStatuses();
  const byName = new Map<string, DaemonStatus>();
  if (statuses) for (const s of statuses) byName.set(s.name, s);

  const out = await Promise.all(
    roster.map(async (a) => {
      const id = identityOf(a.name, a.org);
      const hb = await getHeartbeat(a.name).catch(() => null);
      const hbAt = hb?.last_heartbeat ?? null;
      const ageMin = hbAt ? minutesSince(hbAt) : null;
      const st = byName.get(a.name);

      return {
        id: a.name,
        role: id.role,
        emoji: id.emoji,

        /* MONITOR. `unknown: true` when the daemon could not be reached — a false
           here would paint a dead fleet during a healthy night. */
        live: statuses
          ? {
              running: st?.status === 'running',
              status: st?.status ?? 'absent',
              pid: st?.pid ?? null,
              uptime_seconds: st?.uptime ?? null,
              session_start: st?.sessionStart ?? null,
              crash_count: st?.crashCount ?? null,
              model: st?.model ?? null,
              unknown: false,
              source: 'daemon IPC status → agentManager.getAllStatuses() (pid-checked)',
              resolution: 'seconds — MONITOR',
            }
          : {
              unknown: true,
              source: 'daemon IPC status — UNREACHABLE',
              resolution: 'none — render as unknown, never as offline',
            },

        /* SAMPLE. Coarse bands only. Never rendered as presence. */
        heartbeat: {
          at: hbAt,
          age_minutes: ageMin === null ? null : Math.round(ageMin),
          band: bandOf(ageMin),
          status: hb?.status ?? null,
          mode: hb?.mode ?? null,
          source: 'state/<agent>/heartbeat.json',
          resolution: 'irregular (4h cron + incidental writes) — SAMPLE, not presence',
        },
      };
    })
  );

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* ---------- row 8: approvals — read the store, not the cache ---------- */
function approvals(org: string) {
  const dir = path.join(getApprovalDir(org), 'pending');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const items = [];
  for (const f of files) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      items.push({
        id: a.id ?? null,
        title: a.title ?? null,
        agent: a.agent ?? a.requested_by ?? null,
        category: a.category ?? null,
        created_at: a.created_at ?? null,
      });
    } catch {
      /* skip malformed rather than fabricate one */
    }
  }
  return {
    pending: items.length,
    items,
    all_clear: items.length === 0,
    source: 'orgs/<org>/approvals/pending/*.json',
    resolution: 'on change',
  };
}

/* ---------- row 9: tasks — read the store, not the cache ---------- */
function tasks(org: string) {
  const dir = getTaskDir(org);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const byAgent: Record<string, Array<Record<string, unknown>>> = {};
  let open = 0;
  let inProgress = 0;
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (t.archived || t.status === 'completed' || t.status === 'cancelled') continue;
      open++;
      if (t.status === 'in_progress') inProgress++;
      const who = t.assigned_to || 'unassigned';
      (byAgent[who] ||= []).push({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority ?? null,
        updated_at: t.updated_at ?? null,
      });
    } catch {
      /* skip malformed */
    }
  }
  return {
    open,
    in_progress: inProgress,
    by_agent: byAgent,
    source: 'orgs/<org>/tasks/*.json',
    resolution: 'on change',
  };
}

/* ---------- rows 4 + 10: the real event stream ----------
   Windowed by TIME, not by calendar day. Reading only today's file makes the
   ticker look near-empty for hours after every UTC midnight — and quiet is a
   plausible fleet state, so that bug reads as truth instead of as a bug. Span
   every day-file the window touches. */
function events(org: string, limit: number, windowHours: number) {
  const dir = path.join(getCTXRoot(), 'orgs', org, 'analytics', 'events');
  if (!fs.existsSync(dir)) return null;

  const now = Date.now();
  const since = now - windowHours * 3600e3;
  const days = new Set<string>();
  for (let t = since; t <= now + 86400e3; t += 86400e3) {
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  days.add(new Date(now).toISOString().slice(0, 10));

  const out: Array<{
    at: string;
    agent: string;
    category: string;
    event: string;
    severity: string;
  }> = [];

  let agentDirs: string[];
  try {
    agentDirs = fs.readdirSync(dir);
  } catch {
    return null;
  }

  for (const agent of agentDirs) {
    for (const day of days) {
      const f = path.join(dir, agent, `${day}.jsonl`);
      if (!fs.existsSync(f)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          /* heartbeats are §2 ambient, not ticker signal */
          if (e.category === 'heartbeat') continue;
          const ts = Date.parse(e.timestamp);
          if (Number.isNaN(ts) || ts < since) continue;
          out.push({
            at: e.timestamp,
            agent: e.agent ?? agent,
            category: e.category,
            event: e.event,
            severity: e.severity,
          });
        } catch {
          /* skip malformed line rather than fabricate one */
        }
      }
    }
  }

  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    recent: out.slice(-limit),
    total_in_window: out.length,
    window_hours: windowHours,
    source: 'orgs/<org>/analytics/events/*/YYYY-MM-DD.jsonl (append-only log, NOT the SQLite cache)',
    resolution: 'append-time — genuine event stream, the strongest signal available',
  };
}

/* ---------- per-agent activity: the SIGNAL register's fuel ----------
   Real counts over a real window. A quiet fleet must produce a quiet city: if
   these are zero the scene has to go still, because "always busy" is
   indistinguishable from "not measuring anything". */
function activity(evs: ReturnType<typeof events>) {
  if (!evs) return null;
  const hourAgo = Date.now() - 3600e3;
  const per: Record<string, { events_window: number; events_1h: number; messages_1h: number }> = {};
  for (const e of evs.recent) {
    const a = (per[e.agent] ||= { events_window: 0, events_1h: 0, messages_1h: 0 });
    a.events_window++;
    if (Date.parse(e.at) >= hourAgo) {
      a.events_1h++;
      if (e.category === 'message') a.messages_1h++;
    }
  }
  return {
    per_agent: per,
    window_hours: evs.window_hours,
    source: 'same append log as the ticker',
    resolution: 'append-time',
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const org = searchParams.get('org') || resolveOrg();
  if (!org) {
    console.error('[api/city-state] No org: CTX_ORG unset and no orgs installed');
    return Response.json(
      { error: 'No organization configured — set CTX_ORG or install an org' },
      { status: 503 }
    );
  }
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '60', 10) || 60, 1), 500);
  const windowHours = Math.min(
    Math.max(parseInt(searchParams.get('window') ?? '24', 10) || 24, 1),
    168
  );

  try {
    const eventsData = events(org, limit, windowHours);

    return Response.json({
      generated_at: new Date().toISOString(),
      org,
      agents: await agents(org),
      approvals: approvals(org),
      tasks: tasks(org),
      events: eventsData,
      activity: activity(eventsData),

      /* Rows 12-16 (revenue, ledger, streams, 14-day, trader P&L) are ABSENT on
         purpose. No revenue source exists in this org — SIGNALS.md §5. Absent
         renders as unknown; a zero would render as a fact. */
      money: null,
      notes: {
        money: 'NO SOURCE — omitted deliberately, awaiting owner ruling (SIGNALS.md §5)',
        cache: 'this endpoint deliberately bypasses @/lib/db — see the header comment',
        civic: 'hall is a scene fixture, not an agent; it will never appear in agents[]',
      },
    });
  } catch (err) {
    console.error('[api/city-state] Failed to build state:', err);
    return Response.json({ error: 'Failed to build city state' }, { status: 500 });
  }
}
