import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { AgentManager } from '../../src/daemon/agent-manager.js';
import { writeAgentPidFile, agentPidFilePath } from '../../src/daemon/agent-pid-file.js';

// SYS-DAEMON-RESILIENCE-01 — isolated-instance harness (Part B real-process leg,
// PD condition a). Exercises the SHIPPED reconcileOrphans() end-to-end: real
// pid-file on disk, real `ps` identity probe, real kill — against real spawned
// stubs. Containment: everything under a temp ctxRoot; only PIDs THIS test
// spawned are ever signalled; afterEach reaps any survivor by captured PID.

const INSTANCE = 'dmon-reconcile-test';
const children: ChildProcess[] = [];

function spawnStub(scriptName: string, body: string): ChildProcess {
  // Script NAME carries "claude" so `ps -o command=` matches the agent pattern
  // (/\bclaude\b/) for the positive case; the negative case uses a non-claude name.
  const dir = mkdtempSync(join(tmpdir(), 'cortextos-stub-'));
  const path = join(dir, scriptName);
  writeFileSync(path, body);
  const child = spawn(process.execPath, [path], { stdio: 'ignore' });
  children.push(child);
  return child;
}
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!isAlive(pid)) return true; await new Promise(r => setTimeout(r, 50)); }
  return !isAlive(pid);
}

describe('SYS-DAEMON-RESILIENCE-01 reconcileOrphans (real process)', () => {
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-recon-ctx-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-recon-fw-'));
  });
  afterEach(() => {
    for (const c of children.splice(0)) { if (c.pid && isAlive(c.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* */ } } }
    rmSync(ctxRoot, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  it('REAPS a confirmed own live agent-PTY orphan and removes its pid-file', async () => {
    // A live "agent" whose ps command matches /claude/ via the script name.
    const stub = spawnStub('claude-pty-stub.cjs', 'process.on("SIGHUP",()=>{});setInterval(()=>{},1<<30);');
    expect(stub.pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 200)); // let it register in ps
    writeAgentPidFile(ctxRoot, INSTANCE, 'stubagent', stub.pid!, new Date().toISOString());

    const am = new AgentManager(INSTANCE, ctxRoot, frameworkRoot, 'acme');
    const res = am.reconcileOrphans();

    expect(res.reaped).toContain('stubagent');
    expect(await waitDead(stub.pid!)).toBe(true);           // really SIGTERM'd
    expect(existsSync(agentPidFilePath(ctxRoot, 'stubagent'))).toBe(false); // pid-file cleared
  });

  it('PID-REUSE GUARD: does NOT kill a live PID whose start-time mismatches the recorded spawnedAt (recycled PID)', async () => {
    // Simulate the OS having recycled our dead agent's PID onto a DIFFERENT live
    // process: the live PID exists now, but the pid-file records a spawnedAt from
    // long ago. The start-time leg of the 3-part guard must catch this even when
    // the command happens to match (here every /tmp path contains "claude").
    const stub = spawnStub('claude-recycled-stub.cjs', 'setInterval(()=>{},1<<30);');
    expect(stub.pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 200));
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeAgentPidFile(ctxRoot, INSTANCE, 'stubagent', stub.pid!, oneHourAgo);

    const am = new AgentManager(INSTANCE, ctxRoot, frameworkRoot, 'acme');
    const res = am.reconcileOrphans();

    expect(res.reaped).not.toContain('stubagent');          // NOT reaped (start-time mismatch)
    expect(res.unlinked).toContain('stubagent');            // stale -> unlinked
    expect(isAlive(stub.pid!)).toBe(true);                  // innocent recycled-PID process untouched
    expect(existsSync(agentPidFilePath(ctxRoot, 'stubagent'))).toBe(false);
  });

  it('stale-unlinks a pid-file whose PID is dead (no reap, no error)', async () => {
    // Spawn + kill so the PID is dead but the pid-file remains.
    const stub = spawnStub('claude-dead-stub.cjs', 'setInterval(()=>{},1<<30);');
    const pid = stub.pid!;
    writeAgentPidFile(ctxRoot, INSTANCE, 'deadagent', pid, new Date().toISOString());
    process.kill(pid, 'SIGKILL');
    await waitDead(pid);

    const am = new AgentManager(INSTANCE, ctxRoot, frameworkRoot, 'acme');
    const res = am.reconcileOrphans();

    expect(res.reaped).not.toContain('deadagent');
    expect(res.unlinked).toContain('deadagent');
    expect(existsSync(agentPidFilePath(ctxRoot, 'deadagent'))).toBe(false);
  });
});
