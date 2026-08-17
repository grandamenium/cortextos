import { describe, it, expect, vi } from 'vitest';

// ⚠ RUN THIS FILE WITH `--reporter=verbose`.
// THE DEFAULT REPORTER SWALLOWS THE MEASURED TABLE ENTIRELY: the run prints
// "2 passed" and NONE of the evidence, with nothing to indicate a measurement was
// supposed to exist. That green is indistinguishable from a green that measured
// something. The table is the human-readable artefact; it is NOT what makes this
// file safe — see the next paragraph.
//
// THE NUMBERS ARE LOAD-BEARING, NOT DECORATIVE. Each case asserts the measured
// elapsed time against its documented floor (>= floor, < floor + 4s) AND asserts
// the exact bytes the branch wrote to the PTY. So a regression fails under ANY
// reporter; only the printed summary is reporter-dependent. A printed number
// nobody reads is decoration — an asserted one fails.
//
// Round 4c — WIDTH OF THE stopAgent TEARDOWN WINDOW, MEASURED PER RUNTIME.
//
// WHY THIS FILE EXISTS. The window between `entry.stopped = true`
// (agent-manager.ts:1141) and `this.agents.delete(name)` (:1198) is dominated by
// the single `await entry.process.stop()` at :1146. Its width was previously
// argued from CONSTANTS READ OUT OF agent-process.ts — and that argument was
// wrong twice in one hour:
//
//   1. Five sleep constants were quoted as if they summed. FOUR OF THEM SIT ON
//      MUTUALLY EXCLUSIVE `if (this.config.runtime === …)` BRANCHES. The numbers
//      were all real; the addition was fiction.
//   2. `Promise.race([exitPromise, sleep(15000)])` was spent as a FLOOR. It is a
//      CEILING — it resolves early on exit. An upper bound of 21s is perfectly
//      consistent with a real window of zero.
//
// A MEASUREMENT KILLS BOTH FAILURE MODES AT ONCE, because elapsed wall-clock on
// one branch cannot accidentally include another branch's constants.
//
// ⛔ WHAT THIS FILE DOES **NOT** ESTABLISH — READ BEFORE CITING IT.
// (a) IT DOES NOT SPAWN AN OS PROCESS. `this.pty` is set to a stub whose only
//     job is to be non-null and to answer isAlive(). That is enough for the real
//     branch to execute, because THE FLOOR IS PRODUCED BY `await sleep(...)`
//     CALLS INSIDE agent-process.ts THAT READ NOTHING FROM THE CHILD — they are
//     gated only on `config.runtime` and on `if (pty)` at :228. So the width
//     figures below are figures about THE REAL CODE. They are NOT evidence that
//     a real Claude Code PTY reaches this path in production.
// (b) IT SAYS NOTHING ABOUT FREQUENCY. A 6s floor means the window is REAL on one
//     runtime. It does not say how often anything lands inside it. DO NOT LET 6s
//     MIGRATE FROM REACHABILITY TO FREQUENCY, OR ACROSS RUNTIMES.
// (c) A ZERO FLOOR IS NOT A ZERO WIDTH. codex-app-server has no GUARANTEED
//     minimum; there is still real work between :1141 and :1198. Write
//     "UNPROVEN on codex-app-server", NEVER "unreachable".

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: class {} }));
vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({ CodexAppServerPTY: class {} }));
vi.mock('../../../src/pty/hermes-pty.js', () => ({ HermesPTY: class {}, hermesDbExists: () => false }));
vi.mock('../../../src/pty/opencode-pty.js', () => ({ OpencodePTY: class {}, opencodeSessionExists: () => false }));

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

/**
 * The narrowest stand-in that lets the real stop() run its real branch:
 * non-null (so `if (pty)` at :228 passes) and answering isAlive() (:272).
 * Records what the branch actually wrote, so the runtime branch taken is
 * OBSERVED rather than assumed from the config we passed in.
 */
function makeStubPty() {
  const writes: string[] = [];
  return {
    writes,
    write(s: string) { writes.push(s); },
    isAlive() { return false; },   // false ⇒ kill() is skipped, per :272
    kill() { /* unreachable while isAlive() is false */ },
    // Change A (death-confirmed stop) added an unconditional `pty.getPid()` read
    // to stop() before the kill, to identify the OS child for a possible SIGKILL
    // escalation. getPid() is a real method on every PTY subclass (AgentPTY etc.,
    // used by getStatus()/start()); this stub predates that read. undefined here
    // means "no live child" — consistent with isAlive()===false — so stop()'s
    // `if (childPid && ...)` SIGKILL branch stays skipped and the measured floors
    // and write assertions below are unchanged.
    getPid() { return undefined; },
  };
}

type RuntimeCase = {
  runtime: string;
  /** Documented floor from the branch bodies, for comparison against measurement. */
  expectedFloorMs: number;
  /** What the branch is expected to have written to the PTY. */
  expectedWrites: string[];
  /**
   * Explicit upper bound. Needed because a floor of 0 makes
   * `toBeGreaterThanOrEqual(floor)` an assertion that CANNOT FAIL, so the
   * zero-floor row would otherwise carry no timing evidence at all while still
   * appearing in a table of measurements.
   */
  expectedCeilingMs: number;
  /**
   * ⛔ Set where the row cannot be told apart from this file's own no-pty negative
   * control. Recorded on the row rather than in prose so it travels with the data.
   */
  notDiscriminable?: string;
};

