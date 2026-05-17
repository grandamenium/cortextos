import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { join, relative } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage } from '../types/index.js';
import { AgentProcess } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { CronScheduler } from './cron-scheduler.js';
import { dispatchCronFire } from './cron-fire-dispatch.js';
import { migrateCronsForAgent } from './cron-migration.js';
import type { CronDefinition } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramPoller } from '../telegram/poller.js';
import { isAgentDirScaffolded, resolvePaths } from '../utils/paths.js';
import { acquireSession, releaseSession } from '../utils/session-lock.js';
import { parseEnvFile, resolveEnv } from '../utils/env.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';
import { processMediaMessage } from '../telegram/media.js';
import { transcribeVoice } from '../bus/transcribe-voice.js';
import { stripBom } from '../utils/strip-bom.js';

type LogFn = (msg: string) => void;

/**
 * Manages all agents in a cortextOS instance.
 */
export class AgentManager {
  private agents: Map<string, { process: AgentProcess; checker: FastChecker; poller?: TelegramPoller; activityPoller?: TelegramPoller; pollerToken?: string; activityPollerToken?: string; telegramRejectCount?: number; telegramLastRejectAlertAt?: number }> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  /**
   * Process-wide registry of live Telegram pollers, keyed by bot token.
   * Telegram permits exactly one getUpdates long-poll per token; a second
   * poller triggers permanent "Conflict (terminated by other getUpdates)"
   * errors. registerPoller() enforces the one-poller-per-token invariant by
   * stopping any stale poller before recording a new one — the structural
   * guarantee against the orphaned-poller Conflict storm (incident 2026-05-17).
   */
  private pollersByToken: Map<string, TelegramPoller> = new Map();
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  private pendingRestarts: Set<string> = new Set();
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
      // Reject unscaffolded agent dirs. Without AGENTS.md the session-start prompt
      // tells the agent to read a file that does not exist, so it boots into a
      // broken state and silently bypasses heartbeat/inbox protocol. Observed
      // 2026-05-15: 3 dirs (dev, blocked-uat-escalator, monitor-cortexos-fleet-tasks)
      // had only output/ + .cortextos-env, yet the daemon happily started them.
      if (!isAgentDirScaffolded(dir)) {
        console.error(
          `[agent-manager] Skipping unscaffolded agent: ${name} ` +
          `(no AGENTS.md in ${dir}) — run \`cortextos add-agent ${name}\` or ` +
          `copy templates/agent/* into the dir`,
        );
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

  private isTelegramPollingEnabled(
    config: AgentConfig | undefined,
    agentEnv: Record<string, string>,
  ): boolean {
    const envValue = agentEnv.TELEGRAM_POLLING_ENABLED ?? agentEnv.TELEGRAM_LONG_POLLING;
    if (envValue !== undefined) {
      return /^(1|true|yes|on)$/i.test(envValue.trim());
    }

    if (typeof config?.telegram_polling === 'boolean') {
      return config.telegram_polling;
    }

    return true;
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
  async startAgent(name: string, agentDir: string, config?: AgentConfig, org?: string): Promise<void> {
    if (this.agents.has(name)) {
      // BUG-031: this branch was the workaround for the BUG-011 PTY race
      // (restart-all could send stop+start simultaneously, and the new
      // start would arrive while the old stop's PTY exit was still in
      // flight). PR #11 closed BUG-011 by making `AgentProcess.stop()`
      // await the actual PTY exit before resolving — which means this
      // branch should NEVER fire under normal restart paths.
      //
      // We log a regression warning here instead of deleting the branch
      // entirely, so we'll know IMMEDIATELY if BUG-011 ever regresses
      // (a future change accidentally breaks the exit-await). Phase 4 of
      // the core stability test plan + cycle 2 of PR #13 both confirmed
      // this branch is dormant. Once we have weeks of zero-warning
      // production data, we can delete the queue mechanism entirely.
      if (this.daemonJustCrashed) {
        // Post-crash startup. The previous daemon exited via
        // uncaughtException without running stopAll(), so the in-memory
        // registry from the prior process is gone — but the post-crash
        // discoverAndStart pass can briefly re-enter startAgent for an
        // agent whose pendingRestarts entry survived. This is benign and
        // distinct from the BUG-011 in-flight race PR #11 closed. Log at
        // info level so operators don't think PR #11 has regressed.
        console.log(`[agent-manager] ${name} already in registry (post-crash discovery overlap, expected). Queueing restart.`);
      } else {
        console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: ${name} still in registry during startAgent — pendingRestarts queueing engaged. This should not happen with PR #11 in place.`);
      }
      this.pendingRestarts.add(name);
      return;
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
    let agentEnv: Record<string, string> = {};

    if (existsSync(agentEnvFile)) {
      // parseEnvFile is BOM+CRLF-aware (patched in env.ts). Using it here
      // rather than inline regex so the full key-value dict is available.
      agentEnv = parseEnvFile(agentEnvFile);
      botToken = agentEnv.BOT_TOKEN?.trim();
      chatId = agentEnv.CHAT_ID?.trim();
      allowedUserId = agentEnv.ALLOWED_USER?.trim() || undefined;

      // Validate BOT_TOKEN format: must be numeric_id:alphanumeric_secret
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = undefined;
      }

      // ALLOWED_USER must be a numeric Telegram user ID, not a username
      if (allowedUserId && !/^\d+$/.test(allowedUserId)) {
        log(`SECURITY: ALLOWED_USER is not a numeric ID. Telegram user IDs are numbers (e.g. 123456789). Refusing to enable Telegram. Fix the .env file.`);
        allowedUserId = undefined;
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
      allowedUserId: allowedUserId ? parseInt(allowedUserId, 10) : undefined,
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

    this.agents.set(name, { process: agentProcess, checker });

    // Start agent
    await agentProcess.start();

    // Single-session-per-identity enforcement: write state/{name}/session.lock
    // with the daemon's own pid right after the PTY is up. AgentPTY injects
    // CTX_SESSION_OWNER_PID=<daemonPid> into the PTY env, so every
    // `cortextos bus *` mutation inside the session can prove ownership via
    // src/utils/session-lock.ts verifySessionOwnership(). A separately
    // launched session for the same name will not carry this env var and is
    // rejected by the CLI mutation hook with a named-pid error.
    try {
      const status = agentProcess.getStatus();
      acquireSession(paths.stateDir, {
        agent: name,
        instance_id: this.instanceId,
        owner_pid: process.pid,
        pty_pid: status.pid,
      });
    } catch (err) {
      log(`Session lock write failed (non-fatal, mutations may be rejected until next start): ${err}`);
    }

    // Clear stale stop sentinels now the agent is running again. A leftover
    // .user-stop / .daemon-stop would otherwise mis-classify a later crash as
    // an intentional stop and suppress the crash alert. (.daemon-stop also
    // self-expires after 60s; .user-stop has no expiry of its own.)
    for (const marker of ['.user-stop', '.daemon-stop']) {
      try {
        const markerPath = join(this.ctxRoot, 'state', name, marker);
        if (existsSync(markerPath)) rmSync(markerPath);
      } catch { /* non-fatal — marker cleanup must not block startup */ }
    }

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
    this.startAgentCronScheduler(name);

    // Start fast checker in background
    checker.start().catch(err => {
      console.error(`[${name}] Fast checker error:`, err);
    });

    // Register Telegram slash commands at startup (fix for issue #1)
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === 'ok') {
          log(`Telegram commands registered (${result.count} commands)`);
        }
      }).catch(() => { /* non-fatal */ });
    }

    // Start Telegram poller if credentials are available and enabled.
    if (telegramApi && chatId && this.isTelegramPollingEnabled(config, agentEnv)) {
      const stateDir = join(this.ctxRoot, 'state', name);
      const poller = new TelegramPoller(telegramApi, stateDir, 1000, undefined, name);

      const REJECT_ALERT_THRESHOLD = 3;
      const REJECT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

      poller.onMessage((msg) => {
        // ALLOWED_USER gate: if configured, ignore messages from other users.
        // Use numeric comparison to avoid string coercion issues.
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (msg.from?.id !== allowedId) {
            log(`Ignoring message from unauthorized user (allowed_user gate)`);
            const entry = this.agents.get(name);
            if (entry) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const fromId = msg.from?.id ?? 'unknown';
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram messages (ALLOWED_USER gate). Last from_id: ${fromId}. Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
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
        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

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

        if (isMedia && telegramApi) {
          const downloadDir = join(agentDir, 'telegram-images');
          processMediaMessage(msg, telegramApi, downloadDir).then(async (media) => {
            if (!media) {
              log('Media processing returned null - falling back to text format');
              const text = stripControlChars(msg.caption || '');
              const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot);
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
              formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath);
            } else if (media.type === 'document') {
              formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name!);
            } else if (media.type === 'voice' || media.type === 'audio') {
              // STT: transcribe the voice file before injecting so the agent
              // reads text rather than a raw file path. Best-effort — an empty
              // transcript still produces a usable message with the file path.
              const absoluteVoicePath = media.file_path ?? '';
              const STT_FAIL_MSG = 'Voice transcription failed — please type your message.';
              const transcript = absoluteVoicePath
                ? await transcribeVoice(absoluteVoicePath).catch(() => STT_FAIL_MSG)
                : STT_FAIL_MSG;
              if (transcript && transcript !== STT_FAIL_MSG) {
                log(`[voice-stt] transcribed ${absoluteVoicePath}: "${transcript.slice(0, 80)}..."`);
              } else if (transcript === STT_FAIL_MSG) {
                log(`[voice-stt] transcription failed for ${absoluteVoicePath}`);
              }
              formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration, transcript);
            } else {
              // video or video_note
              formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || '', media.duration);
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
            const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot);
            if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
          });
          return;
        }

