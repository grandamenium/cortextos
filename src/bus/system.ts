import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { readdirSync } from 'fs';
import { ensureDir } from '../utils/atomic.js';
import { TelegramAPI } from '../telegram/api.js';
import type { BusPaths } from '../types/index.js';

// --- Types ---

export interface AutoCommitReport {
  // 'not_a_repo' added 2026-08-13. Previously a failure to resolve the git root
  // returned 'clean', which is indistinguishable from "resolved fine, nothing to do".
  // That ambiguity is the silent-success class: a broken invocation reported the same
  // thing as a healthy no-op. Callers can now tell them apart.
  status: 'staged' | 'clean' | 'nothing_to_stage' | 'dry_run' | 'not_a_repo';
  staged: string[];
  blocked: string[];
  diff_stat?: string;
  error?: string;
}

export interface AgentGoalStatus {
  agent: string;
  org: string;
  status: 'fresh' | 'stale' | 'missing' | 'no_timestamp' | 'parse_error';
  updated?: string;
  age_days?: number;
  stale: boolean;
  reason?: string;
}

export interface GoalStalenessReport {
  summary: { total: number; stale: number; fresh: number; threshold_days: number };
  agents: AgentGoalStatus[];
}

// --- Blocked file patterns ---

const BINARY_TEMP_EXTENSIONS = new Set([
  '.log', '.tmp', '.pid', '.pyc', '.pyo', '.class', '.o', '.so', '.dylib',
]);

const EXCLUDED_DIR_PREFIXES = [
  'telegram-images/',
  'node_modules/',
  '__pycache__/',
  '.venv/',
];

// `sk-` was an unanchored substring: it matched INSIDE ordinary words — "disk-",
// "task-", "risk-", "desk-" — so agent memory files (full of "task-" ids) were all
// blocked as credential leaks. Anchored to a word start and required to be followed
// by real key material, which tightens false positives without losing real sk- keys.
//
// Case-insensitive AND value-shaped, as of 2026-08-13 (second revision).
//
// The bare `key=` / `token=` alternatives were unanchored substrings, so they matched
// inside `monkey=`, `sortKey=`, `?apiKey=`. Adding /i alone made that far worse: an
// adversarial re-review measured it across all 389 non-script files in the estate and
// found 19 NEWLY blocked — every one a doc that merely MENTIONS a variable name, e.g.
// `BOT_TOKEN=<token from BotFather>` and `grep -q "^GEMINI_API_KEY=."`. Several are
// mandatory session-start reads, so they could never be auto-committed again.
//
// The "false positives are cheap" reasoning was wrong: 19 nightly hits reported as
// credential_pattern_detected are indistinguishable from one real leak, which destroys
// the signal the check exists to give. So require a word boundary AND an actual
// secret-shaped VALUE (12+ chars of key material), which excludes placeholders like
// `<token from BotFather>`, `.`, and `value`.
const CREDENTIAL_PATTERNS = new RegExp(
  [
    // NAME=VALUE, but only when the value looks like real key material
    // `:` is in the value class because Telegram bot tokens are `<digits>:<alnum>`,
    // which is the single most likely real secret in THIS estate.
    //
    // The leading group exists because `\b` DOES NOT FIRE on an underscore — `_` is a
    // word character, so `\btoken` never matches inside `TELEGRAM_BOT_TOKEN=`, the most
    // realistic variable name here. Allowing any number of `WORD_` / `WORD-` prefix
    // segments fixes that, while still rejecting `monkey=` and `sortKey=`, where the
    // prefix does not end in a separator.
    //
    // THE SEPARATORS AROUND `=` ARE `[ \t]`, NOT `\s` (fixed 2026-08-13, third revision).
    // `\s` MATCHES A NEWLINE, so `\s*=\s*` let the match run past the end of the line and
    // consume the NEXT VARIABLE'S NAME as if it were this variable's value. An ordinary
    // blank-valued template —
    //     ACTIVITY_BOT_TOKEN=
    //     ACTIVITY_CHAT_ID=
    // — matched on the literal text `ACTIVITY_BOT_TOKEN=\nACTIVITY_CHAT_ID`, because
    // `ACTIVITY_CHAT_ID` is 16 characters of the value class. Every `.env.example`, every
    // setup doc, and every empty-valued config template was therefore a standing false
    // positive, and the scanner reported them as credential_pattern_detected forever.
    // Measured over the same 389-file corpus: 5 matches before, 4 after; the only file
    // cleared is the false positive, and all four real credential stores still match.
    // A credential never legitimately begins on the line after its `=`.
    String.raw`(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|auth[_-]?token|access[_-]?token|bot[_-]?token|secret[_-]?key|token|password|passwd|secret)[ \t]*=[ \t]*['"]?[A-Za-z0-9_\-\/+.:]{12,}`,
    // Vendor-prefixed keys are self-identifying — no value shape needed beyond length
    String.raw`\bsk-[A-Za-z0-9_-]{8,}`,
    String.raw`\bsk_(?:live|test)_[A-Za-z0-9]{8,}`,
    String.raw`\bghp_[A-Za-z0-9]{8,}`,
    String.raw`\bxoxb-[A-Za-z0-9-]{8,}`,
    String.raw`\bAKIA[A-Z0-9]{12,}`,
  ].join('|'),
  'i',
);

