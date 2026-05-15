import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import { buildAgentRuntimeEnv } from '../utils/env.js';

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
  env?: NodeJS.ProcessEnv;
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

    const ptyEnv = buildAgentRuntimeEnv(this.env, this.config);

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

    args.push('--dangerously-skip-permissions');

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

}
