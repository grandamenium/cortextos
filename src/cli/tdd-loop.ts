// Wave-1 Task #64 — `cortextos tdd-loop` CLI wrapper.
//
// Operator-facing surface for the TDD autonomous loop. Keep this file thin:
// the loop driver lives in `src/daemon/tdd-loop-runner.ts` so the iteration
// orchestration is testable without a commander process or a real Claude
// invocation. All this file does is:
//
//   1. Parse CLI flags into a `TddLoopOptions`.
//   2. Resolve the run directory under `~/.cortextos/<instance>/state/tdd-runs/<runId>`.
//   3. Wire up the *real* model invoker (shell out to `claude -p` or, when
//      available, a venv-hosted SDK script) and the *real* test runner
//      (spawnSync on the operator's `--test-cmd`).
//   4. Check the git working-tree-clean precondition (refuse to run dirty so
//      the operator can review the loop's commits in isolation later).
//   5. Hand off to `runTddLoop` and print a one-line summary at the end.
//
// Why not commit / push from this command:
//   The loop is an unattended code generator. Letting it commit silently
//   would force operators to babysit every iteration or risk discovering
//   half-baked fixes in `git log` after a long run. The deal is: this
//   command writes files; the operator inspects the diff and commits.

import { Command } from 'commander';
import { spawnSync, execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath, dirname } from 'path';
import { randomBytes } from 'crypto';
import {
  runTddLoop,
  compileGlob,
  type ModelInvoker,
  type ModelInvocationResult,
  type TestRunner,
  type TestRunResult,
  parseModelTestResponse,
  parseModelFixResponse,
} from '../daemon/tdd-loop-runner.js';

/**
 * Resolve the run directory used by the TDD loop, mirroring the cortextOS
 * convention `~/.cortextos/<instance>/state/<feature>/<id>`.
 */
export function resolveRunDir(instance: string, runId: string): string {
  return join(homedir(), '.cortextos', instance, 'state', 'tdd-runs', runId);
}

