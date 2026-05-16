/**
 * hook-loop-detector.ts — PreToolUse hook: detects and blocks repeated tool loops.
 *
 * Ports the two-strategy detection algorithm from desplega-ai/agent-swarm into
 * a cortextOS PreToolUse hook.
 *
 * Detection strategies:
 *   1. Repetition — the same (tool, args-hash) pair appears ≥ REPETITION_BLOCK
 *      times in the last HISTORY_SIZE calls.
 *   2. Ping-pong — two tools alternate and together dominate ≥ 80% of the last
 *      PINGPONG_WINDOW calls.
 *
 * On detection the hook writes a block decision to stdout and exits 0.
 * All other paths exit 0 silently so the tool call proceeds.
 *
 * State: {ctxRoot}/state/{agentName}/loop-detector.json
 * Cleared automatically when it exceeds HISTORY_SIZE entries (sliding window).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { readStdin, parseHookInput } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling history window size. */
export const HISTORY_SIZE = 30;

/** Block repetition loops after this many identical (tool, args-hash) calls. */
export const REPETITION_BLOCK = 15;

/** Window size for ping-pong pattern analysis. */
export const PINGPONG_WINDOW = 12;

/** Block ping-pong loops after this many alternating-pair calls in the window. */
export const PINGPONG_BLOCK = 14;

/** Fraction of PINGPONG_WINDOW the two dominant tools must occupy to trigger. */
const PINGPONG_DOMINANCE = 0.8;

/**
 * Essential bus commands that must never be blocked by loop detection.
 * These are lifecycle operations (heartbeat, inbox, messaging) that agents
 * need to function even during idle polling periods.
 */
export const ESSENTIAL_COMMANDS: readonly string[] = [
  'update-heartbeat',
  'check-inbox',
  'ack-inbox',
  'send-message',
  'send-telegram',
  'log-event',
  'read-all-heartbeats',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  ts: number; // epoch ms
}

export interface LoopDetectorState {
  history: ToolCallRecord[];
}

// ---------------------------------------------------------------------------
// Args hashing
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys for deterministic JSON serialisation.
 * Arrays are left in their original order (order matters for array args).
 */
function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortObjectKeys(obj[k]);
      return acc;
    }, {});
}

/**
 * Produce a collision-resistant hash string for the tool input arguments.
 * Uses sorted JSON serialisation so {a:1, b:2} === {b:2, a:1}.
 * Returns an empty string for null/undefined inputs.
 *
 * SHA-256 (first 16 hex chars) is used to avoid the false-positive repetition
 * blocks that a 32-bit djb2 hash would produce from collisions.
 */
export function hashArgs(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return '';
  try {
    const normalized = JSON.stringify(sortObjectKeys(toolInput));
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function statePath(stateDir: string): string {
  return join(stateDir, 'loop-detector.json');
}

export function loadState(stateDir: string): LoopDetectorState {
  const p = statePath(stateDir);
  if (!existsSync(p)) return { history: [] };
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LoopDetectorState>;
    const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
    // Filter out corrupt/partial records so countRepetitions and detectPingPong
    // never throw on missing fields (Bug-1 fix).
    const history: ToolCallRecord[] = rawHistory.filter(
      (r): r is ToolCallRecord =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as ToolCallRecord).toolName === 'string' &&
        typeof (r as ToolCallRecord).argsHash === 'string' &&
        typeof (r as ToolCallRecord).ts === 'number',
    );
    return { history };
  } catch {
    return { history: [] };
  }
}

function saveState(stateDir: string, state: LoopDetectorState): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort — never throw from a hook
  }
}

// ---------------------------------------------------------------------------
// Detection algorithms
// ---------------------------------------------------------------------------

/**
 * Repetition detection: count how many times the same (toolName, argsHash)
 * pair appears in the last HISTORY_SIZE records.
 * Returns the count.
 */
export function countRepetitions(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): number {
  return history.filter(r => r.toolName === toolName && r.argsHash === argsHash).length;
}

/**
 * Ping-pong detection (two-phase):
 *
 * Phase 1 — Identify the pair using the last PINGPONG_WINDOW records.
 *   Two tools must together occupy ≥ PINGPONG_DOMINANCE of that window.
 *
 * Phase 2 — Count alternations across the FULL history.
 *   We use the window only to establish WHICH pair is oscillating; the
 *   alternation count is measured over all history so that PINGPONG_BLOCK (14)
 *   is reachable (max alternations in a 12-call window is only 11).
 *
 * Returns { count, tools } where count is total alternations between the pair
 * in the full history, or { count: 0, tools: null } if no pair is found.
 */
