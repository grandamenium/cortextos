import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';

// node-pty types
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

/**
 * Manages a single Claude Code PTY session.
 * Replaces the tmux session management in agent-wrapper.sh.
 */
export class AgentPTY {
  private pty: IPty | null = null;
  private _alive = false;
  private outputBuffer: OutputBuffer;
  private env: CtxEnv;
  private config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string, bootstrapPattern?: string) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, bootstrapPattern);
  }

  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }

    // Lazy-load node-pty (native addon)
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }

    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();

    // Build environment variables for the PTY process
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Source org-level shared secrets (orgs/{org}/secrets.env).
    // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
    // Agent .env is loaded after and overrides org values — agent-specific keys win.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      if (existsSync(orgEnvFile)) {
        const content = readFileSync(orgEnvFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    }

    // Source agent .env file (overrides org secrets.env for same key names).
    // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
    const agentEnvFile = join(this.env.agentDir, '.env');
    if (existsSync(agentEnvFile)) {
      const content = readFileSync(agentEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          ptyEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    // Add convenience CTX_* aliases used throughout agent templates.
    // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv['CTX_TIMEZONE'] = configTimezone;
      ptyEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }
    // Daemon-managed sessions never need in-process auto-update — SDK updates happen
    // via npm at daemon-restart-time. Without this, agents can freeze for >30 min
    // in a "Checking for updates" animation loop, burning stdout with 99-byte ticks
    // and producing no agent work. Observed on BA/FE/PO sessions (2026-05-26).
    ptyEnv['CLAUDE_CODE_DISABLE_AUTOUPDATE'] = 'true';
    ptyEnv['DISABLE_AUTOUPDATER'] = 'true';
    // FIX #3 (2026-05-26): disable claude-code auto-update check that freezes sessions
    // in update-check loop. Observed BA/FE/PO stuck in "Checking for updates" for >30min
    // while burning 99 bytes stdout (pure UI animation, no agent work).
    // Daemon-managed sessions never need in-process auto-update — we control SDK updates
    // via npm at daemon-restart-time.
    ptyEnv['CLAUDE_CODE_DISABLE_AUTOUPDATE'] = 'true';
    ptyEnv['DISABLE_AUTOUPDATER'] = 'true';

    // ┌─ SYS-1M-PREVENT: BEST-EFFORT FORWARD-GUARD; NO-OP ON CURRENT CC (v2.1.162)
    // │  because auto-1M is OPUS-ONLY there. DETECT (agent-process.ts handleExit)
    // └─ is the LOAD-BEARING, VERSION-AGNOSTIC guard. Do NOT treat this as active
    //    prevention — keep this label so a future refactor knows it is a no-op now
    //    and does not let it silently re-become a false-prevention.
    // For an explicit non-Opus model with
    // no .env choice already made, default CLAUDE_CODE_DISABLE_1M_CONTEXT=true to
    // force the standard window. Honoured by current Claude Code (v2.1.162 reads
    // it and disables 1M — see shouldDisable1MContext), but effectiveness against
    // the original improver-1M incident is LIMITED, by design and by version:
    //   - On v2.1.162 the auto-1M default is OPUS-ONLY; explicit Sonnet/Haiku do
    //     not auto-1M, so this env-set is a NO-OP for the models it targets here.
    //   - It only bites on a CC version that BOTH auto-1M's a non-Opus model AND
    //     honours this var. v2.1.111 (the incident version) auto-1M'd Sonnet but
    //     did NOT honour the var — improver's .env already had it set and still
    //     looped; the effective fix was unpinning config.model (PR #62).
    // So this is forward-looking belt-and-suspenders for a future CC regression.
    // Set ONLY when the agent's .env (sourced above) did not already choose —
    // opt-in/opt-out respected. The real guard if 1M ever gates is DETECT.
    if (AgentPTY.shouldDisable1MContext(this.config, ptyEnv['CLAUDE_CODE_DISABLE_1M_CONTEXT'] !== undefined)) {
      ptyEnv['CLAUDE_CODE_DISABLE_1M_CONTEXT'] = 'true';
    }

    // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    // Spawn the agent binary directly (no shell wrapper) — cross-platform, no shell escaping needed.
    // env is passed natively via node-pty options; no bash export commands required.
    // On Windows, npm global installs create .cmd wrappers, not .exe binaries.
    // node-pty's CreateProcess requires the exact wrapper name to resolve correctly.
    const claudeArgs = this.buildClaudeArgs(mode, prompt);
    const claudeCmd = this.getBinaryName();

    this.pty = this.spawnFn!(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: ptyEnv,
    });

    this._alive = true;

    // Set up output capture
    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);
    });

    // Set up exit handler
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });

    // Claude Code shows a "trust this folder?" prompt on first run in a new directory.
    // Auto-accept by sending Enter after the prompt appears.
    // The prompt takes ~3-5s to render; we send Enter at 5s and 8s for reliability.
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes('trust') || recent.includes('Yes')) {
          this.pty.write('\r');
        }
      }
    }, 5000);
    setTimeout(() => {
      if (this.pty) {
        const recent = this.outputBuffer.getRecent();
        if (recent.includes('trust') || recent.includes('Yes')) {
          this.pty.write('\r');
        }
      }
    }, 8000);
  }

  /**
   * Returns the binary name for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   */
  protected getBinaryName(): string {
    if (platform() !== 'win32') return 'claude';
    // The Claude Code Windows installer historically shipped a `claude.cmd`
    // shim alongside `claude.exe`. Newer installers (e.g. when claude lives
    // under `~/.local/bin`) ship only `claude.exe` and have no `.cmd` shim.
    // Hardcoding `claude.cmd` causes node-pty/ConPTY to fail with an empty
    // "File not found" error before the agent ever boots.
    //
    // Probe PATH for whichever extension is present and prefer `.exe` —
    // it spawns more cleanly under ConPTY than a `.cmd` wrapper, and matches
    // what `where.exe claude` returns on current installs.
    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `claude${ext}`))) {
          return `claude${ext}`;
        }
      }
    }
    // Neither found on PATH — fall back to the legacy default so the error
    // message from node-pty surfaces a recognizable filename for debugging.
    return 'claude.cmd';
  }

  /**
   * Build the claude CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    // Skip Claude Code's permission system by default (back-compat: agents have
    // historically run unattended). Set `dangerously_skip_permissions: false` in
    // the agent config to KEEP the gate on — then Claude Code's PermissionRequest
    // flow (and the hook-permission-telegram approval) actually engages. Without
    // this flag the CLI override would suppress any settings.json permission mode.
    // Only the literal boolean `false` disables the skip; warn on a non-boolean so
    // a typo (e.g. the string "false") can't silently leave an agent ungated when
    // the operator intended to engage the gate.
    const skipPermissions = this.config.dangerously_skip_permissions;
    if (skipPermissions !== undefined && typeof skipPermissions !== 'boolean') {
      console.warn(
        `[agent-pty] ${this.env.agentName}: dangerously_skip_permissions must be true or false ` +
        `(got ${JSON.stringify(skipPermissions)}); defaulting to skip-on.`,
      );
    }
    if (skipPermissions !== false) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Local override pattern (feat #20): concatenate {agentDir}/local/*.md files
    // and append as system prompt. The local/ dir is gitignored so users can customize
    // agent behavior without merge conflicts on framework updates.
    const agentDir = this.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    // Pass prompt as a plain string — no shell escaping needed when using node-pty directly
    args.push(prompt);

    return args;
  }

  /**
   * SYS-1M-PREVENT — decide whether to export CLAUDE_CODE_DISABLE_1M_CONTEXT=true
   * for this agent, forcing the standard (non-1M) context window.
   *
   * Claude Code defaults certain models to a 1M-token context window (in the
   * installed build this auto-default applies to Opus, but the `<model>[1m]`
   * suffix opts any model in). An agent spawned with an EXPLICIT config.model
   * inherits that default; on a plan without 1M usage credits the session fails
   * at the billing gate at SESSION START (an empty context) and Claude Code
   * exits 0 — the daemon then halts the agent in a restart loop (the live
   * improver-1M incident, fixed by the PR #62 config.model unpin).
   *
   * This is BEST-EFFORT defense-in-depth, NOT the load-bearing guard — that is
   * SYS-1M-DETECT (agent-process.ts handleExit), which catches + escalates the
   * gate regardless of version. The env var is honoured by current Claude Code
   * (v2.1.162: it disables both the [1m]-suffix and auto-default 1M paths), but
   * on v2.1.162 the auto-default is Opus-only, so for the explicit Sonnet/Haiku
   * this returns true for, there is no 1M to disable (a no-op on current CC). It
   * was also ineffective on v2.1.111 (improver's .env already set it and still
   * looped). So it only bites on a future CC that both auto-1M's a non-Opus
   * model AND honours this var — forward-looking belt-and-suspenders.
   *
   * Scoping is least-surprise:
   *   - explicitSetting → the agent's .env already set the var (true OR false);
   *     respect the operator's choice, never override.
   *   - no config.model → model:none agents inherit the harness default and
   *     sidestep the gate entirely; leave them untouched.
   *   - Opus models → Opus on Max/Team/Enterprise includes 1M natively (no
   *     billing gate); disabling it would be a needless context regression.
   *   - "[1m]" suffix → a deliberate per-model opt-in to 1M; honour it (a
   *     no-credit halt then surfaces via SYS-1M-DETECT — the operator's choice).
   * Everything else (explicit Sonnet/Haiku/unknown) defaults to the safe
   * standard window.
   */
  static shouldDisable1MContext(config: AgentConfig, explicitSetting: boolean): boolean {
    if (explicitSetting) return false;
    if (!config.model) return false;
    if (/opus/i.test(config.model)) return false;
    if (/\[1m\]/i.test(config.model)) return false;
    return true;
  }

  /**
   * Write data to the PTY.
   */
  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    this.pty.write(data);
  }

  /**
   * Kill the PTY process.
   */
  kill(): void {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      pty.kill();
    }
  }

  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  /**
   * Get the PTY PID.
   */
  getPid(): number | null {
    return this.pty?.pid || null;
  }

  /**
   * Register an exit handler.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy essential env vars
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
      'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      // Windows path-expansion essentials. Stripping these causes phantom
      // %SystemDrive% directories from inherited Search Indexer processes
      // and Unity batchmode UPM IPC crashes (path.join(undefined,...)).
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Windows: ensure UTF-8 locale so emoji and Unicode pass through the PTY
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }

    return env;
  }
}
