import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Window 2 duplicate-PTY race, the manager-boundary half of
// the fix whose AgentProcess half is covered by agent-process.test.ts (W1/W2).
//
// The defect, read from source: `stopAgent()` (agent-manager.ts:1367) awaits
// `entry.process.stop()` at :1409, but `AgentProcess.stop()` nulls its PTY handle
// synchronously before any await, so getStatus().pid goes undefined the instant a
// stop begins while status is still 'running'. isAgentActuallyAlive() (:332) then
// reads `!!undefined && ...` === false for the whole stop duration. A start racing
// the stop (the fire-and-forget `stop-agent`+`start-agent` IPC pair) therefore
// SKIPS the alive-branch (and its stoppingAgents queue guard) and falls into the
// eviction path, whose `await stale.process.stop()` (:487) — a RE-ENTRANT stop() —
// used to be a silent no-op (`if (this.stopping) return;`). Eviction then deleted
// the map entry and spawned a fresh PTY while the predecessor's OS child was still
// alive: two live PTYs under one agent name, near-zero gap.
//
// This test drives that exact manager race through the real startAgent/stopAgent
// code paths, with AgentProcess mocked to model the stop() CONTRACT two ways:
//   - 'current'  — re-entrant stop() is a synchronous no-op and the graceful
//                  window returns WITHOUT confirming the OS child died.
//   - 'fixed'    — re-entrant stop() JOINS the in-flight teardown (Change B) and
//                  the teardown reaps the OS child before returning (Change A).
// The 'current' contract is the positive control: it reproduces two coexisting
// live children (RED). The 'fixed' contract is what the shipped AgentProcess.stop()
// now honors (verified directly by the W1/W2 tests in agent-process.test.ts), and
// it must leave exactly one live child at rest with the agent UP.
//
// Harness cloned from agent-manager-eviction-race-round4.test.ts (same FastChecker/
// Telegram/Cron/Worker/metrics mocks, same agentsOf/procAt accessors).

type ProcStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'halted';
type StopContract = 'current' | 'fixed';