export function detectPingPong(history: ToolCallRecord[]): {
  count: number;
  tools: [string, string] | null;
} {
  if (history.length < PINGPONG_WINDOW) return { count: 0, tools: null };

  // Phase 1: identify dominant pair from the recent window
  const window = history.slice(-PINGPONG_WINDOW);
  const freq: Record<string, number> = {};
  for (const r of window) {
    freq[r.toolName] = (freq[r.toolName] ?? 0) + 1;
  }

  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return { count: 0, tools: null };

  const [topTool, topCount] = sorted[0];
  const [secondTool, secondCount] = sorted[1];
  const combinedFraction = (topCount + secondCount) / PINGPONG_WINDOW;

  if (combinedFraction < PINGPONG_DOMINANCE) return { count: 0, tools: null };

  // Phase 2: count alternations between the pair across the FULL history
  const pairSet = new Set([topTool, secondTool]);
  const pairCalls = history.filter(r => pairSet.has(r.toolName));
  let alternations = 0;
  for (let i = 1; i < pairCalls.length; i++) {
    if (pairCalls[i].toolName !== pairCalls[i - 1].toolName) {
      alternations++;
    }
  }

  return {
    count: alternations,
    tools: [topTool, secondTool],
  };
}

// ---------------------------------------------------------------------------
// Essential operation bypass
// ---------------------------------------------------------------------------

/**
 * Check if a tool call is an essential operation that should never be blocked.
 * Essential ops: bus lifecycle commands (heartbeat, inbox, messaging) and
 * reads of lifecycle files (HEARTBEAT.md, GOALS.md).
 */
export function checkEssential(toolName: string, toolInput: unknown): boolean {
  if (toolInput === null || toolInput === undefined || typeof toolInput !== 'object') {
    return false;
  }
  const input = toolInput as Record<string, unknown>;

  // Bash calls running essential bus commands
  if (toolName === 'Bash') {
    const cmd = input.command;
    if (typeof cmd === 'string') {
      if (ESSENTIAL_COMMANDS.some(ec => cmd.includes(`bus ${ec}`))) return true;
      // Cron-driven scripts are expected to run repeatedly — exempt them.
      if (cmd.includes('cortextos-vm-sync-push.js') || cmd.includes('sync-agent-memories.js') || cmd.includes('sync_activity_to_supabase.py') || cmd.includes('inbox-drain-watchdog.js') || cmd.includes('cortextos-mac-task-sync.js')) return true;
    }
  }

  // Read/Glob of essential lifecycle files
  if (toolName === 'Read' || toolName === 'Glob') {
    const filePath = String(input.file_path ?? input.pattern ?? '');
    if (filePath.includes('HEARTBEAT.md') || filePath.includes('GOALS.md')) {
      return true;
    }
  }

  // MCP tools for task listing (polling is expected)
  if (toolName.startsWith('mcp__') && toolName.includes('list_tasks')) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Hook output
// ---------------------------------------------------------------------------

function blockCall(reason: string): void {
  const output = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);

  const agentName = process.env.CTX_AGENT_NAME || '';
  const ctxRoot = process.env.CTX_ROOT || join(homedir(), '.cortextos', 'default');
  const stateDir = join(ctxRoot, 'state', agentName);

  const state = loadState(stateDir);
  const argsHash = hashArgs(tool_input);

  // Append current call to history (before threshold checks so the blocking
  // call is counted — prevents "block at 15, record nothing, retry forever")
  state.history.push({ toolName: tool_name, argsHash, ts: Date.now() });
  // Trim to sliding window
  if (state.history.length > HISTORY_SIZE) {
    state.history = state.history.slice(-HISTORY_SIZE);
  }
  saveState(stateDir, state);

  // --- Essential command bypass ---
  // Essential operations are never blocked. They are still recorded in history
  // so they contribute to pattern detection of non-essential calls, but the
  // block decision is skipped for them.
  const isEssential = checkEssential(tool_name, tool_input);
  if (isEssential) {
    process.exit(0);
    return;
  }

  // --- Strategy 1: Repetition ---
  const reps = countRepetitions(state.history, tool_name, argsHash);
  if (reps >= REPETITION_BLOCK) {
    blockCall(
      `Tool loop detected: "${tool_name}" called ${reps} times with identical arguments in the last ${HISTORY_SIZE} calls. Stop repeating this action and try a fundamentally different approach.`,
    );
    return;
  }

  // --- Strategy 2: Ping-pong ---
  const pp = detectPingPong(state.history);
  if (pp.count >= PINGPONG_BLOCK && pp.tools) {
    const [toolA, toolB] = pp.tools;
    // Only block calls that are part of the oscillating pair.
    // If the current tool is different (e.g. Read, Write, Agent),
    // the pair's loop does not implicate it — let it through.
    if (tool_name !== toolA && tool_name !== toolB) {
      process.exit(0);
      return;
    }
    blockCall(
      `Tool loop detected: "${toolA}" and "${toolB}" are alternating repeatedly (${pp.count} alternations in the last ${state.history.length} calls). Stop this back-and-forth pattern and try a fundamentally different approach.`,
    );
    return;
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
