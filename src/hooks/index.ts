/**
 * Shared utility functions for Claude Code hook scripts.
 * Each hook reads JSON from stdin, processes it, and writes JSON to stdout.
 */

import { readFileSync, existsSync, watch, statSync, unlinkSync, mkdirSync, realpathSync, lstatSync } from 'fs';
import { join, resolve, sep, dirname, basename } from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';

/**
 * Read all data from stdin as a string.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer<ArrayBufferLike>[] = [];
    process.stdin.on('data', (chunk: Buffer<ArrayBufferLike>) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Parse hook input JSON into tool_name and tool_input.
 */
export function parseHookInput(input: string): { tool_name: string; tool_input: any } {
  try {
    const parsed = JSON.parse(input);
    return {
      tool_name: parsed.tool_name || 'unknown',
      tool_input: parsed.tool_input || {},
    };
  } catch {
    return { tool_name: 'unknown', tool_input: {} };
  }
}

/**
 * Load environment variables for hook scripts.
 * Reads BOT_TOKEN and CHAT_ID from .env file in cwd or CTX_AGENT_DIR.
 */
export function loadEnv(): {
  botToken?: string;
  chatId?: string;
  agentName: string;
  stateDir: string;
  ctxRoot: string;
} {
  const agentName = process.env.CTX_AGENT_NAME || require('path').basename(process.cwd());
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);

  // Try to load .env file
  const envPaths = [
    process.env.CTX_AGENT_DIR ? join(process.env.CTX_AGENT_DIR, '.env') : null,
    join(process.cwd(), '.env'),
  ].filter(Boolean) as string[];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }

  return {
    botToken: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    agentName,
    stateDir,
    ctxRoot,
  };
}

/**
 * Write a PermissionRequest decision to stdout and exit.
 */
export function outputDecision(behavior: 'allow' | 'deny', message?: string): void {
  const decision: any = { behavior };
  if (message) decision.message = message;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

/**
 * Generate a unique hex ID for hook requests.
 */
export function generateId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Wait for a response file to appear, using fs.watch with a poll fallback.
 * Returns the file content or null on timeout.
 */
export function waitForResponseFile(filePath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const dir = require('path').dirname(filePath);
    const fileName = require('path').basename(filePath);

    mkdirSync(dir, { recursive: true });

    let resolved = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (watcher) { try { watcher.close(); } catch {} }
      if (pollInterval) clearInterval(pollInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const checkFile = () => {
      if (resolved) return;
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          cleanup();
          resolve(content);
        }
      } catch {
        // File might be mid-write, try again next poll
      }
    };

    // Check immediately
    checkFile();
    if (resolved) return;

    // Set up fs.watch
    try {
      watcher = watch(dir, (eventType: string, filename: string | null) => {
        if (filename === fileName || !filename) {
          checkFile();
        }
      });
      watcher.on('error', () => {
        // Fall through to poll
      });
    } catch {
      // fs.watch not available, poll only
    }

    // Poll fallback every 2 seconds
    pollInterval = setInterval(checkFile, 2000);

    // Timeout
    timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Format a tool summary for human-readable display.
 */
export function formatToolSummary(toolName: string, toolInput: any): string {
  switch (toolName) {
    case 'Edit': {
      const filePath = toolInput.file_path || 'unknown';
      const oldStr = String(toolInput.old_string || '').slice(0, 300);
      const newStr = String(toolInput.new_string || '').slice(0, 300);
      return `File: ${filePath}\n\n- ${oldStr}\n+ ${newStr}`;
    }
    case 'Write': {
      const filePath = toolInput.file_path || 'unknown';
      const content = String(toolInput.content || '').slice(0, 300);
      return `File: ${filePath}\n\n${content}`;
    }
    case 'Bash': {
      // Show enough of the command for the human approver to judge it. A 200-char
      // cap let a benign-looking prefix hide a malicious payload past the cut
      // (#39); the message-level cap still bounds Telegram length. Mark truncation
      // explicitly so the reviewer knows more of the command will run.
      const command = String(toolInput.command || '');
      const shown = command.slice(0, 1500);
      const more = command.length > shown.length ? '\n…(preview truncated — the FULL command, not just this preview, runs if you approve)' : '';
      return `Command: ${shown}${more}`;
    }
    default: {
      return JSON.stringify(toolInput).slice(0, 200);
    }
  }
}

/**
 * Whether a tool operation may be auto-approved because it edits the agent's
 * OWN `.claude/` directory (config/skills the agent legitimately manages at
 * runtime). Under `bypassPermissions` this hook is the only approval gate, so
 * this check must be precise — not a substring match.
 *
 * - Bash is NEVER auto-approved: a shell command string cannot be proven to act
 *   solely within `.claude/` (e.g. `rm -rf ~; ls .claude/` contains the
 *   substring), so it always goes to the human gate (#1/#15).
 * - Edit/Write is auto-approved only when the file_path, resolved to an
 *   absolute normalized path, is genuinely contained within THIS agent's
 *   `<agentDir>/.claude/` — defeating `..` traversal and other agents' /
 *   arbitrary `.claude/` directories (#18).
 *
 * Symlinks are resolved on the deepest existing ancestor (the Write target
 * itself may not exist yet), so a symlink inside `.claude` that points out of
 * the tree cannot be used to escape — matching the shell hook's `realpath -m`.
 * A symlinked `.claude` root is rejected outright (it would redirect the gate
 * to an arbitrary directory). There is NO cwd fallback: without an explicit
 * agent-dir trust boundary the operation is not auto-approved.
 *
 * @param agentDir Base directory of the agent. Defaults to CTX_AGENT_DIR; if
 *   neither is available, returns false (the request goes to the human gate).
 */
export function isClaudeDirOperation(
  toolName: string,
  toolInput: any,
  agentDir?: string,
): boolean {
  if (toolName !== 'Edit' && toolName !== 'Write') return false;
  const filePath = toolInput?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return false;

  // Require an explicit trust boundary — never fall back to cwd, which would let
  // the auto-approve scope drift to whatever directory the hook started in.
  const base = agentDir ?? process.env.CTX_AGENT_DIR;
  if (!base) return false;

  // Canonicalize the agent dir first (resolves legitimate symlinks on the install
  // path, e.g. /tmp -> /private/tmp), so the .claude subtree below it is the only
  // thing left to vet.
  const canonAgentDir = canonicalizePath(resolve(base));
  const claudeRoot = join(canonAgentDir, '.claude');
  const target = resolve(canonAgentDir, filePath);

  // Lexical containment within the agent's own .claude/.
  if (target !== claudeRoot && !target.startsWith(claudeRoot + sep)) return false;

  // Reject if any component at or below .claude is a symlink — live OR dangling.
  // A planted symlink could otherwise redirect an "inside .claude" write out of
  // the tree. We lstat each component because realpathSync can't observe a
  // *dangling* symlink (it throws, and canonicalize would fall back to lexical).
  return !hasSymlinkComponent(canonAgentDir, target);
}

/**
 * Whether any path component strictly below `rootDir` (assumed already
 * canonical) up to and including `target` is a symlink (live or dangling).
 * Stops at the first non-existent component — a name that doesn't exist yet
 * cannot be a symlink, and deeper components can't exist under it.
 */
function hasSymlinkComponent(rootDir: string, target: string): boolean {
  if (!target.startsWith(rootDir + sep)) return false;
  const rel = target.slice(rootDir.length + 1);
  let cur = rootDir;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

/**
 * Canonicalize an absolute path, resolving symlinks. Because the target may not
 * exist yet (e.g. a Write that creates a new file), we realpath the deepest
 * existing ancestor — which resolves any symlinked component — then re-append
 * the non-existent tail. Falls back to the lexical path if nothing exists.
 */
function canonicalizePath(p: string): string {
  let dir = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p; // reached fs root, nothing on the path exists
      tail.push(basename(dir));
      dir = parent;
    }
  }
}

