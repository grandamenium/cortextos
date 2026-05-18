// Wave-1 Task #64 — cortextOS TDD autonomous loop, pure orchestration core.
//
// This module is the test-driven feature loop extracted from the CLI wrapper
// so the iteration logic can be exercised end-to-end without spawning a
// commander process or shelling to a real Claude SDK.
//
// The loop:
//   1. Parse the operator's spec (markdown frontmatter + bullets).
//   2. Iteration #1 — ask the configured model to write failing vitest tests
//      for the spec; write them to disk.
//   3. Run the configured test command. If it exits 0 AND at least one new
//      test file was written this run -> success.
//   4. Otherwise iterate: feed the failing output + current source files into
//      the model, ask for unified-diff or full-file patches, apply them under
//      the --target-files glob, retest. Stop when green or when the iteration
//      cap is hit.
//
// State + replay
//   Each iteration appends a JSONL line to `<runDir>/iterations.jsonl` so an
//   operator can `tail -f` the loop or replay a debugging session offline.
//   Iteration writes go through `atomicWriteSync` so a crash mid-write never
//   leaves a half-rendered test file behind.
//
// Why this lives in src/daemon/
//   Other long-running loops (cron scheduler) live here too — the conventions
//   for "pure driver, CLI is a thin shell" are already established. Keep the
//   CLI side at `src/cli/tdd-loop.ts` deliberately thin so the operator-facing
//   flags can evolve without touching the loop logic.

