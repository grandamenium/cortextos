import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import https from 'https';

// Entity → ClickUp list ID mapping (resolved Jul 14 2026 via ClickUp API)
const ENTITY_LIST_MAP: Record<string, { listId: string; name: string }> = {
  zarelda:        { listId: '901418072210', name: 'Zarelda Tasks' },
  ilp:            { listId: '901418072202', name: 'ILP Tasks (Laurel folder)' },
  watchthis:      { listId: '901418072119', name: 'Watch This!! Tasks (Bishop Ave)' },
  initial_rentals:{ listId: '901323647008', name: 'Initial Rentals To Do' },
  pine_meadows:   { listId: '901311152805', name: 'Pine Meadows Operations' },
  finance:        { listId: '901324730191', name: 'Finance Bill Pay Queue' },
  jordan:         { listId: '901315813749', name: 'Jordan Reyes List' },
  jb:             { listId: '901418072216', name: 'JB Admin Tasks' }, // default
};

// Keyword → entity key. Order matters: checked in insertion order.
const KEYWORD_MAP: [string, string][] = [
  ['zarelda',        'zarelda'],
  ['902',            'zarelda'],
  ['ilp',            'ilp'],
  ['impact',         'ilp'],
  ['carlin',         'ilp'],
  ['marlo',          'ilp'],
  ['bishop',         'watchthis'],
  ['wti',            'watchthis'],
  ['watch this',     'watchthis'],
  ['underwriting',   'watchthis'],
  ['initial rentals','initial_rentals'],
  ['26th',           'initial_rentals'],
  ['pine meadows',   'pine_meadows'],
  ['pine_meadows',   'pine_meadows'],
  ['finance',        'finance'],
  ['heloc',          'finance'],
  ['jordan',         'jordan'],
];

export function resolveClickUpListId(project?: string, title?: string): string {
  const text = `${project ?? ''} ${title ?? ''}`.toLowerCase();
  for (const [keyword, entity] of KEYWORD_MAP) {
    if (text.includes(keyword)) return ENTITY_LIST_MAP[entity].listId;
  }
  return ENTITY_LIST_MAP.jb.listId; // default: JB Admin Tasks
}

function getApiKey(frameworkRoot: string): string | null {
  const secretPath = join(frameworkRoot, 'orgs', 'atlasos', 'secrets', 'clickup_api_key.txt');
  if (!existsSync(secretPath)) return null;
  try { return readFileSync(secretPath, 'utf-8').trim() || null; } catch { return null; }
}

/**
 * POST one task to a ClickUp list.
 *
 * Rejects on transport error or non-2xx. It previously resolved unconditionally
 * — including on 401 and 404 — which meant a revoked key or a stale list ID
 * looked exactly like success and every mirrored task vanished silently. The
 * caller catches and logs; nothing here propagates to task creation.
 */
function postTask(token: string, listId: string, body: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.clickup.com',
        path: `/api/v2/list/${listId}/task`,
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (res) => {
        let payload = '';
        res.on('data', (chunk) => { if (payload.length < 400) payload += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`HTTP ${status} list=${listId} ${payload.slice(0, 160)}`));
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout after 10s')); });
    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

const PRIORITY_MAP: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

/**
 * Record a ClickUp sync failure where a human will actually see it.
 *
 * This used to be `.catch(() => {})`. A silent mirror is indistinguishable from
 * a working one: a stale list ID or a revoked key would drop every task on the
 * floor and nothing would ever say so. Still never throws — a failed mirror must
 * not break task creation — but it now leaves a trail.
 */
function logSyncFailure(frameworkRoot: string, title: string, reason: string): void {
  try {
    const dir = join(frameworkRoot, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'clickup-sync-failures.log'), `${new Date().toISOString()}\t${reason}\t${title}\n`);
  } catch { /* logging must never break the caller */ }
  try { process.stderr.write(`[clickup-sync] FAILED (${reason}): ${title}\n`); } catch { /* ignore */ }
}

/**
 * Fire-and-forget ClickUp task mirror. Only runs for jennifer/human-assigned tasks.
 * ClickUp is the durable, manually-manageable surface: it survives anything
 * happening to the fleet, and she can reorder or re-date it by hand.
 * This function NEVER throws; failures are logged, not swallowed.
 */
export function syncTaskToClickUp(
  frameworkRoot: string,
  title: string,
  opts: {
    description?: string;
    project?: string;
    priority?: string;
    assignee?: string;
    /** ISO 8601 instant. Sent to ClickUp as epoch ms so it lands on her board. */
    dueDate?: string | null;
  },
): void {
  if (opts.assignee !== 'jennifer' && opts.assignee !== 'human' && opts.assignee !== 'user') return;
  const token = getApiKey(frameworkRoot);
  if (!token) { logSyncFailure(frameworkRoot, title, 'no-api-key'); return; }
  const listId = resolveClickUpListId(opts.project, title);
  const body: Record<string, unknown> = {
    name: title,
    description: opts.description ?? '',
    priority: PRIORITY_MAP[opts.priority ?? 'normal'] ?? 3,
    notify_all: false,
  };
  if (opts.dueDate) {
    const ms = new Date(opts.dueDate).getTime();
    if (Number.isFinite(ms)) {
      body.due_date = ms;
      // Time-of-day is meaningful (end of her local day), so don't let ClickUp
      // render it as an all-day task.
      body.due_date_time = true;
    }
  }
  // Defer past the current tick so stdout (taskId) flushes first.
  setImmediate(() => {
    postTask(token, listId, body).catch((err: unknown) => {
      logSyncFailure(frameworkRoot, title, String((err as Error)?.message ?? err).slice(0, 120));
    });
  });
}