const CASES: RuntimeCase[] = [
  { runtime: 'claude-code',      expectedFloorMs: 6000, expectedCeilingMs: 10000, expectedWrites: ['\x03', '/exit\r\n'] },
  { runtime: 'hermes',           expectedFloorMs: 3000, expectedCeilingMs: 7000,  expectedWrites: ['\x04'] },
  { runtime: 'opencode',         expectedFloorMs: 1000, expectedCeilingMs: 5000,  expectedWrites: ['\x03'] },
  {
    runtime: 'codex-app-server', expectedFloorMs: 0,    expectedCeilingMs: 250,   expectedWrites: [],
    // ⛔ THIS ROW PROVES NOTHING ON ITS OWN AND MUST NOT BE COUNTED AS EVIDENCE.
    // Its floor is 0, so the floor assertion cannot fail; and BOTH of its
    // observable signatures — ~0ms elapsed and zero PTY writes — are exactly what
    // the no-pty negative control below produces. So a run where `pty` was never
    // attached, or where dispatch silently skipped this branch, is INDISTINGUISHABLE
    // from a correct run of it.
    // ⭐ Kept because documenting "this runtime has no stop sleeps" is still useful,
    // and the 250ms ceiling still catches a runaway. But it is a DOCUMENTED SHAPE,
    // not a measurement, and the label says so where a reader of the table will see it.
    notDiscriminable:
      'zero-floor + zero-writes is identical to the no-pty negative control; ' +
      'this row documents an expected shape and carries no independent evidence',
  },
];

function buildProcess(runtime: string) {
  const env = { agentName: 'alice', org: 'acme' } as never;
  const config = { name: 'alice', runtime } as never;
  const proc = new AgentProcess('alice', env, config, () => { /* silence */ });
  const pty = makeStubPty();
  // Private by design; this is the whole seam. Setting it is the ONLY thing this
  // test does that a caller could not do — everything after is the real stop().
  (proc as unknown as { pty: unknown }).pty = pty;
  return { proc, pty };
}

// NOTE: this file's line references point at agent-process.ts, NOT agent-manager.ts,
// and were re-verified as still accurate after the round-4 fix (which touched only
// agent-manager.ts). Kept as numbers for that reason.
describe('AgentProcess.stop() — teardown width is a property of config.runtime', () => {
  // 6s + 3s + 1s of real sleeping, plus overhead.
  const TIMEOUT = 30_000;

  it(
    'measures the stop-path floor on every runtime branch, and prints what it measured',
    async () => {
      const rows: string[] = [];

      for (const c of CASES) {
        const { proc, pty } = buildProcess(c.runtime);

        // Condition: a PTY is present, so `if (pty)` at :228 passes. Asserted
        // rather than assumed — without it every branch would measure ~0 and the
        // whole table would agree for the wrong reason.
        expect((proc as unknown as { pty: unknown }).pty).not.toBeNull();

        const t0 = Date.now();
        await proc.stop();
        const elapsed = Date.now() - t0;

        // The branch taken is OBSERVED from what it wrote, not inferred from the
        // config we handed in. If a future refactor changes the dispatch, this
        // fails instead of silently measuring a different branch.
        expect(pty.writes).toEqual(c.expectedWrites);

        rows.push(
          `runtime=${c.runtime.padEnd(17)} pty=PRESENT(stub) ` +
          `writes=[${pty.writes.map((w) => JSON.stringify(w)).join(', ')}] ` +
          `documented_floor=${c.expectedFloorMs}ms measured=${elapsed}ms` +
          // Printed next to the number it qualifies, so the caveat cannot be
          // separated from the row by anyone reading only the output.
          (c.notDiscriminable ? `  ⛔ NOT-DISCRIMINABLE: ${c.notDiscriminable}` : ''),
        );

        // Floor, not equality: the branch must take AT LEAST its sleeps.
        // ⚠ For a row whose floor is 0 this assertion CANNOT FAIL — that row's only
        // real bound is the explicit ceiling below, and its `notDiscriminable` label.
        expect(elapsed).toBeGreaterThanOrEqual(c.expectedFloorMs);
        // Explicit per-case ceiling rather than floor+4000, so the zero-floor row
        // gets a bound that actually separates it from the multi-second branches
        // instead of inheriting a 4s allowance that overlaps three of them.
        expect(elapsed).toBeLessThan(c.expectedCeilingMs);
      }

      // Printed on purpose: a width claim that cannot show which branch it took,
      // that a PTY was present, and what it actually measured is not a
      // measurement anyone else can check.
      console.log('\n[round4c] STOP-PATH WIDTH, MEASURED ON THE REAL AgentProcess.stop():');
      for (const r of rows) console.log('  ' + r);
      console.log(
        '  NOTE: stub PTY, no OS process. Floors come from `await sleep()` inside\n' +
        '  agent-process.ts gated on config.runtime and `if (pty)`; they read nothing\n' +
        '  from the child. Width only — NOT frequency, and a zero FLOOR is not a zero WIDTH.\n',
      );
    },
    TIMEOUT,
  );

  it('NEGATIVE CONTROL: with NO pty the whole branch is skipped and every runtime collapses to ~0 — so the numbers above are the `if (pty)` guard doing real work', async () => {
    for (const c of CASES) {
      const env = { agentName: 'alice', org: 'acme' } as never;
      const config = { name: 'alice', runtime: c.runtime } as never;
      const proc = new AgentProcess('alice', env, config, () => { /* silence */ });
      // pty left null — the `if (pty)` guard at :228 is false.
      const t0 = Date.now();
      await proc.stop();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(250);
    }
  }, 15_000);
});
