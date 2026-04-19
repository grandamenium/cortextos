/**
 * Shared utility functions for Claude Code hook scripts.
 * Each hook reads JSON from stdin, processes it, and writes JSON to stdout.
 */

import { readFileSync, existsSync, watch, statSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';

/** Maximum stdin bytes buffered before truncation (10 MB). BUG-080. */
const MAX_STDIN_SIZE = 10 * 1024 * 1024;

/**
 * Read all data from stdin as a string.
 * Enforces a 10 MB hard cap (BUG-080): if the incoming payload exceeds
 * MAX_STDIN_SIZE the stream is immediately destroyed, a warning is written to
 * stderr, and only the bytes received up to that point are returned (already
 * truncated). This prevents hooks from OOM-ing the process on runaway inputs.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer<ArrayBufferLike>[] = [];
    let totalSize = 0;
    let truncated = false;

    process.stdin.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      if (truncated) return;
      totalSize += chunk.byteLength;
      if (totalSize > MAX_STDIN_SIZE) {
        truncated = true;
        // Keep everything accumulated so far — discard the overflowing chunk
        process.stderr.write(
          `[cortextos hook] WARNING: stdin exceeded ${MAX_STDIN_SIZE} bytes; truncating input (BUG-080)\n`,
        );
        // Destroy the stream so no further data events fire
        try { process.stdin.destroy(); } catch { /* already closed */ }
        resolve(Buffer.concat(chunks).toString('utf-8'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      if (!truncated) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', (err) => {
      if (!truncated) reject(err);
    });
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
      const command = String(toolInput.command || '').slice(0, 200);
      return `Command: ${command}`;
    }
    default: {
      return JSON.stringify(toolInput).slice(0, 200);
    }
  }
}

/**
 * Check if a tool operation targets .claude/ directory (auto-approve).
 */
export function isClaudeDirOperation(toolName: string, toolInput: any): boolean {
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    return cmd.includes('.claude/');
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    return filePath.includes('/.claude/');
  }
  return false;
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
