import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { AgentProcess } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { CronScheduler } from './cron-scheduler.js';
import { migrateCronsForAgent } from './cron-migration.js';
import type { CronDefinition } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramConnector, NullConnector, getConnector } from '../connectors/index.js';
import type {
  MessageConnector,
  NormalizedMessage,
  NormalizedReactionPayload,
  CallbackPayload,
} from '../connectors/index.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';

/**
 * Legacy-compat Telegram enablement resolver (PR1 of pluggable connectors).
 *
 * Reproduces byte-identically the existing inline gate at this file's
 * startAgent() block (the BOT_TOKEN format check, the numeric ALLOWED_USER
 * check, the "BOT_TOKEN set + ALLOWED_USER missing → refuse" security
 * gate). Returns the parsed values when all three gates pass; otherwise
 * returns `{ enabled: false }` after firing the same WARNING/SECURITY log
 * lines today's code emits.
 *
 * Used by startAgent() to drive both the legacy `telegramApi`/`chatId`/
 * `allowedUserId` field population AND the new connector instantiation —
 * a single source of truth so the two stay in lock-step.
 *
 * @param agentEnvFile  Path to the agent's .env file (may not exist).
 * @param log           Optional log sink. Defaults to a no-op so test
 *                      contexts can call this without console noise; the
 *                      daemon passes its real agent-scoped log.
 */
function resolveLegacyTelegramEnablement(
  agentEnvFile: string,
  log: LogFn = () => {},
):
  | { enabled: true; botToken: string; chatId: string; allowedUserId: string }
  | { enabled: false }
{
  if (!existsSync(agentEnvFile)) return { enabled: false };

  const envContent = readFileSync(agentEnvFile, 'utf-8');
  const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
  const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
  const allowedUserMatch = envContent.match(/^ALLOWED_USER=(.+)$/m);
  let botToken = botTokenMatch?.[1]?.trim();
  const chatId = chatIdMatch?.[1]?.trim();
  let allowedUserId = allowedUserMatch?.[1]?.trim() || undefined;

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

  // Security: ALLOWED_USER is REQUIRED when BOT_TOKEN is set.
  if (botToken && !allowedUserId) {
    log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
    botToken = undefined;
  }

  if (botToken && chatId && allowedUserId) {
    return { enabled: true, botToken, chatId, allowedUserId };
  }
  return { enabled: false };
}

export { resolveLegacyTelegramEnablement };

type LogFn = (msg: string) => void;

/**
 * Manages all agents in a cortextOS instance.
 */
export class AgentManager {
  private agents: Map<string, { process: AgentProcess; checker: FastChecker; connector?: MessageConnector; activityConnector?: MessageConnector }> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  private pendingRestarts: Set<string> = new Set();
  private instanceId: string;
  private ctxRoot: string;
  private frameworkRoot: string;
  private org: string;

  constructor(instanceId: string, ctxRoot: string, frameworkRoot: string, org: string) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
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
      console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: ${name} still in registry during startAgent — pendingRestarts queueing engaged. This should not happen with PR #11 in place.`);
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

    // Read agent .env for Telegram credentials via the legacy-compat
    // resolver (PR1 of pluggable connectors). The resolver reproduces the
    // existing BOT_TOKEN + CHAT_ID + numeric ALLOWED_USER gate byte-
    // identically, including the same WARNING/SECURITY log lines. Output
    // drives both the legacy `telegramApi`/`chatId`/`allowedUserId` fields
    // and the new MessageConnector instantiation below — single source of
    // truth.
    const agentEnvFile = join(agentDir, '.env');
    let telegramApi: TelegramAPI | undefined;
    let chatId: string | undefined;
    let allowedUserId: string | undefined;
    let botToken: string | undefined;
    let connector: MessageConnector | null = null;