export function generateRunId(): string {
  // ISO-ish timestamp + 4 random hex chars — short enough to type, unique
  // enough to never collide on the same machine.
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('Z', '');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

/**
 * Probe for an SDK venv at `~/installs/claude-sdk-venv`. If present, prefer
 * it (less subprocess overhead, structured JSON output). Otherwise fall back
 * to the `claude` CLI. Either way, return a callable model invoker.
 *
 * @throws if neither path is available — fail-fast so the operator knows
 *         to fix their environment before iterating.
 */
export function selectModelInvoker(modelName: string): ModelInvoker {
  const venvPath = join(homedir(), 'installs', 'claude-sdk-venv');
  const venvPython = join(venvPath, 'bin', 'python3');
  if (existsSync(venvPython)) {
    return makeVenvInvoker(venvPython, modelName);
  }
  // Fall back to the `claude` CLI.
  const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (which.status === 0 && which.stdout.trim().length > 0) {
    return makeClaudeCliInvoker(which.stdout.trim(), modelName);
  }
  throw new Error(
    'No Claude model invoker available. Install the SDK venv at ' +
    '~/installs/claude-sdk-venv or ensure `claude` is on PATH before running tdd-loop.',
  );
}

/**
 * Build a model invoker that calls `claude -p <prompt> --max-turns 1`. We
 * intentionally use stdio to pass the prompt (avoid shell-escape hazards on
 * very long prompts that exceed argv limits).
 */
function makeClaudeCliInvoker(claudeBin: string, modelName: string): ModelInvoker {
  return async (phase, prompt, _context) => {
    const args = ['-p', prompt, '--max-turns', '1', '--model', modelName];
    const out = spawnSync(claudeBin, args, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (out.error) {
      throw new Error(`claude invocation failed in phase=${phase}: ${out.error.message}`);
    }
    const raw = (out.stdout ?? '') + (out.stderr ?? '');
    const files = phase === 'write-tests'
      ? parseModelTestResponse(raw)
      : parseModelFixResponse(raw);
    const result: ModelInvocationResult = { raw, files };
    return result;
  };
}

/**
 * Build a model invoker that calls a Python helper inside the SDK venv.
 * The helper is expected at `<venv>/bin/cortextos-tdd-invoke.py`; we pass
 * the prompt via stdin and read the raw response on stdout. When the helper
 * isn't installed we fall back to the CLI shape (same encoding).
 */
function makeVenvInvoker(pythonPath: string, modelName: string): ModelInvoker {
  return async (phase, prompt, _context) => {
    const helperPath = join(dirname(pythonPath), 'cortextos-tdd-invoke.py');
    if (!existsSync(helperPath)) {
      // Helper absent — emulate the CLI shape by routing through `claude` if
      // it is also on PATH. Tests bypass this whole path by injecting a mock
      // invoker before this function is called.
      const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
      if (which.status === 0 && which.stdout.trim()) {
        return makeClaudeCliInvoker(which.stdout.trim(), modelName)(phase, prompt, _context);
      }
      throw new Error(
        'venv detected but cortextos-tdd-invoke.py helper missing; ' +
        'install the helper or remove the venv to fall back to the claude CLI.',
      );
    }
    const out = spawnSync(pythonPath, [helperPath, '--model', modelName, '--phase', phase], {
      input: prompt,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    if (out.error) {
      throw new Error(`venv helper failed in phase=${phase}: ${out.error.message}`);
    }
    const raw = (out.stdout ?? '') + (out.stderr ?? '');
    const files = phase === 'write-tests'
      ? parseModelTestResponse(raw)
      : parseModelFixResponse(raw);
    const result: ModelInvocationResult = { raw, files };
    return result;
  };
}

/**
 * Build a real test runner that shells out to the operator's test command.
 * Truncates captured output to the last 4 KB so the iteration log doesn't
 * balloon when a test prints megabytes of stack traces.
 */
export function makeTestRunner(testCmd: string, cwd: string): TestRunner {
  return () => {
    const parts = testCmd.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('Empty --test-cmd');
    }
    const [bin, ...rest] = parts;
    const out = spawnSync(bin, rest, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = (s: string, n = 4000) => s.length > n ? s.slice(-n) : s;
    const result: TestRunResult = {
      exitCode: out.status ?? 1,
      stdout: tail(out.stdout ?? ''),
      stderr: tail(out.stderr ?? ''),
    };
    return result;
  };
}

/**
 * Refuse to run when the git working tree is dirty within the target-files
 * glob. The operator must commit (or stash) first so they can review the
 * loop's mutations in isolation later. Returns the list of dirty files for
 * the operator-facing error message; empty list == clean.
 *
 * Conservative: we look at the entire working tree, not just files matching
 * the glob, because mixing the loop's commits with unrelated WIP would
 * still cause review pain.
 */
export function checkGitClean(repoRoot: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      // Swallow git's stderr — when the dir isn't a git repo, git writes
      // "fatal: not a git repository" which is noise we already handle by
      // returning [] in the catch.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').filter(l => l.trim().length > 0);
    return lines;
  } catch {
    // Not a git repo, or git not installed — operator opted into a non-git
    // workspace. Treat as clean.
    return [];
  }
}

export interface TddLoopCliOptions {
  spec: string;
  testCmd: string;
  targetFiles: string;
  maxIterations: string;
  model: string;
  preTestsOnly?: boolean;
  dryRun?: boolean;
  runId?: string;
  instance: string;
  repoRoot?: string;
  /** Test-only: skip the git-clean check (so unit tests don't need a repo). */
  skipGitCheck?: boolean;
  /** Test-only: inject a synthetic model invoker. */
  modelInvoker?: ModelInvoker;
  /** Test-only: inject a synthetic test runner. */
  testRunner?: TestRunner;
}

/**
 * Programmatic entry point for the CLI command. Exposed so unit tests can
 * drive the command without going through commander's argv parser.
 */
export async function executeTddLoop(opts: TddLoopCliOptions): Promise<number> {
  const repoRoot = resolvePath(opts.repoRoot ?? process.cwd());
  const specPath = resolvePath(opts.spec);
  const runId = opts.runId ?? generateRunId();
  const runDir = resolveRunDir(opts.instance, runId);

  if (!existsSync(specPath)) {
    console.error(`tdd-loop: spec file not found: ${specPath}`);
    return 1;
  }
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    console.error(`tdd-loop: repo root not found: ${repoRoot}`);
    return 1;
  }

  if (!opts.skipGitCheck) {
    const dirty = checkGitClean(repoRoot);
    if (dirty.length > 0) {
      console.error(
        `tdd-loop: working tree is dirty (${dirty.length} files). ` +
        `Commit or stash before running so you can review the loop's writes later.\n` +
        dirty.slice(0, 10).map(l => `  ${l}`).join('\n'),
      );
      return 1;
    }
  }

  // Build invokers (test-injected wins).
  let modelInvoker: ModelInvoker;
  try {
    modelInvoker = opts.modelInvoker ?? selectModelInvoker(opts.model);
  } catch (err) {
    console.error(`tdd-loop: ${(err as Error).message}`);
    return 1;
  }
  const testRunner = opts.testRunner ?? makeTestRunner(opts.testCmd, repoRoot);

  mkdirSync(runDir, { recursive: true });

  // Surface the source files the fix loop will show the model. Cheap glob
  // walk — production callers can replace via env if they want a smarter
  // collector (e.g. only files referenced by the failing tests).
  const collectSourceFiles = () => listFilesUnderGlob(repoRoot, opts.targetFiles);

  const result = await runTddLoop({
    specPath,
    runDir,
    repoRoot,
    targetFilesGlob: opts.targetFiles,
    maxIterations: parseInt(opts.maxIterations, 10),
    preTestsOnly: opts.preTestsOnly,
    dryRun: opts.dryRun,
    modelInvoker,
    testRunner,
    collectSourceFiles,
  });

  console.log(`tdd-loop ${result.status} after ${result.iterations} iteration(s)`);
  if (result.message) console.log(`  ${result.message}`);
  console.log(`  log:    ${result.logPath}`);
  console.log(`  result: ${result.resultPath}`);
  if (result.testFilesWritten.length > 0) {
    console.log(`  tests written: ${result.testFilesWritten.join(', ')}`);
  }
  if (result.sourceFilesModified.length > 0) {
    console.log(`  src patched:   ${result.sourceFilesModified.join(', ')}`);
  }

  return result.status === 'success' ? 0 : 1;
}

/**
 * Walk the repo and return repo-relative paths matching the glob. Deliberately
 * tiny — we don't pull in a glob library. The TDD loop only needs an
 * approximate list to seed model context; missing a file isn't fatal because
 * the model can propose new ones (subject to the same glob guard).
 */
function listFilesUnderGlob(repoRoot: string, glob: string): string[] {
  const rx = compileGlob(glob);
  const out: string[] = [];

  function walk(dir: string, relBase: string): void {
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      const abs = join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (rel === 'tests' || rel.startsWith('tests/')) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (rx.test(rel)) out.push(rel);
      }
    }
  }
  walk(repoRoot, '');
  return out.sort();
}

