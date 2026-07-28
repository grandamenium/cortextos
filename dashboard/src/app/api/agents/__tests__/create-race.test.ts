/**
 * dashboard/src/app/api/agents/__tests__/create-race.test.ts
 *
 * The race that `POST /api/agents` was restructured to close: two creates of the
 * SAME agent name arriving together must produce exactly one 201 and one 409,
 * and leave exactly one coherent registry entry.
 *
 * Why an in-process test is the right shape here, and what it does NOT prove:
 *
 * The window being closed is not a multi-process one.  Both requests are served
 * by one Next worker on one thread, and every step of the registry mutation is
 * synchronous, so two requests can never be *inside* `mutateEnabledAgents` at
 * once regardless of locking.  They interleave at the handler's `await` points —
 * the template copy and the state-dir mkdirs.  The old code checked for a
 * duplicate, awaited all of that, and only then wrote the registry, so both
 * requests passed the check before either had claimed the name.  Reserving the
 * name in the same synchronous block as the check is what closes it, and that is
 * exactly what these tests exercise.
 *
 * The file lock is therefore NOT what makes these tests pass, and they must not
 * be read as evidence that it works: single-threaded, it is uncontended every
 * time.  The lock exists for the cross-process case (CLI and agents), and today
 * the CLI writers of this registry take no lock at all, so the cross-process
 * race remains open.  Nothing here speaks to it.
 *
 * The fs is real (temp dirs, a real template tree, real copies) because the
 * awaits inside the copy are the interleaving points; mocking them away would
 * remove the very thing under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Roots are per-test temp dirs.  `vi.mock` factories are hoisted above the file
// body, so they read through this holder rather than capturing a value.
// ---------------------------------------------------------------------------

const roots = vi.hoisted(() => ({ ctx: '', framework: '' }));

vi.mock('@/lib/config', () => ({
  getCTXRoot: () => roots.ctx,
  getFrameworkRoot: () => roots.framework,
  getAllAgents: () => [],
}));

// No daemon in tests.  `isDaemonRunning` false takes the create path's
// short-circuit, so no IPC socket is ever opened.
vi.mock('@/lib/ipc-client', () => {
  function IPCClient() {}
  IPCClient.prototype.isDaemonRunning = async () => false;
  IPCClient.prototype.send = async () => ({ success: true });
  return { IPCClient };
});

type AgentsRouteModule = typeof import('../route');
let route: AgentsRouteModule;
let tmpRoot: string;

const ORG = 'testorg';
const TEMPLATE = 'agent';

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agents-race-'));
  roots.ctx = path.join(tmpRoot, 'ctx');
  roots.framework = path.join(tmpRoot, 'framework');

  // A real (tiny) template tree, so `copyDir` does real async work.
  const templateDir = path.join(roots.framework, 'templates', TEMPLATE);
  mkdirSync(path.join(templateDir, 'nested'), { recursive: true });
  writeFileSync(path.join(templateDir, 'AGENTS.md'), '# template\n', 'utf-8');
  writeFileSync(path.join(templateDir, 'nested', 'SOUL.md'), '# soul\n', 'utf-8');

  mkdirSync(path.join(roots.ctx, 'config'), { recursive: true });

  vi.resetModules();
  route = await import('../route');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(name: string, overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      org: ORG,
      template: TEMPLATE,
      botToken: 'test-token',
      chatId: '12345',
      ...overrides,
    }),
  });
}

function readRegistry(): Record<string, any> {
  const file = path.join(roots.ctx, 'config', 'enabled-agents.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function agentDirFor(name: string): string {
  return path.join(roots.framework, 'orgs', ORG, 'agents', name);
}

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

describe('POST /api/agents — concurrent creates of the same name', () => {
  it('returns exactly one 201 and one 409', async () => {
    const [a, b] = await Promise.all([
      route.POST(createRequest('racer')),
      route.POST(createRequest('racer')),
    ]);

    // Sorted, because which request wins is a scheduling detail and asserting a
    // particular winner would make this flaky for no gain.
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('leaves exactly one committed registry entry, with no reservation residue', async () => {
    await Promise.all([
      route.POST(createRequest('racer')),
      route.POST(createRequest('racer')),
    ]);

    const registry = readRegistry();
    expect(Object.keys(registry)).toEqual(['racer']);

    const entry = registry.racer;
    // The committed shape — not the reservation.  A surviving `status:'creating'`
    // or `reservationToken` would mean the winner never finished its commit, and
    // `enabled:false` would leave the agent invisible to the daemon.
    expect(entry.enabled).toBe(true);
    expect(entry.org).toBe(ORG);
    expect(entry.template).toBe(TEMPLATE);
    expect(entry.status).toBeUndefined();
    expect(entry.reservationToken).toBeUndefined();
  });

  it('the winner is fully built on disk', async () => {
    await Promise.all([
      route.POST(createRequest('racer')),
      route.POST(createRequest('racer')),
    ]);

    // The loser must not have left the winner's directory half-written: the
    // template contents and the .env both have to be there.
    const dir = agentDirFor('racer');
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('# template\n');
    expect(readFileSync(path.join(dir, 'nested', 'SOUL.md'), 'utf-8')).toBe('# soul\n');
    expect(readFileSync(path.join(dir, '.env'), 'utf-8')).toContain('BOT_TOKEN=test-token');
  });

  it('a third concurrent create of the same name also loses', async () => {
    const results = await Promise.all([
      route.POST(createRequest('racer')),
      route.POST(createRequest('racer')),
      route.POST(createRequest('racer')),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(Object.keys(readRegistry())).toEqual(['racer']);
  });

  it('concurrent creates of DIFFERENT names both succeed', async () => {
    // The control on the other side: the reservation must not serialise
    // unrelated creates into a spurious 409.
    const [a, b] = await Promise.all([
      route.POST(createRequest('alpha')),
      route.POST(createRequest('beta')),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(Object.keys(readRegistry()).sort()).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// Sequential duplicate — the case that already worked, kept so a regression
// that made *everything* 409 would be distinguishable from the fix working.
// ---------------------------------------------------------------------------

describe('POST /api/agents — sequential duplicate', () => {
  it('rejects a create for a name already committed', async () => {
    const first = await route.POST(createRequest('solo'));
    expect(first.status).toBe(201);

    const second = await route.POST(createRequest('solo'));
    expect(second.status).toBe(409);
    expect(Object.keys(readRegistry())).toEqual(['solo']);
  });

  it('rejects a create for a name present on disk but absent from the registry', async () => {
    // Registry-absent + directory-present is a live agent: absent entries
    // default to ENABLED, so this must not be treated as a free name.
    mkdirSync(agentDirFor('ondisk'), { recursive: true });

    const res = await route.POST(createRequest('ondisk'));
    expect(res.status).toBe(409);
  });
});