const SCRIPT_EXTENSIONS = new Set(['.sh', '.py', '.js']);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Functions ---

/**
 * Plan a self-restart. Creates a marker file and logs the reason.
 * The daemon handles the actual restart via IPC.
 * Mirrors bash bus/self-restart.sh.
 */
export function selfRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create restart marker
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] SELF-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Plan a hard restart (fresh session, no --continue).
 * Creates .force-fresh marker file; daemon checks this on next restart.
 * Mirrors bash bus/hard-restart.sh.
 */
export function hardRestart(paths: BusPaths, agentName: string, reason?: string): void {
  const resolvedReason = reason || 'no reason specified';

  // Create force-fresh marker (agent-process.ts checks this on restart)
  ensureDir(paths.stateDir);
  writeFileSync(join(paths.stateDir, '.force-fresh'), resolvedReason + '\n', 'utf-8');

  // Also create restart marker so crash-alert knows it was planned
  writeFileSync(join(paths.stateDir, '.restart-planned'), resolvedReason + '\n', 'utf-8');

  // Append to restarts.log
  ensureDir(paths.logDir);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const logLine = `[${timestamp}] HARD-RESTART: ${resolvedReason}\n`;
  appendFileSync(join(paths.logDir, 'restarts.log'), logLine, 'utf-8');
}

/**
 * Stage safe files at the git repo root CONTAINING `projectDir`.
 *
 * Resolves upward to the toplevel and operates there — `git status --porcelain`
 * emits repo-root-relative paths, so pointing this at a subdirectory would make
 * every existsSync() guard below miss, silently disabling the credential and size
 * checks while still returning success.
 *
 * Filters out credentials, .env, oversized and binary files. Never pushes.
 * Returns 'not_a_repo' — NOT 'clean' — when the root cannot be resolved, so a
 * broken invocation is distinguishable from a healthy no-op.
 */
