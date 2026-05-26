#!/usr/bin/env node
/**
 * mac-codex-bridge — thin daemon that forwards bus messages to Greg's Mac
 * Codex.app via SSH + AppleScript. New tasks create a Codex.app sidebar chat;
 * follow-ups carrying the same task_id resume that task's existing thread.
 *
 * Architecture:
 *   Any agent sends:  cortextos bus send-message mac-codex normal '<prompt>'
 *   Bridge receives:  inbox message via two channels:
 *     1. PTY stdin   — daemon fast-checker injects messages here (primary path)
 *     2. poll        — check-inbox fallback for any messages fast-checker missed
 *   Bridge executes:  ssh gregs-mac -> Codex.app new chat or `codex exec resume`
 *   Bridge replies:   cortextos bus send-message <from> normal '<thread_id>' <msg_id>
 *                     (fire-and-forget: returns thread ID immediately, Greg watches live)
 *
 * The bridge bypasses the Orgo gate — it is explicitly Mac-first by design.
 * Set runtime='script' + script_path='scripts/mac-codex-bridge.js' in config.json.
 */

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENT_NAME = process.env.CTX_AGENT_NAME || 'mac-codex';
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const SSH_HOST = 'gregs-mac';
// Polling loop waits up to 30s for new thread — give SSH 45s headroom
const SSH_TIMEOUT_MS = 45_000;
const CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const CODEX_DB = '/Users/gregharned/.codex/state_5.sqlite';
const TASK_ID_RE = /\btask_\d+_\d+\b/g;
const STATE_ROOT = process.env.CTX_ROOT || process.cwd();
const TASK_THREAD_MAP_PATH = path.join(STATE_ROOT, 'state', AGENT_NAME, 'task-thread-map.json');
const DEFAULT_MAC_CWD = '/Users/gregharned/work/team-brain';

// SSH connection failure patterns — used to distinguish offline vs execution errors
const SSH_CONN_ERROR_PATTERNS = [
  'Connection refused',
  'No route to host',
  'Connection timed out',
  'ssh: connect to host',
  'Could not resolve hostname',
  'Network is unreachable',
  'Host is down',
];

function isConnectionError(err) {
  if (!err) return false;
  const msg = (err.message || '') + (err.stderr || '');
  return SSH_CONN_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Async wrapper around child_process.spawn — resolves with stdout string or
 * rejects with an Error whose .stderr property holds stderr output.
 */
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout, maxBuffer = 10 * 1024 * 1024 } = opts;
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let timedOut = false;
    let timer;
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
    }

    child.stdout.on('data', (d) => {
      chunks.push(d);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total > maxBuffer) {
        child.kill('SIGKILL');
        reject(new Error(`Output exceeded maxBuffer (${maxBuffer} bytes)`));
      }
    });
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`Process timed out after ${timeout}ms`));
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      if (code !== 0) {
        const err = new Error(`ssh exited ${code}: ${stderr.slice(0, 500)}`);
        err.stderr = stderr;
        return reject(err);
      }
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });

    child.on('error', reject);
  });
}

// Tracks already-processed message IDs to deduplicate across both input channels
const processed = new Set();

// State for status-check read-path replies (fix b)
const lastDispatch = { threadId: null, at: 0, from: null, durationMs: 0 };

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractTaskId(text) {
  const ids = extractTaskIds(text);
  return ids[0] || null;
}

function extractTaskIds(text) {
  const matches = String(text || '').match(TASK_ID_RE) || [];
  return [...new Set(matches)];
}

function inferMacProjectCwd(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('/users/gregharned/work/ob1-app') || /\bob1\b|\bob-1\b|daily vignette|vignette|hero loop|flow/.test(t)) {
    return '/Users/gregharned/work/ob1-app';
  }
  if (t.includes('/users/gregharned/work/ob1-parents') || t.includes('ob1-parents') || t.includes('family app')) {
    return '/Users/gregharned/work/ob1-parents';
  }
  if (t.includes('/users/gregharned/work/rgos') || t.includes('agentops') || t.includes('rgos') || t.includes('dashboard')) {
    return '/Users/gregharned/work/rgos';
  }
  if (t.includes('orca voice') || t.includes('voice relay') || t.includes('aquarium') || t.includes('read-aloud')) {
    return '/Users/gregharned/work/team-brain-voice-client-hotfix';
  }
  if (t.includes('/users/gregharned/cortextos') || t.includes('cortextos') || t.includes('mac-codex') || t.includes('bridge')) {
    return '/Users/gregharned/cortextos';
  }
  if (t.includes('/users/gregharned/work/team-brain') || t.includes('team brain') || t.includes('wiki') || t.includes('obsidian')) {
    return '/Users/gregharned/work/team-brain';
  }
  return null;
}