const h = vi.hoisted(() => ({
  /** Every AgentProcess the manager constructed, in construction order. */
  procs: [] as unknown[],
  /** Every FastChecker the manager constructed, in construction order. */
  checkers: [] as unknown[],
  /** Which stop() contract the mock AgentProcess models this run. */
  stopContract: 'fixed' as StopContract,
}));

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    index: number;
    status: ProcStatus = 'stopped';
    pid: number | undefined;
    /**
     * Models the real OS child process — the thing the duplicate-PTY defect is
     * about. Set true by start(); cleared to false ONLY when a teardown actually
     * confirms death (Change A). The 'current' contract deliberately leaves it
     * true after its bounded wait, mirroring a SIGHUP-immune child that outlived
     * the 15s Promise.race with no SIGKILL escalation.
     */
    childAlive = false;

    private stopping = false;
    private stopInFlight: Promise<void> | null = null;
    /** Resolved by the test (finishStop) to stand in for the graceful window +
     *  death confirmation completing. */
    private releaseGate!: () => void;
    private gate: Promise<void>;

    constructor(name: string) {
      this.name = name;
      this.index = h.procs.length;
      h.procs.push(this);
      let release!: () => void;
      this.gate = new Promise<void>((r) => { release = r; });
      this.releaseGate = release;
    }

    async start() {
      if (this.status === 'running') return;   // agent-process.ts:109-112
      this.status = 'starting';                // agent-process.ts:137 — SYNC
      this.status = 'running';
      this.pid = 4000 + this.index;
      this.childAlive = true;
    }

    async stop() {
      return h.stopContract === 'current' ? this.stopCurrent() : this.stopFixed();
    }

    /** Pre-fix contract: re-entry is a synchronous no-op, and the graceful
     *  window returns without confirming the OS child died. */
    private async stopCurrent() {
      if (this.stopping) return;               // agent-process.ts:232 (pre-fix)
      this.stopping = true;
      this.pid = undefined;                    // PTY handle nulled synchronously
      await this.gate;                         // bounded graceful window
      this.status = 'stopped';
      this.stopping = false;
      // childAlive INTENTIONALLY left true — no SIGKILL escalation existed.
    }

    /** Post-fix contract: Change B (join-in-flight) + Change A (death-confirmed). */
    private async stopFixed() {
      if (this.stopping) {                     // Change B
        if (this.stopInFlight) await this.stopInFlight;
        return;
      }
      this.stopInFlight = this.runStopFixed();
      try {
        await this.stopInFlight;
      } finally {
        this.stopInFlight = null;
      }
    }

    private async runStopFixed() {
      this.stopping = true;
      this.pid = undefined;                    // PTY handle nulled synchronously
      await this.gate;                         // graceful window + SIGKILL poll
      this.childAlive = false;                 // Change A: death confirmed
      this.status = 'stopped';
      this.stopping = false;
    }

    /** Test-only: release the parked teardown. */
    finishStop() { this.releaseGate(); }

    getStatus() { return { name: this.name, status: this.status, pid: this.pid }; }

    onExit() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    process: unknown;
    startCount = 0;
    stopCount = 0;
    constructor(agentProcess: unknown) {
      this.process = agentProcess;
      h.checkers.push(this);
    }
    async start() { this.startCount++; }
    stop() { this.stopCount++; }
    wake() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    async handleActivityCallback() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class { async sendMessage() { /* no-op */ } },
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason: string | undefined;
    start() { return new Promise<void>(() => {}); }
    stop() { this.lastExitReason = 'stopped-externally'; }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    agentName: string;
    constructor(opts: { agentName: string }) { this.agentName = opts.agentName; }
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    name: string;
    constructor(name: string) { this.name = name; }
    async spawn() { /* no-op */ }
    async terminate() { /* no-op */ }
    onDone() { /* no-op */ }
    isFinished() { return true; }
    getStatus() { return { name: this.name }; }
  },
}));
vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: async () => ({ status: 'empty' as const, count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type EntryLike = { process: { index: number; childAlive: boolean; status: ProcStatus; finishStop(): void }; stopped?: boolean };
const agentsOf = (am: unknown) => (am as { agents: Map<string, EntryLike> }).agents;
const procAt = (i: number) => h.procs[i] as { index: number; childAlive: boolean; status: ProcStatus; finishStop(): void };
const liveChildren = () => h.procs.filter((p) => (p as { childAlive: boolean }).childAlive).length;

describe('AgentManager Window-2 duplicate-PTY race — stop/start reap-before-spawn', () => {
  let testDir: string;
  let agentDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.procs.length = 0;
    h.checkers.length = 0;
    h.stopContract = 'fixed';
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dup-pty-w2-'));
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ name: 'alice', runtime: 'claude-code' }),
    );
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    // isPidAlive/isChildAlive never see a real pid here (pid is undefined during
    // stop), but stub process.kill defensively so nothing signals a real pid.
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('CONTROL (current stop contract): a start racing an in-flight stop spawns a SECOND live child — the defect', async () => {
    h.stopContract = 'current';

    await am.startAgent('alice', agentDir);
    expect(h.procs.length).toBe(1);
    const proc0 = procAt(0);
    expect(proc0.childAlive).toBe(true);
    expect(liveChildren()).toBe(1);

    // Fire-and-forget stop: it parks in proc0.stop() on the graceful gate, with
    // pid already nulled (so isAgentActuallyAlive reads dead) but the OS child
    // still alive.
    const stopP = am.stopAgent('alice', false);
    await Promise.resolve();

    // A start races in while the stop is parked. isAgentActuallyAlive === false
    // -> eviction path -> `await stale.process.stop()` re-enters stop(), which
    // under the current contract returns immediately (no-op) WITHOUT reaping the
    // child. Eviction then deletes the entry and spawns a fresh child.
    await am.startAgent('alice', agentDir);

    expect(h.procs.length).toBe(2);
    // BOTH children are alive at the same instant — coexisting live PTYs under
    // one agent name. This is the reproduced defect (positive control).
    expect(liveChildren()).toBe(2);
    expect(procAt(0).childAlive).toBe(true);
    expect(procAt(1).childAlive).toBe(true);

    // Release the parked first stop so no promise is left dangling.
    proc0.finishStop();
    await stopP;
  });

  it('FIX (death-confirmed + join-in-flight contract): eviction blocks until the predecessor dies — exactly one live child at rest, agent UP', async () => {
    h.stopContract = 'fixed';

    await am.startAgent('alice', agentDir);
    expect(h.procs.length).toBe(1);
    const proc0 = procAt(0);
    expect(proc0.childAlive).toBe(true);

    // Fire-and-forget stop parks on the gate (pid nulled, child still alive).
    const stopP = am.stopAgent('alice', false);
    await Promise.resolve();

    // Racing start -> eviction -> `await stale.process.stop()` re-enters and, under
    // the fixed contract, JOINS the in-flight teardown. It is now blocked on the
    // same gate: the fresh spawn CANNOT happen until the predecessor is confirmed
    // dead. No second child exists yet.
    const startP = am.startAgent('alice', agentDir);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.procs.length).toBe(1);          // fresh spawn is gated, not yet created
    expect(liveChildren()).toBe(1);          // never two alive at once
    expect(proc0.childAlive).toBe(true);     // predecessor not yet reaped

    // Release the death gate: the teardown reaps the OS child (Change A), the
    // joined eviction unblocks, deletes the entry, and only THEN spawns fresh.
    proc0.finishStop();
    await Promise.all([stopP, startP]);

    expect(h.procs.length).toBe(2);          // the fresh child was spawned
    expect(procAt(0).childAlive).toBe(false);// predecessor reaped before the spawn
    expect(procAt(1).childAlive).toBe(true); // newcomer is the live one
    expect(liveChildren()).toBe(1);          // exactly one live child at rest

    // The agent ends UP, mapped to the newcomer (a stop+start, not a stop).
    const entry = agentsOf(am).get('alice');
    expect(entry?.process).toBe(procAt(1));
    expect(procAt(1).status).toBe('running');
  });
});