/**
 * Sanitize text for use inside Telegram code blocks.
 * Escapes triple backticks.
 */
export function sanitizeCodeBlock(text: string): string {
  return text.replace(/```/g, '``\\`');
}

/**
 * Build an inline keyboard for Telegram permission requests.
 */
export function buildPermissionKeyboard(uniqueId: string): object {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `perm_allow_${uniqueId}` },
      { text: 'Deny', callback_data: `perm_deny_${uniqueId}` },
    ]],
  };
}

/**
 * Build an inline keyboard for Telegram plan review.
 */
export function buildPlanKeyboard(uniqueId: string): object {
  return {
    inline_keyboard: [[
      { text: 'Approve Plan', callback_data: `perm_allow_${uniqueId}` },
      { text: 'Deny Plan', callback_data: `perm_deny_${uniqueId}` },
    ]],
  };
}

/**
 * Build keyboard for ask-question (single-select).
 */
export function buildAskSingleSelectKeyboard(
  questionIdx: number,
  options: string[],
): object {
  return {
    inline_keyboard: options.map((label, optIdx) => [
      { text: label, callback_data: `askopt_${questionIdx}_${optIdx}` },
    ]),
  };
}

/**
 * Build keyboard for ask-question (multi-select).
 */
export function buildAskMultiSelectKeyboard(
  questionIdx: number,
  options: string[],
): object {
  return {
    inline_keyboard: [
      ...options.map((label, optIdx) => [
        { text: label, callback_data: `asktoggle_${questionIdx}_${optIdx}` },
      ]),
      [{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }],
    ],
  };
}

/**
 * Build ask-state structure from questions array.
 */
export function buildAskState(questions: any[]): object {
  return {
    questions: questions.map((q) => ({
      question: q.question,
      header: q.header || '',
      multiSelect: q.multiSelect || false,
      options: (q.options || []).map((o: any) => o.label || o),
    })),
    current_question: 0,
    total_questions: questions.length,
    multi_select_chosen: [],
  };
}

/**
 * Format a question message for Telegram.
 */
export function formatQuestionMessage(
  agentName: string,
  questionIdx: number,
  totalQuestions: number,
  question: any,
): string {
  let msg = totalQuestions > 1
    ? `QUESTION (${questionIdx + 1}/${totalQuestions}) - ${agentName}:`
    : `QUESTION - ${agentName}:`;

  const header = question.header || '';
  if (header) {
    msg += `\n${header}`;
  }
  msg += `\n${question.question}\n`;

  if (question.multiSelect) {
    msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
  }

  const options = question.options || [];
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label || options[i];
    msg += `\n${i + 1}. ${label}`;
    const desc = options[i].description;
    if (desc) {
      msg += `\n   ${desc}`;
    }
  }

  return msg;
}

/**
 * Cleanup a response file, ignoring errors.
 */
export function cleanupResponseFile(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
