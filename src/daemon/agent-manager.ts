import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage } from '../types/index.js';
import { AgentProcess } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { CronScheduler } from './cron-scheduler.js';
import { migrateCronsForAgent } from './cron-migration.js';
import { ensureRequiredHooks } from './hook-reconciler.js';
import type { CronDefinition } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramPoller } from '../telegram/poller.js';
import { SlackAPI } from '../slack/api.js';
import { SlackSocketModeClient } from '../slack/socket-mode.js';
import { dispatchSlackMessage, makeUserNameResolver, type DispatchTarget } from '../slack/dispatcher.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';
import { processMediaMessage } from '../telegram/media.js';
import { stripBom } from '../utils/strip-bom.js';
import { BuzzRelayClient, BuzzDispatcher, loadBuzzConfig, type NostrEvent } from '../buzz/index.js';
import { computeDormancy, parseHeartbeatIntervalMs } from '../utils/dormancy.js';
import { CRONS_DIRECTORY, CRONS_FILENAME } from '../bus/crons-schema.js';

type LogFn = (msg: string) => void;

/**
 * One agent's registry entry. Named (was an inline literal on `agents`) so the
 * map-entry-race identity guard below can be typed honestly.
 */
type AgentEntry = {
  process: AgentProcess;
  checker: FastChecker;
  poller?: TelegramPoller;
  activityPoller?: TelegramPoller;
  telegramRejectCount?: number;
  telegramLastRejectAlertAt?: number;
  /**
   * Round 3 (F5/F2): set by stopAgent the moment a teardown of THIS entry begins.
   *
   * Distinct from `stillMapped()` on purpose, and the distinction is the whole
   * point. stillMapped answers "does the name still resolve to me", which is
   * false in TWO very different situations: I was stopped, or I am still running
   * and somebody else took my name. Callbacks that arrive from MY OWN poller are
   * legitimately mine in the second case and must still be handled — that is what
   * T13/T14 pin. Only the first case means "do not act on the world".
   *
   * A per-entry flag rather than a map lookup because teardown is a fact about
   * this object, and the object is what we still hold across the await.
   */
  stopped?: boolean;
};

// liveness fix: OS-level pid liveness probe using the same signal-0 idiom as
// src/utils/lock.ts — signal 0 sends nothing, it only tests process existence +
// our permission to signal it. We DELIBERATELY diverge from lock.ts on EPERM:
// lock.ts treats every error as dead, but here a process owned by another user
// (EPERM) is alive and must NOT be evicted — only ESRCH (process gone) is dead.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Manages all agents in a cortextOS instance.
 */
export class AgentManager {
  private agents: Map<string, AgentEntry> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /**
   * Org-level singleton Buzz relay client + dispatcher, keyed by org — one
   * shared WebSocket connection per org (mirrors the Slack Socket Mode
   * shape: one relay per workspace/org, not one connection per agent).
   * Only the org's orchestrator starts these; every other agent in the org
   * registers into the same dispatcher instance without opening its own
   * connection.
   */
  private buzzClients: Map<string, { client: BuzzRelayClient; dispatcher: BuzzDispatcher; started: boolean }> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  private pendingRestarts: Set<string> = new Set();
  // liveness fix: names currently being evicted+restarted. Claimed synchronously
  // BEFORE the eviction's `await`, so a concurrent startAgent() for the same dead
  // entry returns instead of double-spawning a PTY (same hazard class BUG-011's
  // pendingRestarts guards for alive entries).
  private evictingAgents: Set<string> = new Set();
  // idempotency fix: names with a stopAgent() teardown currently in flight.
  // Claimed synchronously on stopAgent() entry (before its first await), so a
  // concurrent startAgent() hitting the alive-branch can tell a legit in-flight
  // restart (queue via pendingRestarts) from a pure duplicate start (no-op).
  //
  // ORDERING INVARIANT (relied on by the alive-branch no-op path): for any
  // coordinated stop+start pair on the same name, stopAgent() must claim
  // `stoppingAgents` synchronously BEFORE the paired startAgent() runs its
  // synchronous prefix (the alive-branch check). All CURRENT dispatch paths
  // satisfy this: restartAgent() and stopAll() are sequential-await (stop is
  // fully entered — marker claimed — before start begins), and IPC stop/start
  // messages are processed in arrival order (a restart-all sends stop first).
  // A hypothetical FUTURE caller that dispatched startAgent() BEFORE stopAgent()
  // for a coordinated restart would find `stoppingAgents` still empty, take the
  // idempotent no-op path, and have its start SWALLOWED — so callers MUST keep
  // stop-before-start ordering for coordinated restarts.
  private stoppingAgents: Set<string> = new Set();
  private instanceId: string;
  private ctxRoot: string;
  private frameworkRoot: string;
  private org: string;

  // Set true at construction time if any agent in state/ has a stale
  // .daemon-crashed marker, meaning the previous daemon process died
  // abruptly. Used by startAgent() to downgrade the BUG-011 regression
  // alarm to an info log in the post-crash overlap case (PR #11 only
  // closed the in-flight stop/start race; crash-restart can legitimately
  // see overlapping registry state). Cleared after discoverAndStart()
  // finishes so the next clean restart starts from a known-good baseline.
  private daemonJustCrashed: boolean = false;

  // Slack Socket Mode: one shared connection for the whole daemon process
  // (Slack is one app per workspace, not one bot per agent — see
  // maybeStartSlackSocketMode's docblock). slackSocketStarted guards
  // against starting a second connection if startAgent() runs again for
  // the orchestrator (e.g. a restart) while this daemon process is alive.
  private slackSocketStarted = false;
  private slackSocketClient: SlackSocketModeClient | null = null;

  // silent-dormancy fix: epoch ms of when this AgentManager (i.e. the daemon)
  // was constructed. Used as the Face-B liveness baseline for enabled agents
  // that are absent from the mapped set — there is no per-agent uptime for
  // them, so staleness is measured relative to daemon start.
  private daemonStartMs: number = Date.now();

