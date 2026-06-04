/**
 * Tests for the agent detail PATCH route — MEMORY.md optimistic concurrency (#515).
 *
 * Seeds a temp CTX_ROOT with an agent + MEMORY.md, then invokes the PATCH
 * handler directly. CTX_ROOT/CTX_FRAMEWORK_ROOT are set before importing the
 * handler so the route module's config picks them up at evaluation time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-route-'));
// Snapshot env so we don't leak a deleted temp root into later vitest files in
// the same worker (codex review).
const ORIG_CTX_ROOT = process.env.CTX_ROOT;
const ORIG_CTX_FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT;
process.env.CTX_ROOT = rootTmp;
// Point framework root at a non-existent path so getAgentDir falls through to
// CTX_ROOT/agents/<name> rather than a real project tree.
process.env.CTX_FRAMEWORK_ROOT = path.join(rootTmp, '__no_framework__');

const AGENT = 'memtest';
const agentDir = path.join(rootTmp, 'agents', AGENT);
const memoryMd = path.join(agentDir, 'MEMORY.md');
const ORIGINAL = 'original memory content\n';

const hashOf = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');

let route: typeof import('../route');

beforeAll(async () => {
  route = await import('../route');
});

beforeEach(() => {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(memoryMd, ORIGINAL, 'utf-8');
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(rootTmp, { recursive: true, force: true });
  if (ORIG_CTX_ROOT === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = ORIG_CTX_ROOT;
  if (ORIG_CTX_FRAMEWORK_ROOT === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
  else process.env.CTX_FRAMEWORK_ROOT = ORIG_CTX_FRAMEWORK_ROOT;
});

function patchMemory(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/agents/${AGENT}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.PATCH(req, { params: Promise.resolve({ name: AGENT }) });
}

describe('PATCH /api/agents/[name] — MEMORY.md optimistic concurrency (#515)', () => {
  it('rejects with 409 and does NOT overwrite when memoryHash is stale', async () => {
    // Client loaded an older version; the file changed underneath it.
    const staleHash = hashOf('a different, older version\n');
    const res = await patchMemory({ memoryRaw: 'client edits\n', memoryHash: staleHash });

    expect(res.status).toBe(409);
    // The on-disk file must be untouched — this is the data-loss guard.
    expect(fs.readFileSync(memoryMd, 'utf-8')).toBe(ORIGINAL);
  });

  it('writes when memoryHash matches the current file', async () => {
    const res = await patchMemory({ memoryRaw: 'client edits\n', memoryHash: hashOf(ORIGINAL) });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(memoryMd, 'utf-8')).toBe('client edits\n');
  });

  it('rejects with 400 and does NOT write when memoryRaw is sent without a memoryHash', async () => {
    const res = await patchMemory({ memoryRaw: 'no-hash write\n' });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(memoryMd, 'utf-8')).toBe(ORIGINAL);
  });

  it('treats a missing MEMORY.md as an empty baseline (hash of "")', async () => {
    fs.rmSync(memoryMd, { force: true });
    // Stale hash against a missing file still conflicts...
    const stale = await patchMemory({ memoryRaw: 'x\n', memoryHash: hashOf('not empty\n') });
    expect(stale.status).toBe(409);
    expect(fs.existsSync(memoryMd)).toBe(false);
    // ...but the empty-string hash matches and creates the file.
    const ok = await patchMemory({ memoryRaw: 'fresh\n', memoryHash: hashOf('') });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(memoryMd, 'utf-8')).toBe('fresh\n');
  });

  it('returns the post-write hash so consecutive saves do not false-409', async () => {
    const first = await patchMemory({ memoryRaw: 'v2\n', memoryHash: hashOf(ORIGINAL) });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.memoryHash).toBe(hashOf('v2\n'));

    // Second save using the hash returned from the first must NOT conflict.
    const second = await patchMemory({ memoryRaw: 'v3\n', memoryHash: body.memoryHash });
    expect(second.status).toBe(200);
    expect(fs.readFileSync(memoryMd, 'utf-8')).toBe('v3\n');
  });
});