function loadTaskThreadMap() {
  try {
    const raw = fs.readFileSync(TASK_THREAD_MAP_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') {
      return parsed;
    }
  } catch { /* missing/corrupt map starts empty */ }
  return { version: 1, tasks: {} };
}

function saveTaskThreadMap(map) {
  fs.mkdirSync(path.dirname(TASK_THREAD_MAP_PATH), { recursive: true });
  const tmp = `${TASK_THREAD_MAP_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  fs.renameSync(tmp, TASK_THREAD_MAP_PATH);
}

async function macSql(query, timeout = 10_000) {
  const queryB64 = Buffer.from(query, 'utf-8').toString('base64');
  const remoteCmd = `printf %s ${queryB64} | base64 -d | sqlite3 ${shellQuote(CODEX_DB)}`;
  return spawnAsync('ssh', [
    '-n',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    SSH_HOST,
    remoteCmd,
  ], { timeout });
}

async function threadExists(threadId) {
  try {
    const out = await macSql(`SELECT COUNT(*) FROM threads WHERE id=${sqlStringLiteral(threadId)};`);
    return parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

async function resolveThreadForTask(taskId) {
  if (!taskId) return null;

  const map = loadTaskThreadMap();
  const mapped = map.tasks[taskId]?.threadId;
  if (mapped && await threadExists(mapped)) return mapped;

  try {
    const like = `%${taskId}%`;
    const out = await macSql(`
      SELECT id
      FROM threads
      WHERE title LIKE ${sqlStringLiteral(like)}
         OR first_user_message LIKE ${sqlStringLiteral(like)}
         OR preview LIKE ${sqlStringLiteral(like)}
      ORDER BY created_at ASC
      LIMIT 1;
    `);
    const resolved = out.trim();
    if (resolved) {
      map.tasks[taskId] = {
        threadId: resolved,
        updatedAt: new Date().toISOString(),
        source: 'mac-db-backfill',
      };
      saveTaskThreadMap(map);
      return resolved;
    }
  } catch (e) {
    log(`task thread backfill failed for ${taskId}: ${e.message.slice(0, 160)}`);
  }

  return null;
}

async function getThreadCwd(threadId) {
  if (!threadId) return null;
  try {
    const out = await macSql(`SELECT cwd FROM threads WHERE id=${sqlStringLiteral(threadId)} LIMIT 1;`);
    return out.trim() || null;
  } catch {
    return null;
  }
}

function projectMatches(expectedCwd, actualCwd) {
  if (!expectedCwd || !actualCwd) return true;
  return actualCwd === expectedCwd || actualCwd.startsWith(`${expectedCwd}/`);
}

function rememberThreadForTask(taskId, threadId, sourceMsgId) {
  if (!taskId || !threadId) return;
  const map = loadTaskThreadMap();
  map.tasks[taskId] = {
    threadId,
    updatedAt: new Date().toISOString(),
    sourceMsgId,
  };
  try {
    saveTaskThreadMap(map);
  } catch (e) {
    log(`task thread map write failed for ${taskId}: ${e.message.slice(0, 160)}`);
  }
}

function isStatusCheck(text) {
  const t = (text || '').trim().toLowerCase();
  return t === 'status'
    || t === 'ping'
    || t === 'health'
    || t === 'status?'
    || t === 'status check'
    || t.startsWith('status check ')
    || t.startsWith('status check:')
    || t.includes('status check only')
    || t.includes('do not open codex.app thread');
}

// Liveness probe: returns thread count from Mac SQLite, or null on error (fix c)
async function probeDbThreadCount() {
  try {
    const out = await spawnAsync('ssh', [
      '-n', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_HOST,
      `sqlite3 ${shellQuote(CODEX_DB)} 'SELECT COUNT(*) FROM threads;'`,
    ], { timeout: 10_000 });
    return parseInt(out.trim(), 10);
  } catch {
    return null;
  }
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] [mac-codex-bridge] ${msg}\n`);
}