  constructor(instanceId: string, ctxRoot: string, frameworkRoot: string, org: string) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
    this.daemonJustCrashed = this.detectDaemonCrashMarkers();
    if (this.daemonJustCrashed) {
      console.log('[agent-manager] Detected .daemon-crashed marker(s) — previous daemon exited abnormally. Will quiet BUG-011 alarm for this startup cycle.');
    }
  }

  /**
   * Scan state/<agent>/.daemon-crashed markers (written by daemon/index.ts:handleFatal).
   * Presence means the previous daemon process died via uncaughtException
   * or process.kill rather than a clean shutdown.
   */
  private detectDaemonCrashMarkers(): boolean {
    const stateBase = join(this.ctxRoot, 'state');
    if (!existsSync(stateBase)) return false;
    try {
      const dirs = readdirSync(stateBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      return dirs.some(name => existsSync(join(stateBase, name, '.daemon-crashed')));
    } catch {
      return false;
    }
  }

  /**
   * Delete .daemon-crashed markers after a successful discoverAndStart pass
   * AND clear the daemonJustCrashed flag. Once the initial post-crash
   * discovery has finished, any further startAgent calls — IPC-triggered
   * agent enables, dashboard restarts, manual restartAgent — represent
   * normal operation, not post-crash overlap. They should fire the real
   * BUG-011 alarm, not the quieted variant.
   *
   * Called once per daemon startup at the end of discoverAndStart().
   * Idempotent — if no markers exist, this is a no-op. Wrapped in
   * best-effort try/catch so a missing dir or permission error never
   * blocks daemon startup.
   */
  private clearDaemonCrashMarkers(): void {
    if (!this.daemonJustCrashed) return;
    const stateBase = join(this.ctxRoot, 'state');
    if (existsSync(stateBase)) {
      try {
        const dirs = readdirSync(stateBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const name of dirs) {
          try {
            const marker = join(stateBase, name, '.daemon-crashed');
            if (existsSync(marker)) unlinkSync(marker);
          } catch { /* per-agent best effort */ }
        }
      } catch { /* directory unreadable — leave markers, next clean startup will retry */ }
    }
    // Reset the flag so subsequent startAgent calls (IPC enable, dashboard
    // restart, manual restartAgent) get the real BUG-011 alarm, not the
    // quieted post-crash variant.
    this.daemonJustCrashed = false;
  }

  /**
   * Discover and start all enabled agents.
   */
  async discoverAndStart(): Promise<void> {
    const agentDirs = this.discoverAgents();

    // BUG-028: read instance-level enabled-agents.json so the daemon respects
    // the user's explicit enable/disable choices written by the CLI
    // (`cortextos enable`/`disable`) and the dashboard. Without this read, those
    // commands have no effect across daemon restarts — the daemon would
    // re-discover and re-start any agent dir on disk regardless of user intent.
    const instanceEnabled = this.readInstanceEnableList();

    for (const { name, dir, org, config } of agentDirs) {
      // Per-agent config.json `enabled: false` (existing behavior, unchanged)
      if (config.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (per-agent config.json)`);
        continue;
      }
      // Instance-level enabled-agents.json `enabled: false` (BUG-028 fix)
      const entry = instanceEnabled[name];
      if (entry && entry.enabled === false) {
        console.log(`[agent-manager] Skipping disabled agent: ${name} (enabled-agents.json)`);
        continue;
      }
      // BUG-043 fix: pass the per-agent org so startAgent can use it instead
      // of falling back to `this.org` (the daemon's startup org).
      await this.startAgent(name, dir, config, org);
    }

    // Successful startup pass — clear .daemon-crashed markers from disk
    // AND clear the in-memory daemonJustCrashed flag. After this point,
    // any further startAgent() calls (IPC enable, dashboard restart, etc)
    // are normal operation and should fire the real BUG-011 alarm if a
    // race ever does leak through PR #11's protection.
    this.clearDaemonCrashMarkers();
  }

  /**
   * Read the instance-level enabled-agents.json registry.
   * Returns an empty object if the file is missing or unreadable —
   * agents not present in the file default to enabled, matching the existing
   * default-on behavior of `discoverAndStart`.
   */
  private readInstanceEnableList(): Record<string, { enabled?: boolean; org?: string; status?: string }> {
    const enabledFile = join(this.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) return {};
    try {
      return JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      return {}; // corrupt or unreadable — fall through to default-enabled
    }
  }

  /**
   * BUG-043 fix: resolve the canonical org for a given agent without
   * defaulting to the daemon's startup `this.org`.
   *
   * Resolution order:
   *   1. Explicit `org` argument (e.g. from `discoverAgents()` which knows
   *      which org a dir lives under)
   *   2. `enabled-agents.json[name].org` — set by `cortextos enable`/`add-agent`
   *   3. Filesystem scan: walk `frameworkRoot/orgs/*` looking for a dir
   *      named `name` — handles legacy enabled-agents.json entries that
   *      were written before the `org` field was added
   *   4. Legacy fallback: `this.org` (preserves single-org install behavior)
   *
   * Before this fix, all six `this.org` sites in `agent-manager.ts` would
   * short-circuit to the daemon's startup `CTX_ORG`, which silently broke
   * multi-org installs — agents in `lifeos` or `cointally` were invisible
   * to a daemon started with `CTX_ORG=testorg`.
   */
  private resolveAgentOrg(name: string, explicitOrg?: string): string {
    if (explicitOrg) return explicitOrg;

    const enabledAgents = this.readInstanceEnableList();
    const entry = enabledAgents[name];
    if (entry?.org) return entry.org;

    // Legacy fallback: scan all orgs on disk for a dir named `name`.
    // Handles enabled-agents.json entries missing the `org` field, or
    // agents that were created via raw filesystem operations.
    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (existsSync(orgsBase)) {
      try {
        const orgs = readdirSync(orgsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const org of orgs) {
          if (existsSync(join(orgsBase, org, 'agents', name))) {
            return org;
          }
        }
      } catch { /* ignore read errors */ }
    }

    // Ultimate fallback: daemon's startup org (single-org install behavior)
    return this.org;
  }

  /**
   * Start a specific agent.
   *
   * BUG-043 fix: accepts an optional `org` parameter and uses
   * `resolveAgentOrg()` to find the correct org for path/env lookups
   * instead of falling back to `this.org`. This makes the daemon
   * multi-org aware — an install with lifeos + cointally + testorg will
   * spawn each agent in its correct org dir regardless of what
   * `CTX_ORG` the daemon was started with.
   */
  /**
   * Synchronously classify a start/stop/restart request before dispatch.
   *
   * Lets the IPC handler distinguish DEDUPED (agent already in registry, so
   * a start is collapsing against an in-flight identical op — or a stop /
   * restart of an agent that was just removed) from NOT_FOUND (agent never
   * existed in the registry). The dedup logic in startAgent / stopAgent /
   * restartAgent is unchanged — this read-only check exists purely to give
   * the IPC layer enough info to set IPCResponse.code. See issue #346.
   */
  /**
   * liveness fix: true liveness for a mapped agent — presence in this.agents is
   * NOT proof of life. An entry is actually alive only if its AgentProcess
   * reports a live status AND (for a running entry) its OS pid is actually alive.
   * 'starting' is treated as alive with NO pid check: an in-flight start has not
   * spawned a pid yet, and preempting it would break the BUG-011 in-flight-restart
   * dedup. All other statuses (stopped/crashed/halted) — and 'running' with a
   * dead/absent pid — are dead and eligible for eviction.
   */
  private isAgentActuallyAlive(name: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    const { status, pid } = entry.process.getStatus();
    if (status === 'starting') return true;   // in-flight start — never evict
    if (status !== 'running') return false;   // stopped / crashed / halted => dead
    return !!pid && isPidAlive(pid);           // running => must have a live pid
  }

  /**
   * map-entry-race fix: true iff `name` still resolves to the exact instance
   * captured before an await. `this.agents.set` is the single call site in this
   * class and always stores a freshly-constructed object literal, so reference
   * identity is exact and cannot ABA (a re-registered agent is never the same
   * object as the one we captured).
   *
   * Same question AgentProcess.lifecycleGeneration answers one layer down ("is
   * this still my lifecycle?"), but compared against the object rather than a
   * counter: the caller already holds the reference across the await, so no
   * parallel counter keyed by the re-bindable name is needed.
   */
  private stillMapped(name: string, entry: AgentEntry): boolean {
    return this.agents.get(name) === entry;
  }

  inspectAgentOp(op: 'start' | 'stop' | 'restart', name: string): { ok: true } | { ok: false; code: 'DEDUPED' | 'NOT_FOUND'; message: string } {
    const inRegistry = this.agents.has(name);
    if (op === 'start') {
      // liveness fix: only DEDUP a start against a genuinely-alive entry. A
      // mapped-but-dead entry (halted/crashed/stopped, or a running entry whose
      // pid is gone) must NOT report "already running" — startAgent will evict it
      // and start fresh, so tell the caller the start is proceeding.
      if (inRegistry && this.isAgentActuallyAlive(name)) {
        return { ok: false, code: 'DEDUPED', message: `start request for "${name}" deduped — agent already in registry (in-flight start or already running)` };
      }
      return { ok: true };
    }
    // stop / restart need the agent to be present
    if (!inRegistry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${name}" not in registry — cannot ${op}` };
    }
    return { ok: true };
  }

  async startAgent(name: string, agentDir: string, config?: AgentConfig, org?: string): Promise<void> {
    if (this.agents.has(name)) {
      // BUG-031: this branch was the workaround for the BUG-011 PTY race
      // (restart-all could send stop+start simultaneously, and the new
      // start would arrive while the old stop's PTY exit was still in
      // flight). PR #11 closed BUG-011 by making `AgentProcess.stop()`
      // await the actual PTY exit before resolving.
      //
      // The idempotency fix then repurposed the queue path: the alive sub-branch
      // below distinguishes a LEGIT in-flight restart (a stopAgent() teardown is
      // genuinely in flight — stoppingAgents.has — so we queue via pendingRestarts)
      // from a pure duplicate start against a healthy agent (idempotent no-op).
      // The legit-restart case fires on every concurrent restart-all and is logged
      // at info level, NOT as a regression alarm — see the per-case comments below.
      if (this.isAgentActuallyAlive(name)) {
        // ALIVE entry: preserve the existing BUG-011/031/040 dedup/queue behavior
        // EXACTLY — this is the legitimate in-flight-restart race path.
        if (this.daemonJustCrashed) {
          // Post-crash startup. The previous daemon exited via
          // uncaughtException without running stopAll(), so the in-memory
          // registry from the prior process is gone — but the post-crash
          // discoverAndStart pass can briefly re-enter startAgent for an
          // agent whose pendingRestarts entry survived. This is benign and
          // distinct from the BUG-011 in-flight race PR #11 closed. Log at
          // info level so operators don't think PR #11 has regressed.
          console.log(`[agent-manager] ${name} already in registry (post-crash discovery overlap, expected). Queueing restart.`);
          this.pendingRestarts.add(name);
          return;
        }
        if (this.stoppingAgents.has(name)) {
          // LEGIT in-flight restart: a concurrent stopAgent() is tearing this
          // agent down but hasn't reached its final PTY-exit line yet, so the
          // entry still reads as alive. Queue the restart so stopAgent()'s honor
          // path brings the agent back — the real BUG-011/BUG-031 race path.
          //
          // Info-level, NOT a regression alarm: after the idempotency fix this
          // is the EXPECTED legit-restart race (stoppingAgents proves a teardown
          // is genuinely in flight), so it fires on every concurrent restart-all.
          // A true BUG-011 regression (start racing a stop WITHOUT a marker) does
          // NOT reach here — it falls through to the no-op path below instead.
          console.log(`[agent-manager] ${name} start raced an in-flight stop (expected legit in-flight restart) — queueing via pendingRestarts; stopAgent's honor path will bring it back.`);
          this.pendingRestarts.add(name);
          return;
        }
        // SPURIOUS pure duplicate start against a healthy agent nobody is
        // stopping. No teardown is in flight, so a queued restart would cause a
        // later spurious restart. Idempotent no-op instead — no warn, no queue.
        console.log(`[agent-manager] ${name} already running and healthy — duplicate start ignored (idempotent no-op).`);
        return;
      }
      // liveness fix: entry exists but is NOT actually alive (halted/crashed/
      // stopped, or a running entry whose OS pid is gone). Evict the stale entry
      // and fall through to a fresh start rather than stranding the agent.
      if (this.evictingAgents.has(name)) {
        // DELIBERATE EXCEPTION to the identity rule below: this set is keyed by
        // NAME on purpose. The thing being deduplicated is "spawn a PTY for this
        // name", which is a claim about the name, not about an object — so a
        // membership test is the right question here and an identity guard would
        // be the wrong one. Residual, judged acceptable: if our eviction later
        // aborts because it was superseded, a start that arrived during our
        // await was refused for nothing. The marker is cleared synchronously in
        // the `finally` on the same tick as that abort, so the stale window is
        // the eviction's own lifetime and never outlives it.
        //
        // A concurrent startAgent is already evicting+restarting this dead entry.
        // Return instead of spawning a second PTY — the in-flight eviction will
        // bring the agent up. Mirrors the alive in-flight dedup above.
        console.log(`[agent-manager] ${name} eviction already in flight — skipping duplicate start.`);
        return;
      }
      // Claimed synchronously BEFORE the eviction's `await` so a second caller
      // hits the guard above. The fresh-start path below has NO await before
      // `this.agents.set(name, ...)`, so once we release the marker and fall
      // through, the new entry is mapped before any caller can interleave.
      this.evictingAgents.add(name);
      try {
        console.log(`[agent-manager] ${name} in registry but not actually alive — evicting stale entry and starting fresh.`);
        const stale = this.agents.get(name)!;
        // Round 4 (F-B1): mark the teardown on the entry itself, BEFORE the await
        // below, exactly as stopAgent does at its own pre-await point. Eviction is
        // a teardown of `stale` and was the only teardown path that never said so.
        //
        // Without this write, a start still parked in agentProcess.start() resumes
        // after we have stopped its checker and unmapped it, reads
        // `!ownEntry.stopped` as true at the checker-start guard, and re-arms that
        // checker. Nothing can ever stop it again: every later stopAgent reaches a
        // checker only by name, and the name belongs to the newcomer — so it keeps
        // injecting into a dead PTY for the life of the daemon.
        //
        // Set here rather than next to this branch's `agents.delete(name)` because
        // the hazard is the AWAIT, not the unmapping: the parked start can resume
        // any time after `stale.process.stop()` yields, which is before the delete
        // is reached. Deferring the write to the delete leaves that sub-window open.
        //
        // Referred to by symbol, not by line number, on purpose: this very comment
        // shifted every line below it by 15, which silently falsified 41 numeric
        // references in the round-4 tests. A line number in a comment is a
        // hand-maintained index with no checker, and it rots on the next edit.
        stale.stopped = true;
        // map-entry-race fix: capture the scheduler BEFORE the await below.
        // `evictingAgents` blocks a concurrent startAgent but NOT a concurrent
        // stopAgent, so the name can be re-bound while we are parked here.
        // RULE: act unconditionally on the objects you captured; act by name
        // only while the name still resolves to you. See stillMapped().
        const staleScheduler = this.cronSchedulers.get(name);
        try { stale.poller?.stop(); } catch { /* best-effort */ }
        try { stale.activityPoller?.stop(); } catch { /* best-effort */ }
        try { stale.checker.stop(); } catch { /* best-effort */ }
        // process.stop() sets status='stopped', which neutralizes any pending
        // crash-backoff setTimeout on the old AgentProcess (its `if (status ===
        // 'crashed')` guard now fails), so no orphan PTY is spawned after eviction.
        try { await stale.process.stop(); } catch { /* best-effort */ }
        if (staleScheduler) {
          staleScheduler.stop();
          if (this.cronSchedulers.get(name) === staleScheduler) {
            this.cronSchedulers.delete(name);
            // Symmetric with stopAgent below: if a new instance took the name
            // while we were tearing down, its own startAgentCronScheduler() may
            // have been refused by the "already running" guard because OURS was
            // still mapped. Re-wire now the slot is free.
            if (!this.stillMapped(name, stale)) this.startAgentCronScheduler(name);
          }
        } else if (this.stillMapped(name, stale)) {
          // The hoisted capture above has a blind spot the post-await read it
          // replaced did not: a scheduler wired for the stale entry DURING our
          // await (startAgent's post-start wiring, or reloadCrons' lazy-create)
          // was not capturable before it. Nothing else will ever stop it — it
          // outlives the agent as a live setInterval AND blocks the fresh start
          // below from getting a scheduler at all. Safe to act by name here
          // precisely because the name still resolves to the entry we are
          // evicting, so anything under it is ours.
          const late = this.cronSchedulers.get(name);
          if (late) {
            late.stop();
            this.cronSchedulers.delete(name);
          }
        }
        // Round 3 (F3): stillMapped() is `agents.get(name) === entry`, which is
        // false BOTH when a different entry holds the name AND when nothing holds
        // it at all. Only the first case means "somebody else is starting" — the
        // second means the slot is empty and we should carry on with the fresh
        // start. Ask the has() question first so the two stop being the same
        // answer; without it we abort a start that nothing is replacing and the
        // warning below asserts a re-registration that provably did not happen.
        if (this.agents.has(name) && !this.stillMapped(name, stale)) {
          // A different instance took this name while we tore the stale one
          // down. The fresh-start path below deletes by name and then ends in an
          // UNCONDITIONAL agents.set(), either of which would orphan a live
          // agent — the exact failure this fix exists to prevent. The newcomer
          // is already starting; our work here is done. The return is inside
          // the try, so `finally` still clears the evicting marker.
          console.warn(`[agent-manager] ${name} was re-registered during eviction — aborting this start.`);
          return;
        }
        this.agents.delete(name);
        this.pendingRestarts.delete(name);
      } finally {
        this.evictingAgents.delete(name);
      }
      // fall through synchronously to the fresh-start path below
    }

    // BUG-043 fix: resolve the agent's true org instead of using `this.org`.
    const resolvedOrg = this.resolveAgentOrg(name, org);

    // Auto-discover agent directory if not provided (e.g. when started via IPC)
    if (!agentDir || !existsSync(agentDir)) {
      const discovered = join(this.frameworkRoot, 'orgs', resolvedOrg, 'agents', name);
      if (existsSync(discovered)) {
        agentDir = discovered;
      } else {
        console.error(`[agent-manager] Agent directory not found for ${name}: tried ${discovered}`);
        return;
      }
    }

    if (!config) {
      config = this.loadAgentConfig(agentDir);
    }

    // Reconcile required hooks into the agent's settings (agents spawned
    // from older templates may lack them — 2026-07-09 stall diagnosis #1).
    ensureRequiredHooks(agentDir, (msg) => console.log(`[agent-manager] ${name}: ${msg}`));

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir,
      org: resolvedOrg,
      projectRoot: this.frameworkRoot,
    };

    const paths = resolvePaths(name, this.instanceId, resolvedOrg);

    const log = (msg: string) => {
      console.log(`[${name}] ${msg}`);
    };

    // Read agent .env for Telegram credentials
    const agentEnvFile = join(agentDir, '.env');
    let telegramApi: TelegramAPI | undefined;
    let chatId: string | undefined;
    let allowedUserId: string | undefined;
    let botToken: string | undefined;

    if (existsSync(agentEnvFile)) {
      // stripBom: Windows tooling writes .env with a UTF-8 BOM that breaks
      // /^BOT_TOKEN=/m when BOT_TOKEN is on line 1 (2026-05-16 silent
      // smith-not-receiving-Telegram incident). See src/utils/strip-bom.ts.
      const envContent = stripBom(readFileSync(agentEnvFile, 'utf-8'));
      const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
      const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
      const allowedUserMatch = envContent.match(/^ALLOWED_USER=(.+)$/m);
      botToken = botTokenMatch?.[1]?.trim();
      chatId = chatIdMatch?.[1]?.trim();
      allowedUserId = allowedUserMatch?.[1]?.trim() || undefined;

      // Validate BOT_TOKEN format: must be numeric_id:alphanumeric_secret
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = undefined;
      }

      // ALLOWED_USER must be one or more numeric Telegram user IDs.
      // Comma-separated for multi-user (e.g. group chats with Sam + a collaborator).
      // Whitespace tolerated; any non-numeric token rejects the whole list.
      if (allowedUserId) {
        const ids = allowedUserId.split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) {
          log(`SECURITY: ALLOWED_USER must be a comma-separated list of numeric Telegram user IDs (e.g. 123456789,987654321). Refusing to enable Telegram. Fix the .env file.`);
          allowedUserId = undefined;
        } else {
          // Normalize to comma-joined form so downstream gate splits on it
          allowedUserId = ids.join(',');
        }
      }

      // Security: ALLOWED_USER is REQUIRED when BOT_TOKEN is set. Without it,
      // ANY Telegram user who finds the bot @handle could control the agent.
      // Fail closed: refuse to start Telegram unless the operator explicitly
      // whitelists their numeric user ID.
      if (botToken && !allowedUserId) {
        log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
        if (chatId) {
          const alertApi = new TelegramAPI(botToken);
          alertApi.sendMessage(chatId,
            `⚠️ WATCHDOG: ${name} has BOT_TOKEN but ALLOWED_USER is missing or malformed in .env. Telegram is DISABLED for this agent. Fix ALLOWED_USER and restart.`,
          ).catch(() => {});
        }
        botToken = undefined;
      }

      if (botToken && chatId) {
        telegramApi = new TelegramAPI(botToken);
        // Don't log sensitive user IDs — just indicate the gate is enabled
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
      }
    }

    const agentProcess = new AgentProcess(name, env, config, log);
    // Issue #330: pass the Telegram handle into AgentProcess so CodexAppServerPTY
    // can emit sendChatAction directly from the JSONL stream. Has no effect for
    // claude-code / hermes runtimes — those still use fast-checker.
    if (telegramApi && chatId) {
      agentProcess.setTelegramHandle(telegramApi, chatId);
    }
    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      // FastChecker only needs the first ID for its single-recipient typing
      // indicator / quick-checks. Multi-user is enforced by the gates above.
      allowedUserId: allowedUserId ? parseInt(allowedUserId.split(',')[0].trim(), 10) : undefined,
    });

    // Send Telegram notification on crashes and session refreshes
    if (telegramApi && chatId) {
      const tgApi = telegramApi;
      const tgChatId = chatId;
      let prevStatus: string | null = null;
      agentProcess.onStatusChanged((status) => {
        if (status.status === 'crashed') {
          const crashNum = status.crashCount ?? '?';
          tgApi.sendMessage(tgChatId, `Agent ${name} crashed (crash #${crashNum}) — auto-restarting`).catch(() => {});
        } else if (status.status === 'halted') {
          tgApi.sendMessage(tgChatId, `Agent ${name} HALTED — exceeded crash limit. Restart manually with: cortextos start ${name}`).catch(() => {});
        } else if (status.status === 'running' && prevStatus === 'crashed') {
          tgApi.sendMessage(tgChatId, `Agent ${name} recovered and is back online`).catch(() => {});
        }
        prevStatus = status.status;
      });
    }

    // map-entry-race fix: hold our own entry reference. Everything below runs
    // after at least one await, so looking the entry back up by name can return
    // a DIFFERENT instance's entry — attaching our poller to it would break that
    // entry's teardown and guarantee ours leaks.
    const ownEntry: AgentEntry = { process: agentProcess, checker };
    this.agents.set(name, ownEntry);

    // Start agent
    await agentProcess.start();

    // Subtask 2.2: Auto-migrate crons from config.json → crons.json before
    // starting the scheduler, so the scheduler always has a populated crons.json
    // to read from.  The migration is idempotent (marker file prevents re-runs).
    const configJsonPath = join(agentDir, 'config.json');
    migrateCronsForAgent(name, configJsonPath, this.ctxRoot, {
      log: (msg) => log(`[migration] ${msg}`),
    });

    // Wire daemon-level CronScheduler for this agent.
    // The scheduler reads crons.json, fires crons, and injects prompts into
    // the agent PTY via injectAgent().  This is the Phase 2 daemon-managed
    // external cron system — agents no longer need to call CronCreate on boot.
    //
    // map-entry-race fix: everything from here down runs AFTER
    // `await agentProcess.start()`, so the name may have been re-bound while we
    // were parked. Two distinct hazards, one guard each:
    if (this.stillMapped(name, ownEntry)) {
      const existing = this.cronSchedulers.get(name);
      if (existing) {
        // (a) A predecessor's supersede-re-wire installed a scheduler under our
        // name while we were parked. It read crons.json BEFORE
        // migrateCronsForAgent above wrote it, so it holds ZERO crons — and
        // startAgentCronScheduler's "already running — skipped" guard would
        // leave it that way DURABLY: tick() never reloads, and reload() is
        // otherwise only reachable over IPC. Refresh it instead of skipping.
        existing.reload();
      } else {
        this.startAgentCronScheduler(name);
      }
    }
    // (b) If we are NOT still mapped we were stopped or superseded mid-start.
    // Wiring a scheduler here would install OURS under the newcomer's name,
    // where its "already running" guard then denies the newcomer its own.

    // Start fast checker in background.
    // Round 3 (F2): same identity question as the scheduler block above, which
    // this originally did not ask. stopAgent calls entry.checker.stop() BEFORE
    // its await, so a start parked in agentProcess.start() would resume here and
    // re-arm a checker that was already torn down. It can never be stopped again:
    // stopAgent reaches a checker only through a by-name lookup, and by then the
    // name belongs to somebody else — so it would keep injecting into the PTY the
    // operator asked to stop for the life of the daemon.
    // Guarded on OUR teardown rather than on map identity: a start that was merely
    // superseded still owns a live process that needs its checker.
    if (!ownEntry.stopped) {
      checker.start().catch(err => {
        console.error(`[${name}] Fast checker error:`, err);
      });
    }

    // Register Telegram slash commands at startup (fix for issue #1)
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === 'ok') {
          log(`Telegram commands registered (${result.count} commands)`);
        } else if (result.status !== 'empty') {
          // Surface failures instead of swallowing them silently: a failed
          // registration means the agent's slash menu is missing until the next
          // restart, so operators need to see it (non-fatal to agent startup).
          log(`Telegram command registration failed after retries: ${result.error}`);
        }
      }).catch((err) => {
        log(`Telegram command registration error: ${String(err)}`);
      });
    }

    // Start Telegram poller if credentials are available and not explicitly disabled.
    // Set telegram_polling: false in config.json to prevent a specialist agent from
    // running its own poller (only the designated orchestrator agent should poll).
    if (telegramApi && chatId && config.telegram_polling !== false) {
      const stateDir = join(this.ctxRoot, 'state', name);
      const poller = new TelegramPoller(telegramApi, stateDir);

      const REJECT_ALERT_THRESHOLD = 3;
      const REJECT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

      poller.onMessage((msg) => {
        // ALLOWED_USER gate: comma-separated list of numeric user IDs.
        // If configured, ignore messages from other users. Always log the
        // rejected user_id + name so operators can discover IDs to whitelist.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = msg.from?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            const rejectedFrom = msg.from?.first_name || msg.from?.username || 'unknown';
            log(`Ignoring message from unauthorized user (allowed_user gate): from=${fromId} (${rejectedFrom})`);
            // #459 reject-count watchdog: alert after N consecutive rejects (multi-user gate from #467 preserved).
            // map-entry-race fix: count on OUR entry. A by-name lookup here
            // credits the reject to whichever instance holds the name now, which
            // both corrupts the successor's counter and loses ours.
            // Round 3 (F5): guard on IDENTITY, not on truthiness. This block used
            // to read `const entry = this.agents.get(name); if (entry) {`, and that
            // `if` was doing real work: it skipped whenever the name was unmapped.
            // `ownEntry` is an object literal and is NEVER falsy, so replacing the
            // lookup with it silently made the block unconditional — a stranger
            // reject arriving in an in-flight getUpdates batch after teardown would
            // then fire a WATCHDOG Telegram on behalf of a stopped agent.
            // The predicate is OUR TEARDOWN, not map identity. stillMapped would
            // ALSO skip when we are still running and merely superseded — but a
            // reject arriving on our own poller is genuinely ours then, and
            // dropping it silently disables the ALLOWED_USER watchdog for a live
            // agent (T13/T14 pin exactly that). `stopped` separates the two.
            const entry = ownEntry;
            if (!ownEntry.stopped) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram messages (ALLOWED_USER gate). Last from_id: ${fromId ?? 'unknown'}. Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        // Message passed ALLOWED_USER gate — reset rejection counter.
        // map-entry-race fix: reset OUR counter, not the current name-holder's.
        ownEntry.telegramRejectCount = 0;

        const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
        const msgChatId = msg.chat?.id;
        const effectiveChatId = msgChatId ?? chatId ?? '';
        const stateDir = join(this.ctxRoot, 'state', name);

        // Persist the inbound message to JSONL AND emit a
        // `message/telegram_received` bus event in one helper so
        // experiment cycles and dashboards can count inbound traffic.
        // Without the event, Rubi's v3 fleet measurement found 0
        // inbound messages on a window where Eros replied to multiple
        // agents — the JSONL had the data but it never reached the
        // event log.
        recordInboundTelegram(paths, this.ctxRoot, name, resolvedOrg, from, msg, log);

        // Check for media messages (photo, document, voice, audio, video, video_note)
        const isMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
        const replyToText = buildReplyContext(msg.reply_to_message);

        if (isMedia && telegramApi) {
          const downloadDir = join(agentDir, 'telegram-images');
          processMediaMessage(msg, telegramApi, downloadDir).then((media) => {
            if (!media) {
              log('Media processing returned null - falling back to text format');
              const text = stripControlChars(msg.caption || '');
              const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, replyToText);
              if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
              return;
            }

            // BUG-046: Convert absolute paths to relative (from agent working dir).
            // Claude Code strips absolute paths from pasted user input, so the
            // agent never sees them. Relative paths survive injection.
            // BUG-049: Use the agent's actual launch cwd (config.working_directory
            // if set, else agentDir) so the path resolves when Read() is invoked.
            const launchDir = config?.working_directory || agentDir;
            const toRel = (p: string | undefined) => p ? relative(launchDir, p) : '';
            const relImagePath = toRel(media.image_path);
            const relFilePath = toRel(media.file_path);

            log(`[DEBUG] media.type=${media.type} image_path=${JSON.stringify(relImagePath)} file_path=${JSON.stringify(relFilePath)}`);
            let formatted: string;
            if (media.type === 'photo') {
              formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath, replyToText);
            } else if (media.type === 'document') {
              formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name!, replyToText);
            } else if (media.type === 'voice' || media.type === 'audio') {
              formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration, media.transcript, replyToText);
            } else {
              // video or video_note
              formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || '', media.duration, replyToText);
            }

            if (checker.isDuplicate(formatted)) {
              log('Duplicate Telegram media message suppressed');
              return;
            }
            log(`Media message received: type=${media.type}, path=${media.image_path || media.file_path}`);
            checker.queueTelegramMessage(formatted);
          }).catch((err) => {
            log(`Media processing error: ${err} - falling back to text format`);
            const text = stripControlChars(msg.caption || '');
            const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, replyToText);
            if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
          });
          return;
        }

        // Text message (non-media)
        const text = stripControlChars(msg.text || '');
        const lastSent = FastChecker.readLastSent(stateDir, effectiveChatId);

        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6) ?? undefined;
        const formatted = FastChecker.formatTelegramTextMessage(
          from,
          effectiveChatId,
          text,
          this.frameworkRoot,
          replyToText,
          lastSent ?? undefined,
          recentHistory,
        );

        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram message suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      poller.onCallback((query) => {
        // Route to fast-checker for hook response handling (perm_allow/deny, askopt, etc.)
        // handleCallback writes hook-response files and edits Telegram messages
        checker.handleCallback(query).catch(err => {
          log(`Callback handling error: ${err}`);
        });
      });

      poller.onReaction((reaction) => {
        // ALLOWED_USER gate: same multi-user rule as message handler.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = reaction.user?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            log(`Ignoring reaction from unauthorized user (allowed_user gate): from=${fromId}`);
            // #459 reject-count watchdog (multi-user gate from #467 preserved).
            // map-entry-race fix: count on OUR entry — see the message handler.
            // Round 3 (F5): guard on IDENTITY, not on truthiness. This block used
            // to read `const entry = this.agents.get(name); if (entry) {`, and that
            // `if` was doing real work: it skipped whenever the name was unmapped.
            // `ownEntry` is an object literal and is NEVER falsy, so replacing the
            // lookup with it silently made the block unconditional — a stranger
            // reject arriving in an in-flight getUpdates batch after teardown would
            // then fire a WATCHDOG Telegram on behalf of a stopped agent.
            // The predicate is OUR TEARDOWN, not map identity. stillMapped would
            // ALSO skip when we are still running and merely superseded — but a
            // reject arriving on our own poller is genuinely ours then, and
            // dropping it silently disables the ALLOWED_USER watchdog for a live
            // agent (T13/T14 pin exactly that). `stopped` separates the two.
            const entry = ownEntry;
            if (!ownEntry.stopped) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram interactions (ALLOWED_USER gate). Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        // map-entry-race fix: reset OUR counter, not the current name-holder's.
        ownEntry.telegramRejectCount = 0;

        const from = stripControlChars(reaction.user?.first_name || reaction.user?.username || 'Unknown');
        const reactionChatId = reaction.chat?.id ?? chatId ?? '';
        const formatted = FastChecker.formatTelegramReaction(
          from,
          reactionChatId,
          reaction.message_id,
          reaction.old_reaction ?? [],
          reaction.new_reaction ?? [],
        );
        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram reaction suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      // Wrap poller.start() in a restart-on-Conflict loop. The poller's
      // internal Conflict-self-die (see TelegramPoller.start) yields the
      // Telegram getUpdates lock when a duplicate poller is detected — but
      // without a restart layer above, the agent loses Telegram input
      // permanently. After a daemon crash, the old getUpdates connections
      // can hold the lock for ~60s in Telegram's cloud, so this loop
      // sleeps and retries on 'conflict-self-die' until the lock clears.
      // Intentional stops (stopAgent → poller.stop()) set
      // lastExitReason='stopped-externally' and exit the loop cleanly.
      const startPrimaryPollerWithRestart = async () => {
        // 5min hard cap measured against CONSECUTIVE Conflict failures,
        // not total wrapper lifetime. A long-running successful poll
        // (>1min) resets the counter — without this reset, a poller that
        // runs cleanly for hours and then hits a single Conflict would
        // give up immediately because total runtime already exceeds 5min.
        const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
        const LONG_RUN_RESET_MS = 60_000;
        let consecutiveConflictStart: number | null = null;
        while (true) {
          // map-entry-race fix: IDENTITY, not presence. `agents.has(name)` asks
          // "is anyone mapped under this name", and after round 1's guards the
          // answer is deliberately YES when a NEW instance has superseded us —
          // so a presence check reads TRUE for an object that is not ours and we
          // restart a poller that was already torn down. TelegramPoller.start()
          // has no re-entry guard (`this.running = true` is its first statement,
          // unconditional), so that restart really does produce a live poll
          // loop; two loops on one bot token is the 409 Conflict churn this
          // whole change exists to prevent.
          //
          // Pre-fix, stopAgent's UNCONDITIONAL `agents.delete(name)` killed this
          // wrapper as an accidental side effect. That delete was wrong AND
          // load-bearing: fixing it removed the protection, turning "both die"
          // into "the old one comes back".
          //
          // lastExitReason cannot cover this: start() blanks it (poller.ts:90),
          // so a stop() that lands while we are parked in the sleep below leaves
          // no trace by the time we look.
          if (!this.stillMapped(name, ownEntry)) return;
          const runStart = Date.now();
          try {
            await poller.start();
          } catch (err) {
            log(`Telegram poller threw (will not restart): ${err}`);
            return;
          }
          const runDuration = Date.now() - runStart;
          if (poller.lastExitReason === 'stopped-externally') return;
          if (!this.stillMapped(name, ownEntry)) return;
          // A poll session that ran for >LONG_RUN_RESET_MS proves the
          // Conflict lock is no longer chronic — reset the retry budget.
          if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
          if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
          if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
            log(`Telegram poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up. Inspect for duplicate bot instance.`);
            return;
          }
          log(`Telegram poller for ${name} exited (${poller.lastExitReason}). Sleeping 30s then restarting to retake getUpdates lock.`);
          await new Promise(r => setTimeout(r, 30_000));
        }
      };
      startPrimaryPollerWithRestart().catch(err => {
        log(`Telegram poller wrapper crashed: ${err}`);
        // Best-effort operator alert via the agent's own bot. The wrapper
        // crashing is rare (the only catchable path is a throw from
        // poller.start() before its own try/catch), but when it happens the
        // agent silently loses Telegram input — exactly the failure class
        // the 2026-05-16 audit flagged. Surface it to the operator chat so
        // they see "X poller crashed" instead of mysterious silence.
        if (telegramApi && chatId) {
          telegramApi.sendMessage(
            String(chatId),
            `${name}: Telegram poller wrapper crashed. Inbound messages may be dropped until restart. Check daemon log.`,
          ).catch(() => { /* swallow alert failure; original log already captured */ });
        }
      });

      // Store poller reference so stopAgent() can clean it up. Assigned to the
      // entry we created, never to whatever the name resolves to now.
      ownEntry.poller = poller;

      log('Telegram poller started (with Conflict-restart wrapper)');

      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      // Round 3 (F1): resolvedOrg, NOT the raw `org` parameter. Only
      // discoverAndStart passes an org; restartAgent, the pendingRestarts honor
      // path and ipc-server's start-agent handler all pass none, and
      // maybeStartActivityChannelPoller returns immediately on a falsy org — so
      // every restart silently dropped the orchestrator's approval-button path,
      // with stopAgent seeing activityPoller undefined and nothing reporting it.
      await this.maybeStartActivityChannelPoller(name, resolvedOrg, agentDir, log, ownEntry);
    }

    // Buzz (Nostr/NIP-29) registration + org-level relay start. Every agent
    // with a buzz.json registers into the org's shared dispatcher (even if
    // this agent isn't the orchestrator); only the orchestrator opens the
    // actual relay connection. Non-blocking by construction — both the
    // dispatcher registration and the relay start below are wrapped so a
    // Buzz misconfiguration or outage can never block agent/orchestrator
    // startup.
    try {
      await this.maybeRegisterBuzzAgent(name, org, agentDir, log);
    } catch (err) {
      log(`Buzz registration failed (non-fatal): ${err}`);
    }

    // Slack Socket Mode. Deliberately OUTSIDE the Telegram gate above —
    // Slack must work for an agent that has no Telegram config at all
    // (a Slack-only agent). Same "only the orchestrator starts the shared
    // connection" shape as maybeStartActivityChannelPoller, for the same
    // reason: Slack is one app per workspace (a shared SLACK_BOT_TOKEN /
    // SLACK_APP_TOKEN), not one bot per agent like Telegram, so there must
    // be exactly one Socket Mode connection for the whole org, not one per
    // agent.
    await this.maybeStartSlackSocketMode(name, org, log);
  }

  /**
   * If this agent is the org's orchestrator AND the org has SLACK_APP_TOKEN
   * (and SLACK_BOT_TOKEN) configured, start the one shared
   * SlackSocketModeClient for the whole daemon and wire its inbound events
   * through dispatchSlackMessage() to every agent whose slack.json allows
   * the channel+user. Safe no-op otherwise (non-orchestrator agent, or the
   * tokens absent — Slack inbound is simply not configured yet).
   *
   * Failure isolation is deliberate and load-bearing: a Slack Socket Mode
   * failure (a runtime that predates the Node 22 WebSocket global, an
   * unreachable Slack API, anything unexpected) must degrade to "Slack
   * inactive," never take down orchestrator startup — startAgent() awaits
   * this method for every agent, so an uncaught throw here would block the
   * orchestrator itself from starting. Mirrors
   * maybeStartActivityChannelPoller's failure-isolation contract exactly.
   */
  private async maybeStartSlackSocketMode(
    name: string,
    org: string | undefined,
    log: LogFn,
  ): Promise<void> {
    if (!org) return;
    if (this.slackSocketStarted) return; // already running for this daemon process

    const orgDir = join(this.frameworkRoot, 'orgs', org);
    let orchestratorName: string | undefined;
    try {
      const contextJson = stripBom(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return; // No context.json or unreadable — skip
    }
    if (!orchestratorName || orchestratorName !== name) return;

    const appToken = process.env.SLACK_APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!appToken || !botToken) return; // Slack inbound not configured — normal state

    this.slackSocketStarted = true;
    const slackApi = new SlackAPI(botToken);
    const resolveUserName = makeUserNameResolver((userId) => slackApi.getUserInfo(userId));
    const client = new SlackSocketModeClient(appToken, { log: (msg) => log(`[slack-socket-mode] ${msg}`) });

    client.onMessage((event) => {
      const targets: DispatchTarget[] = Array.from(this.agents.entries()).map(([n, entry]) => ({
        name: n,
        checker: entry.checker,
      }));
      dispatchSlackMessage(event, targets, this.frameworkRoot, org, resolveUserName)
        .then((result) => {
          if (result.delivered.length > 0) {
            log(`[slack-socket-mode] delivered to: ${result.delivered.join(', ')}`);
          }
        })
        .catch((err) => log(`[slack-socket-mode] dispatch error: ${err}`));
    });

    try {
      await client.start();
      this.slackSocketClient = client;
      log('Slack Socket Mode connected (org-level, orchestrator-owned)');
    } catch (err) {
      this.slackSocketStarted = false; // allow a future startAgent() call (e.g. a restart) to retry
      log(`Slack Socket Mode failed to start (Slack inactive, agent startup unaffected): ${err}`);
    }
  }

  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramPoller bound
   * to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
   * handleActivityCallback. Safe no-op in every other case — if the
   * context.json is missing/corrupt, the orchestrator field is empty,
   * this agent is not the orchestrator, or the activity-channel.env
   * is absent/unreadable/missing credentials, this method returns
   * without starting anything.
   */
  private async maybeStartActivityChannelPoller(
    name: string,
    org: string | undefined,
    agentDir: string,
    log: LogFn,
    // map-entry-race fix: the caller's own entry, passed in rather than looked
    // up by name after the awaits in here. See the ownEntry comment in startAgent().
    ownEntry: AgentEntry,
  ): Promise<void> {
    if (!org) {
      // Observability, added with the F1 fix: this return used to be silent, and a
      // silent return is why F1 survived. The poller's SUCCESS path logs, so its
      // absence in the log was real evidence — but with no line here there was
      // nothing to distinguish "not the orchestrator" from "org never arrived",
      // and an approval button that goes nowhere looks exactly like an approval
      // nobody pressed.
      log('Activity-channel poller skipped: no org resolved for this agent');
      return;
    }
    const orgDir = join(this.frameworkRoot, 'orgs', org);

    // Only the org's orchestrator runs the activity-channel poller.
    let orchestratorName: string | undefined;
    try {
      // stripBom: see src/utils/strip-bom.ts for incident context.
      const contextJson = stripBom(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return; // No context.json or unreadable — skip
    }
    if (!orchestratorName || orchestratorName !== name) return;

    // Parse activity-channel.env for the separate bot token + chat id.
    const activityEnvPath = join(orgDir, 'activity-channel.env');
    let activityBotToken: string | undefined;
    let activityChatId: string | undefined;
    try {
      // stripBom + CRLF-aware split: Windows tooling writes activity-channel.env
      // with BOM + CRLF. Without these, ACTIVITY_BOT_TOKEN never resolves
      // and the activity-channel poller silently never starts.
      const content = stripBom(readFileSync(activityEnvPath, 'utf-8'));
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === 'ACTIVITY_BOT_TOKEN') activityBotToken = value;
        if (key === 'ACTIVITY_CHAT_ID') activityChatId = value;
      }
    } catch {
      return; // activity-channel.env absent — silent no-op
    }

    if (!activityBotToken || !activityChatId) {
      log('Activity-channel env present but missing BOT_TOKEN or CHAT_ID — skipping poller');
      return;
    }

    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = join(this.ctxRoot, 'state', name);
    // offsetFileSuffix keeps the activity poller's offset file distinct
    // from the primary bot's .telegram-offset — without this they would
    // clobber each other in the same stateDir.
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1000, 'activity');

    activityPoller.onCallback((query) => {
      // map-entry-race fix: this poller belongs to ownEntry, so its callbacks
      // serve ownEntry's checker. A by-name lookup would route an approval
      // button-press into whichever instance holds the name now. The wrapper
      // above stops this poller as soon as ownEntry is unmapped, so the only
      // window this closes is an in-flight getUpdates batch.
      ownEntry.checker.handleActivityCallback(query, activityApi).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    });

    // Best-effort message logger — activity channel is primarily outbound
    // but any inbound chatter (broadcasts, user DMs, etc.) gets logged
    // so operators can see what is flowing. No PTY injection.
    activityPoller.onMessage((msg) => {
      const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
      const text = stripControlChars(msg.text || msg.caption || '');
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    });

    // Same Conflict-restart wrapper as the primary poller — activity
    // channel can lose its getUpdates lock after a daemon crash too.
    // 5min retry budget measured against CONSECUTIVE failures; resets
    // after a >1min successful run. See primary poller wrapper for rationale.
    const startActivityPollerWithRestart = async () => {
      const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
      const LONG_RUN_RESET_MS = 60_000;
      let consecutiveConflictStart: number | null = null;
      while (true) {
        // map-entry-race fix: identity, not presence — see the primary poller's
        // wrapper for the full reasoning. Same defect, same remedy.
        if (!this.stillMapped(name, ownEntry)) return;
        const runStart = Date.now();
        try {
          await activityPoller.start();
        } catch (err) {
          log(`Activity-channel poller threw (will not restart): ${err}`);
          return;
        }
        const runDuration = Date.now() - runStart;
        if (activityPoller.lastExitReason === 'stopped-externally') return;
        if (!this.stillMapped(name, ownEntry)) return;
        if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
        if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
        if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
          log(`Activity-channel poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up.`);
          return;
        }
        log(`Activity-channel poller for ${name} exited (${activityPoller.lastExitReason}). Sleeping 30s then restarting.`);
        await new Promise(r => setTimeout(r, 30_000));
      }
    };
    startActivityPollerWithRestart().catch((err) => {
      log(`Activity-channel poller wrapper crashed: ${err}`);
    });

    ownEntry.activityPoller = activityPoller;

    log(`Activity-channel poller started (chat ${activityChatId}, with Conflict-restart wrapper)`);
  }

  /**
   * Ensures this org has a running Buzz relay client (started once, by the
   * orchestrator only) and registers this agent's buzz.json into that org's
   * shared BuzzDispatcher — mirrors maybeStartActivityChannelPoller's
   * "org.json says who the orchestrator is, only it starts the shared
   * connection" gate, but every agent (not just the orchestrator) still
   * needs to register itself so the dispatcher knows to route messages to
   * it. Safe no-op if the agent has no buzz.json, org is unset, or
   * context.json is missing/corrupt.
   */
  private async maybeRegisterBuzzAgent(
    name: string,
    org: string | undefined,
    agentDir: string,
    log: LogFn,
  ): Promise<void> {
    if (!org) return;
    const buzzConfig = loadBuzzConfig(agentDir);
    if (!buzzConfig) return; // no buzz.json / no BUZZ_PRIVATE_KEY — Buzz disabled for this agent

    let entry = this.buzzClients.get(org);
    if (!entry) {
      const relayUrl = buzzConfig.relay_url || process.env.BUZZ_RELAY_URL;
      if (!relayUrl) {
        log('Buzz configured but no relay_url (buzz.json or BUZZ_RELAY_URL) — skipping');
        return;
      }
      const dispatcher = new BuzzDispatcher();
      const client = new BuzzRelayClient(relayUrl, buzzConfig.secret_key, (msg) => log(`[buzz] ${msg}`));
      client.onMessage((channelId, event: NostrEvent) => {
        const results = dispatcher.dispatch(channelId, event);
        for (const result of results) {
          const target = this.agents.get(result.agentName);
          if (!target) continue;
          const formatted = FastChecker.formatBuzzTextMessage(event.pubkey, channelId, event.content);
          target.checker.queueBuzzMessage(formatted);
        }
      });
      entry = { client, dispatcher, started: false };
      this.buzzClients.set(org, entry);
    }

    // Only the org's orchestrator opens the actual relay connection — same
    // gate as the activity-channel poller. Checked on every call (not just
    // entry creation) so a non-orchestrator registering first does not
    // permanently prevent the orchestrator from later starting the shared
    // connection once it also registers.
    if (!entry.started) {
      const orgDir = join(this.frameworkRoot, 'orgs', org);
      let orchestratorName: string | undefined;
      try {
        const contextJson = stripBom(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
        orchestratorName = JSON.parse(contextJson).orchestrator;
      } catch {
        // No context.json — fall back to "whichever agent registers first
        // starts the connection" rather than never starting it at all.
      }
      if (!orchestratorName || orchestratorName === name) {
        entry.started = true;
        try {
          entry.client.start().catch((err) => {
            log(`Buzz relay client wrapper crashed (non-fatal): ${err}`);
          });
        } catch (err) {
          log(`Buzz relay client failed to start (non-fatal): ${err}`);
        }
      }
    }

    entry.dispatcher.register(name, buzzConfig);
    entry.client.subscribeChannels(entry.dispatcher.allChannels());
    log(`Buzz registered for org ${org} (channels: ${buzzConfig.channels.join(', ') || 'none'})`);
  }

  /**
   * Stop a specific agent.
   */
  async stopAgent(name: string, userInitiated = false): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }

    // idempotency fix (#923): claim the name synchronously BEFORE the first await
    // (entry.process.stop() below) so a startAgent() racing this teardown sees
    // the marker and queues via pendingRestarts instead of taking the no-op
    // path. finally (NOT catch) so a throw from process.stop() still propagates
    // to callers while the marker is always released.
    this.stoppingAgents.add(name);
    try {
      // map-entry-race fix (#895): capture every name-keyed resource we own
      // BEFORE the await below. entry.process.stop() yields for up to ~21s
      // (BUG-032's graceful /exit dance plus BUG-040's 15s exit wait), and a NEW
      // instance can be registered under this same name inside that window
      // (startAgent's eviction path, or a fire-and-forget IPC start —
      // ipc-server.ts never awaits startAgent/stopAgent/restartAgent). After the
      // await, `name` is no longer a reliable handle to us.
      // RULE: act unconditionally on the objects you captured; act by name only
      // while the name still resolves to you. See stillMapped().
      const scheduler = this.cronSchedulers.get(name);

      // Round 3 (F5/F2): mark the teardown BEFORE it starts, not after it
      // finishes. A poller's stop() cannot recall a getUpdates batch that is
      // already open, and process.stop() yields for up to ~21s — so callbacks and
      // a parked startAgent both land DURING the teardown, which is exactly when
      // they must not act.
      entry.stopped = true;

      if (entry.poller) entry.poller.stop();
      if (entry.activityPoller) entry.activityPoller.stop();
      // Unregister from every org's Buzz dispatcher — harmless no-op for orgs
      // this agent was never registered in. We don't track which org this
      // agent belongs to on the entry itself, so this sweeps all of them
      // rather than requiring an extra lookup.
      for (const buzzEntry of this.buzzClients.values()) {
        buzzEntry.dispatcher.unregister(name);
      }
      entry.checker.stop();
      await entry.process.stop();

      // Our scheduler object: stopping it is always correct (the interval is
      // ours, and skipping it leaks a setInterval forever). Unmapping it is only
      // correct while the name still points at it.
      if (!scheduler && this.stillMapped(name, entry)) {
        // The capture above has a blind spot the post-await read it replaced did
        // not: a scheduler wired for US during the await (startAgent's post-start
        // wiring at the `startAgentCronScheduler` call below, or reloadCrons'
        // lazy-create) did not exist when we captured. Nothing else ever stops it
        // — it outlives the agent as a live setInterval whose onFire injects into
        // a name that is gone, AND it makes the next start's scheduler request hit
        // the "already running — skipped" guard, so the replacement inherits a
        // dead scheduler. Acting by name is safe here BECAUSE the name still
        // resolves to us, so whatever is under it is ours.
        const late = this.cronSchedulers.get(name);
        if (late) {
          late.stop();
          this.cronSchedulers.delete(name);
        }
      }

      if (scheduler) {
        scheduler.stop();
        if (this.cronSchedulers.get(name) === scheduler) {
          this.cronSchedulers.delete(name);
          // If a new instance took the name while we were stopping, it may have
          // been refused a scheduler by startAgentCronScheduler's "already
          // running" guard because OURS was still mapped. Re-wire now the slot is
          // free — otherwise the new agent runs with no crons at all. Calling a
          // start-path helper from the stop path is deliberate: the method is
          // idempotent and map-driven, and this is the only moment at which the
          // newcomer's missing scheduler is detectable.
          if (!this.stillMapped(name, entry)) this.startAgentCronScheduler(name);
        }
      }

      // Round 3 (F4): same conflation as the eviction path — see the F3 comment in
      // startAgent(). Reachable here via two concurrent stops for one name (ipc-server
      // never awaits stopAgent): the first to finish deletes the name, and the second
      // then took this branch, warned about a re-registration that never happened, and
      // returned BEFORE the pendingRestarts handling below — stranding a queued restart
      // that later fires against an unrelated stop.
      if (this.agents.has(name) && !this.stillMapped(name, entry)) {
        // Superseded: our instance is fully torn down, but the name belongs to
        // someone else now. Deleting it here would empty the map slot while the
        // new agent keeps running — an untracked orphan. pendingRestarts is
        // deliberately left alone: the queue refers to whoever is mapped. The
        // finally below still releases stoppingAgents.
        console.warn(`[agent-manager] ${name} was re-registered while stopping — old instance fully torn down, new instance left mapped.`);
        return;
      }

      this.agents.delete(name);

      // disable-resurrection fix: an explicit user stop/disable must win against a
      // racing queued restart. Drop the pending entry instead of honoring it.
      // Internal callers (restartAgent, stopAll) pass userInitiated=false, so the
      // BUG-011/BUG-031 restart-all honor path below is preserved unchanged.
      if (userInitiated) {
        if (this.pendingRestarts.delete(name)) {
          console.log(`[agent-manager] Dropped queued restart for ${name} — explicit user stop/disable wins.`);
        }
        return;
      }

      // BUG-031: honor any restart that was queued while we were stopping.
      // After the idempotency fix `pendingRestarts` is a NORMAL control-flow
      // signal, not a BUG-011 canary. Writers enumeration (both `pendingRestarts.add`
      // sites in this file): (1) startAgent's post-crash branch — guarded by
      // daemonJustCrashed=true; (2) startAgent's stoppingAgents.has branch — the
      // legit in-flight restart. So reaching this honor branch with
      // daemonJustCrashed=false means writer (2): the EXPECTED legit-restart race.
      // Both cases are info-level; neither is a regression, so honoring is normal.
      if (this.pendingRestarts.has(name)) {
        if (this.daemonJustCrashed) {
          console.log(`[agent-manager] pendingRestarts fired for ${name} (post-crash safety net, expected). Honoring queued restart.`);
        } else {
          console.log(`[agent-manager] pendingRestarts fired for ${name} (expected legit in-flight-restart race). Honoring queued restart.`);
        }
        this.pendingRestarts.delete(name);
        console.log(`[agent-manager] Honoring queued restart for ${name}`);
        this.startAgent(name, '').catch(err =>
          console.error(`[agent-manager] Queued restart failed for ${name}:`, err),
        );
      }
    } finally {
      this.stoppingAgents.delete(name);
    }
  }

  /**
   * Restart a specific agent.
   *
   * Delegates to stopAgent + startAgent to guarantee a full teardown and
   * rebuild of every per-agent resource: AgentProcess, FastChecker, TelegramAPI,
   * TelegramPoller, crash callback, and slash-command registration. Fresh
   * credentials are re-read from {agentDir}/.env on each restart.
   *
   * agentDir is auto-discovered by startAgent() from frameworkRoot/orgs/{org}/agents/{name}.
   * Participates in the pendingRestarts race protection used by restart-all.
   */
  async restartAgent(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found — cannot restart`);
      return;
    }
    console.log(`[agent-manager] Restarting ${name}`);
    await this.stopAgent(name);
    // map-entry-race fix: a normal stop leaves the name UNBOUND, so the test is
    // "did somebody else bind it", not stillMapped(). If a new instance took the
    // name while we were stopping, stopAgent correctly left it mapped and
    // returned early — starting by name here would find that live entry, emit
    // the "BUG-011 REGRESSION CHECK" warning on a race that is now handled BY
    // DESIGN (a false alarm on a warning operators are trained to treat as
    // serious), and leave a pendingRestarts entry that fires a spurious restart
    // on the newcomer's next stop.
    const successor = this.agents.get(name);
    if (successor !== undefined && successor !== entry) {
      console.log(`[agent-manager] ${name} was re-registered while restarting — a new instance already holds the name, skipping the start.`);
      return;
    }
    await this.startAgent(name, '');
    console.log(`[agent-manager] Restart complete for ${name}`);
  }

  /**
   * Stop all agents.
   *
   * BUG-034 partial fix: writes a `.daemon-stop` marker file in each agent's
   * state dir BEFORE stopping it. The SessionEnd crash-alert hook
   * (src/hooks/hook-crash-alert.ts) reads this marker and reports a clean
   * `🛑 daemon shutdown` notification instead of a false `🚨 CRASH` alarm.
   * Without this, every `pm2 restart cortextos-daemon` (or `pm2 stop`)
   * generates a false crash alarm per agent — trust-destroying.
   *
   * Pattern matches src/cli/bus.ts:1283-1289 and PR #12 (BUG-036). Markers
   * are written synchronously before the async stop loop starts, so by the
   * time `pty.kill()` runs, every agent already has its marker on disk.
   */
  async stopAll(): Promise<void> {
    this.slackSocketClient?.stop();
    this.slackSocketClient = null;
    this.slackSocketStarted = false;
    // DELIBERATE EXCEPTION to the identity rule used everywhere else in this
    // file, and NOT an oversight. Shutdown wants "stop whatever is running under
    // this name", which is a name question, so acting by name is correct routing
    // here — an identity guard would make us skip an instance that replaced the
    // one we snapshotted, i.e. leave MORE running, not less.
    //
    // KNOWN RESIDUAL, left unfixed on purpose, and stated at its true scope:
    // an instance registered under ANY name in this snapshot is never stopped and
    // survives daemon shutdown as an orphan PTY. That includes the name being
    // processed RIGHT NOW — the await inside stopAgent is itself a window in which
    // a newcomer can take the name, and stopAgent then deliberately leaves it
    // mapped, after which this loop has moved on and never revisits it. It is NOT
    // limited to names the loop has already passed.
    // Worse, the .daemon-stop markers are all written in the loop above BEFORE any
    // stop runs, so the crash-alert hook reports a clean shutdown for an instance
    // that is still running. Closing this needs a second pass over the map,
    // not an identity guard — a behaviour change with its own termination
    // question (a caller that keeps starting agents), so it is deliberately out
    // of scope for a concurrency-guard change and tracked separately.
    const names = [...this.agents.keys()];

    for (const name of names) {
      try {
        const stateDir = join(this.ctxRoot, 'state', name);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.daemon-stop'), 'daemon shutdown (SIGTERM)');
      } catch (err) {
        // Don't block shutdown on marker-write failure — worst case the user
        // gets a false crash alarm (the bug we're fixing), best case they get
        // the correct daemon-stop notification.
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }

    for (const name of names) {
      try {
        await this.stopAgent(name);
      } catch (err) {
        console.error(`[agent-manager] Error stopping ${name}:`, err);
      }
    }

    // Close every org's shared Buzz relay connection now that all agents
    // (and thus all dispatcher registrations) are torn down.
    for (const [org, buzzEntry] of this.buzzClients) {
      try {
        buzzEntry.client.stop();
      } catch (err) {
        console.error(`[agent-manager] Error stopping Buzz relay client for org ${org}:`, err);
      }
    }
    this.buzzClients.clear();
  }

  /**
   * Get status of all agents.
   */
  getAllStatuses(): AgentStatus[] {
    const nowMs = Date.now();
    const daemonUptimeMs = nowMs - this.daemonStartMs;
    // silent-dormancy fix: agents not in enabled-agents.json default to enabled
    // (matching discoverAndStart's default-on behavior); an explicit
    // `enabled: false` entry is the only way to be disabled.
    const enabledList = this.readInstanceEnableList();
    const isEnabled = (name: string): boolean => enabledList[name]?.enabled !== false;

    const statuses: AgentStatus[] = [];
    const mapped = new Set<string>();
    for (const [name, entry] of this.agents) {
      const status = entry.process.getStatus();
      // liveness fix: a mapped entry still reporting 'running' whose OS pid is
      // gone is dead, not running. getStatus() returns a fresh object, so
      // correcting .status here does not mutate AgentProcess internal state.
      if (status.status === 'running' && (!status.pid || !isPidAlive(status.pid))) {
        status.status = 'stopped';
      }
      mapped.add(name);
      // Face A — staleness relative to the agent's own process uptime.
      const d = computeDormancy({
        agent: name,
        org: enabledList[name]?.org,
        enabled: isEnabled(name),
        mapped: true,
        nowMs,
        lastSeenMs: this.readHeartbeatMs(name),
        uptimeMs: status.uptime != null ? status.uptime * 1000 : null,
        daemonUptimeMs,
        expectedIntervalMs: this.readHeartbeatIntervalMs(name),
      });
      if (d.dormant) {
        status.dormant = true;
        status.dormancyReason = d.reason;
      }
      statuses.push(status);
    }

    // Face B — roster-diff: enabled agents absent from the mapped set. There is
    // no per-agent uptime, so staleness is measured relative to daemon start.
    for (const name of Object.keys(enabledList)) {
      if (mapped.has(name) || !isEnabled(name)) continue;
      const d = computeDormancy({
        agent: name,
        org: enabledList[name]?.org,
        enabled: true,
        mapped: false,
        nowMs,
        lastSeenMs: this.readHeartbeatMs(name),
        uptimeMs: null,
        daemonUptimeMs,
        expectedIntervalMs: this.readHeartbeatIntervalMs(name),
      });
      statuses.push({
        name,
        status: 'stopped',
        ...(d.dormant ? { dormant: true, dormancyReason: d.reason } : {}),
      });
    }

    return statuses;
  }

  /**
   * silent-dormancy fix: read the epoch ms of an agent's last heartbeat from
   * its canonical state/<agent>/heartbeat.json. Returns null if missing or
   * unparseable — best effort, never throws.
   */
  private readHeartbeatMs(agent: string): number | null {
    const hbPath = join(this.ctxRoot, 'state', agent, 'heartbeat.json');
    if (!existsSync(hbPath)) return null;
    try {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
      const ts = hb.last_heartbeat || hb.timestamp;
      if (!ts) return null;
      const ms = new Date(ts).getTime();
      return isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }

  /**
   * silent-dormancy fix: read an agent's expected heartbeat cadence (ms) from
   * its ENABLED `heartbeat` cron, so computeDormancy derives the staleness
   * threshold from the agent's OWN configured cadence rather than a fixed
   * default. Returns null when there is no enabled `heartbeat` cron or its
   * schedule form is unparseable — best effort, never throws; the caller then
   * falls back to FALLBACK_INTERVAL_MS (24h).
   *
   * Root resolution is load-bearing. We build the crons path directly from
   * `this.ctxRoot` (mirroring readHeartbeatMs) using CRONS_DIRECTORY/
   * CRONS_FILENAME — NOT `readCrons()` from bus/crons.ts, whose cronsFilePath
   * resolves its root from `process.env.CTX_ROOT ?? process.cwd()`
   * independently of the daemon's own ctxRoot. A wrong root would read zero
   * crons and silently drop every agent to the 24h fallback.
   */
  private readHeartbeatIntervalMs(agent: string): number | null {
    const cronsPath = join(this.ctxRoot, CRONS_DIRECTORY, agent, CRONS_FILENAME);
    if (!existsSync(cronsPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(cronsPath, 'utf-8'));
      const crons: CronDefinition[] = Array.isArray(parsed?.crons) ? parsed.crons : [];
      const heartbeat = crons.find(c => c.name === 'heartbeat' && c.enabled !== false);
      if (!heartbeat) return null;
      return parseHeartbeatIntervalMs(heartbeat.schedule);
    } catch {
      return null;
    }
  }

  /**
   * Get status of a specific agent.
   */
  getAgentStatus(name: string): AgentStatus | null {
    const entry = this.agents.get(name);
    return entry ? entry.process.getStatus() : null;
  }

  /**
   * Get the FastChecker for an agent (for Telegram message routing).
   */
  getFastChecker(name: string): FastChecker | null {
    return this.agents.get(name)?.checker || null;
  }

  /**
   * Get all agent names.
   */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Live roster with orgs — consumed by the daemon staleness detector.
   */
  getAgentRoster(): Array<{ name: string; org: string }> {
    return [...this.agents.entries()].map(([name, v]) => ({ name, org: v.process.org }));
  }

  /**
   * Return the CronScheduler for a given agent (for testing / introspection).
   * Returns undefined if no scheduler is running for that agent.
   */
  getCronScheduler(agentName: string): CronScheduler | undefined {
    return this.cronSchedulers.get(agentName);
  }

  // --- Worker management ---

  /**
   * Spawn an ephemeral worker session for a parallelized task.
   */
  async spawnWorker(name: string, dir: string, prompt: string, parent?: string, model?: string): Promise<void> {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" is already running`);
    }
    if (this.agents.has(name)) {
      throw new Error(`"${name}" is already a registered agent name`);
    }

    const log = (msg: string) => console.log(`[worker:${name}] ${msg}`);
    const worker = new WorkerProcess(name, dir, parent, log);

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir: dir,
      org: this.org,
      projectRoot: this.frameworkRoot,
    };

    const config = model ? { model } : {};

    this.workers.set(name, worker);

    worker.onDone((workerName) => {
      // Auto-remove finished workers after a short delay so list-workers
      // can still show the final status briefly before cleanup
      setTimeout(() => {
        // map-entry-race fix: isFinished() is a liveness question, not an
        // identity one. Without the reference check this reaps whatever holds
        // the name 30s later — evicting a DIFFERENT, finished worker and
        // truncating its status-visibility window.
        const mapped = this.workers.get(workerName);
        if (mapped === worker && mapped.isFinished()) {
          this.workers.delete(workerName);
        }
      }, 30_000); // keep for 30s after exit
    });

    await worker.spawn(env, prompt, config);
  }

  /**
   * Terminate a running worker session.
   */
  async terminateWorker(name: string): Promise<void> {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    await worker.terminate();
    // map-entry-race fix: same class as the agents map — terminate() yields, and
    // unmapping by name after it would evict a REPLACEMENT worker registered
    // under this name in the meantime. Currently unreachable (spawnWorker's
    // synchronous `workers.has` guard keeps the name claimed for terminate()'s
    // whole window) — this makes it robust to that guard or those timings
    // changing, rather than relying on them.
    if (this.workers.get(name) === worker) this.workers.delete(name);
  }

  /**
   * Inject text into a running worker's PTY (nudge / stuck-state recovery).
   */
  injectWorker(name: string, text: string): boolean {
    const worker = this.workers.get(name);
    if (!worker) return false;
    return worker.inject(text);
  }

  /**
   * Inject text directly into a running agent's PTY.
   * Used by `cortextos bus test-cron-fire` to fire a cron immediately for testing.
   * Returns true if the agent is running and the inject succeeded; false otherwise.
   */
  injectAgent(agentName: string, text: string): boolean {
    return this.injectAgentDetailed(agentName, text).ok;
  }

  /**
   * Inject text into an agent's PTY with structured outcome — issue #346.
   *
   * Returns NOT_FOUND if the agent isn't in the registry, NOT_RUNNING if
   * registered but the PTY is gone, DEDUPED on a MessageDedup hash hit. The
   * boolean-returning `injectAgent()` is preserved for callers (cron
   * scheduler, fast-checker, fire-cron) that only need pass/fail.
   */
  injectAgentDetailed(agentName: string, text: string): { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    const entry = this.agents.get(agentName);
    if (!entry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${agentName}" not in registry` };
    }
    return entry.process.injectMessageDetailed(text);
  }

  /**
   * Signal the CronScheduler for an agent to re-read crons.json.
   *
   * Called by the IPC server after a `bus add-cron` / `bus remove-cron` write so
   * the daemon-level scheduler picks up the new definition without waiting for
   * the next 30 s tick.  Returns true on a successful reload (or no-op for
   * Hermes agents, which manage their own crons natively); false if the agent
   * is not running at all.
   *
   * Iter 7 fix: previously this returned `true` for any registered agent even
   * when no scheduler existed in `cronSchedulers`, silently dropping reload
   * requests during the start-window gap between `this.agents.set(name, ...)`
   * and `startAgentCronScheduler(name)` (across the `await agentProcess.start()`
   * yield in `startAgent`). Now: for non-Hermes agents that lack a scheduler we
   * lazy-wire one so the just-written crons.json is read immediately.
   */
  reloadCrons(agentName: string): boolean {
    const scheduler = this.cronSchedulers.get(agentName);
    if (scheduler) {
      scheduler.reload();
      console.log(`[agent-manager] Cron scheduler reloaded for ${agentName}`);
      return true;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return false;

    // Hermes manages its own crons natively — no daemon scheduler exists by
    // design. The reload IS a no-op; report success so the caller does not
    // retry forever.
    if (entry.process['config']?.runtime === 'hermes') {
      return true;
    }

    // Non-Hermes agent registered but no scheduler: this is the start-window
    // gap. Lazy-wire the scheduler now; its start() reads crons.json which
    // already contains the new entry the caller just wrote.
    this.startAgentCronScheduler(agentName);
    console.log(`[agent-manager] Cron scheduler lazy-created for ${agentName} (start-window reload)`);
    return this.cronSchedulers.has(agentName);
  }

  /**
   * Wire a daemon-level CronScheduler for the named agent.
   *
   * The scheduler reads `crons.json` (via `readCrons()`), computes fire times,
   * and on each tick injects the cron's prompt text directly into the agent PTY
   * via `injectAgent()`.  The fire callback builds the same injected text that
   * a Claude-Code `CronCreate` callback would emit so the agent's session sees
   * a normal-looking cron-fire message and handles it with existing skill code.
   *
   * Hermes agents manage their own cron system natively — skip them here.
   * If crons.json is absent or empty the scheduler starts but has nothing to do;
   * it will pick up new entries on the next `reloadCrons()` call.
   */
  private startAgentCronScheduler(agentName: string): void {
    // Skip if already running (idempotent — e.g. called twice on fast restart)
    if (this.cronSchedulers.has(agentName)) {
      console.log(`[agent-manager] Cron scheduler already running for ${agentName} — skipped`);
      return;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return;

    // Hermes manages its own cron scheduling — don't double-schedule
    if (entry.process['config']?.runtime === 'hermes') {
      console.log(`[daemon] Skipping external cron scheduler for Hermes agent "${agentName}"`);
      return;
    }

    const onFire = async (cron: CronDefinition): Promise<void> => {
      // DELIBERATE EXCEPTION to the identity rule: this fires on a timer long
      // after any await and injects by NAME, so a cron fires into whichever
      // instance currently holds the name. That is the intended routing — a cron
      // belongs to the agent name, not to one PTY lifecycle, and binding it to a
      // captured entry would silently stop firing across every restart.
      const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;
      // Salt with the fire timestamp so MessageDedup (which hashes the last 100
      // injects) does not reject identical cron prompts on subsequent fires.
      // Without the salt, every recurring cron after its first fire would be
      // dedup-rejected and treated as a dispatch failure.
      const firedAt = new Date().toISOString();
      const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
      const injected = this.injectAgent(agentName, injection);
      if (!injected) {
        throw new Error(`injectAgent returned false for agent "${agentName}" — agent may not be running`);
      }
    };

    const scheduler = new CronScheduler({
      agentName,
      onFire,
      logger: (msg) => console.log(`[daemon] ${msg}`),
    });

    scheduler.start();
    this.cronSchedulers.set(agentName, scheduler);

    const count = scheduler.getNextFireTimes().length;
    console.log(`[daemon] Loaded ${count} external cron(s) for agent "${agentName}" from crons.json`);
  }

  /**
   * Get status of all workers (running + recently completed).
   */
  listWorkers(): WorkerStatus[] {
    return [...this.workers.values()].map(w => w.getStatus());
  }

  /**
   * Get status of a specific worker.
   */
  getWorkerStatus(name: string): WorkerStatus | null {
    return this.workers.get(name)?.getStatus() ?? null;
  }

  /**
   * Discover agents from the organization directory structure.
   *
   * BUG-043 fix: iterate over EVERY org under `frameworkRoot/orgs/*`,
   * not just `this.org`. Before this fix, a daemon started with
   * `CTX_ORG=testorg` would only discover agents in `orgs/testorg/agents/`
   * — agents in `orgs/lifeos/agents/` and `orgs/cointally/agents/` were
   * effectively invisible to the daemon and could never be auto-spawned
   * from a cold start. Multi-org installs silently half-worked.
   *
   * The returned tuple now includes an `org` field so `discoverAndStart()`
   * can pass the correct org to `startAgent()` and downstream path
   * lookups via `resolveAgentOrg()`.
   */
  private discoverAgents(): Array<{ name: string; dir: string; org: string; config: AgentConfig }> {
    const agents: Array<{ name: string; dir: string; org: string; config: AgentConfig }> = [];

    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (!existsSync(orgsBase)) return agents;

    let orgNames: string[] = [];
    try {
      orgNames = readdirSync(orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      return agents; // unreadable orgs dir — treat as empty
    }

    for (const org of orgNames) {
      const agentsBase = join(orgsBase, org, 'agents');
      if (!existsSync(agentsBase)) continue;

      try {
        const dirs = readdirSync(agentsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const name of dirs) {
          const dir = join(agentsBase, name);
          const config = this.loadAgentConfig(dir);
          agents.push({ name, dir, org, config });
        }
      } catch {
        // Ignore read errors for this org — continue scanning others
      }
    }

    return agents;
  }

  /**
   * Load agent config from config.json.
   *
   * On parse error: log a clear, operator-actionable error to stderr (file path,
   * SyntaxError message, and a 1-line offending-snippet hint when locatable) and
   * fall back to default config so the daemon does not hard-crash. Without this
   * surfacing, a trailing comma in config.json silently degrades the agent into
   * a "model not available" state because the model field is missing — see #345.
   */
  private loadAgentConfig(agentDir: string): AgentConfig {
    const configPath = join(agentDir, 'config.json');
    if (!existsSync(configPath)) return {};
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      console.error(`[agent-manager] config read failed: ${configPath}: ${(err as Error).message}`);
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const msg = (err as SyntaxError).message;
      // Best-effort line/column extraction from V8 SyntaxError messages.
      // V8 emits "Unexpected token ... in JSON at position N" — we resolve
      // N back to a 1-indexed line/column so operators can jump to the offender.
      const posMatch = /position (\d+)/.exec(msg);
      let locHint = '';
      if (posMatch) {
        const pos = Math.min(Number(posMatch[1]), raw.length);
        const before = raw.slice(0, pos);
        const line = before.split('\n').length;
        const col = pos - (before.lastIndexOf('\n') + 1) + 1;
        const offendingLine = raw.split('\n')[line - 1] || '';
        locHint = ` (line ${line}, col ${col}: \`${offendingLine.trim().slice(0, 80)}\`)`;
      }
      console.error(`[agent-manager] config.json invalid JSON: ${configPath}${locHint}: ${msg}`);
      console.error(`[agent-manager] hint: trailing commas, unquoted keys, and single quotes are common causes`);
      return {};
    }
  }
}

/**
 * Derive a human-readable reply context string from a Telegram replied-to message.
 *
 * Priority: text > caption > media type label.
 * This is exported for unit testing; call sites use it via the message handler.
 *
 * Before this fix (BUG: reply context lost for media messages): only `.text` was
 * checked, so replies to videos/photos/voice arrived as bare text with no
 * indication of what was being replied to (e.g. "This one" with zero context).
 */
export function buildReplyContext(
  replyMsg: TelegramMessage | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  const parts: string[] = [];
  if (replyMsg.text) {
    parts.push(stripControlChars(replyMsg.text));
  } else if (replyMsg.caption) {
    parts.push(stripControlChars(replyMsg.caption));
  }

  if (replyMsg.document) parts.push(`[document: ${replyMsg.document.file_name ?? 'file'}]`);
  if (replyMsg.photo) parts.push('[photo]');
  if (replyMsg.video) parts.push('[video]');
  if (replyMsg.video_note) parts.push('[video note]');
  if (replyMsg.voice) parts.push('[voice message]');
  if (replyMsg.audio) parts.push('[audio]');

  if (parts.length > 0) return parts.join('\n');
  return undefined;
}
