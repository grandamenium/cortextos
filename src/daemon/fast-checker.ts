import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { atomicWriteSync } from '../utils/atomic.js';
import { execFile, execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox, sendMessage } from '../bus/message.js';
import { updateApproval, listPendingApprovals } from '../bus/approval.js';
import { listTasks } from '../bus/task.js';
import { mirrorTaskToRgos, drainRetryQueue, isEnabled as isMirrorEnabled } from '../bus/rgos-mirror.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars } from '../utils/validate.js';

type LogFn = (msg: string) => void;

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Poll-cycle stall watchdog + circuit breaker
  private pollCycleWatchdog: NodeJS.Timeout | null = null;
  private lastPollCycleCompletedAt: number = 0;
  private watchdogRestarts: number[] = [];
  private watchdogCircuitBroken: boolean = false;
  private watchdogCircuitBrokenAt: number = 0;
  private readonly POLL_CYCLE_TIMEOUT_MS = 30_000;
  private readonly WATCHDOG_MAX_RESTARTS = 3;
  private readonly WATCHDOG_WINDOW_MS = 15 * 60 * 1000;   // 15 min
  private readonly WATCHDOG_CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30 min

  // Gmail watch state
  private gmailWatch?: { query: string; intervalMs: number };
  private gmailLastCheckedAt: number = 0;

  // Usage rate-limit guard state
  private usageLastCheckedAt: number = 0;
  private usageTier: 0 | 1 | 2 = 0; // 0=normal, 1=high(≥85%), 2=critical(≥95%)
  private usageTierFile: string = '';
  private readonly USAGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

  // Context-exhaustion + frozen-stdout watchdog state
  private bootstrappedAt: number = 0;
  private lastHardRestartAt: number = 0;
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  private readonly BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  private readonly STDOUT_FROZEN_MS = 30 * 60 * 1000;

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxAutoresetFiredAt: number = 0;  // Tier 0 auto-reset: fires once per session
  private ctxSessionStartedAt: number = 0;  // set on first session_id observed; gates Tier 0 boot-window
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: {
      pollInterval?: number;
      log?: LogFn;
      telegramApi?: TelegramAPI;
      chatId?: string;
      allowedUserId?: number;
      gmailWatch?: { query: string; intervalMs: number };
    } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Initialize Gmail watch
    if (options.gmailWatch) {
      this.gmailWatch = options.gmailWatch;
    }

    // Initialize usage tier state
    this.usageTierFile = join(paths.stateDir, 'usage-tier.json');
    this.loadUsageTier();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    this.log('Bootstrap complete. Beginning poll loop.');
    this.bootstrappedAt = Date.now();
    this.stdoutLastChangeAt = Date.now();

    // Re-notify user of any approvals that were pending before restart.
    // Runs once per session start; best-effort (errors are logged, not thrown).
    this.rescanPendingApprovals().catch(err => this.log(`rescanPendingApprovals error: ${err}`));

    // Mirror any in-progress tasks that may have been claimed during a gap window
    // (e.g. before the claimTask mirror hook shipped). Idempotent — upsert on UUIDv5 ID.
    this.backfillInProgressTasks().catch(err => this.log(`backfillInProgressTasks error: ${err}`));

    // Boot-time drain: flush any queued retry entries that accumulated while the
    // daemon was down. Short-lived CLI processes exit before setImmediate fires so
    // entries can stack up between restarts. The daemon is long-lived — safe to await.
    if (isMirrorEnabled()) {
      drainRetryQueue().catch(err => this.log(`boot drain error: ${err}`));
    }

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Poll-cycle stall watchdog: runs independently every 30s.
    // If pollCycle hasn't completed in 90s the loop is wedged — hard-restart.
    // A circuit breaker halts auto-restart after 3 trips in 15 min (upstream likely down).
    this.lastPollCycleCompletedAt = Date.now();
    const WATCHDOG_INTERVAL_MS = 30_000;
    const STALL_THRESHOLD_MS = 90_000;
    this.pollCycleWatchdog = setInterval(() => {
      const now = Date.now();
      if (this.bootstrappedAt === 0) return;
      if (now - this.bootstrappedAt < STALL_THRESHOLD_MS) return;

      // Auto-reset circuit breaker after 30 min of quiet
      if (this.watchdogCircuitBroken && now - this.watchdogCircuitBrokenAt > this.WATCHDOG_CIRCUIT_RESET_MS) {
        this.watchdogCircuitBroken = false;
        this.watchdogRestarts = [];
        this.log('Watchdog circuit breaker reset after 30min quiet window');
      }
      if (this.watchdogCircuitBroken) return;

      const stallMs = now - this.lastPollCycleCompletedAt;
      if (stallMs <= STALL_THRESHOLD_MS) return;

      // Prune restart history older than the window
      this.watchdogRestarts = this.watchdogRestarts.filter(t => now - t < this.WATCHDOG_WINDOW_MS);

      // Circuit break: too many restarts mean restart isn't fixing it
      if (this.watchdogRestarts.length >= this.WATCHDOG_MAX_RESTARTS) {
        this.watchdogCircuitBroken = true;
        this.watchdogCircuitBrokenAt = now;
        const winMin = this.WATCHDOG_WINDOW_MS / 60_000;
        const resetMin = this.WATCHDOG_CIRCUIT_RESET_MS / 60_000;
        this.log(
          `Watchdog circuit breaker TRIPPED: ${this.watchdogRestarts.length} restarts in ${winMin}min. ` +
          `Halting auto-restart for ${resetMin}min — likely upstream issue. ` +
          `Check manually with: pm2 logs cortextos-daemon`,
        );
        if (this.telegramApi && this.chatId) {
          this.telegramApi
            .sendMessage(
              this.chatId,
              `⚠️ ${agentName} watchdog tripped — ${this.watchdogRestarts.length} auto-restarts in ${winMin}min. Restart loop paused ${resetMin}min. Likely upstream issue. Manual fix: pm2 restart cortextos-daemon`,
            )
            .catch(() => {});
        }
        this.lastPollCycleCompletedAt = now;
        return;
      }

      this.watchdogRestarts.push(now);
      this.log(
        `pollCycle stalled for ${Math.round(stallMs / 1000)}s — triggering hard-restart ` +
        `(${this.watchdogRestarts.length}/${this.WATCHDOG_MAX_RESTARTS} in ${this.WATCHDOG_WINDOW_MS / 60_000}min window)`,
      );
      this.triggerHardRestart(`pollCycle stalled for ${Math.round(stallMs / 1000)}s`);
      this.lastPollCycleCompletedAt = now;
    }, WATCHDOG_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        // Race pollCycle against a timeout so a hung operation (e.g. stuck fetch,
        // slow execFile) can't freeze the loop indefinitely. If the timeout fires,
        // the underlying operation is abandoned and the loop continues on the next tick.
        await Promise.race([
          this.pollCycle(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
              this.POLL_CYCLE_TIMEOUT_MS,
            ),
          ),
        ]);
        this.lastPollCycleCompletedAt = Date.now();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollCycleWatchdog !== null) {
      clearInterval(this.pollCycleWatchdog);
      this.pollCycleWatchdog = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        // Cooldown after injection
        await sleep(5000);
      }
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }

    // Watchdog: detect ctx-exhaustion survey + frozen stdout
    this.watchdogCheck();

    // Gmail watch: check on configured interval (default 15 min)
    await this.checkGmailWatch();

    // Usage rate-limit guard: check every 15 min
    await this.checkUsageTier();

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();
  }

  /**
   * Detect stuck agent and trigger hard-restart.
   * Ported from CRM fast-checker.sh (FROZEN_RESTART + context-threshold logic).
   *
   * Two signals:
   *   1. Claude Code's "How is Claude doing this session?" survey prompt — fires
   *      when context is exhausted and the session needs to end. If it appears
   *      in stdout, the agent is cooked.
   *   2. stdout log unchanged for 30+ min while the agent is "active" (has a
   *      pending message and no idle flag) — passively frozen.
   */
  private watchdogCheck(): void {
    if (this.watchdogTriggered) return;
    const now = Date.now();
    if (this.bootstrappedAt === 0 || now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;
    if (this.lastHardRestartAt > 0 && now - this.lastHardRestartAt < this.HARD_RESTART_COOLDOWN_MS) return;

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    if (!existsSync(stdoutPath)) return;

    let size: number;
    try { size = statSync(stdoutPath).size; } catch { return; }

    if (size !== this.stdoutLastSize) {
      this.stdoutLastSize = size;
      this.stdoutLastChangeAt = now;
    }

    // Signal 1: scan last 20KB of stdout for the session-survey prompt.
    // Claude Code emits this when context is full ("How is Claude doing this session?").
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        const tail = buf.toString('utf-8');
        if (/How is Claude doing this session\?/.test(tail)) {
          this.log('WATCHDOG: ctx-exhaustion survey prompt detected — hard-restarting');
          this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout');
          return;
        }
      }
    } catch { /* non-critical */ }

    // Signal 2: stdout frozen for 30+ min while agent is active.
    if (
      this.lastMessageInjectedAt > 0 &&
      now - this.stdoutLastChangeAt > this.STDOUT_FROZEN_MS &&
      this.isAgentActive()
    ) {
      const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);
      this.log(`WATCHDOG: stdout frozen for ${stalledSec}s while active — hard-restarting`);
      this.triggerHardRestart(`frozen: stdout unchanged ${stalledSec}s while active`);
    }
  }

  private triggerHardRestart(reason: string): void {
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    if (this.telegramApi && this.chatId) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .catch(() => { /* non-critical */ });
    }
    this.forceContextRestart(reason);
  }

  /**
   * Poll Gmail for unread messages matching the configured query.
   *
   * Runs on the configured interval (default 15 min). Uses the `gws` CLI
   * (https://github.com/google-workspace-utilities/gws) which reads OAuth
   * credentials from ~/.config/gws/. Requires `gws` to be authenticated.
   *
   * If unread messages are found: writes an inbox message so Claude wakes
   * and processes them. If nothing matches: does nothing (zero Claude cost).
   * Claude is responsible for marking messages read after processing.
   */
  private async checkGmailWatch(): Promise<void> {
    if (!this.gmailWatch) return;
    const now = Date.now();
    if (now - this.gmailLastCheckedAt < this.gmailWatch.intervalMs) return;
    this.gmailLastCheckedAt = now;

    // Fetch unread message list
    let listOutput = '';
    try {
      listOutput = await new Promise<string>((resolve, reject) => {
        execFile('gws', ['gmail', 'users', 'messages', 'list',
          '--params', JSON.stringify({ userId: 'me', q: this.gmailWatch!.query }),
          '--format', 'json',
        ], (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Gmail watch list failed: ${err}`);
      return;
    }

    let messageIds: string[] = [];
    try {
      const data = JSON.parse(listOutput);
      messageIds = (data?.messages ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    } catch {
      this.log('Gmail watch: could not parse list response');
      return;
    }

    if (messageIds.length === 0) return; // nothing to do

    // Fetch snippet + subject for each message (metadata format only)
    const summaries: string[] = [];
    for (const id of messageIds.slice(0, 20)) { // cap at 20 to avoid runaway fetches
      try {
        const getOutput = await new Promise<string>((resolve, reject) => {
          execFile('gws', ['gmail', 'users', 'messages', 'get',
            '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] }),
            '--format', 'json',
          ], (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
          });
        });
        const msg = JSON.parse(getOutput);
        const headers: Array<{ name: string; value: string }> = msg?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
        const snippet = msg?.snippet ?? '';
        summaries.push(`ID: ${id}\n   Subject: ${subject}\n   From: ${from}\n   Snippet: ${snippet.slice(0, 200)}`);
      } catch {
        summaries.push(`ID: ${id} (could not fetch details)`);
      }
    }

    const total = messageIds.length;
    const shown = summaries.length;
    const header = `=== GMAIL WATCH: ${total} unread message${total !== 1 ? 's' : ''} ===\n` +
      `Query: ${this.gmailWatch.query}\n\n`;
    const body = summaries.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
    const footer = total > shown ? `\n\n(${total - shown} more not shown)` : '';
    const hint = `\n\nProcess: gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}' --format json` +
      `\nMark read: gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --body '{"removeLabelIds":["UNREAD"]}' --format json`;

    const inboxText = header + body + footer + hint;
    this.log(`Gmail watch: ${total} unread message(s) — writing inbox`);

    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
    } catch (err) {
      this.log(`Gmail watch inbox write failed: ${err}`);
    }
  }

  /**
   * Check Claude Max API utilization and send tier-transition alerts.
   *
   * Runs every 15 minutes. Calls `cortextos bus check-usage-api` and reads
   * the JSON output. Computes tier (0=normal, 1=high≥85%, 2=critical≥95%).
   * On tier change: sends a Telegram alert directly (no Claude wake) and
   * writes an inbox message so Claude acts on it next time it is awake.
   * Tier state persists across restarts in usage-tier.json.
   */
  private async checkUsageTier(): Promise<void> {
    const now = Date.now();
    if (now - this.usageLastCheckedAt < this.USAGE_CHECK_INTERVAL_MS) return;
    this.usageLastCheckedAt = now;

    let rawJson = '';
    try {
      rawJson = await new Promise<string>((resolve, reject) => {
        // Pass high warn thresholds to suppress the script's own Telegram alerts —
        // we handle alerting ourselves on tier transitions only.
        execFile('cortextos', ['bus', 'check-usage-api', '--json'], (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      const errMsg = String(err);
      if (!errMsg.includes('No OAuth token') && !errMsg.includes('accounts.json')) {
        this.log(`Usage check failed: ${errMsg}`);
      }
      return;
    }

    let utilization = -1;
    try {
      const data = JSON.parse(rawJson);
      const fiveH = typeof data?.five_hour?.utilization === 'number'
        ? data.five_hour.utilization
        : typeof data?.five_hour_utilization === 'number'
          ? data.five_hour_utilization
          : -1;
      const sevenD = typeof data?.seven_day?.utilization === 'number'
        ? data.seven_day.utilization
        : typeof data?.seven_day_utilization === 'number'
          ? data.seven_day_utilization
          : -1;
      utilization = Math.max(fiveH, sevenD);
    } catch {
      this.log('Usage check: could not parse response');
      return;
    }

    if (utilization < 0) return;

    const newTier: 0 | 1 | 2 = utilization >= 95 ? 2 : utilization >= 85 ? 1 : 0;
    const prevTier = this.usageTier;

    if (newTier === prevTier) return; // no transition — stay quiet

    this.usageTier = newTier;
    this.saveUsageTier();

    const pct = Math.round(utilization);
    const msg = newTier === 0
      ? `Rate limit recovered. Utilization at ${pct}%. Resuming normal operations.`
      : newTier === 1
        ? `Rate limit at ${pct}%. Tier 1 wind-down: finish current task, no new autonomous work.`
        : `Rate limit at ${pct}%. Critical threshold reached. Going dark — do not start new work. Will notify on reset.`;

    this.log(`Usage tier transition: ${prevTier} → ${newTier} (${pct}%)`);

    // 1. Send Telegram alert directly (no Claude wake needed)
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, msg).catch(() => { /* non-critical */ });
    }

    // 2. Write inbox message so Claude acts on it next time it is awake
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'urgent', msg);
    } catch (err) {
      this.log(`Usage tier inbox write failed: ${err}`);
    }
  }

  /**
   * Load usage tier from persistent file.
   */
  private loadUsageTier(): void {
    try {
      if (existsSync(this.usageTierFile)) {
        const data = JSON.parse(readFileSync(this.usageTierFile, 'utf-8'));
        if (data.tier === 0 || data.tier === 1 || data.tier === 2) {
          this.usageTier = data.tier;
        }
      }
    } catch {
      this.usageTier = 0;
    }
  }

  /**
   * Persist current usage tier to file.
   */
  private saveUsageTier(): void {
    try {
      atomicWriteSync(this.usageTierFile, JSON.stringify({ tier: this.usageTier, checkedAt: Date.now() }));
    } catch {
      // Non-critical
    }
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    return `=== AGENT MESSAGE from ${msg.from}${replyNote} [msg_id: ${msg.id}] ===
\`\`\`
${msg.text}
\`\`\`
Reply using: cortextos bus send-message ${msg.from} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
    recentHistory?: string,
  ): string {
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]\n`;
    }

    let historyCx = '';
    if (recentHistory) {
      historyCx = `[Recent conversation:]\n${recentHistory}\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
    const body = isSlashCommand
      ? text.trim()
      : `\`\`\`\n${text}\n\`\`\``;
    return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(
    from: string,
    chatId: string | number,
    messageId: number,
    oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
    newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  ): string {
    const render = (list: typeof newReaction): string =>
      list.length === 0
        ? '(none)'
        : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

    return `=== REACTION from [USER: ${from}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is optional and only emitted when populated by an upstream
   * transcription service. Whisper integration is not currently wired in
   * cortextos src/ (only in tools/graphify); call sites pass undefined until
   * that pipeline is in place. The codex extractor surfaces the transcript
   * block when present.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
    transcript?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    const transcriptBlock = transcript && transcript.trim()
      ? `transcript:\n\`\`\`\n${transcript.trim()}\n\`\`\`\n`
      : '';
    return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${from} (chat_id:${chatId}) ===
caption:
\`\`\`
${caption}
\`\`\`
duration: ${dur}s
local_file: ${filePath}
file_name: ${fileName}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * On session start, re-notify the user of any approvals that were in
   * pending/ before the restart. Without this, a crash while an approval is
   * pending leaves the approval silently sitting in pending/ forever — the
   * user never gets another notification and the requesting agent stays blocked.
   *
   * Sends one Telegram message per pending approval with Approve/Deny buttons
   * (same callback_data format as createApproval's activity-channel post, so
   * handleCallback routes them correctly). No-ops if Telegram is not configured.
   *
   * Best-effort: errors are logged and never propagate to the caller.
   */
  private async rescanPendingApprovals(): Promise<void> {
    if (!this.telegramApi || !this.chatId) return;

    let pending;
    try {
      pending = listPendingApprovals(this.paths);
    } catch {
      return; // approvalDir missing or unreadable — nothing to do
    }

    if (pending.length === 0) return;
    this.log(`rescanPendingApprovals: ${pending.length} pending approval(s) found — re-notifying`);

    for (const approval of pending) {
      try {
        const lines = [
          `⏳ Pending approval (restart re-notify): ${approval.title}`,
          `Category: ${approval.category}`,
          `Requested by: ${approval.requesting_agent}`,
        ];
        if (approval.description) lines.push('', approval.description);
        lines.push('', `id: ${approval.id}`);

        const keyboard = {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `appr_allow_${approval.id}` },
            { text: '❌ Deny', callback_data: `appr_deny_${approval.id}` },
          ]],
        };

        await this.telegramApi.sendMessage(this.chatId, lines.join('\n'), keyboard);
        this.log(`rescanPendingApprovals: re-notified for ${approval.id}`);
      } catch (err) {
        this.log(`rescanPendingApprovals: failed to re-notify ${approval.id}: ${err}`);
      }
    }
  }

  /**
   * On session start, push any locally in-progress tasks to the RGOS mirror.
   * Handles the gap window where claimTask ran before the mirror hook shipped.
   * Idempotent — all mirror operations are upserts (POST + Prefer:merge-duplicates).
   * No-ops immediately if the task directory does not exist (first-boot guard).
   */
  private async backfillInProgressTasks(): Promise<void> {
    // listTasks() already returns [] when taskDir is missing; explicit guard for clarity.
    if (!existsSync(this.paths.taskDir)) return;

    const tasks = listTasks(this.paths, { status: 'in_progress' });
    if (tasks.length === 0) return;

    this.log(`backfillInProgressTasks: mirroring ${tasks.length} in-progress task(s) to RGOS`);
    for (const task of tasks) {
      await mirrorTaskToRgos(task, 'update').catch(err =>
        this.log(`backfillInProgressTasks: failed to mirror ${task.id}: ${err}`),
      );
    }
    this.log(`backfillInProgressTasks: done`);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    this.log(`Unhandled callback data: ${data}`);
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n\`\`\`\n${content}\n\`\`\`\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   *
   * `autoreset` is 0 when disabled (absent or explicit 0). Any value > 0 arms the
   * Tier 0 silent auto-reset path.
   */
  private getCtxThresholds(): { warn: number; handoff: number; autoreset: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        config.ctx_autoreset_threshold = cfg.ctx_autoreset_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    const raw = config.ctx_autoreset_threshold;
    const autoreset = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    return {
      warn: config.ctx_warning_threshold ?? 70,
      handoff: config.ctx_handoff_threshold ?? 80,
      autoreset,
    };
  }

  /**
   * Best-effort NON-BLOCKING snapshot for the current agent. Called by Tier 0
   * alongside a force-restart. Launched detached with `spawn` so the 1s poll
   * loop is never blocked by slow I/O in the snapshot chain (Neon INSERT,
   * memory file append). Always --silent (daemon-initiated auto-resets must
   * not page Logan).
   *
   * We do NOT wait for the snapshot to finish. The caller proceeds with
   * hardRestart + sessionRefresh immediately. Worst case: the agent process
   * dies while the snapshot is mid-write. Partial snapshot is acceptable —
   * losing context is what we are avoiding, and the Neon + memory steps are
   * each individually idempotent (append-only, insert-only).
   */
  private runAutoresetSnapshot(reason: string): void {
    try {
      const scriptPath = join(this.frameworkRoot, 'scripts', 'snapshot-agent.sh');
      if (!existsSync(scriptPath)) {
        this.log(`snapshot-agent.sh not found at ${scriptPath} — skipping snapshot`);
        return;
      }
      const child = spawn('bash', [scriptPath, this.agent.name, '--silent', '--reason', reason], {
        env: {
          ...process.env,
          CTX_AGENT_NAME: this.agent.name,
          CTX_AGENT_DIR: this.agent.getAgentDir(),
          CTX_FRAMEWORK_ROOT: this.frameworkRoot,
        },
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', err => this.log(`snapshot-agent.sh spawn failed (non-fatal): ${err.message}`));
      // unref so the Node event loop is not kept alive by the child
      child.unref();
    } catch (err) {
      // Snapshot failed to spawn. Caller still restarts — losing a snapshot is
      // better than letting the agent drift toward the hard 80% handoff tier.
      this.log(`snapshot-agent.sh failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip
      pct = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = typeof data.session_id === 'string' ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.ctxAutoresetFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
        this.ctxSessionStartedAt = now;
      }
    } catch { return; }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config)
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (/extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff, autoreset } = this.getCtxThresholds();

    // No threshold configured — observe-only mode (log but don't act). Any of
    // the three thresholds being explicitly set arms the monitor; an agent
    // that sets only ctx_autoreset_threshold still gets Tier 0.
    const cfg = this.agent.getConfig();
    const anyThresholdSet =
      cfg.ctx_handoff_threshold !== undefined ||
      cfg.ctx_warning_threshold !== undefined ||
      (typeof cfg.ctx_autoreset_threshold === 'number' && cfg.ctx_autoreset_threshold > 0);
    if (!anyThresholdSet) return;

    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;

    // Tier 3: deadline exceeded — force restart if agent ignored handoff prompt
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 0: silent auto-reset — takes a snapshot and force-restarts BEFORE
    // the graceful-handoff tier fires. Disabled unless ctx_autoreset_threshold > 0.
    // Fires once per session lifecycle; session-id change clears the fired flag.
    //
    // Boot-window floor: refuse to fire within 60s of session start. Without
    // this, an agent that boots at or above the threshold (bloated CLAUDE.md,
    // large handoff doc, heavy bootstrap) enters a restart loop — every fresh
    // session would immediately cross the threshold and trip Tier 0 again.
    //
    // Idempotency: if .restart-planned already exists AND is recent, another
    // path is already restarting the agent, so we skip to avoid stacking restart
    // requests. Stale markers (> 2min old or negative age from clock skew) are
    // treated as leaked from an earlier crash and ignored — otherwise a single
    // orphaned marker would permanently disable Tier 0 for that agent.
    if (autoreset > 0 && effectivePct >= autoreset && this.ctxAutoresetFiredAt === 0) {
      const sessionAge = this.ctxSessionStartedAt > 0 ? now - this.ctxSessionStartedAt : Infinity;
      if (sessionAge >= 0 && sessionAge < 60_000) {
        this.log(`Tier 0 would fire at ${Math.round(effectivePct)}% but session is only ${Math.round(sessionAge / 1000)}s old — skipping (boot-window guard)`);
        return; // do not latch — let the next poll reconsider after boot window
      }
      const restartPlannedMarker = join(this.paths.stateDir, '.restart-planned');
      if (existsSync(restartPlannedMarker)) {
        let markerAge: number = Infinity;
        try { markerAge = now - statSync(restartPlannedMarker).mtimeMs; } catch { /* ignore */ }
        // Treat negative ages (clock skew) as stale — a marker "from the future"
        // is almost certainly a leftover whose mtime we cannot trust.
        const markerIsFresh = markerAge >= 0 && markerAge < 2 * 60_000;
        if (markerIsFresh) {
          this.log(`Tier 0 would fire at ${Math.round(effectivePct)}% but .restart-planned present (age ${Math.round(markerAge / 1000)}s) — skipping`);
          this.ctxAutoresetFiredAt = now; // latch so we do not re-check every poll
          return;
        }
        this.log(`Tier 0: .restart-planned is stale (age ${markerAge}ms) — proceeding anyway`);
      }
      this.ctxAutoresetFiredAt = now;
      const pctRound = Math.round(effectivePct);
      this.log(`Tier 0 auto-reset fired at ${pctRound}% (threshold ${autoreset}%)`);
      this.runAutoresetSnapshot(`ctx auto-reset at ${pctRound}%`);
      // Reset context_status.json pre-emptively so the restarted session's
      // FastChecker does not immediately re-fire Tier 0 off the stale value.
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      // Arm silent-restart marker so the post-restart session suppresses the
      // boot "online" Telegram messages. Without this, every Tier 0 trip leaks
      // a user-visible "back online" notification, violating the silent
      // contract of auto-reset.
      try {
        writeFileSync(join(this.paths.stateDir, '.silent-restart'), `tier-0-autoreset-${pctRound}%`, 'utf-8');
      } catch { /* non-fatal */ }
      // forceContextRestart handles circuit breaker + hardRestart + sessionRefresh.
      this.forceContextRestart(`ctx auto-reset at ${pctRound}% (tier 0)`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0) {
      this.ctxHandoffFiredAt = now;
      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with EXACTLY these sections (machine-parseable — do not rename or reorder them):

## Active Tasks
- [task_id] title — status, next action

## Key Decisions Made This Session
- Decision: chose X over Y because Z

## Files Modified
- path/to/file — what changed and why

## Cron State Notes
- Any cron-related state worth preserving

## Memory Extractions
- Any facts learned this session that should persist across sessions (these will be auto-appended to MEMORY.md)

## Unfinished Work
- Exactly what to pick up immediately in the next session

Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // If the agent wrote a handoff doc in the last 15 minutes but didn't get to call
    // hard-restart --handoff-doc (e.g. Tier 3 force-restart cut it short), pick it up
    // so the new session still receives handoff context.
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (existsSync(handoffsDir)) {
        const cutoff = now - 15 * 60_000;
        const recent = readdirSync(handoffsDir)
          .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
          .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
          .filter(({ mtime }) => mtime >= cutoff)
          .sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = join(handoffsDir, recent[0].f);
          const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
          writeFileSync(markerPath, docPath, 'utf-8');
          this.log(`Tier 3 restart: found recent handoff doc, writing marker → ${docPath}`);
        }
      }
    } catch { /* non-fatal — proceed without handoff context */ }

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;
    this.ctxAutoresetFiredAt = 0;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh() does stop() + start(); shouldContinue() will return false
    // because .force-fresh was just written, giving us a clean fresh session.
    this.agent.sessionRefresh().catch(err => this.log(`Context restart failed: ${err}`));
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