import { existsSync, readFileSync, mkdirSync, statSync, appendFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed shape of the operator's `--spec` markdown file. We keep this
 * deliberately narrow — a description + an acceptance criteria list is the
 * entire contract a TDD loop needs. Extra frontmatter (`tags`, `owner`, etc.)
 * is preserved in `frontmatter` for callers that want to use it but the loop
 * itself only consults `description` + `acceptanceCriteria`.
 */
export interface ParsedSpec {
  /** Top-level title (first `# Heading`) or the frontmatter `title:` field. */
  title: string;
  /** Body paragraph(s) above the acceptance-criteria list. Trimmed. */
  description: string;
  /**
   * Bullet items under an `## Acceptance criteria` (case-insensitive) heading.
   * Markdown list markers (`-`, `*`, `1.`) are stripped; items keep their text.
   */
  acceptanceCriteria: string[];
  /** Frontmatter key/values if a `---` YAML header was present (raw strings). */
  frontmatter: Record<string, string>;
}

/**
 * Suggestion for a single test file. The model is asked to return one or
 * more of these; the loop writes them as-is (after the --target-files guard
 * for the FIX iterations — tests themselves are always allowed under
 * `tests/`). Returned by `parseModelTestResponse`.
 */
export interface ProposedTestFile {
  /** Repo-relative path (e.g. `tests/unit/foo/bar.test.ts`). */
  path: string;
  /** Full file contents to write. */
  content: string;
}

/**
 * Suggestion for a single source-file patch produced by the fix-loop model
 * call. We only support full-file replacement today — unified-diff parsing
 * is a known follow-up (callsites that need it can post-process this).
 */
export interface ProposedFileChange {
  /** Repo-relative path. */
  path: string;
  /** Replacement contents. */
  content: string;
}

/**
 * Output of one model invocation. The runner only inspects `files`; the raw
 * text is logged to the iteration JSONL for operator replay/audit.
 */
export interface ModelInvocationResult {
  /** Raw text returned by the model — recorded verbatim for audit. */
  raw: string;
  /** Parsed file proposals; may be empty if the model didn't propose any. */
  files: ProposedTestFile[] | ProposedFileChange[];
}

/**
 * Contract for the model invoker passed into `runTddLoop`. Real production
 * call shells out to `claude -p` (see CLI wrapper); tests inject a mock that
 * returns canned responses. Keeping this an injection point is what makes
 * the loop driver testable without spending API quota.
 */
export type ModelInvoker = (
  phase: 'write-tests' | 'fix',
  prompt: string,
  context: Record<string, unknown>,
) => Promise<ModelInvocationResult>;

/**
 * Contract for the test-runner injection. Production wires this to a
 * spawnSync of the configured test command; unit tests inject a deterministic
 * fake so we can simulate red->green transitions across iterations without
 * forking processes.
 */
export type TestRunner = () => TestRunResult;

export interface TestRunResult {
  /** Process exit code (0 == green). */
  exitCode: number;
  /** Last N bytes of merged stdout. */
  stdout: string;
  /** Last N bytes of merged stderr. */
  stderr: string;
}

export interface IterationLogEntry {
  /** 1-based iteration number. */
  iteration: number;
  /** When this iteration's record was written (ISO 8601). */
  ts: string;
  /** What happened in this step. */
  phase: 'write-tests' | 'run-tests' | 'fix' | 'done' | 'cap-reached' | 'rejected';
  /** Files touched or proposed in this step. Repo-relative. */
  files: string[];
  /** Test-runner exit code if this iteration ran tests. */
  exitCode?: number;
  /** Short message — failure summary, "all green", "max iterations hit", etc. */
  message?: string;
  /** Raw model text — only on iterations that invoked the model. */
  modelRaw?: string;
}

export interface RunResult {
  status: 'success' | 'cap_reached' | 'pre_tests_only' | 'dry_run' | 'rejected';
  iterations: number;
  /** Path to the iteration JSONL log. */
  logPath: string;
  /** Path to the final `result.json` summary. */
  resultPath: string;
  /** If the loop ran tests at least once, the last exit code. */
  lastExitCode?: number;
  /** Files the loop has written test code to. */
  testFilesWritten: string[];
  /** Files the fix-loop modified. */
  sourceFilesModified: string[];
  /** Short human-readable reason — useful for CLI summary line. */
  message?: string;
}

export interface TddLoopOptions {
  /** Absolute path to the spec markdown file. */
  specPath: string;
  /** Absolute path to the run state directory (`~/.cortextos/<inst>/state/tdd-runs/<id>`). */
  runDir: string;
  /** Repo root inside which target-files globs are anchored. */
  repoRoot: string;
  /** Allowed-modify glob for the fix loop. Default: `src/**\/*.ts` excluding `tests/`. */
  targetFilesGlob?: string;
  /** Hard cap on iterations (including the test-write iteration). Default 10. */
  maxIterations?: number;
  /** Stop after the test-write step — skip the fix loop entirely. */
  preTestsOnly?: boolean;
  /** Plan only; do not write any files. */
  dryRun?: boolean;
  /** Injection points — see types above. */
  modelInvoker: ModelInvoker;
  testRunner: TestRunner;
  /** Optional list of source-file repo-relative paths surfaced to the fix model. */
  collectSourceFiles?: () => string[];
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/**
 * Parse a TDD spec markdown file.
 *
 * Supported shape:
 *   ---
 *   key: value
 *   ---
 *   # Title
 *
 *   Description paragraph...
 *
 *   ## Acceptance criteria
 *   - first criterion
 *   - second criterion
 *
 * Frontmatter is optional. The title falls back to the first `# heading` if
 * no `title:` frontmatter is present. Acceptance criteria heading match is
 * case-insensitive; we accept `Acceptance Criteria` / `acceptance criteria`
 * / `Acceptance criteria:` (trailing colon).
 *
 * @throws if the spec has no acceptance criteria — the loop can't write
 *         meaningful tests without at least one.
 */
export function parseSpec(rawMarkdown: string): ParsedSpec {
  let body = rawMarkdown;
  const frontmatter: Record<string, string> = {};

  // Frontmatter: `---\n...\n---\n`
  if (body.startsWith('---\n')) {
    const closeIdx = body.indexOf('\n---', 4);
    if (closeIdx > 0) {
      const fmBlock = body.slice(4, closeIdx);
      for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx <= 0) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes if any
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key) frontmatter[key] = value;
      }
      const consumed = closeIdx + '\n---'.length;
      body = body.slice(consumed).replace(/^\n+/, '');
    }
  }

  // Title: prefer frontmatter, fall back to first H1
  let title = frontmatter['title'] ?? '';
  if (!title) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) title = h1Match[1].trim();
  }

  // Acceptance-criteria section — case-insensitive H2
  const lines = body.split('\n');
  const acIdx = lines.findIndex(l =>
    /^##\s+acceptance\s+criteria\s*:?\s*$/i.test(l.trim())
  );

  const acceptanceCriteria: string[] = [];
  let descriptionEnd = lines.length;
  if (acIdx >= 0) {
    descriptionEnd = acIdx;
    // Collect bullets until the next heading or EOF
    for (let i = acIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,6}\s+/.test(line)) break; // next heading
      const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/);
      if (bulletMatch) {
        acceptanceCriteria.push(bulletMatch[1]);
      }
    }
  }

  if (acceptanceCriteria.length === 0) {
    throw new Error(
      'Spec has no acceptance criteria. Add a "## Acceptance criteria" section ' +
      'with bullet points before running the TDD loop.'
    );
  }

  // Description: everything between the first H1 and the AC heading, minus the H1 line itself.
  const descLines = lines.slice(0, descriptionEnd);
  const descBody = descLines
    .filter(l => !/^#\s+/.test(l.trim()))
    .join('\n')
    .trim();

  return { title, description: descBody, acceptanceCriteria, frontmatter };
}

