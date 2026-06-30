import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import type {
  AdapterContext,
  ExecInput,
  ExecResult,
  HealthResult,
  Unavailability,
  WorkerAdapter,
} from '../base.js';
import { excerpt } from '../base.js';

const BINARY = 'python3';

const SAFE_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];

// Path-1 (API) entrypoint, relative to the project root the agent runs in.
// It reuses mmrag.py's genai.Client + _retry_generate_content classifier.
const SCRIPT_REL = join('knowledge-base', 'scripts', 'gemini_task.py');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killedByTimeout: boolean;
  spawnError: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8', cwd },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (err && err.code === 'ENOENT') {
          resolve({ code: 127, stdout: stdout ?? '', stderr: stderr ?? '', killedByTimeout: false, spawnError: true });
          return;
        }
        const killedByTimeout = Boolean(err && err.killed);
        const code = err && typeof err.code === 'number'
          ? err.code
          : err
            ? 1
            : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', killedByTimeout, spawnError: false });
      }
    );
  });
}

/** The JSON contract printed by gemini_task.py (one line on stdout). */
interface GeminiTaskEnvelope {
  ok: boolean;
  output?: string;
  servedModel?: string;
  failure?: 'rate-limit' | 'no-auth' | 'process-fail';
  detail?: string;
}

export const geminiAdapter: WorkerAdapter = {
  id: 'gemini',
  binary: BINARY,

  safeModels(): string[] {
    return [...SAFE_MODELS];
  },

  async health(model?: string): Promise<HealthResult> {
    const start = Date.now();
    const pinned = model ?? SAFE_MODELS[0];

    // Auth must match what gemini_task.py actually resolves: get_api_key() reads
    // GEMINI_API_KEY from the env OR `gemini_api_key` from the mmrag config file.
    // Checking env alone made health STRICTER than capability — it skipped Gemini
    // when the key lived only in the mmrag config. Mirror both sources here.
    const hasKey = Boolean(process.env.GEMINI_API_KEY) || mmragConfigHasGeminiKey();
    if (!hasKey) {
      return {
        available: false,
        reason: 'no-auth',
        detail: 'GEMINI_API_KEY absent in env and no gemini_api_key in the mmrag config',
        checkedModel: pinned,
        latencyMs: Date.now() - start,
      };
    }

    return {
      available: true,
      checkedModel: pinned,
      latencyMs: Date.now() - start,
    };
  },

  async execute(input: ExecInput, ctx: AdapterContext): Promise<ExecResult> {
    const model = input.model ?? SAFE_MODELS[0];

    // The prompt goes through a temp file so arbitrarily large / shell-unsafe
    // prompts never touch argv.
    let tmpDir: string | null = null;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'hermes-gemini-'));
      const promptFile = join(tmpDir, 'prompt.txt');
      writeFileSync(promptFile, input.prompt, { encoding: 'utf-8' });

      const cwd = ctx.env.projectRoot || process.cwd();
      const args = [SCRIPT_REL, '--model', model, '--prompt-file', promptFile, '--workdir', input.workdir];

      const r = await run(BINARY, args, input.timeoutMs, cwd);

      if (r.killedByTimeout) {
        return {
          ok: false,
          failure: 'timeout',
          retryable: true,
          exitCode: r.code ?? undefined,
          stderrExcerpt: excerpt(`${r.stdout}\n${r.stderr}`),
          servedModel: model,
        };
      }

      if (r.code === 127 || r.spawnError) {
        return {
          ok: false,
          failure: 'no-binary',
          retryable: false,
          exitCode: 127,
          stderrExcerpt: excerpt(r.stderr || `${BINARY} not found`),
          servedModel: model,
        };
      }

      // gemini_task.py encodes failure in JSON and exits 0; a genuine crash exits
      // non-zero with no parseable envelope.
      const envelope = parseEnvelope(r.stdout);
      if (!envelope) {
        return {
          ok: false,
          failure: 'process-fail',
          retryable: true, // process-fail gets 1 retry then failover (spec §4.3 table)
          exitCode: r.code ?? undefined,
          stderrExcerpt: excerpt(r.stderr || r.stdout || 'gemini_task.py: no parseable JSON on stdout'),
          servedModel: model,
        };
      }

      if (envelope.ok) {
        return {
          ok: true,
          output: envelope.output ?? '',
          retryable: false,
          exitCode: 0,
          servedModel: envelope.servedModel ?? model,
        };
      }

      const failure: Unavailability = mapFailure(envelope.failure);
      return {
        ok: false,
        failure,
        // rate-limit and process-fail are retried (per spec §4.3); no-auth is not.
        retryable: failure === 'rate-limit' || failure === 'process-fail',
        exitCode: r.code ?? undefined,
        stderrExcerpt: excerpt(envelope.detail ?? r.stderr ?? r.stdout),
        servedModel: model,
      };
    } finally {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  },
};

function parseEnvelope(stdout: string): GeminiTaskEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The script prints ONE JSON line; if other diagnostics leaked, take the last
  // JSON-looking line.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as GeminiTaskEnvelope;
      if (typeof obj.ok === 'boolean') return obj;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function mapFailure(failure: GeminiTaskEnvelope['failure']): Unavailability {
  switch (failure) {
    case 'rate-limit':
      return 'rate-limit';
    case 'no-auth':
      return 'no-auth';
    default:
      return 'process-fail';
  }
}

/**
 * Mirror gemini_task.py's secondary credential source: get_api_key() falls back
 * to `gemini_api_key` in the mmrag config when GEMINI_API_KEY is not in the env.
 * Resolve the config path exactly as mmrag.py does (MMRAG_CONFIG, else
 * MMRAG_DIR/config.json, else ~/.mmrag/config.json). Best-effort: any read/parse
 * failure means "no key here", never throws into the health probe.
 */
function mmragConfigHasGeminiKey(): boolean {
  try {
    const configPath =
      process.env.MMRAG_CONFIG ||
      join(process.env.MMRAG_DIR || join(homedir(), '.mmrag'), 'config.json');
    if (!existsSync(configPath)) return false;
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { gemini_api_key?: unknown };
    return typeof cfg.gemini_api_key === 'string' && cfg.gemini_api_key.length > 0;
  } catch {
    return false;
  }
}
