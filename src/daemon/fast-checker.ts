import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'fs';
import { exec } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox } from '../bus/message.js';
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

  // Context-exhaustion + frozen-stdout watchdog state
  private bootstrappedAt: number = 0;
  private lastHardRestartAt: number = 0;
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  // Numeric-context ports (from old frank CRM fast-checker.sh)
  private ctxAlert70Sent: boolean = false;
  private ctxAlert85Sent: boolean = false;
  private safetyNetArmed: boolean = false;
  private readonly BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  private readonly STDOUT_FROZEN_MS = 30 * 60 * 1000;
  private readonly CTX_RESTART_PCT = 85;
  private readonly CTX_WARN_PCT = 70;
  private readonly CTX_EMERGENCY_PCT = 85;
  private readonly ZOMBIE_TRANSCRIPT_STALE_MS = 15 * 60 * 1000;
  private readonly ZOMBIE_CTX_MIN_PCT = 50;
  private readonly BRIDGE_FRESH_MS = 5 * 60 * 1000;

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: { pollInterval?: number; log?: LogFn; telegramApi?: TelegramAPI; chatId?: string; allowedUserId?: number } = {},
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

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      const ts = new Date().toISOString();
      exec(`cortextos bus update-heartbeat "[watchdog] ${agentName} alive — idle session ${ts}"`, (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        await this.pollCycle();
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
  }

  /**
   * Detect stuck agent and trigger hard-restart.
   * Ported from CRM fast-checker.sh (FROZEN_RESTART + context-threshold logic).
   *
   * Signals:
   *   1. Numeric context pct from bridge file (gsd-statusline). Graduated
   *      warnings at 70%/85%, restart at 85% with delay scaled by severity,
   *      post-restart verification + retry.
   *   2. Transcript mtime zombie: transcript jsonl > 15min stale AND context
   *      >= 50% = cooked after real work.
   *   3. Claude Code's "How is Claude doing this session?" survey prompt.
   *   4. stdout log unchanged for 30+ min while the agent is "active".
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

    // Signal 1: numeric context pct with graduated warnings + scaled grace.
    const ctxPct = this.readContextPct();
    if (ctxPct > 0) {
      if (ctxPct >= this.CTX_WARN_PCT && !this.ctxAlert70Sent && this.telegramApi && this.chatId) {
        this.ctxAlert70Sent = true;
        this.log(`WATCHDOG: context at ${ctxPct}% — sending 70pct heads-up`);
        this.telegramApi
          .sendMessage(this.chatId, `Heads-up: context at ${ctxPct} percent (threshold ${this.CTX_RESTART_PCT}). Proactive restart will fire at ${this.CTX_RESTART_PCT}.`)
          .catch(() => { /* non-critical */ });
      }
      if (ctxPct >= this.CTX_EMERGENCY_PCT && !this.ctxAlert85Sent && this.telegramApi && this.chatId) {
        this.ctxAlert85Sent = true;
        this.log(`WATCHDOG: context at ${ctxPct}% — sending 85pct emergency`);
        this.telegramApi
          .sendMessage(this.chatId, `Emergency: context at ${ctxPct} percent. Self-restart first, safety net will force in seconds if no action.`)
          .catch(() => { /* non-critical */ });
      }
      if (ctxPct >= this.CTX_RESTART_PCT) {
        const delay = this.safetyNetDelayMs(ctxPct);
        this.log(`WATCHDOG: context ${ctxPct}% >= ${this.CTX_RESTART_PCT}% — arming safety net (delay=${delay}ms)`);
        this.armSafetyNet(`context at ${ctxPct}%`, delay);
        return;
      }
    }

    // Signal 2: transcript mtime zombie check.
    const zombie = this.checkTranscriptZombie();
    if (zombie && ctxPct >= this.ZOMBIE_CTX_MIN_PCT) {
      this.log(`WATCHDOG: transcript ${zombie.ageSec}s stale at ${ctxPct}% ctx — zombie, hard-restarting`);
      this.triggerHardRestart(`zombie: transcript ${zombie.ageSec}s stale + ctx ${ctxPct}%`);
      return;
    }

    // Signal 3: scan last 20KB of stdout for the session-survey prompt.
    // Claude Code emits this when context is full ("How is Claude doing this session?").
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        const tail = buf.toString('utf-8');
        if (/How is Claude doing this session\?|Error during compaction: Conversation too long/.test(tail)) {
          this.log('WATCHDOG: ctx-exhaustion survey prompt detected — hard-restarting');
          this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout');
          return;
        }
      }
    } catch { /* non-critical */ }

    // Signal 4: stdout frozen for 30+ min while agent is active.
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

  /**
   * Read numeric context pct from gsd-statusline bridge file.
   * Returns 0-100, or 0 if bridge missing/stale/invalid.
   * Prefers raw remaining_percentage over used_pct (avoids autocompact inflation).
   */
  private readContextPct(): number {
    const agentName = this.agent.name;
    const candidates = [
      join(tmpdir(), `claude-ctx-agent-${agentName}.json`),
      `/tmp/claude-ctx-agent-${agentName}.json`,
    ];
    for (const bridgePath of candidates) {
      if (!existsSync(bridgePath)) continue;
      try {
        const st = statSync(bridgePath);
        if (Date.now() - st.mtimeMs > this.BRIDGE_FRESH_MS) continue;
        const raw = JSON.parse(readFileSync(bridgePath, 'utf-8'));
        if (typeof raw.remaining_percentage === 'number') {
          return Math.max(0, Math.min(100, 100 - raw.remaining_percentage));
        }
        if (typeof raw.used_pct === 'number') {
          return Math.max(0, Math.min(100, raw.used_pct));
        }
      } catch { /* non-critical */ }
    }
    return 0;
  }

  /**
   * Check transcript jsonl mtime under ~/.claude/projects/<escaped-cwd>/.
   * Returns age info if stale >15min AND session is >15min old, else null.
   * Staleness alone is NOT a zombie — idle agents have stale transcripts by
   * design. Caller gates on ctx pct.
   */
  private checkTranscriptZombie(): { ageSec: number; sessionAgeSec: number } | null {
    const cwd = this.agent.getWorkingDirectory();
    if (!cwd) return null;
    const escaped = cwd.replace(/\//g, '-');
    const transcriptDir = join(process.env.HOME || '', '.claude', 'projects', escaped);
    if (!existsSync(transcriptDir)) return null;
    let latest: { path: string; mtime: number } | null = null;
    try {
      for (const name of readdirSync(transcriptDir)) {
        if (!name.endsWith('.jsonl')) continue;
        const p = join(transcriptDir, name);
        const st = statSync(p);
        if (!latest || st.mtimeMs > latest.mtime) {
          latest = { path: p, mtime: st.mtimeMs };
        }
      }
    } catch { return null; }
    if (!latest) return null;
    const now = Date.now();
    const ageMs = now - latest.mtime;
    const sessionAgeMs = this.bootstrappedAt > 0 ? now - this.bootstrappedAt : 0;
    if (ageMs < this.ZOMBIE_TRANSCRIPT_STALE_MS) return null;
    if (sessionAgeMs < this.ZOMBIE_TRANSCRIPT_STALE_MS) return null;
    return { ageSec: Math.round(ageMs / 1000), sessionAgeSec: Math.round(sessionAgeMs / 1000) };
  }

  /**
   * Graduated safety net delay: tighter at higher ctx (agent too cooked to
   * execute bash reliably past ~95%).
   */
  private safetyNetDelayMs(ctxPct: number): number {
    if (ctxPct >= 95) return 20_000;
    if (ctxPct >= 90) return 45_000;
    return 120_000;
  }

  /**
   * Arm the safety net: inject a self-restart instruction + start a delayed
   * forced hard-restart. After the forced restart, verify the agent has
   * bootstrapped again; if not, retry once.
   */
  private armSafetyNet(reason: string, delayMs: number): void {
    if (this.safetyNetArmed) return;
    this.safetyNetArmed = true;
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();

    const instruction = `SYSTEM: Context threshold reached (${reason}). Before restarting: 1) Write handoff files. 2) Notify Josh via Telegram. 3) Run: cortextos bus hard-restart --reason '${reason}'`;
    this.agent.injectMessage(instruction);

    setTimeout(() => {
      this.log(`WATCHDOG: safety net firing forced hard-restart (${reason})`);
      this.agent.hardRestartSelf(`forced: context threshold not acted on (${reason})`)
        .catch(e => this.log(`hardRestartSelf failed: ${e}`));
      // Verify after 90s; retry once if still not bootstrapped.
      setTimeout(() => {
        if (!this.agent.isBootstrapped()) {
          this.log('WATCHDOG: post-restart verification FAILED — retrying restart once');
          this.agent.hardRestartSelf(`retry: first restart did not bootstrap (${reason})`)
            .catch(e => this.log(`hardRestartSelf retry failed: ${e}`));
        } else {
          this.log('WATCHDOG: post-restart verification PASSED');
        }
      }, 90_000);
    }, delayMs);
  }

  private triggerHardRestart(reason: string): void {
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    if (this.telegramApi && this.chatId) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .catch(() => { /* non-critical */ });
    }
    this.agent.hardRestartSelf(reason).catch(e => this.log(`hardRestartSelf failed: ${e}`));
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
  ): string {
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${replyToText.slice(0, 500)}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${lastSentText.slice(0, 500)}"]\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
    const body = isSlashCommand
      ? text.trim()
      : `\`\`\`\n${text}\n\`\`\``;
    return `=== TELEGRAM from [USER: ${from}] (chat_id:${chatId}) ===
${replyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

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
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VOICE from ${from} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

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