// ---------------------------------------------------------------------------
// Model-output parsing
// ---------------------------------------------------------------------------

/**
 * Parse a model response into proposed file writes.
 *
 * Accepted shapes (in order of preference):
 *   1. Fenced code blocks with a path comment immediately above:
 *
 *      File: tests/unit/foo.test.ts
 *      ```ts
 *      import { describe ... } from 'vitest';
 *      ...
 *      ```
 *
 *   2. ` ```ts path=tests/unit/foo.test.ts ` style attribute:
 *
 *      ```ts path=tests/unit/foo.test.ts
 *      ...
 *      ```
 *
 *   3. A JSON object the model emits inside ` ```json ... ``` `:
 *
 *      ```json
 *      { "files": [{ "path": "tests/unit/foo.test.ts", "content": "..." }] }
 *      ```
 *
 * We never *guess* a path — if a code block has no path indicator, it is
 * silently dropped (operator will see this in the iteration log because
 * `modelRaw` is preserved).
 */
export function parseModelTestResponse(raw: string): ProposedTestFile[] {
  return parseModelFileProposals(raw);
}

/** Same parser as test-writing; semantics are identical (path + content). */
export function parseModelFixResponse(raw: string): ProposedFileChange[] {
  return parseModelFileProposals(raw);
}