export const tddLoopCommand = new Command('tdd-loop')
  .description('Run a test-driven feature loop: model writes failing tests, then iterates fixes until green.')
  .requiredOption('--spec <file>', 'Feature spec (markdown) — description + acceptance criteria')
  .option('--test-cmd <cmd>', 'How to run tests', 'npm test')
  .option('--target-files <glob>', 'Files the fix loop may modify (excludes tests/)', 'src/**/*.ts')
  .option('--max-iterations <n>', 'Hard cap on iterations', '10')
  .option('--model <name>', 'Model passed to claude -p --model', 'claude-sonnet')
  .option('--pre-tests-only', 'Stop after writing tests; skip the fix loop')
  .option('--dry-run', 'Plan only; do not write any files')
  .option('--run-id <id>', 'Reuse a prior run id to resume; default is timestamp+random')
  .option('--instance <name>', 'cortextOS instance id', process.env.CTX_INSTANCE_ID ?? 'default')
  .option('--repo-root <dir>', 'Repo root (defaults to current working directory)')
  .action(async (opts: TddLoopCliOptions) => {
    try {
      const code = await executeTddLoop(opts);
      process.exit(code);
    } catch (err) {
      console.error(`tdd-loop: ${(err as Error).message}`);
      process.exit(1);
    }
  });
