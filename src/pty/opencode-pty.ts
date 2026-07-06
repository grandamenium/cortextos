import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { AgentPTY } from './agent-pty.js';
import { KEYS } from './inject.js';
import { OpencodeContextReporter } from './opencode-context-reporter.js';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { stripControlChars } from '../utils/validate.js';

const OPENCODE_BOOTSTRAP_PATTERN = 'Ask anything';
const OPENCODE_SESSION_MARKER = 'opencode-session.json';
const OPENCODE_PROCESS_MARKER = 'opencode-process.json';
const STARTUP_INJECT_MAX_ATTEMPTS = 60;
const STARTUP_INJECT_INTERVAL_MS = 500;
const STARTUP_INJECT_MIN_ATTEMPTS = 6;
const STARTUP_INJECT_STABLE_TICKS = 3;
const CONTEXT_REPORT_INTERVAL_MS = 5000;
const INJECTION_SHELL_RESET_DELAY_MS = 150;
// After a typed `exit`, the zsh shell tears down and OpenCode repaints the chat
// TUI. Give that repaint room before typing the real content, otherwise the
// content races the shell teardown and lands at the dying prompt.
const INJECTION_SHELL_EXIT_SETTLE_MS = 500;
// How many tail lines of cleaned output to inspect when deciding chat vs shell.
// Shell mode replaces the persistent chat chrome ("Ask anything"), so the
// decision must look at the live tail, not the whole scrollback.
const SHELL_DETECT_TAIL_LINES = 20;
// A zsh prompt line ends in `$`, `%`, or `#` (root) once trailing cursor
// whitespace is stripped. Used only as the negative fallthrough after chat
// markers are ruled out.
const SHELL_PROMPT_TAIL_PATTERN = /[%$#]$/;
const TELEGRAM_HEADER_PATTERN = /^=== TELEGRAM(?:\s+\w+)?\s+from[^\n]*\(chat_id:(-?\d+)\)/;

/**
 * PTY wrapper for OpenCode agents.
 *
 * OpenCode's terminal runtime is close to Claude Code's PTY shape:
 * - Binary: `opencode`
 * - Fresh startup: `opencode`, then inject the Cortext startup prompt once
 *   the TUI is ready for input.
 * - Continue startup: `opencode --continue`, then inject the Cortext continue
 *   prompt once the TUI is ready.
 * - Optional model: `--model provider/model`
 * - Optional OpenCode agent: `--agent <name>`
 *
 * The adapter intentionally reuses AgentPTY's environment loading, output
 * logging, secret redaction, and message injection path. It only adds
 * OpenCode-specific args and isolated OpenCode XDG roots under cortextOS
 * state, so multiple native agents do not share sessions/auth/cache by
 * accident. `OPENCODE_CONFIG_DIR` remains under the agent directory for
 * agent-local commands/agents/plugins.
 */
export class OpencodePTY extends AgentPTY {
  private stateDir: string;
  private agentDir: string;
  private workingDir: string;
  private opencodeStateRoot: string;
  private contextReporter: OpencodeContextReporter | null = null;
  private contextReportTimer: ReturnType<typeof setInterval> | null = null;
  private spawnStartedAtMs = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath, OPENCODE_BOOTSTRAP_PATTERN);
    this.agentDir = env.agentDir;
    this.workingDir = config.working_directory || env.agentDir || process.cwd();
    this.stateDir = join(env.ctxRoot, 'state', env.agentName);
    this.opencodeStateRoot = join(this.stateDir, 'opencode');
  }

  protected getBinaryName(): string {
    if (platform() !== 'win32') return 'opencode';

    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `opencode${ext}`))) {
          return `opencode${ext}`;
        }
      }
    }
    return 'opencode';
  }

  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    if (this.config.opencode_agent) {
      args.push('--agent', this.config.opencode_agent);
    }

    return args;
  }

  protected customizeEnv(env: Record<string, string>): void {
    const opencodeStateRoot = env['OPENCODE_XDG_ROOT'] || join(this.stateDir, 'opencode');
    this.opencodeStateRoot = opencodeStateRoot;
    const xdgDirs = {
      XDG_DATA_HOME: join(opencodeStateRoot, 'data'),
      XDG_CONFIG_HOME: join(opencodeStateRoot, 'config'),
      XDG_STATE_HOME: join(opencodeStateRoot, 'state'),
      XDG_CACHE_HOME: join(opencodeStateRoot, 'cache'),
    };
    for (const [key, dir] of Object.entries(xdgDirs)) {
      mkdirSync(dir, { recursive: true });
      env[key] = dir;
    }

    if (!env['OPENCODE_CONFIG_DIR']) {
      const configDir = join(this.agentDir, '.opencode');
      mkdirSync(configDir, { recursive: true });
      env['OPENCODE_CONFIG_DIR'] = configDir;
    }

    if (!env['GOOGLE_GENERATIVE_AI_API_KEY'] && env['GEMINI_API_KEY']) {
      env['GOOGLE_GENERATIVE_AI_API_KEY'] = env['GEMINI_API_KEY'];
    }
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    // OpenCode exits after completing a launch-time prompt (`--prompt` or
    // `opencode run <message>`). Cortext agents must stay alive for future
    // Telegram, inbox, and cron injections, so start the persistent TUI first
    // and inject the startup prompt through the normal PTY input path.
    this.cleanupStaleProcessMarker();
    this.spawnStartedAtMs = Date.now();
    await super.spawn(mode, '');
    this.writeSessionMarker(mode);
    this.writeProcessMarker();
    this.startContextReporter(mode);
    if (prompt.trim()) {
      this.injectStartupPromptWhenReady(this.prepareStartupPrompt(prompt));
    }
  }

  override kill(): void {
    try {
      this.stopContextReporter();
      super.kill();
    } finally {
      this.removeProcessMarker();
    }
  }

  override injectMessage(content: string): Promise<boolean> {
    // OpenCode v1.17.9's TUI does not reliably surface content delivered with
    // bracketed paste (`ESC[200~ ... ESC[201~`): sandbox validation showed the
    // shared injector could repaint the screen without the inbound message
    // reaching the input box. Raw typed input does reach the TUI. Strip terminal
    // control sequences before typing so external Telegram/bus text cannot
    // smuggle escape codes now that we intentionally bypass bracketed paste.
    //
    // OpenCode drops into a real zsh Shell after the agent runs a terminal
    // command from the TUI — which the Telegram reply-protocol forces on every
    // reply (`cortextos bus send-telegram ...`) AND which OpenCode's own
    // heartbeat/check-inbox crons run on their own cadence. Esc alone does NOT
    // exit that stuck `$` prompt: live probing showed the next inbound then
    // lands at the zsh prompt (`$ === TELEGRAM ...` -> command not found) and
    // produces no model reply. The proven recovery is a TYPED `exit` + Enter,
    // which tears down the shell and repaints the chat TUI.
    //
    // But an unconditional `exit` is unsafe — in chat mode it is submitted as a
    // chat message. So detect the live input mode from the output tail first:
    // chat readiness markers => chat (type directly, today's behavior); a bare
    // zsh prompt with no chat markers => shell (exit-recover, then type). The
    // default is conservative chat, so the worst case is exactly today's
    // behavior and a spurious `exit` is never typed into a real chat box. Base
    // AgentPTY (Claude/Codex) is unaffected; this override is OpenCode-only.
    const safeContent = this.prepareInjectedContent(content);
    const mode = this.detectInputMode();
    try {
      this.write(KEYS.ESCAPE);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[opencode-pty] shell-mode reset (Escape) failed before injection (pty likely torn down): ${msg}`);
      return Promise.resolve(false);
    }

    if (mode === 'shell') {
      return new Promise((resolve) => {
        setTimeout(() => {
          try {
            this.write('exit');
            this.write(KEYS.ENTER);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[opencode-pty] shell exit-recovery failed before injection (pty likely torn down): ${msg}`);
            resolve(false);
            return;
          }
          setTimeout(() => {
            void this.typeAndSubmit(safeContent).then(resolve);
          }, INJECTION_SHELL_EXIT_SETTLE_MS).unref?.();
        }, INJECTION_SHELL_RESET_DELAY_MS).unref?.();
      });
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        void this.typeAndSubmit(safeContent).then(resolve);
      }, INJECTION_SHELL_RESET_DELAY_MS).unref?.();
    });
  }

  /**
   * Decide whether the OpenCode TUI is currently at the chat input box or has
   * dropped into a raw zsh shell, by inspecting the tail of recent output.
   *
   * Positive chat detection (readiness markers in the tail) wins outright.
   * Only when those markers are absent AND the last non-empty line looks like a
   * bare shell prompt do we treat it as shell mode. Anything else defaults to
   * chat, so a spurious `exit` is never typed into a real chat box.
   */
  private detectInputMode(): 'shell' | 'chat' {
    let recent: string;
    try {
      recent = this.getOutputBuffer().getRecent();
    } catch {
      return 'chat';
    }

    const tail = recent
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('[opencode-pty]'))
      .slice(-SHELL_DETECT_TAIL_LINES);
    const tailText = tail.join('\n');

    if (tailText.includes('Ask anything') || tailText.includes('ctrl+p commands')) {
      return 'chat';
    }

    const lastNonEmpty = tail
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.length > 0)
      .at(-1) ?? '';
    return SHELL_PROMPT_TAIL_PATTERN.test(lastNonEmpty) ? 'shell' : 'chat';
  }

  private typeAndSubmit(safeContent: string): Promise<boolean> {
    const maxChunk = 4096;
    try {
      for (let i = 0; i < safeContent.length; i += maxChunk) {
        this.write(safeContent.slice(i, i + maxChunk));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[opencode-pty] deferred injection failed (pty likely torn down): ${msg}`);
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          this.write(KEYS.ENTER);
          resolve(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[opencode-pty] deferred Enter failed (pty likely torn down): ${msg}`);
          resolve(false);
        }
      }, 300).unref?.();
    });
  }

  private prepareInjectedContent(content: string): string {
    const safeContent = stripControlChars(content).replace(/\r\n?/g, '\n');
    const telegramMatch = safeContent.match(TELEGRAM_HEADER_PATTERN);
    if (!telegramMatch) return safeContent;

    const chatId = telegramMatch[1];
    const replyTargetMatch = safeContent.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    const replyTargetBlock = replyTargetMatch?.[1]
      ? `
[OPENCODE REPLY TARGET]
The Telegram user replied to this specific prior message:
"${replyTargetMatch[1].slice(0, 500)}"
If the user says "this", "that", "it", or asks a short follow-up, answer about this replied-to message before using broader recent history.`
      : '';
    return `${safeContent}
${replyTargetBlock}

[OPENCODE TELEGRAM DELIVERY REQUIREMENT]
This is a real Telegram inbound message. A plain answer printed only in the OpenCode TUI is NOT delivered to the user and is a failed reply.
You MUST deliver your response by executing exactly one terminal command:

cortextos bus send-telegram ${chatId} '<your reply>'

Keep the reply concise. Do not just write the answer in the OpenCode chat.`;
  }

  private prepareStartupPrompt(prompt: string): string {
    const safePrompt = stripControlChars(prompt).replace(/\r\n?/g, '\n').trim();
    return `${safePrompt}

[OPENCODE STARTUP EXECUTION REQUIREMENT]
The text above is a live startup instruction message, not passive context or a session title. Execute it now as the next model turn.
If it instructs you to send Telegram or bus output, run the required terminal command now. Do not wait for another inbound message.`;
  }

  private injectStartupPromptWhenReady(prompt: string): void {
    let attempts = 0;
    let stableTicks = 0;
    let lastRecentLength = 0;
    const timer = setInterval(() => {
      attempts++;
      const recent = this.getOutputBuffer().getRecent();
      const cleaned = recent.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      const cleanedForReadiness = cleaned
        .split('\n')
        .filter((line) => !line.startsWith('[opencode-pty]'))
        .join('\n');
      const recentLength = recent.length;
      stableTicks = recentLength === lastRecentLength ? stableTicks + 1 : 0;
      lastRecentLength = recentLength;

      const hasRendered = cleanedForReadiness.trim().length > 0;
      const knownPromptReady = cleanedForReadiness.includes('Ask anything')
        || cleanedForReadiness.includes('ctrl+p commands');
      const quiescentTuiReady = attempts >= STARTUP_INJECT_MIN_ATTEMPTS
        && hasRendered
        && stableTicks >= STARTUP_INJECT_STABLE_TICKS;
      const ready = knownPromptReady || quiescentTuiReady;

      if (ready) {
        clearInterval(timer);
        try {
          this.injectMessage(prompt);
        } catch {
          // If the TUI exited during startup, AgentProcess exit handling will
          // decide whether to recover. The lost startup prompt is preferable to
          // crashing the daemon.
        }
      } else if (attempts >= STARTUP_INJECT_MAX_ATTEMPTS) {
        clearInterval(timer);
        this.getOutputBuffer().push('[opencode-pty] startup prompt not injected: TUI readiness not detected\n');
      }
    }, STARTUP_INJECT_INTERVAL_MS);
    timer.unref?.();
  }

  private writeSessionMarker(mode: 'fresh' | 'continue'): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const markerPath = join(this.stateDir, OPENCODE_SESSION_MARKER);
      writeFileSync(markerPath, JSON.stringify({
        runtime: 'opencode',
        mode,
        updated_at: new Date().toISOString(),
      }, null, 2) + '\n', 'utf-8');
    } catch {
      // Non-fatal: missing marker only makes the next boot start fresh.
    }
  }

  private startContextReporter(mode: 'fresh' | 'continue'): void {
    this.stopContextReporter();
    this.contextReporter = new OpencodeContextReporter({
      stateDir: this.stateDir,
      agentDir: this.agentDir,
      workingDir: this.workingDir,
      opencodeStateRoot: this.opencodeStateRoot,
      config: this.config,
      startedAtMs: mode === 'fresh' ? this.spawnStartedAtMs : 0,
    });
    if (mode === 'fresh') {
      this.contextReporter.resetContextStatus();
    }
    this.contextReporter.reportOnce();
    this.contextReportTimer = setInterval(() => {
      this.contextReporter?.reportOnce();
    }, CONTEXT_REPORT_INTERVAL_MS);
    this.contextReportTimer.unref?.();
  }

  private stopContextReporter(): void {
    if (this.contextReportTimer) {
      clearInterval(this.contextReportTimer);
      this.contextReportTimer = null;
    }
    this.contextReporter = null;
  }

  private processMarkerPath(): string {
    return join(this.stateDir, OPENCODE_PROCESS_MARKER);
  }

  private writeProcessMarker(): void {
    const pid = this.getPid();
    if (!pid) return;
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.processMarkerPath(), JSON.stringify({
        runtime: 'opencode',
        pid,
        updated_at: new Date().toISOString(),
      }, null, 2) + '\n', 'utf-8');
    } catch {
      // Non-fatal: the marker is only a cleanup aid after daemon crashes.
    }
  }

  private removeProcessMarker(): void {
    try {
      unlinkSync(this.processMarkerPath());
    } catch {
      // Already gone.
    }
  }

  private cleanupStaleProcessMarker(): void {
    try {
      const markerPath = this.processMarkerPath();
      if (!existsSync(markerPath)) return;
      const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as { pid?: unknown };
      const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
      if (pid && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Missing process or permission failure; either way do not block boot.
        }
      }
      unlinkSync(markerPath);
    } catch {
      // A corrupt marker must not block the agent from starting.
    }
  }
}

export function opencodeSessionExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, 'state', agentName, OPENCODE_SESSION_MARKER));
}
