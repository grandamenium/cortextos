/**
 * The config PATCH must REPLACE config.json, not rewrite it in place.
 *
 * The bug this guards is invisible to the obvious test.  A test that PATCHes
 * and then asserts the resulting contents passes identically against
 * `writeFileSync` and against `atomicWriteSync` — both leave the same bytes on
 * disk.  What differs is only observable DURING the write: `writeFileSync`
 * truncates the target and then refills it, so a concurrent reader can see a
 * half-written file, while temp-file-plus-rename leaves the old inode intact
 * and swaps a complete new one into its place.
 *
 * So the first test below asserts that swap directly, by hard-linking the file
 * before the write.  A link is a second name for the SAME inode: if the handler
 * rewrote the file in place, the link sees the new bytes; if it replaced the
 * file, the link still holds the whole old contents.  That is exactly the
 * property "no reader observes a torn file" rests on, and it is what fails if
 * someone swaps `atomicWriteSync` back for `writeFileSync` — verified by making
 * that mutation and watching this test go red.
 *
 * HONEST SCOPE.  This is a single-process test.  It proves the write is a
 * whole-file replacement; it does NOT run a reader concurrently with a writer,
 * and it says nothing about durability — `atomicWriteSync` does not fsync, so
 * the guarantee is "no torn read", not "survives power loss".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgatomic-state-'));
const frameworkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgatomic-fw-'));
process.env.CTX_ROOT = stateRoot;
process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

const ORG = 'acme';
const AGENT = 'testbot';
const agentDir = path.join(frameworkRoot, 'orgs', ORG, 'agents', AGENT);
const configPath = path.join(agentDir, 'config.json');
const snapshotPath = path.join(frameworkRoot, 'config.json.link');

let configRoute: typeof import('../config/route');

beforeAll(async () => {
  fs.mkdirSync(path.join(stateRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, 'config', 'enabled-agents.json'),
    JSON.stringify({ [AGENT]: { enabled: true, org: ORG } }),
  );
  fs.mkdirSync(agentDir, { recursive: true });

  configRoute = await import('../config/route');
});

afterAll(() => {
  for (const dir of [stateRoot, frameworkRoot]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  fs.rmSync(snapshotPath, { force: true });
  // 0o644 is what a config.json written by the CLI actually carries, and one of
  // the assertions below is about that mode changing — so set it explicitly
  // rather than inheriting whatever the test runner's umask produces.
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        agent_name: AGENT,
        enabled: true,
        startup_delay: 0,
        max_session_seconds: 3600,
        working_directory: '.',
        timezone: 'UTC',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o644 },
  );
  fs.chmodSync(configPath, 0o644);
});

const params = () => ({ params: Promise.resolve({ name: AGENT }) });
const patchBody = (): NextRequest =>
  ({ json: async () => ({ timezone: 'America/New_York' }) }) as unknown as NextRequest;
const readConfig = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('config PATCH writes config.json atomically', () => {
  it('replaces the file rather than rewriting the existing inode in place', async () => {
    // A hard link is a second name for the same inode. Whatever the handler
    // does to `configPath` in place is visible through it.
    fs.linkSync(configPath, snapshotPath);
    const originalIno = fs.statSync(configPath).ino;

    const res = await configRoute.PATCH(patchBody(), params());
    expect(res.status).toBe(200);

    // Control arm: the write has to have actually landed, or "the old inode is
    // untouched" would be trivially true for a handler that wrote nothing.
    expect(readConfig(configPath).timezone).toBe('America/New_York');

    // The claim. Under `writeFileSync` this reads 'America/New_York' — the
    // truncate-and-refill happened to the inode the link still points at, which
    // is the same inode a concurrent reader would have had open.
    expect(readConfig(snapshotPath).timezone).toBe('UTC');
    expect(fs.statSync(configPath).ino).not.toBe(originalIno);
  });

  it('leaves no temp file behind on the success path', async () => {
    const res = await configRoute.PATCH(patchBody(), params());
    expect(res.status).toBe(200);

    // A leftover `.tmp.*` would mean the rename never completed. Note this one
    // is vacuously green under a plain `writeFileSync` — it guards the atomic
    // path's own failure mode, it does not distinguish the two writers.
    expect(fs.readdirSync(agentDir).filter(f => f.startsWith('.tmp.'))).toEqual([]);
  });

  it('writes exactly one trailing newline', async () => {
    expect((await configRoute.PATCH(patchBody(), params())).status).toBe(200);

    // `atomicWriteSync` appends its own "\n". A caller that also appends one —
    // as this route did before — would leave the file ending in "\n\n".
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });

  it('narrows config.json from 0644 to 0600', async () => {
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o644);

    expect((await configRoute.PATCH(patchBody(), params())).status).toBe(200);

    // Not a goal of this change — a consequence of it, asserted so it is a
    // recorded decision rather than a surprise. `atomicWriteSync` creates its
    // temp file 0o600 and rename preserves the mode, so the first write through
    // this path narrows the file. Nothing in the fleet reads config.json as
    // another user; if that ever changes, this test is where it surfaces.
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