export function autoCommit(projectDir: string, dryRun: boolean = false): AutoCommitReport {
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { cwd: projectDir, encoding: 'utf-8' }).trim();
  } catch (err) {
    // Do NOT report 'clean' here. Reaching this branch means the directory does not
    // exist or is not a work tree — the caller asked about something unusable, which
    // is a different fact from "resolved fine, nothing to commit". Conflating them is
    // how a silent success hides a broken invocation.
    return {
      status: 'not_a_repo',
      staged: [],
      blocked: [],
      error: `could not resolve a git repo at ${projectDir}: ${(err as Error).message?.split('\n')[0] ?? 'unknown'}`,
    };
  }
  if (!repoRoot) {
    return { status: 'not_a_repo', staged: [], blocked: [], error: `empty toplevel for ${projectDir}` };
  }
  projectDir = repoRoot;

  // Get changed files.
  //
  // `-z` is REQUIRED, not a nicety. Without it git quotes any path containing a
  // space or non-ASCII character (emitting a literal `"has space.txt"`), and renames
  // arrive as `R  old -> new` on one line. The previous `line.slice(3)` handed both
  // straight through, producing entries like `a.txt -> b.txt` and `"has space.txt"`
  // that then FAILED `git add` — and the failure was swallowed by an empty catch, so
  // the report listed files it had not staged. Worse, existsSync() is false for those
  // mangled paths, which SKIPPED the credential scan and the 10MB check for exactly
  // the files most likely to need them.
  //
  // With -z: entries are NUL-terminated and never quoted. A rename/copy emits TWO
  // NUL-separated fields — `XY new` then `old` — so the extra field must be consumed.
  let porcelainOutput: string;
  try {
    // `-uall` is a SECURITY requirement, not verbosity. By default git collapses an
    // untracked directory to a single `?? nested/` entry. That directory then gets
    // staged as one unit — and because statSync(dir).isFile() is false, the credential
    // scan and the 10MB check are BOTH SKIPPED for every file inside it. A brand-new
    // folder containing an API key would be staged unscanned. Found 2026-08-13 by a
    // regression test written for the -z change, which failed for this reason.
    porcelainOutput = execSync('git status --porcelain -z -uall', { cwd: projectDir, encoding: 'utf-8' });
  } catch (err) {
    return {
      status: 'not_a_repo',
      staged: [],
      blocked: [],
      error: `git status failed in ${projectDir}: ${(err as Error).message?.split('\n')[0] ?? 'unknown'}`,
    };
  }

  if (!porcelainOutput.trim()) {
    return { status: 'clean', staged: [], blocked: [] };
  }

  const fields = porcelainOutput.split('\0').filter(f => f.length > 0);
  const changedFiles: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    changedFiles.push(entry.slice(3));
    // Rename/copy: the ORIGINAL path follows as its own field. Consume it so it is
    // not mistaken for a status entry and sliced into nonsense.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;
  }

  const staged: string[] = [];
  const blocked: string[] = [];

  for (const file of changedFiles) {
    if (!file) continue;

    // Block .env files
    if (file.endsWith('.env') || file.includes('/.env')) {
      blocked.push(`${file}:contains_credentials`);
      continue;
    }

    // Block .cortextos-env
    if (file === '.cortextos-env' || file.endsWith('/.cortextos-env')) {
      blocked.push(`${file}:runtime_env`);
      continue;
    }

    // Block binary/temp extensions
    const ext = extname(file);
    if (BINARY_TEMP_EXTENSIONS.has(ext)) {
      blocked.push(`${file}:binary_or_temp`);
      continue;
    }

    // Block excluded directories
    if (EXCLUDED_DIR_PREFIXES.some(prefix => file.startsWith(prefix))) {
      blocked.push(`${file}:excluded_directory`);
      continue;
    }

    const fullPath = join(projectDir, file);

    // Block files over 10MB
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE) {
          blocked.push(`${file}:over_10MB`);
          continue;
        }
      } catch {
        // If can't stat, still try to stage
      }
    }

    // Check credential patterns in non-script file content
    if (existsSync(fullPath) && !SCRIPT_EXTENSIONS.has(ext)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < MAX_FILE_SIZE) {
          const content = readFileSync(fullPath, 'utf-8');
          if (CREDENTIAL_PATTERNS.test(content)) {
            blocked.push(`${file}:credential_pattern_detected`);
            continue;
          }
        }
      } catch {
        // Binary files may throw on utf-8 read - skip credential check
      }
    }

    staged.push(file);
  }

  if (staged.length === 0) {
    return { status: 'nothing_to_stage', staged: [], blocked };
  }

  if (dryRun) {
    return { status: 'dry_run', staged, blocked };
  }

  // Stage safe files.
  //
  // A failed `git add` used to be swallowed while the path stayed in `staged`, so the
  // returned report was a statement of INTENT, not of fact — it listed files that were
  // never staged, and its own diff_stat contradicted it. Report only what actually
  // staged, and surface the rest as blocked so a failure is visible instead of silent.
  const actuallyStaged: string[] = [];
  for (const file of staged) {
    try {
      execFileSync('git', ['add', '--', file], { cwd: projectDir, stdio: 'pipe' });
      actuallyStaged.push(file);
    } catch (err) {
      blocked.push(`${file}:git_add_failed`);
    }
  }

  if (actuallyStaged.length === 0) {
    return { status: 'nothing_to_stage', staged: [], blocked };
  }

  // Get diff stat
  let diffStat: string | undefined;
  try {
    const stat = execSync('git diff --cached --stat', { cwd: projectDir, encoding: 'utf-8' });
    const lines = stat.trim().split('\n');
    diffStat = lines[lines.length - 1]?.trim() || undefined;
  } catch {
    // Ignore
  }

  return { status: 'staged', staged: actuallyStaged, blocked, diff_stat: diffStat };
}

/**
 * Check goal staleness for all agents across all orgs.
 * Mirrors bash bus/check-goal-staleness.sh.
 */