function parseModelFileProposals(raw: string): ProposedTestFile[] {
  // Try JSON-first envelope: a single fenced ```json``` block describing files.
  const jsonBlock = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1]);
      if (parsed && Array.isArray(parsed.files)) {
        const out: ProposedTestFile[] = [];
        for (const entry of parsed.files) {
          if (entry && typeof entry.path === 'string' && typeof entry.content === 'string') {
            out.push({ path: normalizeRelativePath(entry.path), content: entry.content });
          }
        }
        if (out.length > 0) return out;
      }
    } catch {
      // Fall through to fenced-block parsing
    }
  }

  // Fenced-block parsing.
  // Matches ```lang [attrs]\n...\n```; capture lang+attrs in group 1, body in 2.
  const fenceRegex = /```([^\n]*)\n([\s\S]*?)\n```/g;
  const out: ProposedTestFile[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const header = match[1].trim();
    const body = match[2];

    // (2) ```ts path=tests/foo.test.ts
    let path: string | null = null;
    const pathAttrMatch = header.match(/(?:^|\s)path=([^\s]+)/);
    if (pathAttrMatch) {
      path = pathAttrMatch[1];
    }

    // (1) preceding-line `File: ...` / `Path: ...`
    if (!path) {
      const before = raw.slice(0, match.index);
      // Look at the last non-empty line preceding the fence
      const beforeLines = before.split('\n').reverse();
      for (const line of beforeLines) {
        const t = line.trim();
        if (!t) continue;
        const fileLineMatch = t.match(/^(?:File|Path|FILE|PATH|file|path)\s*:\s*(.+?)\s*$/);
        if (fileLineMatch) {
          path = fileLineMatch[1].replace(/^[`"']|[`"']$/g, '');
        }
        break; // stop at first non-empty line whether matched or not
      }
    }

    if (path) {
      out.push({ path: normalizeRelativePath(path), content: body });
    }
  }
  return out;
}

function normalizeRelativePath(p: string): string {
  // Strip leading ./ and any absolute prefix; we treat everything as repo-relative
  // and the path-traversal guard rejects `..` inside `applyChangesIfAllowed`.
  let cleaned = p.replace(/\\/g, '/'); // normalize windows-style for safety
  if (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  if (cleaned.startsWith('/')) cleaned = cleaned.replace(/^\/+/, '');
  return cleaned;
}

// ---------------------------------------------------------------------------
// Target-files glob matching
// ---------------------------------------------------------------------------

/**
 * Compile a glob like `src/**\/*.ts` into a regex.
 *
 * Supported tokens:
 *   `**` — any depth of path segments (including zero)
 *   `*`  — any chars except `/`
 *   `?`  — single char except `/`
 *   `{a,b}` — alternation
 *
 * This deliberately covers what the operator will type in --target-files and
 * nothing more; we resist pulling in `minimatch` to keep the no-new-deps rule.
 */
export function compileGlob(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** — any path, optionally with trailing /
        re += '.*';
        i++;
        // Eat the optional trailing / so `src/**/*.ts` matches `src/x.ts`
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const closeIdx = glob.indexOf('}', i);
      if (closeIdx > i) {
        const alts = glob.slice(i + 1, closeIdx).split(',').map(escapeRe).join('|');
        re += `(?:${alts})`;
        i = closeIdx;
      } else {
        re += '\\{';
      }
    } else {
      re += escapeRe(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide whether the fix loop is allowed to write to `relPath`. Tests under
 * the dedicated tests/ root are always rejected by the fix step — the only
 * place tests are written is the test-write phase (iteration #1).
 */
export function isPathTargetable(
  relPath: string,
  targetGlob: string,
): boolean {
  // Reject path-traversal: any segment that resolves outside the repo is
  // unsafe. We treat the presence of `..` as the strongest signal.
  if (relPath.includes('..')) return false;
  // Tests are off-limits for fix-loop writes.
  if (relPath.startsWith('tests/') || relPath.startsWith('tests' + sep)) return false;
  const rx = compileGlob(targetGlob);
  return rx.test(relPath);
}

// ---------------------------------------------------------------------------
// Iteration journal
// ---------------------------------------------------------------------------

/**
 * Append a JSONL entry to the iteration log. The directory is created on the
 * first call (idempotent). We deliberately use append-only writes instead of
 * atomic rewrites so an operator can `tail -f` the file during a long loop.
 */
export function logIteration(logPath: string, entry: IterationLogEntry): void {
  ensureDir(dirname(logPath));
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
}

/**
 * Read all completed iterations from the JSONL log. Returns [] when the file
 * doesn't exist (first run). Used by `runTddLoop` for `runId` resume.
 */
export function readIterationLog(logPath: string): IterationLogEntry[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8');
  const out: IterationLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines — operator can `jq` to diagnose later.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main loop driver
// ---------------------------------------------------------------------------

/**
 * Drive a full TDD loop. Returns the run summary; the caller (CLI) is
 * responsible for surfacing the message + exit code to the operator.
 *
 * Idempotent resume: if `runDir` already has an `iterations.jsonl`, the loop
 * counts those iterations against `maxIterations` and continues from the
 * next number. The fix-loop is the only step that can be resumed — if the
 * previous run terminated after step 1 (test-write) and the operator wants
 * to start again, the resume picks up at the test-run step (no second
 * test-write).
 */
export async function runTddLoop(opts: TddLoopOptions): Promise<RunResult> {
  const {
    specPath,
    runDir,
    repoRoot,
    targetFilesGlob = 'src/**/*.ts',
    maxIterations = 10,
    preTestsOnly = false,
    dryRun = false,
    modelInvoker,
    testRunner,
    collectSourceFiles,
  } = opts;

  ensureDir(runDir);
  const logPath = join(runDir, 'iterations.jsonl');
  const resultPath = join(runDir, 'result.json');

  // ----- Spec parse -----
  if (!existsSync(specPath)) {
    throw new Error(`spec not found: ${specPath}`);
  }
  const specRaw = readFileSync(specPath, 'utf-8');
  const spec = parseSpec(specRaw);

  // Resume state
  const prior = readIterationLog(logPath);
  const testFilesWritten: string[] = [];
  const sourceFilesModified: string[] = [];
  let testsAlreadyWritten = false;
  let lastExitCode: number | undefined;
  for (const entry of prior) {
    if (entry.phase === 'write-tests') {
      testsAlreadyWritten = true;
      for (const f of entry.files) {
        if (!testFilesWritten.includes(f)) testFilesWritten.push(f);
      }
    } else if (entry.phase === 'fix') {
      for (const f of entry.files) {
        if (!sourceFilesModified.includes(f)) sourceFilesModified.push(f);
      }
    } else if (entry.phase === 'run-tests') {
      lastExitCode = entry.exitCode;
    }
  }

  // Only the action phases (write-tests, run-tests, fix) count as iterations;
  // terminal markers (done, cap-reached, rejected) are closing log entries.
  // Otherwise a resumed loop would double-count the previous run's terminator.
  const actionPhases = new Set(['write-tests', 'run-tests', 'fix']);
  let iterationCounter = prior.filter(e => actionPhases.has(e.phase)).length;

  // ----- Iteration 1 (or skipped on resume): write tests -----
  if (!testsAlreadyWritten) {
    iterationCounter += 1;
    const prompt = buildWriteTestsPrompt(spec, repoRoot);
    const result = await modelInvoker('write-tests', prompt, { spec });
    const proposals = parseModelTestResponse(result.raw);

    // Tests must land under tests/. Strip any proposal that tries to write
    // outside that root — that's the only place tests are allowed.
    const accepted: ProposedTestFile[] = [];
    const rejected: string[] = [];
    for (const p of proposals) {
      if (p.path.startsWith('tests/')) {
        accepted.push(p);
      } else {
        rejected.push(p.path);
      }
    }

    if (!dryRun) {
      for (const f of accepted) {
        const abs = resolveSafePath(repoRoot, f.path);
        atomicWriteSync(abs, f.content);
        if (!testFilesWritten.includes(f.path)) testFilesWritten.push(f.path);
      }
    }

    logIteration(logPath, {
      iteration: iterationCounter,
      ts: new Date().toISOString(),
      phase: 'write-tests',
      files: accepted.map(f => f.path),
      message: rejected.length > 0
        ? `wrote ${accepted.length} test files; rejected ${rejected.length} (outside tests/)`
        : `wrote ${accepted.length} test files`,
      modelRaw: result.raw,
    });

    if (accepted.length === 0) {
      const message = 'model did not propose any test files — aborting';
      const result: RunResult = {
        status: 'rejected',
        iterations: iterationCounter,
        logPath,
        resultPath,
        testFilesWritten,
        sourceFilesModified,
        message,
      };
      writeResult(resultPath, result);
      return result;
    }
  }

  if (dryRun) {
    const result: RunResult = {
      status: 'dry_run',
      iterations: iterationCounter,
      logPath,
      resultPath,
      testFilesWritten,
      sourceFilesModified,
      message: 'dry run — no files written, no tests executed',
    };
    writeResult(resultPath, result);
    return result;
  }

  if (preTestsOnly) {
    const result: RunResult = {
      status: 'pre_tests_only',
      iterations: iterationCounter,
      logPath,
      resultPath,
      testFilesWritten,
      sourceFilesModified,
      message: 'pre-tests-only — stopped after test scaffolding',
    };
    writeResult(resultPath, result);
    return result;
  }

  // ----- Iterate: run tests; on failure, ask model to fix -----
  while (iterationCounter < maxIterations) {
    // Run tests
    iterationCounter += 1;
    const testRun = testRunner();
    lastExitCode = testRun.exitCode;
    logIteration(logPath, {
      iteration: iterationCounter,
      ts: new Date().toISOString(),
      phase: 'run-tests',
      files: [],
      exitCode: testRun.exitCode,
      message: testRun.exitCode === 0 ? 'tests green' : 'tests red',
    });

    if (testRun.exitCode === 0 && testFilesWritten.length > 0) {
      const success: RunResult = {
        status: 'success',
        iterations: iterationCounter,
        logPath,
        resultPath,
        lastExitCode,
        testFilesWritten,
        sourceFilesModified,
        message: `all tests green after ${iterationCounter} iterations`,
      };
      logIteration(logPath, {
        iteration: iterationCounter,
        ts: new Date().toISOString(),
        phase: 'done',
        files: [],
        message: success.message,
      });
      writeResult(resultPath, success);
      return success;
    }

    if (iterationCounter >= maxIterations) break;

    // Fix step
    iterationCounter += 1;
    const sourceFiles = collectSourceFiles ? collectSourceFiles() : [];
    const sourceSnippets: Record<string, string> = {};
    for (const sf of sourceFiles) {
      try {
        const abs = resolveSafePath(repoRoot, sf);
        if (existsSync(abs) && statSync(abs).isFile()) {
          sourceSnippets[sf] = readFileSync(abs, 'utf-8');
        }
      } catch {
        // Skip unreadable files silently — the model can still propose new ones.
      }
    }

    const testFileSnippets: Record<string, string> = {};
    for (const tf of testFilesWritten) {
      try {
        const abs = resolveSafePath(repoRoot, tf);
        if (existsSync(abs)) testFileSnippets[tf] = readFileSync(abs, 'utf-8');
      } catch {
        // Ignore
      }
    }

    const fixPrompt = buildFixPrompt(spec, testRun, testFileSnippets, sourceSnippets, targetFilesGlob);
    const fixResult = await modelInvoker('fix', fixPrompt, {
      spec,
      lastFailureStdout: testRun.stdout,
      lastFailureStderr: testRun.stderr,
    });
    const fixProposals = parseModelFixResponse(fixResult.raw);

    const accepted: ProposedFileChange[] = [];
    const rejected: string[] = [];
    for (const p of fixProposals) {
      if (isPathTargetable(p.path, targetFilesGlob)) {
        accepted.push(p);
      } else {
        rejected.push(p.path);
      }
    }

    for (const f of accepted) {
      const abs = resolveSafePath(repoRoot, f.path);
      atomicWriteSync(abs, f.content);
      if (!sourceFilesModified.includes(f.path)) sourceFilesModified.push(f.path);
    }

    logIteration(logPath, {
      iteration: iterationCounter,
      ts: new Date().toISOString(),
      phase: 'fix',
      files: accepted.map(f => f.path),
      message: rejected.length > 0
        ? `applied ${accepted.length} patches; rejected ${rejected.length} (outside --target-files)`
        : `applied ${accepted.length} patches`,
      modelRaw: fixResult.raw,
    });

    if (accepted.length === 0) {
      // Model failed to propose targeted patches; stop early rather than spin
      // through the cap pointlessly.
      const result: RunResult = {
        status: 'rejected',
        iterations: iterationCounter,
        logPath,
        resultPath,
        lastExitCode,
        testFilesWritten,
        sourceFilesModified,
        message: rejected.length > 0
          ? `model proposed patches only outside --target-files (${rejected.join(', ')})`
          : 'model proposed no patches',
      };
      writeResult(resultPath, result);
      return result;
    }
  }

  // Cap hit.
  const capHit: RunResult = {
    status: 'cap_reached',
    iterations: iterationCounter,
    logPath,
    resultPath,
    lastExitCode,
    testFilesWritten,
    sourceFilesModified,
    message: `max-iterations cap (${maxIterations}) reached`,
  };
  logIteration(logPath, {
    iteration: iterationCounter,
    ts: new Date().toISOString(),
    phase: 'cap-reached',
    files: [],
    exitCode: lastExitCode,
    message: capHit.message,
  });
  writeResult(resultPath, capHit);
  return capHit;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a repo-relative path safely. Throws if the resolved absolute path
 * escapes `repoRoot` (path-traversal guard). The fix-loop's glob check is
 * the primary defence; this is a belt-and-suspenders backup.
 */
function resolveSafePath(repoRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(`absolute paths are not allowed: ${relPath}`);
  }
  const abs = resolve(repoRoot, relPath);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes repo root: ${relPath}`);
  }
  return abs;
}

function writeResult(resultPath: string, result: RunResult): void {
  mkdirSync(dirname(resultPath), { recursive: true });
  atomicWriteSync(resultPath, JSON.stringify(result, null, 2));
}

/**
 * Build the prompt for iteration #1 (test-writing). Deliberately verbose
 * about the output shape so the model returns parseable fenced blocks.
 */
export function buildWriteTestsPrompt(spec: ParsedSpec, repoRoot: string): string {
  const acBlock = spec.acceptanceCriteria.map((b, i) => `${i + 1}. ${b}`).join('\n');
  return `You are writing FAILING vitest tests for a new feature.

Repo root: ${repoRoot}
Feature title: ${spec.title || '(untitled)'}
Description:
${spec.description || '(none)'}

Acceptance criteria:
${acBlock}

Write one or more vitest test files under \`tests/unit/\`. Choose path(s) that
reflect the feature area. Do NOT write the implementation — only the failing
tests. Each test must assert one acceptance criterion.

OUTPUT FORMAT — return each file as:

File: tests/unit/<area>/<name>.test.ts
\`\`\`ts
<file contents>
\`\`\`

You may return multiple files. Do not include any other prose.`;
}

/**
 * Build the prompt for fix-loop iterations.
 */
export function buildFixPrompt(
  spec: ParsedSpec,
  testRun: TestRunResult,
  testFiles: Record<string, string>,
  sourceFiles: Record<string, string>,
  targetGlob: string,
): string {
  const acBlock = spec.acceptanceCriteria.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const testFileBlock = Object.entries(testFiles)
    .map(([path, content]) => `File: ${path}\n\`\`\`ts\n${content}\n\`\`\``)
    .join('\n\n');
  const sourceFileBlock = Object.entries(sourceFiles)
    .map(([path, content]) => `File: ${path}\n\`\`\`ts\n${content}\n\`\`\``)
    .join('\n\n');
  const tail = (s: string, n = 4000) => s.length > n ? s.slice(-n) : s;
  return `Vitest is failing. Patch the source files to make the tests green.

Feature: ${spec.title || '(untitled)'}
Acceptance criteria:
${acBlock}

Test runner stderr (tail):
${tail(testRun.stderr) || '(empty)'}

Test runner stdout (tail):
${tail(testRun.stdout) || '(empty)'}

Current test files:
${testFileBlock || '(none readable)'}

Current source files within --target-files (${targetGlob}):
${sourceFileBlock || '(none readable — propose new files inside the glob)'}

CONSTRAINTS:
- You may only modify files matching: ${targetGlob}
- Do NOT modify files under tests/.
- Return FULL FILE REPLACEMENTS, one per file you want to write.

OUTPUT FORMAT:

File: src/<path>.ts
\`\`\`ts
<full new file contents>
\`\`\`

You may return multiple files. Do not include any other prose.`;
}
