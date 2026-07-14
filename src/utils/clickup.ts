import { readFileSync, existsSync } from 'fs';
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

function postTask(token: string, listId: string, body: object): Promise<void> {
  return new Promise((resolve) => {
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
      },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve()); // fire-and-forget: never throw
    req.write(data);
    req.end();
  });
}

const PRIORITY_MAP: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

/**
 * Fire-and-forget ClickUp task mirror. Only runs for jennifer/human-assigned tasks.
 * ClickUp is a read/review surface — the cortextOS task JSON is the source of truth.
 * This function NEVER throws; failures are silently discarded.
 */
export function syncTaskToClickUp(
  frameworkRoot: string,
  title: string,
  opts: {
    description?: string;
    project?: string;
    priority?: string;
    assignee?: string;
  },
): void {
  if (opts.assignee !== 'jennifer' && opts.assignee !== 'human' && opts.assignee !== 'user') return;
  const token = getApiKey(frameworkRoot);
  if (!token) return;
  const listId = resolveClickUpListId(opts.project, title);
  const body = {
    name: title,
    description: opts.description ?? '',
    priority: PRIORITY_MAP[opts.priority ?? 'normal'] ?? 3,
    notify_all: false,
  };
  // Defer past the current tick so stdout (taskId) flushes first.
  setImmediate(() => { postTask(token, listId, body).catch(() => {}); });
}