    // Dispatch on explicit `config.connector` first; fall back to the legacy
    // gate when absent. Codex M1.cr — without this branch the override was
    // declared in AgentConfig but silently ignored by startAgent. Three-way
    // dispatch (Codex M1.crv refinement) so future connector kinds reach the
    // factory without revisiting this site.
    if (config.connector === 'none') {
      // Explicit no-comms agent. Skip the legacy Telegram gate entirely
      // (including its WARNING/SECURITY log lines — none of them apply when
      // the operator has opted out of Telegram by config).
      connector = new NullConnector();
    } else if (config.connector && config.connector !== 'telegram') {
      // Future connector kinds (Matrix, RocketChat, etc.). Dormant today —
      // CONNECTOR_ALLOWLIST is just ['telegram', 'none'] — but the factory
      // is the dispatch point so adding a new kind is purely additive
      // (extend the union in AgentConfig, extend CONNECTOR_ALLOWLIST, add
      // the implementation under src/connectors/<kind>/, add to the
      // factory's switch). No edit to startAgent required.
      connector = getConnector(config.connector, agentDir, process.env);
    } else {
      // config.connector === 'telegram' explicit, or undefined (today's
      // default inference path). Resolve the legacy gate against .env.
      const legacy = resolveLegacyTelegramEnablement(agentEnvFile, log);
      if (legacy.enabled) {
        botToken = legacy.botToken;
        chatId = legacy.chatId;
        allowedUserId = legacy.allowedUserId;
        // Construct the TelegramConnector FIRST, then extract its internal
        // TelegramAPI for the legacy fields. Codex M2.cr — single shared
        // TelegramAPI instance so rate-limiting (api.ts:85) and self-chat
        // warning dedup (api.ts:88) stay in lock-step across the connector
        // path and the legacy-field path. Previously these were two
        // distinct instances against the same bot token.
        // PR4: `downloadDir` enables the connector's media-enrichment
        // pipeline (photo / document / voice / audio / video /
        // video_note → `NormalizedMessage.media`). Path matches the
        // pre-PR4 daemon-inline `join(agentDir, 'telegram-images')`
        // byte-for-byte so existing downloaded files keep their paths.
        connector = new TelegramConnector(agentDir, {
          BOT_TOKEN: legacy.botToken,
          CHAT_ID: legacy.chatId,
          ALLOWED_USER: legacy.allowedUserId,
        }, { downloadDir: join(agentDir, 'telegram-images') });
        telegramApi = (connector as TelegramConnector).rawTelegramApi();
        // Don't log sensitive user IDs — just indicate the gate is enabled
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
      }
      // (else: connector remains null — byte-identical to today's behavior of
      // leaving telegramApi/chatId/allowedUserId undefined when the gate fails.)
    }

    const agentProcess = new AgentProcess(name, env, config, log);
    // Issue #330: pass the Telegram handle into AgentProcess so CodexAppServerPTY
    // can emit sendChatAction directly from the JSONL stream. Has no effect for
    // claude-code / hermes runtimes — those still use fast-checker.
    if (telegramApi && chatId) {
      agentProcess.setTelegramHandle(telegramApi, chatId);
    }
    // PR1 of pluggable connectors: also wire the MessageConnector handle
    // when present. AgentProcess.setConnector populates the legacy
    // telegramApi/telegramChatId fields when the connector is a
    // TelegramConnector (one-way mirror), so this call after
    // setTelegramHandle is idempotent for the legacy fields and additive
    // for the new connector field.
    if (connector) {
      agentProcess.setConnector(connector);
    }
    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      allowedUserId: allowedUserId ? parseInt(allowedUserId, 10) : undefined,
      connector: connector ?? undefined,
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