        // Text message (non-media)
        const text = stripControlChars(msg.text || '');
        const lastSent = FastChecker.readLastSent(stateDir, effectiveChatId);
        // Build reply context from the replied-to message.
        const replyToText = buildReplyContext(msg.reply_to_message);

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
        if (allowedUserId) {
          const allowedId = parseInt(allowedUserId, 10);
          if (reaction.user?.id !== allowedId) {
            log('Ignoring reaction from unauthorized user (allowed_user gate)');
            const entry = this.agents.get(name);
            if (entry) {
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

        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

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

      // Single-poller-per-token invariant + conflict self-heal. Registering
      // the poller stops any stale poller still holding this bot token; the
      // persistent-conflict handler makes an orphan self-terminate instead of
      // joining a Conflict storm. This replaces the earlier
      // startPrimaryPollerWithRestart wrapper: that wrapper restarted the
      // poller on a `conflict-self-die` exit reason the poller never emitted,
      // and a restart-on-Conflict loop re-creates the very duplicate pollers
      // that caused the 2026-05-17 storm. The registry handles stale
      // getUpdates locks instead — the poller keeps polling and simply starts
      // winning once a crashed daemon's server-side long-poll times out.
      if (botToken) {
        poller.onPersistentConflict(this.makeConflictHandler(botToken, poller, name));
        this.registerPoller(botToken, poller);
      }

      poller.start().catch(err => {
        log(`Telegram poller error: ${err}`);
      });

      // Store poller reference so stopAgent() can clean it up
      const entry = this.agents.get(name);
      if (entry) {
        entry.poller = poller;
        entry.pollerToken = botToken;
      }

      log(`Telegram poller started (${name})`);


      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      await this.maybeStartActivityChannelPoller(name, org, agentDir, log, botToken);
    } else if (telegramApi && chatId) {
      log('Telegram poller disabled by config/env; outbound notifications remain enabled');
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
    primaryBotToken?: string,
  ): Promise<void> {
    if (!org) return;
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

    if (primaryBotToken && activityBotToken === primaryBotToken) {
      log("Activity-channel bot token matches primary bot; skipping duplicate activity poller. Primary poller already handles approval callbacks.");
      return;
    }

    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = join(this.ctxRoot, 'state', name);
    // offsetFileSuffix keeps the activity poller's offset file distinct
    // from the primary bot's .telegram-offset — without this they would
    // clobber each other in the same stateDir.
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1000, 'activity', `${name}:activity`);

    activityPoller.onCallback((query) => {
      const entry = this.agents.get(name);
      if (!entry) return;
      entry.checker.handleActivityCallback(query, activityApi).catch((err) => {
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

    // Single-poller-per-token invariant + conflict self-heal for the
    // activity-channel bot — same guarantee as the agent's primary poller.
    // Replaces the earlier startActivityPollerWithRestart wrapper (see the
    // primary poller above for why the restart-on-Conflict loop was removed).
    activityPoller.onPersistentConflict(
      this.makeConflictHandler(activityBotToken, activityPoller, `${name}:activity`),
    );
    this.registerPoller(activityBotToken, activityPoller);

    activityPoller.start().catch((err) => {
      log(`Activity-channel poller error: ${err}`);
    });

    const entry = this.agents.get(name);
    if (entry) {
      entry.activityPoller = activityPoller;
      entry.activityPollerToken = activityBotToken;
    }

    log(`Activity-channel poller started (chat ${activityChatId}, with Conflict-restart wrapper)`);
  }

  /**
   * Register `poller` as the sole poller for `botToken`, stopping any
   * poller already registered for the same token first. The eviction is the
   * structural guarantee that two pollers never race on one bot token —
   * even if a restart path failed to stop the previous poller cleanly.
   */
  private registerPoller(botToken: string, poller: TelegramPoller): void {
    const existing = this.pollersByToken.get(botToken);
    if (existing && existing !== poller) {
      console.warn(
        `[telegram-poller-conflict] duplicate poller for bot token ...${botToken.slice(-6)} — ` +
        `stopping the stale instance (orphaned-poller guard)`,
      );
      existing.stop();
    }
    this.pollersByToken.set(botToken, poller);
  }

  /** Remove `poller` from the token registry, but only if it is still the
   *  registered one (a superseded poller must not evict its replacement). */
  private unregisterPoller(botToken: string, poller: TelegramPoller): void {
    if (this.pollersByToken.get(botToken) === poller) {
      this.pollersByToken.delete(botToken);
    }
  }

  /**
   * Build the persistent-conflict handler for a poller. When the poller has
   * lost getUpdates to a Conflict for a sustained streak, this decides its
   * fate: if it is no longer the registered poller for its token it is a
   * superseded orphan and stops itself; if it IS the registered poller the
   * conflict originates outside this process — log loudly so a monitor pages.
   */
  private makeConflictHandler(botToken: string, poller: TelegramPoller, label: string): () => void {
    return () => {
      if (this.pollersByToken.get(botToken) !== poller) {
        console.warn(
          `[telegram-poller-conflict] ${label}: poller superseded by a newer instance — orphan self-terminating`,
        );
        poller.stop();
      } else {
        console.error(
          `[telegram-poller-conflict] ${label}: registered poller still losing getUpdates after a ` +
          `sustained streak — an external getUpdates caller is on bot token ...${botToken.slice(-6)}; investigate`,
        );
      }
    };
  }

  /**
   * Stop a specific agent.
   */
  async stopAgent(name: string): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }

    if (entry.poller) {
      entry.poller.stop();
      if (entry.pollerToken) this.unregisterPoller(entry.pollerToken, entry.poller);
    }
    if (entry.activityPoller) {
      entry.activityPoller.stop();
      if (entry.activityPollerToken) this.unregisterPoller(entry.activityPollerToken, entry.activityPoller);
    }
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);

    // Release the session.lock so a fresh startAgent (or external recovery
    // tool) can take ownership without tripping verifySessionOwnership().
    // releaseSession is idempotent — safe if the lock was never written.
    try {
      releaseSession(join(this.ctxRoot, 'state', name));
    } catch { /* non-fatal */ }

    // Stop and remove the agent's cron scheduler (if one was wired)
    const scheduler = this.cronSchedulers.get(name);
    if (scheduler) {
      scheduler.stop();
      this.cronSchedulers.delete(name);
    }

    // BUG-031: honor any restart that was queued while we were stopping.
    // After PR #11 (BUG-011 fix) this branch should never fire — see the
    // matching warning comment in startAgent(). The honor logic is preserved
    // as a safety net in case BUG-011 regresses; the warn line tells us
    // immediately if it ever does.
    if (this.pendingRestarts.has(name)) {
      if (this.daemonJustCrashed) {
        console.log(`[agent-manager] pendingRestarts fired for ${name} (post-crash safety net, expected). Honoring queued restart.`);
      } else {
        console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: pendingRestarts fired for ${name} — race condition leaked through. Honoring queued restart as safety net.`);
      }
      this.pendingRestarts.delete(name);
      console.log(`[agent-manager] Honoring queued restart for ${name}`);
      this.startAgent(name, '').catch(err =>
        console.error(`[agent-manager] Queued restart failed for ${name}:`, err),
      );
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
    if (!this.agents.has(name)) {
      console.log(`[agent-manager] Agent ${name} not found — cannot restart`);
      return;
    }
    console.log(`[agent-manager] Restarting ${name}`);
    await this.stopAgent(name);
    await this.startAgent(name, '');
    console.log(`[agent-manager] Restart complete for ${name}`);
  }

  /**
   * Write .daemon-stop markers for all currently-managed agents synchronously.
   *
   * Call this in the SIGINT/SIGTERM signal handler BEFORE any async work.
   * PM2 sends the signal to the daemon's entire process group, so PTY children
   * (Claude Code CLI) receive it at the same instant as the daemon process.
   * Without markers on disk at that moment, agent-process.ts:handleExit()
   * sees no .daemon-stop marker and classifies each PTY exit as a crash →
   * SESSION CONTINUATION flood (30-40 fake restarts/hour).
   *
   * stopAll() also writes these markers as belt-and-suspenders for any path
   * that calls stopAll() directly. This method is the fast synchronous path.
   */
  writeAllDaemonStopMarkersSync(): void {
    const names = [...this.agents.keys()];
    for (const name of names) {
      try {
        const stateDir = join(this.ctxRoot, 'state', name);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.daemon-stop'), 'daemon shutdown (SIGTERM)');
      } catch (err) {
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }
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
   * are written by writeAllDaemonStopMarkersSync() in the signal handler first;
   * this loop is belt-and-suspenders for any future direct caller.
   */
  async stopAll(): Promise<void> {
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
  }

  /**
   * Get status of all agents.
   */
  getAllStatuses(): AgentStatus[] {
    const statuses: AgentStatus[] = [];
    for (const [, entry] of this.agents) {
      statuses.push(entry.process.getStatus());
    }
    return statuses;
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
        if (this.workers.get(workerName)?.isFinished()) {
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
    this.workers.delete(name);
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
    const entry = this.agents.get(agentName);
    if (!entry) return false;
    return entry.process.injectMessage(text);
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
      await dispatchCronFire(cron, {
        agentName,
        frameworkRoot: this.frameworkRoot,
        org: this.resolveAgentOrg(agentName),
        injectAgent: (targetAgent, message) => this.injectAgent(targetAgent, message),
      });
    };

    const scheduler = new CronScheduler({
      agentName,
      onFire,
      logger: (msg) => console.log(`[daemon] ${msg}`),
      timezone: entry.process.timezone,
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
  if (replyMsg.text) return stripControlChars(replyMsg.text);
  if (replyMsg.caption) return stripControlChars(replyMsg.caption);
  if (replyMsg.video) return '[video]';
  if (replyMsg.video_note) return '[video note]';
  if (replyMsg.photo) return '[photo]';
  if (replyMsg.voice) return '[voice message]';
  if (replyMsg.audio) return '[audio]';
  if (replyMsg.document) return `[document: ${replyMsg.document.file_name ?? 'file'}]`;
  return undefined;
}