function bus(...args) {
  return execFileSync('cortextos', ['bus', ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim();
}

function updateHeartbeat(status) {
  try {
    bus('update-heartbeat', status);
  } catch (e) {
    log(`heartbeat failed: ${e.message.slice(0, 100)}`);
  }
}

function checkInbox() {
  try {
    const raw = bus('check-inbox');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Open a new chat in Codex.app on gregs-mac via SSH + AppleScript.
 * Uses File > New Chat menu item, types the prompt, presses Return.
 * Fire-and-forget: returns the new thread ID immediately — Greg watches live.
 *
 * Writes the AppleScript to a temp file on the Mac to avoid all shell-quoting
 * issues with special characters in the prompt.
 */
function execOnMac(prompt, cwd = DEFAULT_MAC_CWD) {
  const nonce = Date.now();
  const tmpScript = `/tmp/codex-dispatch-${nonce}.applescript`;
  const tmpPrompt = `/tmp/codex-prompt-${nonce}.txt`;

  // Prompt is written to a temp file and loaded into clipboard via pbcopy.
  // Using clipboard paste (Cmd+V) instead of keystroke avoids AppleScript
  // treating newlines as Return keypresses, which would submit multi-paragraph
  // prompts after the first line.
  const scriptBody = [
    `do shell script "pbcopy < ${tmpPrompt}"`,
    // Snapshot MAX(created_at) BEFORE triggering new chat — race-fix anchor (fix a).
    // Any thread with created_at strictly greater is guaranteed to be the new one.
    `set snapshotTs to do shell script "sqlite3 ${CODEX_DB} \\"SELECT COALESCE(MAX(created_at), '1970-01-01 00:00:00') FROM threads;\\""`,
    'tell application "Codex" to activate',
    'delay 0.6',
    'tell application "System Events"',
    '  tell process "Codex"',
    '    click menu item "New Chat" of menu 1 of menu bar item "File" of menu bar 1',
    '    delay 1.2',
    '    keystroke "v" using command down',
    '    delay 0.5',
    '    key code 36',
    '  end tell',
    'end tell',
    // Poll up to 30s (60 × 0.5s) for the new thread to appear.
    // Replaces the old fixed delay-2 + DESC LIMIT 1 that raced against Codex.app writes.
    'set threadId to ""',
    'repeat 60 times',
    `  set threadId to do shell script "sqlite3 ${CODEX_DB} \\"SELECT id FROM threads WHERE created_at > '" & snapshotTs & "' ORDER BY created_at ASC LIMIT 1;\\""`,
    '  if threadId is not "" then exit repeat',
    '  delay 0.5',
    'end repeat',
    `do shell script "rm -f ${tmpScript} ${tmpPrompt}"`,
    'if threadId is "" then error "Timed out waiting for new Codex.app thread (30s)"',
    'return threadId',
  ].join('\n');

  // Base64-encode both files so they survive SSH quoting untouched.
  const scriptB64 = Buffer.from(scriptBody).toString('base64');
  const promptB64 = Buffer.from(prompt).toString('base64');
  const cwdB64 = Buffer.from(cwd || DEFAULT_MAC_CWD).toString('base64');

  const remoteCmd = [
    `TARGET_CWD=$(echo ${cwdB64} | base64 -d)`,
    'mkdir -p "$TARGET_CWD"',
    `echo ${scriptB64} | base64 -d > ${tmpScript}`,
    `echo ${promptB64} | base64 -d > ${tmpPrompt}`,
    `cd "$TARGET_CWD" && osascript ${tmpScript}`,
  ].join(' && ');

  return spawnAsync('ssh', [
    '-n',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    SSH_HOST,
    remoteCmd,
  ], { timeout: SSH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
}

async function execOnMacExistingThread(prompt, threadId) {
  const nonce = Date.now();
  const tmpPrompt = `/tmp/codex-followup-${nonce}.txt`;
  const tmpResult = `/tmp/codex-followup-${nonce}.out`;
  const promptB64 = Buffer.from(prompt).toString('base64');

  // Use the real Codex home so resume targets the same Codex.app thread DB.
  // This appends to the existing task thread instead of creating another sidebar chat.
  const remoteCmd = [
    `printf %s ${promptB64} | base64 -d > ${tmpPrompt}`,
    `${shellQuote(CODEX_BIN)} exec resume --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m gpt-5.5 -o ${tmpResult} ${shellQuote(threadId)} - < ${tmpPrompt} >/dev/null`,
    `cat ${tmpResult} 2>/dev/null || true`,
    `rm -f ${tmpPrompt} ${tmpResult}`,
  ].join(' && ');

  await spawnAsync('ssh', [
    '-n',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    SSH_HOST,
    remoteCmd,
  ], { timeout: SSH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  return threadId;
}

async function processMessage(msg) {
  const { id, from, text } = msg;
  if (processed.has(id)) return;
  processed.add(id);
  if (processed.size > 1000) {
    const oldest = [...processed].slice(0, 500);
    oldest.forEach((k) => processed.delete(k));
  }

  const preview = (text || '').slice(0, 80);
  log(`Processing msg ${id} from ${from}: ${preview}...`);

  // Status-check read path (fix b): reply locally without dispatching to Codex.app.
  // Saves one thread per status/health/ping probe.
  if (isStatusCheck(text)) {
    const elapsed = lastDispatch.at
      ? `${Math.round((Date.now() - lastDispatch.at) / 1000)}s ago`
      : 'never';
    const threadCount = await probeDbThreadCount();
    const dbInfo = threadCount !== null ? `, db_threads=${threadCount}` : '';
    const reply = lastDispatch.threadId
      ? `status: last dispatch ${elapsed} (thread ${lastDispatch.threadId}, ${lastDispatch.durationMs}ms${dbInfo})`
      : `status: no dispatches this session${dbInfo}`;
    try { bus('send-message', from, 'normal', reply, id); } catch { /* non-fatal */ }
    try { bus('ack-inbox', id); } catch { /* non-fatal */ }
    log(`Status check from ${from}: ${reply}`);
    return;
  }

  const start = Date.now();
  let result;
  let ok = false;
  let reused = false;

  try {
    const taskIds = extractTaskIds(text);
    const expectedCwd = inferMacProjectCwd(text);
    let taskId = taskIds[0] || null;
    let existingThreadId = null;
    for (const id of taskIds) {
      const resolved = await resolveThreadForTask(id);
      const resolvedCwd = resolved ? await getThreadCwd(resolved) : null;
      if (resolved && projectMatches(expectedCwd, resolvedCwd)) {
        taskId = id;
        existingThreadId = resolved;
        break;
      } else if (resolved && expectedCwd) {
        log(`mapped thread ${resolved} for ${id} has cwd=${resolvedCwd || 'unknown'}, expected ${expectedCwd}; refusing reuse`);
      }
    }
    const threadId = existingThreadId
      ? await execOnMacExistingThread(text || '', existingThreadId)
      : await execOnMac(text || '', expectedCwd || DEFAULT_MAC_CWD);
    const tid = threadId.trim();
    const durationMs = Date.now() - start;
    reused = Boolean(existingThreadId);
    if (taskIds.length) {
      taskIds.forEach((foundTaskId) => rememberThreadForTask(foundTaskId, tid, id));
    }
    result = reused
      ? `dispatched — appended to existing Codex.app thread for ${taskId} (thread ${tid})`
      : `dispatched — new chat in Codex.app (thread ${tid})`;
    ok = true;
    lastDispatch.threadId = tid;
    lastDispatch.at = Date.now();
    lastDispatch.from = from;
    lastDispatch.durationMs = durationMs;
    log(`Dispatched in ${(durationMs / 1000).toFixed(1)}s — ${reused ? 'reused' : 'new'} thread ${tid}`);
  } catch (e) {
    result = `mac-codex error: ${e.message.slice(0, 500)}`;
    log(`Error: ${result}`);
    if (isConnectionError(e)) {
      // Alert orchestrator so it can reroute or notify user
      try {
        bus('send-message', 'orchestrator', 'high',
          `mac-codex offline: SSH to ${SSH_HOST} failed. Dispatch for msg ${id} from ${from} dropped.`);
      } catch { /* non-fatal — orchestrator may itself be down */ }
    }
  }

  // Reply to sender with thread ID (fire-and-forget — Greg watches Codex.app live)
  try {
    bus('send-message', from, 'normal', ok ? result : `ERROR: ${result}`, id);
  } catch (e) {
    log(`Reply failed: ${e.message.slice(0, 100)}`);
  }

  // ACK the message (prevents re-delivery)
  try {
    bus('ack-inbox', id);
  } catch (e) {
    log(`ACK failed for ${id}: ${e.message.slice(0, 100)}`);
  }

  // Log telemetry event
  try {
    bus('log-event', 'action', 'mac_codex_dispatch', ok ? 'info' : 'warning',
      '--meta', JSON.stringify({ from, durationMs: Date.now() - start, ok, msgId: id, reusedThread: reused }));
  } catch { /* non-fatal */ }
}

/**
 * Parse messages injected by the daemon's fast-checker via PTY stdin.
 *
 * Fast-checker writes the cortextos agent message format:
 *   === AGENT MESSAGE from <from> [msg_id: <id>] ===
 *   <text lines>
 *   Reply using: cortextos bus send-message <from> normal '<reply>' <id>
 *
 * We extract from/id/text and feed into processMessage().
 */
/**
 * Strip ANSI/VT100 escape sequences (including bracketed-paste markers ESC[200~ / ESC[201~)
 * that the daemon fast-checker injects around PTY-written messages.
 */
function stripEscapes(str) {
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')  // CSI sequences (including ESC[200~ ESC[201~)
    .replace(/\x1b./g, '');                    // any remaining ESC + one char
}

function parseStdinMessages(buf) {
  const text = stripEscapes(buf.toString('utf-8'));
  // Split on message boundaries
  const blocks = text.split(/(?====\s+AGENT MESSAGE)/);
  for (const block of blocks) {
    const headerMatch = block.match(/===\s+AGENT MESSAGE from (\S+)\s+\[msg_id:\s+(\S+)\]/);
    if (!headerMatch) continue;
    const from = headerMatch[1];
    const id = headerMatch[2];
    // Body: lines between header and "Reply using:" or end.
    // Fast-checker wraps the body in triple-backtick code fences; strip them.
    const bodyMatch = block.match(/===\n([\s\S]*?)(?:\nReply using:|$)/);
    const rawBody = bodyMatch ? bodyMatch[1].trim() : '';
    const bodyText = rawBody
      .replace(/^```[^\n]*\n/, '')  // strip opening ``` or ```lang
      .replace(/\n```\s*$/, '');    // strip closing ```
    if (id && from) {
      processMessage({ id, from, text: bodyText, to: AGENT_NAME, priority: 'normal', timestamp: new Date().toISOString(), reply_to: null })
        .catch((e) => log(`stdin processMessage uncaught: ${e.message}`));
    }
  }
}

async function main() {
  log(`Starting (agent=${AGENT_NAME})`);
  updateHeartbeat('online — waiting for dispatch');

  // Listen on stdin for fast-checker message injections (PTY stdin channel)
  let stdinBuf = '';
  if (process.stdin.isTTY !== false) {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      stdinBuf += chunk;
      // Wait for a complete block: both the header AND the reply-using footer must be
      // present before parsing. Multi-line messages arrive in multiple PTY chunks;
      // parsing on the first chunk (header only) gives empty body text.
      if (stdinBuf.includes('=== AGENT MESSAGE') && stdinBuf.includes('\nReply using:')) {
        parseStdinMessages(Buffer.from(stdinBuf));
        stdinBuf = '';
      }
    });
    process.stdin.resume();
  }

  let lastHeartbeat = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
      updateHeartbeat('online — waiting for dispatch');
      lastHeartbeat = Date.now();
    }

    // Fallback: poll inbox for any messages fast-checker missed
    const messages = checkInbox();
    for (const msg of messages) {
      // fire-and-forget — concurrent dispatches don't block each other
      processMessage(msg).catch((e) => log(`processMessage uncaught: ${e.message}`));
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((e) => {
  process.stderr.write(`[mac-codex-bridge] Fatal: ${e.message}\n`);
  process.exit(1);
});