    // Start Telegram poller if credentials are available and not explicitly disabled.
    // PR2 of pluggable-connectors + Codex M1.cr code-review fix:
    // `inbound_polling` takes precedence when set. Only fall back to legacy
    // `telegram_polling` when `inbound_polling` is undefined. Both default
    // to true. Setting either to false (when it's the active field)
    // suppresses the poller. Specialist-agent semantics preserved exactly.
    const pollingEnabled = config.inbound_polling !== undefined
      ? config.inbound_polling !== false
      : config.telegram_polling !== false;
    if (connector?.capabilities.longPolling && pollingEnabled) {
      const stateDir = join(this.ctxRoot, 'state', name);

      // PR3 of pluggable-connectors: route inbound polling through the
      // connector's `startPolling` lifecycle instead of constructing a
      // TelegramPoller directly. The connector's stateDir contract
      // (Codex Q5 lock — connector.ts:48-55) preserves
      // `<ctxRoot>/state/<name>/.telegram-offset` byte-for-byte across the
      // wire migration. Handlers consume NormalizedMessage /
      // CallbackPayload / NormalizedReactionPayload. PR4 commit 1 lifted
      // media handling onto the connector (`m.media`); PR4 commit 2
      // normalized `chat_id` and `reply_to.text` onto `NormalizedMessage`
      // so the formatting hot path no longer casts back to TelegramMessage.
      // The only remaining `m.raw as TelegramMessage` cast lives at the
      // `recordInboundTelegram` JSONL-logger call, which is a telegram-
      // namespace helper that legitimately consumes the provider shape.
      // The activity-channel poller (`maybeStartActivityChannelPoller`
      // below) uses the same connector lifecycle through a SECOND
      // TelegramConnector instance with `pollerNamespace: 'activity'`.
      const onMessage = (m: NormalizedMessage) => {
        // ALLOWED_USER gate: NormalizedMessage.from.id is the stringified
        // provider user id, so comparison is string-equality with the
        // raw `.env` value (no parseInt indirection). Empty string is
        // treated as "no sender" — gate denies.
        if (allowedUserId) {
          if (!m.from.id || m.from.id !== allowedUserId) {
            log(`Ignoring message from unauthorized user (allowed_user gate)`);
            return;
          }
        }

        // PR4 commit 1: media processing happens inside TelegramConnector's
        // polling pipeline, so `m.media` is pre-populated when this handler
        // fires for a media message. PR4 commit 2: `m.chat_id` carries the
        // inbound message's own chat id (formerly read off `m.raw.chat.id`)
        // and `m.reply_to.text` carries the rendered reply context (formerly
        // built in this file by `buildReplyContext`; now produced by
        // `buildTelegramReplyContext` at normalization time — see
        // src/connectors/telegram/telegram-connector.ts). The only
        // remaining `m.raw as TelegramMessage` cast in this handler is
        // for the telegram-namespace JSONL logger below.
        const from = stripControlChars(m.from.name || m.from.username || 'Unknown');
        const effectiveChatId = m.chat_id ?? chatId ?? '';
        const stateDir = join(this.ctxRoot, 'state', name);

        // Persist the inbound message to JSONL AND emit a
        // `message/telegram_received` bus event in one helper so
        // experiment cycles and dashboards can count inbound traffic.
        // Without the event, Rubi's v3 fleet measurement found 0
        // inbound messages on a window where Eros replied to multiple
        // agents — the JSONL had the data but it never reached the
        // event log.
        recordInboundTelegram(paths, this.ctxRoot, name, resolvedOrg, from, m.raw as TelegramMessage, log);

        // PR4: media-formatted-message path uses `m.media` directly.
        if (m.media) {
          // BUG-046: Convert absolute paths to relative (from agent working
          // dir). Claude Code strips absolute paths from pasted user input,
          // so the agent never sees them. Relative paths survive injection.
          // BUG-049: Use the agent's actual launch cwd
          // (config.working_directory if set, else agentDir) so the path
          // resolves when Read() is invoked.
          const launchDir = config?.working_directory || agentDir;
          const relLocalPath = relative(launchDir, m.media.localPath);

          log(`[DEBUG] media.kind=${m.media.kind} localPath=${JSON.stringify(relLocalPath)}`);
          let formatted: string;
          if (m.media.kind === 'photo') {
            formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, m.text, relLocalPath);
          } else if (m.media.kind === 'document') {
            formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, m.text, relLocalPath, m.media.fileName ?? '');
          } else if (m.media.kind === 'voice' || m.media.kind === 'audio') {
            formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relLocalPath, m.media.duration, m.media.transcription);
          } else {
            // video or video_note
            formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, m.text, relLocalPath, m.media.fileName ?? '', m.media.duration);
          }

          if (checker.isDuplicate(formatted)) {
            log('Duplicate Telegram media message suppressed');
            return;
          }
          log(`Media message received: kind=${m.media.kind}, path=${m.media.localPath}`);
          checker.queueTelegramMessage(formatted);
          return;
        }

        // Text message (non-media). The connector emits this path either
        // because the inbound message had no media flags, OR because
        // media processing returned null (e.g. Telegram getFile failed) —
        // in both cases `m.text` carries the right body (msg.text or
        // msg.caption fallback per TelegramConnector.toNormalizedMessage).
        const text = stripControlChars(m.text);
        const lastSent = FastChecker.readLastSent(stateDir, effectiveChatId);
        // Reply context populated by TelegramConnector at normalization
        // time (PR4 commit 2) — see `buildTelegramReplyContext` in
        // src/connectors/telegram/telegram-connector.ts.
        const replyToText = m.reply_to?.text;

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
      };

      const onCallback = (c: CallbackPayload) => {
        // Route to fast-checker for hook response handling (perm_*, askopt,
        // etc.). PR4 c7 (Codex P1.A): handleCallback now consumes the typed
        // `CallbackPayload` directly. The previous `c.raw as
        // TelegramCallbackQuery` cast is gone — the daemon path is
        // provider-agnostic and Discord / Mattermost / RocketChat
        // connectors don't have to fabricate a Telegram-shaped raw.
        checker.handleCallback(c).catch(err => {
          log(`Callback handling error: ${err}`);
        });
      };

      const onReaction = (r: NormalizedReactionPayload) => {
        // ALLOWED_USER gate: NormalizedReactionPayload.from.id is the
        // stringified provider user id. Same string-equality rule as
        // onMessage above.
        if (allowedUserId) {
          if (!r.from.id || r.from.id !== allowedUserId) {
            log('Ignoring reaction from unauthorized user (allowed_user gate)');
            return;
          }
        }

        const from = stripControlChars(r.from.name || r.from.username || 'Unknown');
        const reactionChatId = r.chat_id ?? chatId ?? '';
        // PR4 c8: r.message_id is now string; r.old/new_reaction are
        // ConnectorReaction[] (generalized from TelegramReactionType).
        const formatted = FastChecker.formatReaction(
          from,
          reactionChatId,
          r.message_id,
          r.old_reaction,
          r.new_reaction,
        );
        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram reaction suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      };

      // Fire-and-forget per the connector's contract (resolves AFTER the
      // loop is scheduled, NOT after it completes). Matches the prior
      // `poller.start().catch(...)` pattern byte-for-byte.
      connector.startPolling({ onMessage, onCallback, onReaction }, { stateDir }).catch(err => {
        log(`Connector poller error: ${err}`);
      });

      // Store connector reference so stopAgent() can call stopPolling().
      const entry = this.agents.get(name);
      if (entry) entry.connector = connector;

      log(`Inbound poller started via ${connector.kind} connector`);

      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      await this.maybeStartActivityChannelPoller(name, org, agentDir, log);
    }
  }

  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramConnector
   * bound to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
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
  ): Promise<void> {
    if (!org) return;
    const orgDir = join(this.frameworkRoot, 'orgs', org);

    // Only the org's orchestrator runs the activity-channel poller.
    let orchestratorName: string | undefined;
    try {
      const contextJson = readFileSync(join(orgDir, 'context.json'), 'utf-8');
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
      const content = readFileSync(activityEnvPath, 'utf-8');
      for (const line of content.split('\n')) {
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

    const stateDir = join(this.ctxRoot, 'state', name);
    // PR3 activity-channel pluggability: the activity channel is now
    // its own MessageConnector instance. `pollerNamespace: 'activity'`
    // keeps the activity poller's offset file at
    // `.telegram-offset-activity` so it doesn't clobber the agent's
    // primary `.telegram-offset` in the shared stateDir. `agentDir` is
    // unused for the activity connector (we always pass `stateDir`
    // explicitly via startPolling), so the orchestrator's stateDir is
    // a safe placeholder.
    const activityConnector = new TelegramConnector(stateDir, {
      BOT_TOKEN: activityBotToken,
      CHAT_ID: activityChatId,
      ALLOWED_USER: '',
    }, { pollerNamespace: 'activity' });

    const onCallback = (c: CallbackPayload) => {
      const entry = this.agents.get(name);
      if (!entry) return;
      // PR3 final-stage migration: handleActivityCallback now accepts a
      // MessageConnector instead of a TelegramAPI; the connector knows
      // its own chatId so the callback's chat-routing is implicit.
      // PR4 c7 (Codex P1.A): consumes typed CallbackPayload, no raw cast.
      entry.checker.handleActivityCallback(c, activityConnector).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    };

    // Best-effort message logger — activity channel is primarily outbound
    // but any inbound chatter (broadcasts, user DMs, etc.) gets logged
    // so operators can see what is flowing. No PTY injection.
    const onMessage = (m: NormalizedMessage) => {
      const from = stripControlChars(m.from.name || m.from.username || 'Unknown');
      const text = stripControlChars(m.text);
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    };

    activityConnector.startPolling({ onMessage, onCallback }, { stateDir }).catch((err) => {
      log(`Activity-channel poller error: ${err}`);
    });

    const entry = this.agents.get(name);
    if (entry) entry.activityConnector = activityConnector;

    log(`Activity-channel poller started via ${activityConnector.kind} connector (chat ${activityChatId})`);
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

    // PR3: primary + activity pollers are both owned by their connectors
    // now. stopPolling is a no-op when the connector never started polling
    // (e.g. NullConnector or pollingEnabled=false), so calling
    // unconditionally is safe.
    if (entry.connector) {
      await entry.connector.stopPolling().catch((err) => {
        console.log(`[agent-manager] connector.stopPolling error for ${name}: ${err}`);
      });
    }
    if (entry.activityConnector) {
      await entry.activityConnector.stopPolling().catch((err) => {
        console.log(`[agent-manager] activity connector.stopPolling error for ${name}: ${err}`);
      });
    }
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);

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
      console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: pendingRestarts fired for ${name} — race condition leaked through. Honoring queued restart as safety net.`);
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

    await worker.spawn({ ...env, ...(model ? {} : {}) }, prompt);
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
   */
  private loadAgentConfig(agentDir: string): AgentConfig {
    const configPath = join(agentDir, 'config.json');
    try {
      if (existsSync(configPath)) {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
      }
    } catch {
      // Ignore parse errors
    }
    return {}; // Default config
  }
}