export function checkGoalStaleness(
  projectRoot: string,
  thresholdDays: number = 7,
): GoalStalenessReport {
  const agents: AgentGoalStatus[] = [];
  const thresholdMs = thresholdDays * 86400 * 1000;
  const now = Date.now();

  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) {
    return {
      summary: { total: 0, stale: 0, fresh: 0, threshold_days: thresholdDays },
      agents: [],
    };
  }

  let orgNames: string[];
  try {
    orgNames = readdirSync(orgsDir).filter(name => {
      try {
        return statSync(join(orgsDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    orgNames = [];
  }

  for (const orgName of orgNames) {
    const agentsDir = join(orgsDir, orgName, 'agents');
    if (!existsSync(agentsDir)) continue;

    let agentNames: string[];
    try {
      agentNames = readdirSync(agentsDir).filter(name => {
        // Validate agent name (lowercase, numbers, hyphens, underscores)
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        try {
          return statSync(join(agentsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const agentName of agentNames) {
      const goalsFile = join(agentsDir, agentName, 'GOALS.md');

      if (!existsSync(goalsFile)) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'no GOALS.md file',
        });
        continue;
      }

      // Read and parse GOALS.md
      let content: string;
      try {
        content = readFileSync(goalsFile, 'utf-8');
      } catch {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'missing',
          stale: true,
          reason: 'could not read GOALS.md',
        });
        continue;
      }

      // Find "## Updated" section and get the next line
      const lines = content.split('\n');
      let updatedLine: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('## Updated')) {
          // Get next non-empty line
          for (let j = i + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed && !trimmed.startsWith('##')) {
              updatedLine = trimmed;
              break;
            }
          }
          break;
        }
      }

      if (!updatedLine) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'no_timestamp',
          stale: true,
          reason: 'no Updated timestamp in GOALS.md',
        });
        continue;
      }

      // Parse ISO 8601 timestamp
      const parsedDate = new Date(updatedLine);
      if (isNaN(parsedDate.getTime())) {
        agents.push({
          agent: agentName,
          org: orgName,
          status: 'parse_error',
          updated: updatedLine,
          stale: true,
          reason: 'could not parse timestamp',
        });
        continue;
      }

      const ageMs = now - parsedDate.getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const isStale = ageMs > thresholdMs;

      agents.push({
        agent: agentName,
        org: orgName,
        status: isStale ? 'stale' : 'fresh',
        updated: updatedLine,
        age_days: ageDays,
        stale: isStale,
        reason: isStale
          ? `${ageDays} days since last update (threshold: ${thresholdDays})`
          : undefined,
      });
    }
  }

  const total = agents.length;
  const staleCount = agents.filter(a => a.stale).length;
  const freshCount = agents.filter(a => !a.stale).length;

  return {
    summary: {
      total,
      stale: staleCount,
      fresh: freshCount,
      threshold_days: thresholdDays,
    },
    agents,
  };
}

/**
 * Post a message to the org's Telegram activity channel.
 *
 * Returns false if not configured (silent fail — callers can ignore the
 * return value and treat activity-channel posting as best-effort).
 *
 * `replyMarkup` is an optional Telegram inline keyboard (or any reply
 * markup shape). When provided, the message ships with the keyboard
 * attached — used for interactive workflows like approval Approve/Deny
 * buttons posted alongside approval creation. Leaving it undefined
 * preserves the prior one-way notification shape exactly.
 *
 * Mirrors bash bus/post-activity.sh.
 */
export async function postActivity(
  orgDir: string,
  ctxRoot: string,
  org: string,
  message: string,
  replyMarkup?: object,
): Promise<boolean> {
  // Look for activity-channel.env
  const candidates = [
    join(orgDir, 'activity-channel.env'),
    join(ctxRoot, 'orgs', org, 'activity-channel.env'),
  ];

  let configPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    return false;
  }

  // Parse the env file
  let botToken: string | undefined;
  let chatId: string | undefined;

  try {
    const content = readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'ACTIVITY_BOT_TOKEN') botToken = value;
      if (key === 'ACTIVITY_CHAT_ID') chatId = value;
    }
  } catch {
    return false;
  }

  if (!botToken || !chatId) {
    return false;
  }

  try {
    const api = new TelegramAPI(botToken);
    await api.sendMessage(chatId, message, replyMarkup);
    return true;
  } catch {
    return false;
  }
}
