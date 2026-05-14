import { Command } from 'commander';
import { spawnSync, execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { sendMessage, checkInbox, ackInbox } from '../bus/message.js';
import { validateAgentName } from '../utils/validate.js';
import { randomString } from '../utils/random.js';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, checkStaleTasks, archiveTasks, checkHumanTasks, findTaskFile } from '../bus/task.js';
import { saveOutput } from '../bus/save-output.js';
import { logEvent } from '../bus/event.js';
import { updateHeartbeat, readAllHeartbeats } from '../bus/heartbeat.js';
import { pollWatchdog } from '../bus/watchdog.js';
import { runCodebaseScan } from '../bus/codebase-scan.js';
import { runSecurityAudit } from '../bus/security-audit.js';
import { selfRestart, hardRestart, autoCommit, autoCompactAgent, checkGoalStaleness, postActivity } from '../bus/system.js';
import { createExperiment, runExperiment, evaluateExperiment, listExperiments, gatherContext, manageCycle, loadExperimentConfig, loadExperiment, syncExperimentToSupabase, syncAllExperimentsToSupabase } from '../bus/experiment.js';
import { browseCatalog, installCommunityItem, prepareSubmission, submitCommunityItem } from '../bus/catalog.js';
import { collectMetrics, parseUsageOutput, storeUsageData, checkUpstream, collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { createApproval, updateApproval } from '../bus/approval.js';
import { createReminder, listReminders, ackReminder, pruneReminders } from '../bus/reminders.js';
import { updateCronFire, parseDurationMs, readCronState } from '../bus/cron-state.js';
import { addCron, removeCron, readCrons, updateCron as updateCronDef, getCronByName, getExecutionLog } from '../bus/crons.js';
import { nextFireFromCron } from '../daemon/cron-scheduler.js';
import { queryKnowledgeBase, ingestKnowledgeBase, ensureKBDirs } from '../bus/knowledge-base.js';
import { checkUsageApi, refreshOAuthToken, rotateOAuth, loadAccounts, ALERT_5H, ALERT_7D } from '../bus/oauth.js';
import { drainRetryQueue, readRetryQueue, retryQueuePath, isEnabled } from '../bus/rgos-mirror.js';
import { createSkillPr } from '../bus/skill-autopr.js';
import { sendSlack } from '../bus/send-slack.js';
import { enforceControlPolicy } from '../bus/orch-control-policy.js';
import { sendTelegramVoice } from '../bus/send-telegram-voice.js';
import { checkDuplicate } from '../bus/p6-dedup.js';
import { generateSkill } from '../bus/generate-skill.js';
import { syncSkills } from '../bus/sync-skills.js';
import { runWorkflow } from '../bus/run-workflow.js';
import { computerUse } from '../bus/computer-use.js';
import { checkOrgoLeaseWatchdog, claimOrgoLease, formatLeaseStatus, listOrgoLeaseStatus, releaseOrgoLease } from '../bus/orgo-lease.js';

import { atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { IPCClient } from '../daemon/ipc-server.js';
import { TelegramAPI } from '../telegram/api.js';
import { logOutboundMessage, cacheLastSent } from '../telegram/logging.js';
import type { Priority, Task, TaskStatus, EventCategory, EventSeverity, ApprovalCategory, ApprovalStatus, OrgContext, CronDefinition } from '../types/index.js';

/**
 * Check if the org requires deliverables and the task has none attached.
 * Returns an error message if the transition should be blocked, or null if allowed.
 */
function checkDeliverableRequirement(taskId: string, frameworkRoot: string, org: string, paths: ReturnType<typeof resolvePaths>): string | null {
  // Read org context to check require_deliverables setting
  const contextPath = join(frameworkRoot, 'orgs', org, 'context.json');
  if (!existsSync(contextPath)) return null;

  let ctx: OrgContext;
  try {
    ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch {
    return null; // cannot read config — allow the transition
  }

  if (!ctx.require_deliverables) return null;

  // Check if the task has outputs
  const taskFile = findTaskFile(paths, taskId);
  if (!taskFile || !existsSync(taskFile)) return null;

  let task: Task;
  try {
    task = JSON.parse(readFileSync(taskFile, 'utf-8'));
  } catch {
    return null;
  }

  if (!task.outputs || task.outputs.length === 0) {
    return `Cannot submit task ${taskId}: require_deliverables is enabled but this task has no file deliverables attached. Use "cortextos bus save-output ${taskId} <file>" to attach a deliverable first.`;
  }

  return null;
}

export const busCommand = new Command('bus')
  .description('Bus commands for agent messaging, tasks, and events');

// ---------------------------------------------------------------------------
// Reply-mode helpers
//
// Reply mode is a per-agent user preference set via the dashboard at
// /comms. Values: 'text' (default), 'voice', 'both'. It controls how agents
// deliver replies TO THE USER — not to other agents. The logic is baked
// into send-message so agents do not need to know it exists.
// ---------------------------------------------------------------------------
type ReplyMode = 'text' | 'voice' | 'both';

function readReplyMode(ctxRoot: string, agent: string): ReplyMode {
  try {
    const v = readFileSync(join(ctxRoot, 'state', agent, 'reply-mode'), 'utf-8').trim();
    if (v === 'voice' || v === 'both' || v === 'text') return v;
  } catch { /* default */ }
  return 'text';
}

function readAgentEnvVar(agentDir: string | undefined, key: string): string {
  if (!agentDir) return '';
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) return '';
  const line = readFileSync(envPath, 'utf-8').split('\n').find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

function readAgentVoice(agentDir: string | undefined): string {
  if (!agentDir) return 'en-US-AndrewNeural';
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return 'en-US-AndrewNeural';
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return typeof cfg.voice === 'string' && cfg.voice ? cfg.voice : 'en-US-AndrewNeural';
  } catch {
    return 'en-US-AndrewNeural';
  }
}

async function enforcePolicyOrExit(
  gate: string,
  action: string,
  target?: string,
  opts?: { policyApprovalId?: string; exemptOrchestrator?: boolean },
): Promise<void> {
  try {
    await enforceControlPolicy({
      gate,
      action,
      target,
      approvalId: opts?.policyApprovalId,
      exemptOrchestrator: opts?.exemptOrchestrator,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Generate MP3 via edge-tts and publish to {ctxRoot}/dashboard-uploads so
 * the dashboard /comms channel can embed it as an inline audio player.
 * Returns { tmpFile, audioUrl } or null if generation fails.
 * Caller is responsible for deleting tmpFile when done.
 */
function generateAgentMp3(
  ctxRoot: string,
  agentName: string | undefined,
  agentDir: string | undefined,
  text: string,
): { tmpFile: string; audioUrl: string } | null {
  const os = require('os') as typeof import('os');
  const { mkdirSync, copyFileSync } = require('fs') as typeof import('fs');
  const voice = readAgentVoice(agentDir);
  const tmpFile = join(os.tmpdir(), `reply-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  try {
    execFileSync('python3', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', tmpFile], {
      stdio: 'pipe',
    });
  } catch {
    return null;
  }
  if (!existsSync(tmpFile)) return null;

  try {
    const uploadsDir = join(ctxRoot, 'dashboard-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const safeAgent = (agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
    const audioFilename = `${Date.now()}-voice-${safeAgent}.mp3`;
    copyFileSync(tmpFile, join(uploadsDir, audioFilename));
    return { tmpFile, audioUrl: `/api/media/dashboard-uploads/${audioFilename}` };
  } catch {
    return null;
  }
}

function isRegisteredAgent(frameworkRoot: string, target: string): boolean {
  const orgsDir = join(frameworkRoot, 'orgs');
  if (!existsSync(orgsDir)) return false;
  try {
    const { readdirSync } = require('fs') as typeof import('fs');
    for (const org of readdirSync(orgsDir)) {
      if (existsSync(join(orgsDir, org, 'agents', target))) return true;
    }
  } catch { /* fall through */ }
  return false;
}

function isLocalVoiceEndpoint(target: string): boolean {
  return target === 'voice-orch-talk' || target.startsWith('voice-session-');
}

// Extensions that are safe to publish to {ctxRoot}/dashboard-uploads so the
// dashboard bus channel can link or render them. Media types render inline
// (image/audio/video); document types render as a download chip. We avoid
// publishing HTML/SVG/XML — they could execute script when the /api/media/
// route serves them inline (same-origin XSS vector).
const DASHBOARD_PUBLISHABLE_EXTS = new Set([
  // Media — channel-view renders inline
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.mp3', '.m4a', '.wav', '.ogg', '.opus',
  '.mp4', '.mov',
  // Documents — channel-view renders as a download chip
  '.pdf', '.csv', '.tsv', '.sql', '.zip', '.log',
  // Plain text — safe to serve as text/plain
  '.md', '.txt', '.json', '.yaml', '.yml',
]);

/**
 * Copy a local file into {ctxRoot}/dashboard-uploads so the dashboard
 * /comms view can render it inline via /api/media/... Returns the
 * resulting media URL, or null if the source can't be published (missing
 * file, disallowed extension, copy error).
 */
function publishFileToDashboardUploads(
  ctxRoot: string,
  agentName: string | undefined,
  srcPath: string,
): string | null {
  try {
    const { copyFileSync, mkdirSync } = require('fs') as typeof import('fs');
    const { extname } = require('path') as typeof import('path');
    if (!existsSync(srcPath)) return null;
    const ext = extname(srcPath).toLowerCase();
    if (!DASHBOARD_PUBLISHABLE_EXTS.has(ext)) return null;
    const uploadsDir = join(ctxRoot, 'dashboard-uploads');
    mkdirSync(uploadsDir, { recursive: true });
    const safeAgent = (agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
    const destName = `${Date.now()}-tg-${safeAgent}${ext}`;
    copyFileSync(srcPath, join(uploadsDir, destName));
    return `/api/media/dashboard-uploads/${destName}`;
  } catch {
    return null;
  }
}

busCommand
  .command('send-message')
  .argument('<to>', 'Target agent')
  .argument('<priority>', 'Message priority (urgent, high, normal, low)')
  .argument('<text>', 'Message text')
  .argument('[reply-to]', 'Reply to message ID (optional positional form)')
  .option('--reply-to <id>', 'Reply to message ID')
  .option('--trace-id <id>', 'OTel-style trace ID to correlate this message with a workflow or task')
  .option('--policy-approval-id <id>', 'Approval ID authorizing a policy-gated live user send')
  .action(async (to: string, priority: string, text: string, replyToArg: string | undefined, opts: { replyTo?: string; traceId?: string; policyApprovalId?: string }) => {
    // Accept reply-to as either positional arg or --reply-to flag (P2 fix #9)
    const effectiveReplyTo = opts.replyTo ?? replyToArg;
    const validPriorities: Priority[] = ['urgent', 'high', 'normal', 'low'];
    if (!validPriorities.includes(priority as Priority)) {
      console.error(`Invalid priority '${priority}'. Must be one of: ${validPriorities.join(', ')}`);
      process.exit(1);
    }
    // Security (H9): Validate agent name before any filesystem access.
    try {
      validateAgentName(to);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }

    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const agentExists = isRegisteredAgent(projectRoot, to) || isLocalVoiceEndpoint(to);
    if (!agentExists) {
      // If target isn't a known agent, it's the user (dashboard/Telegram identity).
      // Fall through to user-destination handling below — no warning.
      await enforcePolicyOrExit('externalEmail', 'send-message user delivery', to, {
        policyApprovalId: opts.policyApprovalId,
        exemptOrchestrator: true,
      });
    }

    // -----------------------------------------------------------------------
    // User-destination handling (non-agent target)
    //
    // When the target name does not match a registered agent we treat it as
    // the dashboard/Telegram user identity. In that case the reply is
    // delivered on BOTH surfaces — the dashboard /comms channel (via inbox)
    // and Telegram (via mirror below) — honoring the reply-mode the user
    // set via the dashboard toggle.
    //
    // The logic lives here so agents do not need any CLAUDE.md knowledge of
    // reply-mode. They just call send-message like before — the CLI handles
    // the voice/text/telegram fan-out automatically.
    // -----------------------------------------------------------------------
    let bodyText = text;
    let tmpAudioFile: string | null = null;
    let audioUrl = '';
    let mode: ReplyMode = 'text';

    if (!agentExists && env.ctxRoot && env.agentName) {
      mode = readReplyMode(env.ctxRoot, env.agentName);
      if (mode === 'voice' || mode === 'both') {
        const gen = generateAgentMp3(env.ctxRoot, env.agentName, env.agentDir, text);
        if (gen) {
          tmpAudioFile = gen.tmpFile;
          audioUrl = gen.audioUrl;
          bodyText = mode === 'voice' ? audioUrl : `${text}\n${audioUrl}`;
        } else {
          // edge-tts failed; fall back to text so we never block the reply.
          console.error('[send-message] voice generation failed; delivering text only.');
        }
      }
    }

    const msgId = sendMessage(paths, env.agentName, to, priority as Priority, bodyText, effectiveReplyTo, opts.traceId);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'agent_message_sent', 'info', JSON.stringify({ to, priority, msg_id: msgId, reply_to: effectiveReplyTo ?? null, trace_id: opts.traceId ?? null, mode: agentExists ? null : mode }));
    } catch { /* non-fatal */ }

    // -----------------------------------------------------------------------
    // Telegram mirror — when replying to the user, also deliver on Telegram
    // so the user sees the same reply in both places. Reads BOT_TOKEN +
    // CHAT_ID from the calling agent's .env. If either is missing, skip
    // silently (agent continues to behave normally for Telegram-less setups).
    // -----------------------------------------------------------------------
    if (!agentExists) {
      const botToken = readAgentEnvVar(env.agentDir, 'BOT_TOKEN') || process.env.BOT_TOKEN || '';
      const chatId = readAgentEnvVar(env.agentDir, 'CHAT_ID') || process.env.CHAT_ID || '';
      if (botToken && chatId) {
        try {
          const api = new TelegramAPI(botToken);
          let sentMessageId = 0;
          if (tmpAudioFile && (mode === 'voice' || mode === 'both')) {
            const caption = mode === 'both' ? text : '';
            const result = await api.sendDocument(chatId, tmpAudioFile, caption);
            sentMessageId = result?.result?.message_id ?? 0;
          } else {
            const result = await api.sendMessage(chatId, text, undefined, { parseMode: 'HTML' });
            sentMessageId = result?.result?.message_id ?? 0;
          }
          if (env.ctxRoot && env.agentName) {
            // IMPORTANT: don't call logOutboundMessage here. The inbox JSON
            // we already wrote via sendMessage() is what the dashboard
            // /comms channel endpoint renders; adding an outbound-messages.jsonl
            // entry for the same reply makes the channel view show it twice
            // (once from inbox, once from the telegram log). cacheLastSent is
            // kept because it feeds agent context injection, not the UI.
            const dashText = audioUrl && mode === 'both' ? `${text}\n${audioUrl}` : audioUrl && mode === 'voice' ? audioUrl : text;
            cacheLastSent(env.ctxRoot, env.agentName, chatId, dashText);
          }
        } catch (err: any) {
          console.error(`[send-message] Telegram mirror failed: ${err.message || err}`);
        }
      }
    }

    if (tmpAudioFile) {
      try { require('fs').unlinkSync(tmpAudioFile); } catch { /* ignore */ }
    }

    console.log(msgId);
    // Exit immediately after all local writes and Telegram mirror complete.
    // sendMessage() and logEvent() both schedule fire-and-forget async work via
    // setImmediate → mirrorMessageToRgos/mirrorEventToRgos → drainRetryQueue.
    // Each drain entry holds a 10s fetch; with a large retry queue the event
    // loop can stay alive for tens of minutes. The drain is persisted to disk
    // and runs on the next daemon cycle — exiting here does not lose data.
    process.exit(0);
  });

busCommand
  .command('check-inbox')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const messages = checkInbox(paths);
    console.log(JSON.stringify(messages));
  });

busCommand
  .command('ack-inbox')
  .argument('<id>', 'Message ID to acknowledge')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    ackInbox(paths, id);
    try {
      logEvent(paths, env.agentName, env.org, 'message', 'inbox_ack', 'info', JSON.stringify({ msg_id: id }));
    } catch { /* non-fatal */ }
    console.log(`ACK'd ${id}`);
    // Exit after local writes complete — logEvent schedules a drain via setImmediate
    // that can hold the process alive for tens of minutes (same hazard as send-telegram).
    process.exit(0);
  });

busCommand
  .command('create-task')
  .argument('<title>', 'Task title')
  .option('--desc <description>', 'Task description')
  .option('--assignee <agent>', 'Assigned agent')
  .option('--priority <p>', 'Priority (urgent, high, normal, low)', 'normal')
  .option('--project <name>', 'Project name')
  .option('--needs-approval', 'Require human approval before execution')
  .option('--blocked-by <ids>', 'Comma-separated task IDs that must complete before this task can progress')
  .option('--blocks <ids>', 'Comma-separated task IDs that this new task will block (symmetric reverse edge)')
  .option('--meta <json>', 'Free-form correlation metadata as JSON object (e.g. \'{"cron":"poll-codex-outbox"}\')')
  .action((title: string, opts: { desc?: string; assignee?: string; priority: string; project?: string; needsApproval?: boolean; blockedBy?: string; blocks?: string; meta?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const parseList = (raw?: string) => (raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []);
    let meta: Record<string, unknown> | undefined;
    if (opts.meta) {
      try {
        const parsed = JSON.parse(opts.meta);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.error('--meta must be a JSON object (e.g. \'{"key":"value"}\')');
          process.exit(1);
        }
        meta = parsed as Record<string, unknown>;
      } catch (err) {
        console.error(`--meta is not valid JSON: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    // Pre-generate trace_id so it's stored with the task from creation.
    // The task ID itself serves as the trace root — agents use it as `--trace-id $TASK_ID`
    // on downstream send-message calls to correlate the full workflow chain.
    const autoTraceId = randomString(12);
    const taskId = createTask(paths, env.agentName, env.org, title, {
      description: opts.desc,
      assignee: opts.assignee,
      priority: opts.priority as Priority,
      project: opts.project,
      needsApproval: opts.needsApproval ?? false,
      blockedBy: parseList(opts.blockedBy),
      blocks: parseList(opts.blocks),
      meta: { trace_id: autoTraceId, ...(meta ?? {}) },
    });
    console.log(taskId);
    // Auto-notify assignee so the task is visible immediately (issue #78)
    if (opts.assignee && opts.assignee !== env.agentName) {
      const assigneePaths = resolvePaths(opts.assignee, env.instanceId, env.org);
      const desc = opts.desc ? ` — ${opts.desc.slice(0, 120)}` : '';
      sendMessage(assigneePaths, env.agentName, opts.assignee, 'normal',
        `Task assigned: [${opts.priority}] ${title}${desc} (id: ${taskId})`);
    }
    // Exit after all local writes complete. createTask() fires mirrorTaskToRgos
    // and sendMessage() fires mirrorMessageToRgos — both via fire-and-forget;
    // the drain is persisted to disk and runs on the next daemon cycle.
    process.exit(0);
  });

busCommand
  .command('update-task')
  .argument('<id>', 'Task ID')
  .argument('<status>', 'New status (pending, in_progress, completed, blocked, cancelled)')
  .action((id: string, status: string) => {
    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];
    if (!validStatuses.includes(status as TaskStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // Guard: block review/completion when deliverables are required but missing.
    // Checks both ready_for_review (approval workflow) and completed (vanilla upstream)
    // so the validator works regardless of which status set is installed.
    if ((status === 'ready_for_review' || status === 'completed') && env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    updateTask(paths, id, status as TaskStatus);
    console.log(`Updated ${id} -> ${status}`);
    // Exit after local write completes — updateTask fires mirrorTaskToRgos
    // which schedules drainRetryQueue; exit before the drain runs.
    process.exit(0);
  });

busCommand
  .command('compact-tasks')
  .description('Archive completed tasks older than N days into a per-month archive-YYYY-MM.jsonl and remove them from the active list — preserves audit logs, skips tasks still needed as blockers')
  .option('--older-than <days>', 'Cutoff in days (default: 30)', '30')
  .option('--dry-run', 'Report what would be compacted without modifying anything')
  .action((opts: { olderThan: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const olderThanDays = parseInt(opts.olderThan, 10);
    if (isNaN(olderThanDays) || olderThanDays < 0) {
      console.error('--older-than must be a non-negative integer');
      process.exit(1);
    }
    const report = compactTasks(paths, { olderThanDays, dryRun: opts.dryRun });
    const verb = report.dry_run ? 'would compact' : 'compacted';
    console.log(`${verb} ${report.archived.length} task${report.archived.length === 1 ? '' : 's'}, skipped ${report.skipped.length}`);
    for (const a of report.archived) console.log(`  ✓ ${a.id}  ->  ${a.archive_file}`);
    if (report.skipped.length > 0) {
      console.log(`\nSkipped (common reasons: within cutoff, still needed as blocker):`);
      for (const s of report.skipped) console.log(`  - ${s.id}  (${s.reason})`);
    }
  });

busCommand
  .command('check-deps')
  .description('Show open dependencies blocking a task — lists blocked_by entries that are not yet completed')
  .argument('<id>', 'Task ID')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const open = checkTaskDependencies(paths, id);
    if (open.length === 0) {
      console.log(`${id}: no open dependencies — ready to work`);
      return;
    }
    console.log(`${id} blocked by ${open.length} dependency${open.length === 1 ? '' : 's'}:`);
    for (const d of open) console.log(`  ${d.id}  [${d.status}]`);
  });

busCommand
  .command('task-history')
  .description("Show a task's append-only audit log (every status change, claim, and completion)")
  .argument('<id>', 'Task ID')
  .option('--json', 'Emit raw JSONL instead of formatted text')
  .action((id: string, opts: { json?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const entries = readTaskAudit(paths, id);
    if (entries.length === 0) {
      console.log(`No audit log for task ${id}`);
      return;
    }
    if (opts.json) {
      for (const e of entries) console.log(JSON.stringify(e));
      return;
    }
    console.log(`Audit log for ${id} (${entries.length} entries):`);
    for (const e of entries) {
      const transition = e.from && e.to ? `${e.from} -> ${e.to}` : e.to || '';
      const note = e.note ? ` | ${e.note}` : '';
      console.log(`  ${e.ts}  ${e.event.padEnd(8)}  ${e.agent.padEnd(16)}  ${transition}${note}`);
    }
  });

busCommand
  .command('claim-task')
  .description('Atomically claim a pending task — marks in_progress + sets assignee in one shot, rejecting if another agent already owns it')
  .argument('<id>', 'Task ID')
  .option('--agent <name>', 'Agent claiming the task (defaults to CTX_AGENT_NAME)')
  .action((id: string, opts: { agent?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const agent = opts.agent || env.agentName;
    if (!agent) {
      console.error('ERROR: --agent or CTX_AGENT_NAME required');
      process.exit(1);
    }
    try {
      const task = claimTask(paths, id, agent);
      console.log(`Claimed ${id} -> in_progress (assigned to ${agent})`);
      console.log(`  Title: ${task.title}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('complete-task')
  .argument('<id>', 'Task ID')
  .argument('[result]', 'Completion result (optional positional form)')
  .option('--result <text>', 'Completion result')
  .action((id: string, resultArg: string | undefined, opts: { result?: string }) => {
    // Accept result as either positional arg or --result flag (P1 fix #8)
    const effectiveResult = opts.result ?? resultArg;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // Guard: block completion when deliverables are required but missing
    if (env.org) {
      const err = checkDeliverableRequirement(id, env.frameworkRoot, env.org, paths);
      if (err) {
        console.error(err);
        process.exit(1);
      }
    }

    completeTask(paths, id, effectiveResult);
    console.log(`Completed ${id}`);
    // Exit after local write completes — completeTask fires mirrorTaskToRgos
    // which schedules drainRetryQueue; exit before the drain runs.
    process.exit(0);
  });

busCommand
  .command('save-output')
  .description('Copy a file into the per-task deliverables tree and link it to the task as a file output')
  .argument('<task-id>', 'Target task ID')
  .argument('<source>', 'Source file to save (absolute or relative to cwd)')
  .option('--label <label>', 'Human-readable label for the linked output (defaults to filename)')
  .option('--move', 'Delete the source file after a successful copy')
  .option('--no-link', 'Save file without linking to task.outputs[]')
  .action((taskId: string, source: string, opts: { label?: string; move?: boolean; link?: boolean }) => {
    const noLink = opts.link === false;
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      const result = saveOutput(paths, {
        taskId,
        sourcePath: source,
        label: opts.label,
        move: opts.move ?? false,
        noLink,
      });
      console.log(result.targetPath);
      if (result.linked) {
        console.log(`Linked to ${taskId} as [snapshot] ${opts.label ?? result.storedPath}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

busCommand
  .command('list-tasks')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--respect-deps', 'Sort DAG-aware: unblocked tasks first, blocked tasks last')
  .action((opts: { agent?: string; status?: string; format?: string; respectDeps?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const tasks = listTasks(paths, {
      agent: opts.agent,
      status: opts.status as TaskStatus,
      respectDeps: opts.respectDeps ?? false,
    });

    if (opts.format === 'json') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    // Text table format
    if (tasks.length === 0) {
      console.log('  No tasks found.');
      return;
    }

    const PRIORITY_ICON: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '🔵', low: '⚪' };
    const STATUS_ICON: Record<string, string> = { pending: '○', in_progress: '●', blocked: '◑', completed: '✓', done: '✓', cancelled: '✗' };

    console.log(`\n  Tasks (${tasks.length})\n`);
    const header = '  Status  Pri  ID                        Assignee         Title';
    const separator = '  ' + '-'.repeat(header.length - 2);
    console.log(header);
    console.log(separator);

    for (const t of tasks) {
      const statusIcon = (STATUS_ICON[t.status] || '?').padEnd(8);
      const priIcon = (PRIORITY_ICON[t.priority] || '·').padEnd(5);
      const id = t.id.substring(0, 26).padEnd(26);
      const assignee = (t.assigned_to || '-').substring(0, 16).padEnd(17);
      const title = t.title.substring(0, 50);
      console.log(`  ${statusIcon}${priIcon}${id}${assignee}${title}`);
    }
    console.log('');
  });

busCommand
  .command('log-event')
  .argument('<category>', 'Event category')
  .argument('<event>', 'Event name')
  .argument('<severity>', 'Severity (info, warning, error, critical)')
  .option('--meta <json>', 'Metadata JSON string', '{}')
  .action((category: string, event: string, severity: string, opts: { meta: string }) => {
    const validCategories: EventCategory[] = ['action', 'error', 'metric', 'milestone', 'heartbeat', 'message', 'task', 'approval'];
    if (!validCategories.includes(category as EventCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const validSeverities: EventSeverity[] = ['info', 'warning', 'error', 'critical'];
    if (!validSeverities.includes(severity as EventSeverity)) {
      console.error(`Invalid severity '${severity}'. Must be one of: ${validSeverities.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    logEvent(paths, env.agentName, env.org, category as EventCategory, event, severity as EventSeverity, opts.meta);
    console.log(`Logged ${category}/${event} (${severity})`);
    // Exit after local JSONL write completes — logEvent schedules mirrorEventToRgos
    // via setImmediate which triggers drainRetryQueue; exit before drain runs.
    process.exit(0);
  });

busCommand
  .command('update-heartbeat')
  .argument('<status>', 'Heartbeat status message')
  .option('--task <task>', 'Current task description')
  .option('--timezone <tz>', 'Timezone for day/night mode detection')
  .option('--interval <i>', 'Loop interval from cron config')
  .action((status: string, opts: { task?: string; timezone?: string; interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);

    // Read display name from IDENTITY.md so agents self-report their user-facing name
    let displayName: string | undefined;
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
    if (frameworkRoot) {
      const identityPaths = [
        join(frameworkRoot, 'orgs', env.org, 'agents', env.agentName, 'IDENTITY.md'),
        join(frameworkRoot, 'agents', env.agentName, 'IDENTITY.md'),
      ];
      for (const idPath of identityPaths) {
        if (existsSync(idPath)) {
          try {
            const lines = readFileSync(idPath, 'utf-8').split('\n');
            // "## Name" section takes priority (user-configured display name)
            const nameIdx = lines.findIndex(l => l.trim() === '## Name');
            if (nameIdx >= 0) {
              for (let i = nameIdx + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || line.startsWith('<!--')) continue;
                if (line.startsWith('#')) break;
                displayName = line;
                break;
              }
            }
            // Fallback: first non-empty, non-comment top-level heading value
            if (!displayName) {
              const h1 = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
              if (h1) displayName = h1.replace(/^#\s+/, '').trim();
            }
          } catch {
            // Skip
          }
          break;
        }
      }
    }

    updateHeartbeat(paths, env.agentName, status, {
      org: env.org,
      timezone: opts.timezone,
      loopInterval: opts.interval,
      currentTask: opts.task,
      displayName,
    });
    // Auto-emit a heartbeat event so the activity feed surfaces any live agent
    // even if the agent itself forgets to call log-event. This makes the
    // dashboard "agents" list derive from heartbeats, not just explicit events.
    try {
      logEvent(paths, env.agentName, env.org, 'heartbeat', 'heartbeat', 'info', JSON.stringify({ status, task: opts.task ?? '' }));
    } catch {
      // Non-fatal: heartbeat write already succeeded
    }
    console.log(`Heartbeat updated: ${env.agentName}`);
    // Exit after all local writes complete — logEvent schedules mirrorEventToRgos
    // via setImmediate → drainRetryQueue. The drain is disk-persisted and runs
    // on the next daemon cycle; exiting here does not lose data.
    process.exit(0);
  });

busCommand
  .command('orgo-lease-claim')
  .description('Claim an Orgo fleet node lease in Supabase orch_fleet_nodes')
  .requiredOption('--node <node_key>', 'Orgo node_key to claim')
  .requiredOption('--focus <text>', 'Current focus/workload for the lease')
  .option('--holder <agent>', 'Lease holder (defaults to CTX_AGENT_NAME)')
  .option('--preconditions <json>', 'Required app/session/tool preconditions as JSON object', '{}')
  .option('--artifact <text>', 'Expected artifact/deliverable')
  .option('--release <text>', 'Release condition')
  .option('--escalation <text>', 'Escalation rule')
  .option('--ttl <minutes>', 'Artifact TTL / lease expiry in minutes', '60')
  .option('--value <text>', 'Throughput/cost/value signal')
  .option('--task <id>', 'Linked task id')
  .option('--force', 'Claim even when node is already busy or leased')
  .option('--json', 'Emit JSON')
  .action(async (opts: { node: string; focus: string; holder?: string; preconditions?: string; artifact?: string; release?: string; escalation?: string; ttl?: string; value?: string; task?: string; force?: boolean; json?: boolean }) => {
    try {
      const result = await claimOrgoLease({
        node: opts.node,
        focus: opts.focus,
        holder: opts.holder,
        preconditions: opts.preconditions,
        artifact: opts.artifact,
        release: opts.release,
        escalation: opts.escalation,
        ttl: parseInt(opts.ttl ?? '60', 10),
        value: opts.value,
        task: opts.task,
        force: opts.force ?? false,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Claimed ${result.node.node_key} lease ${result.lease.lease_id}`);
        console.log(`  holder: ${result.lease.holder}`);
        console.log(`  focus: ${result.lease.focus}`);
        console.log(`  expires_at: ${result.lease.expires_at}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('orgo-lease-release')
  .description('Release an active Orgo fleet node lease')
  .option('--lease <uuid>', 'Lease id to release')
  .option('--node <node_key>', 'Node key whose active lease should be released')
  .option('--result <text>', 'Result or produced artifact summary')
  .option('--json', 'Emit JSON')
  .action(async (opts: { lease?: string; node?: string; result?: string; json?: boolean }) => {
    if (!opts.lease && !opts.node) {
      console.error('Either --lease or --node is required');
      process.exit(1);
    }
    try {
      const result = await releaseOrgoLease({ lease: opts.lease, node: opts.node, result: opts.result });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Released ${result.node.node_key} lease ${result.released.lease_id}`);
        if (result.released.result) console.log(`  result: ${result.released.result}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('orgo-lease-status')
  .description('Show Orgo fleet lease status from Supabase orch_fleet_nodes')
  .option('--node <node_key>', 'Filter to a node')
  .option('--status <status>', 'busy, idle, or all', 'all')
  .option('--json', 'Emit JSON')
  .action(async (opts: { node?: string; status?: string; json?: boolean }) => {
    if (opts.status && !['busy', 'idle', 'all'].includes(opts.status)) {
      console.error('--status must be one of: busy, idle, all');
      process.exit(1);
    }
    try {
      const nodes = await listOrgoLeaseStatus({ node: opts.node, status: opts.status as 'busy' | 'idle' | 'all' });
      console.log(opts.json ? JSON.stringify(nodes, null, 2) : formatLeaseStatus(nodes));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('orgo-lease-watchdog')
  .description('List expired Orgo leases that need escalation')
  .option('--json', 'Emit JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      const expired = await checkOrgoLeaseWatchdog();
      if (opts.json) {
        console.log(JSON.stringify(expired, null, 2));
      } else if (expired.length === 0) {
        console.log('No expired Orgo leases.');
      } else {
        for (const item of expired) {
          console.log(`${item.node_key} expired at ${item.expired_at}: ${item.lease.escalation_rule}`);
        }
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

busCommand
  .command('read-all-heartbeats')
  .description('Read heartbeat files for all agents in the system')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .action((opts: { format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const heartbeats = readAllHeartbeats(paths);

    if (opts.format === 'json') {
      console.log(JSON.stringify(heartbeats, null, 2));
      return;
    }

    if (heartbeats.length === 0) {
      console.log('No agents found.');
      return;
    }

    for (const hb of heartbeats) {
      const stale = new Date(hb.last_heartbeat) < new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleFlag = stale ? ' [STALE]' : '';
      const label = hb.display_name ? `${hb.display_name} (${hb.agent})` : hb.agent;
      console.log(`${label} (${hb.org}) — ${hb.status}${staleFlag} — last seen ${hb.last_heartbeat}`);
      if (hb.current_task) console.log(`  task: ${hb.current_task}`);
    }
  });

busCommand
  .command('poll-watchdog')
  .description('Check all agent heartbeats against their lease thresholds and emit alerts for expired agents')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .option('--lease <seconds>', 'Default lease threshold in seconds (overridden per-agent by config.json watchdog.lease_seconds)', String(14400))
  .option('--restart', 'Auto soft-restart expired agents via daemon IPC')
  .action(async (opts: { format?: string; lease?: string; restart?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const defaultLeaseSeconds = Math.max(60, parseInt(opts.lease ?? '14400', 10) || 14400);

    const results = pollWatchdog(paths, env.agentName, env.org, {
      projectRoot: env.projectRoot,
      defaultLeaseSeconds,
    });

    const expired = results.filter(r => r.expired);

    if (opts.restart && expired.length > 0) {
      const ipc = new IPCClient(env.ctxRoot);
      for (const r of expired) {
        try {
          await ipc.send({ type: 'restart-agent', agent: r.agent, source: 'poll-watchdog' });
          console.log(`Restart signal sent for ${r.agent}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Failed to restart ${r.agent}: ${msg}`);
        }
      }
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log('No agents found.');
      return;
    }

    for (const r of results) {
      const flag = r.expired ? ' [EXPIRED]' : ' [OK]';
      const label = r.org ? `${r.agent} (${r.org})` : r.agent;
      const ageMin = Math.round(r.age_seconds / 60);
      const leaseMin = Math.round(r.lease_seconds / 60);
      console.log(`${label}${flag} — last seen ${r.last_heartbeat} (${ageMin}m ago, lease ${leaseMin}m)`);
    }
    if (expired.length > 0) {
      console.log(`\n${expired.length} agent(s) expired.`);
    } else {
      console.log('\nAll agents within lease.');
    }
  });

busCommand
  .command('codebase-scan')
  .description('Scan src/ for TODO/FIXME/HACK/XXX markers and large files; write daily report and create RGOS tasks')
  .option('--output <path>', 'Override output file path (default: agent output dir)')
  .option('--dry-run', 'Print report path but do not create RGOS tasks')
  .action(async (opts: { output?: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const today = new Date().toISOString().slice(0, 10);
    const outputPath = opts.output ??
      join(env.agentDir ?? join(env.projectRoot ?? env.frameworkRoot, 'orgs', env.org, 'agents', env.agentName),
        'output', `${today}-codebase-scan.md`);

    console.log(`[codebase-scan] Scanning ${env.frameworkRoot}/src ...`);
    const result = runCodebaseScan(env.frameworkRoot, outputPath);
    console.log(`[codebase-scan] Report written → ${outputPath}`);
    console.log(`[codebase-scan] Hits: ${result.hits.length} markers, ${result.largeFiles.length} large files`);

    if (!opts.dryRun && result.topActionable.length > 0) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      for (const item of result.topActionable) {
        const taskId = createTask(paths, env.agentName, env.org, `[codebase-scan] ${item}`, {
          description: `Auto-generated by codebase-scan loop on ${today}. See ${outputPath} for full report.`,
          priority: 'low',
        });
        console.log(`[codebase-scan] Created task ${taskId}: ${item}`);
        logEvent(paths, env.agentName, env.org, 'action', 'codebase_scan_task_created', 'info', { task_id: taskId });
      }
    }

    logEvent(
      resolvePaths(env.agentName, env.instanceId, env.org),
      env.agentName, env.org, 'action', 'codebase_scan_complete', 'info',
      { hits: result.hits.length, large_files: result.largeFiles.length, output: outputPath },
    );
  });

busCommand
  .command('security-audit')
  .description('Run npm audit, write daily report, and create RGOS tasks for critical/high vulns with fixes')
  .option('--output <path>', 'Override output file path (default: agent output dir)')
  .option('--dry-run', 'Write report but do not create RGOS tasks')
  .option('--cwd <dir>', 'Directory to audit (default: framework root)')
  .action(async (opts: { output?: string; dryRun?: boolean; cwd?: string }) => {
    const env = resolveEnv();
    const auditCwd = opts.cwd ?? env.frameworkRoot;
    const today = new Date().toISOString().slice(0, 10);
    const outputPath = opts.output ??
      join(env.agentDir ?? join(env.projectRoot ?? env.frameworkRoot, 'orgs', env.org, 'agents', env.agentName),
        'output', `${today}-npm-audit.md`);

    console.log(`[security-audit] Running npm audit in ${auditCwd} ...`);
    const result = runSecurityAudit(auditCwd, outputPath);
    console.log(`[security-audit] Report written → ${outputPath}`);
    console.log(`[security-audit] Critical: ${result.criticalCount}, High: ${result.highCount}, Actionable: ${result.actionable.length}`);

    if (!opts.dryRun && result.actionable.length > 0) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      for (const vuln of result.actionable) {
        const fix = typeof vuln.fixAvailable === 'object'
          ? `upgrade to ${vuln.fixAvailable.name}@${vuln.fixAvailable.version}`
          : 'fix available';
        const taskId = createTask(paths, env.agentName, env.org,
          `[security] ${vuln.severity} vuln in ${vuln.name} — ${fix}`, {
            description: `Detected by security-audit loop on ${today}. See ${outputPath}.`,
            priority: vuln.severity === 'critical' ? 'high' : 'normal',
          });
        console.log(`[security-audit] Created task ${taskId}: ${vuln.name} (${vuln.severity})`);
        logEvent(paths, env.agentName, env.org, 'action', 'security_vuln_task_created', 'info',
          { task_id: taskId, package: vuln.name, severity: vuln.severity });
      }
    }

    logEvent(
      resolvePaths(env.agentName, env.instanceId, env.org),
      env.agentName, env.org, 'action', 'security_audit_complete', 'info',
      { critical: result.criticalCount, high: result.highCount, actionable: result.actionable.length, output: outputPath },
    );
  });

busCommand
  .command('recall-facts')
  .description('Recall recent session facts extracted at compaction time (cross-session memory)')
  .option('--days <n>', 'How many days back to scan', '3')
  .option('--format <fmt>', 'Output format: text or json', 'text')
  .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
  .action((opts: { days: string; format: string; agent?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const daysBack = Math.max(1, Math.min(30, parseInt(opts.days, 10) || 3));
    const factsDir = join(env.ctxRoot, 'state', agentName, 'memory', 'facts');

    const entries: Array<{ ts: string; session_id: string; summary: string; keywords: string[] }> = [];

    for (let d = 0; d < daysBack; d++) {
      const date = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const factsFile = join(factsDir, `${dateStr}.jsonl`);
      if (!existsSync(factsFile)) continue;
      try {
        const lines = readFileSync(factsFile, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line));
          } catch { /* skip corrupt lines */ }
        }
      } catch { /* skip unreadable files */ }
    }

    if (opts.format === 'json') {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log('No session facts found. Facts are written automatically at context compaction.');
      return;
    }

    console.log(`\n  Session Memory — last ${daysBack} day(s) — ${entries.length} entries\n`);
    for (const e of entries.slice(-10)) { // Show last 10 entries
      const ts = e.ts.replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
      console.log(`  [${ts}]`);
      // Print first 400 chars of summary
      const preview = e.summary.slice(0, 400).replace(/\n/g, ' ');
      console.log(`  ${preview}${e.summary.length > 400 ? '...' : ''}`);
      if (e.keywords && e.keywords.length > 0) {
        console.log(`  Keywords: ${e.keywords.slice(0, 8).join(', ')}`);
      }
      console.log();
    }
  });

busCommand
  .command('check-stale-tasks')
  .description('Find stale tasks (in_progress >2h, pending >24h, overdue)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const report = checkStaleTasks(paths);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('archive-tasks')
  .description('Archive completed tasks older than 7 days')
  .option('--dry-run', 'Show what would be archived without modifying files')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const report = archiveTasks(paths, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-human-tasks')
  .description('Find stale human-assigned tasks (>24h)')
  .action(() => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const tasks = checkHumanTasks(paths);
    console.log(JSON.stringify(tasks));
  });

busCommand
  .command('self-restart')
  .description('Immediately restart this agent via daemon IPC (same as soft-restart but targets self)')
  .option('--reason <why>', 'Reason for restart')
  .action(async (opts: { reason?: string }) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reason = opts.reason || 'self-restart requested';

    // Write .user-restart marker (same as soft-restart)
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const stateDir = join(ctxRoot, 'state', env.agentName);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);

    // Also write to restarts.log
    selfRestart(paths, env.agentName, reason);

    // Send IPC restart-agent signal for self — makes restart immediate
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus self-restart' });
      if (resp.success) {
        console.log(`Restarting ${env.agentName} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('hard-restart')
  .description('Plan a hard restart (fresh session, no --continue)')
  .option('--reason <why>', 'Reason for restart')
  .option('--handoff-doc <path>', 'Path to handoff document to inject into next session boot prompt')
  .action(async (opts: { reason?: string; handoffDoc?: string }) => {
    const { writeFileSync: fsWrite, existsSync: fsExists, mkdirSync: fsMkdir } = require('fs');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    hardRestart(paths, env.agentName, opts.reason);
    if (opts.handoffDoc && fsExists(opts.handoffDoc)) {
      fsMkdir(paths.stateDir, { recursive: true });
      fsWrite(join(paths.stateDir, '.handoff-doc-path'), opts.handoffDoc + '\n', 'utf-8');
    }
    // Send IPC restart-agent so the daemon terminates and restarts this session
    // immediately. Without this the session keeps running — .force-fresh is only
    // consumed on the NEXT restart, which never comes unless the daemon is notified.
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: env.agentName, source: 'cortextos bus hard-restart' });
      if (resp.success) {
        console.log(`Hard restart triggered for ${env.agentName} — fresh session incoming`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.log('Hard restart planned (daemon not running — will take effect on next start)');
    }
  });

busCommand
  .command('auto-compact-agent')
  .description('Silently snapshot an agent and trigger a fresh restart (manual ops hatch; daemon fires the same chain at ctx_autoreset_threshold)')
  .argument('[agent]', 'Agent name (defaults to $CTX_AGENT_NAME)')
  .option('--reason <why>', 'Reason recorded in the snapshot + restart log', 'manual auto-compact')
  .option('--notify', 'Send Telegram notification (default is silent)')
  .option('--no-ipc', 'Arm markers only; skip the daemon IPC restart signal (markers still consume on the next restart triggered elsewhere)')
  .action(async (agentArg: string | undefined, opts: { reason: string; notify?: boolean; ipc?: boolean }) => {
    const env = resolveEnv();
    const target = agentArg || env.agentName;
    if (!target) {
      console.error('ERROR: agent name required (pass as argument or set CTX_AGENT_NAME)');
      process.exit(1);
    }
    validateAgentName(target);
    const paths = resolvePaths(target, env.instanceId, env.org);
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const report = autoCompactAgent(paths, target, frameworkRoot, {
      reason: opts.reason,
      silent: !opts.notify,
    });
    // Trigger the actual restart unless --no-ipc was passed. Without this,
    // markers are written but the agent keeps running until someone else
    // restarts it — which defeats the point of the manual hatch.
    let restartTriggered = false;
    let ipcError: string | undefined;
    if (opts.ipc !== false && !report.already_in_flight) {
      const ipc = new IPCClient(env.instanceId);
      if (await ipc.isDaemonRunning()) {
        const resp = await ipc.send({ type: 'restart-agent', agent: target, source: 'cortextos bus auto-compact-agent' });
        if (resp.success) {
          restartTriggered = true;
        } else {
          ipcError = resp.error || 'restart-agent IPC call failed';
        }
      } else {
        ipcError = 'daemon is not running — markers armed but no restart fired';
      }
    }
    console.log(JSON.stringify({ ...report, restart_triggered: restartTriggered, ipc_error: ipcError }));
    if (ipcError) process.exit(1);
  });

busCommand
  .command('auto-commit')
  .description('Stage safe files for commit (never pushes)')
  .option('--dry-run', 'Show what would be staged without modifying git')
  .action((opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const projectDir = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = autoCommit(projectDir, opts.dryRun ?? false);
    console.log(JSON.stringify(report));
  });

busCommand
  .command('check-goal-staleness')
  .description('Detect agents with stale GOALS.md')
  .option('--threshold <days>', 'Staleness threshold in days', '7')
  .action((opts: { threshold: string }) => {
    const env = resolveEnv();
    const projectRoot = env.projectRoot || env.frameworkRoot || process.cwd();
    const report = checkGoalStaleness(projectRoot, parseInt(opts.threshold, 10));
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('post-activity')
  .description('Post a message to the org Telegram activity channel')
  .argument('<message>', 'Message to post')
  .action(async (message: string) => {
    const env = resolveEnv();
    const orgDir = env.agentDir ? env.agentDir.replace(/\/agents\/.*$/, '') : '';
    const success = await postActivity(orgDir, env.ctxRoot, env.org, message);
    if (success) {
      console.log('Activity posted');
    } else {
      console.error('Failed to post activity. Check that ACTIVITY_CHAT_ID is set in your org secrets.env or .env file.');
    }
  });

busCommand
  .command('create-experiment')
  .description('Create a new experiment proposal')
  .argument('<metric>', 'Metric to measure')
  .argument('<hypothesis>', 'Hypothesis to test')
  .option('--surface <path>', 'Surface file path')
  .option('--direction <dir>', 'Direction: higher or lower', 'higher')
  .option('--window <dur>', 'Measurement window', '24h')
  .action(async (metric: string, hypothesis: string, opts: { surface?: string; direction?: string; window?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const id = createExperiment(agentDir, env.agentName, metric, hypothesis, {
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
    });
    console.log(id);

    // If approval_required is configured, auto-create an approval
    const config = loadExperimentConfig(agentDir);
    if (config.approval_required) {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      const approvalId = await createApproval(
        paths,
        env.agentName,
        env.org,
        `Run experiment: ${metric} — ${hypothesis.slice(0, 80)}`,
        'other',
        `Experiment ID: ${id}\nMetric: ${metric}\nHypothesis: ${hypothesis}`,
        env.frameworkRoot,
        env.agentDir,
      );
      console.log(`approval_required: ${approvalId}`);
    }

    // Sync to orch_experiments (non-blocking, best-effort)
    try {
      const exp = loadExperiment(agentDir, id);
      await syncExperimentToSupabase(exp, agentDir);
    } catch { /* non-fatal */ }
  });

busCommand
  .command('run-experiment')
  .description('Start running a proposed experiment')
  .argument('<id>', 'Experiment ID')
  .argument('[description]', 'Description of changes')
  .action(async (id: string, description?: string) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const experiment = runExperiment(agentDir, id, description);
    console.log(JSON.stringify(experiment, null, 2));
    try { await syncExperimentToSupabase(experiment, agentDir); } catch { /* non-fatal */ }
  });

busCommand
  .command('evaluate-experiment')
  .description('Evaluate a running experiment with a measured value, a 1-10 score, or both')
  .argument('<id>', 'Experiment ID')
  .argument('[value]', 'Measured value (quantitative metrics); omit for pure qualitative --score evals')
  .option('--score <n>', 'Score rubric 1-10 (stored in its own field; doubles as the result value when no positional value is provided)')
  .option('--justification <text>', 'Justification text')
  .action(async (id: string, value: string | undefined, opts: { score?: string; justification?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    const measuredValue = value !== undefined ? parseFloat(value) : undefined;
    if (measuredValue !== undefined && Number.isNaN(measuredValue)) {
      throw new Error(`Measured value '${value}' is not a number`);
    }
    const score = opts.score !== undefined ? parseInt(opts.score, 10) : undefined;
    if (score !== undefined && (Number.isNaN(score) || score < 1 || score > 10)) {
      throw new Error(`--score must be an integer 1-10 (got '${opts.score}')`);
    }
    const experiment = evaluateExperiment(agentDir, id, measuredValue, {
      score,
      justification: opts.justification,
    });
    console.log(JSON.stringify(experiment, null, 2));
    try { await syncExperimentToSupabase(experiment, agentDir); } catch { /* non-fatal */ }
  });

busCommand
  .command('list-experiments')
  .description('List experiments with optional filters')
  .option('--agent <name>', 'Filter by agent')
  .option('--status <s>', 'Filter by status')
  .option('--metric <m>', 'Filter by metric')
  .option('--json', 'Output as JSON')
  .action((opts: { agent?: string; status?: string; metric?: string; json?: boolean }) => {
    const env = resolveEnv();
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const experiments = listExperiments(agentDir, {
      agent: opts.agent,
      status: opts.status,
      metric: opts.metric,
    });
    console.log(JSON.stringify(experiments, null, 2));
  });

busCommand
  .command('gather-context')
  .description('Gather experiment context for an agent')
  .option('--agent <name>', 'Agent name')
  .option('--format <fmt>', 'Output format: json or markdown', 'json')
  .action((opts: { agent?: string; format?: string }) => {
    const env = resolveEnv();
    const agentName = opts.agent || env.agentName;
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const context = gatherContext(agentDir, agentName, { format: opts.format as 'json' | 'markdown' });
    console.log(JSON.stringify(context, null, 2));
  });

busCommand
  .command('manage-cycle')
  .description('Manage experiment cycles')
  .argument('<action>', 'Action: create, modify, remove, list')
  .argument('<agent>', 'Agent name')
  .option('--metric <name>', 'Metric name')
  .option('--metric-type <type>', 'Metric type: quantitative or qualitative')
  .option('--surface <path>', 'Surface path (file to experiment on)')
  .option('--direction <dir>', 'Direction: higher or lower')
  .option('--window <dur>', 'Measurement window (how long before evaluating)')
  .option('--measurement <method>', 'How to measure the metric')
  .option('--loop-interval <dur>', 'Cron frequency for the experiment loop')
  .option('--enabled <bool>', 'Enable or pause the cycle (true/false)')
  .option('--cycle <name>', 'Cycle name')
  .action((action: string, agent: string, opts: { metric?: string; metricType?: string; surface?: string; direction?: string; window?: string; measurement?: string; loopInterval?: string; enabled?: string; cycle?: string }) => {
    const env = resolveEnv();
    const agentDir = env.agentDir || process.cwd();
    if (opts.direction && opts.direction !== 'higher' && opts.direction !== 'lower') {
      console.error(`Invalid --direction '${opts.direction}'. Must be 'higher' or 'lower'`);
      process.exit(1);
    }
    if (opts.metricType && opts.metricType !== 'quantitative' && opts.metricType !== 'qualitative') {
      console.error(`Invalid --metric-type '${opts.metricType}'. Must be 'quantitative' or 'qualitative'`);
      process.exit(1);
    }
    const cycles = manageCycle(agentDir, action as 'create' | 'modify' | 'remove' | 'list', {
      agent,
      name: opts.cycle,
      metric: opts.metric,
      metric_type: opts.metricType as 'quantitative' | 'qualitative' | undefined,
      surface: opts.surface,
      direction: opts.direction as 'higher' | 'lower',
      window: opts.window,
      measurement: opts.measurement,
      loop_interval: opts.loopInterval,
      enabled: opts.enabled !== undefined ? opts.enabled === 'true' : undefined,
    });
    console.log(JSON.stringify(cycles, null, 2));
  });

busCommand
  .command('browse-catalog')
  .description('Browse community catalog for items')
  .option('--type <type>', 'Filter by type (skill, agent, org)')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search by name or description')
  .action((opts: { type?: string; tag?: string; search?: string }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = browseCatalog(frameworkRoot, env.ctxRoot, {
      type: opts.type,
      tag: opts.tag,
      search: opts.search,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('install-community-item')
  .description('Install a community catalog item')
  .argument('<name>', 'Item name to install')
  .option('--dry-run', 'Show what would be installed without modifying files')
  .action((name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = installCommunityItem(frameworkRoot, env.ctxRoot, name, {
      dryRun: opts.dryRun,
      agentDir: env.agentDir,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('prepare-submission')
  .description('Prepare a skill/agent/org for community submission with PII scanning')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<source-path>', 'Source directory path')
  .argument('<name>', 'Item name')
  .option('--dry-run', 'Scan without keeping staged files')
  .action((type: string, sourcePath: string, name: string, opts: { dryRun?: boolean }) => {
    const env = resolveEnv();
    const result = prepareSubmission(env.ctxRoot, type, sourcePath, name, {
      dryRun: opts.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('submit-community-item')
  .description('Submit a prepared item to the community catalog')
  .argument('<name>', 'Item name')
  .argument('<type>', 'Item type (skill, agent, org)')
  .argument('<description>', 'Item description')
  .option('--dry-run', 'Show what would be submitted')
  .option('--author <author>', 'Author name or handle for attribution')
  .option('--contribute', 'Create branch, push to origin, and open a PR against upstream')
  .action((name: string, type: string, description: string, opts: { dryRun?: boolean; author?: string; contribute?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = submitCommunityItem(frameworkRoot, env.ctxRoot, name, type, description, {
      dryRun: opts.dryRun,
      author: opts.author,
      contribute: opts.contribute,
    });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('collect-metrics')
  .description('Collect and aggregate system metrics across all agents')
  .action(() => {
    const env = resolveEnv();
    const report = collectMetrics(env.ctxRoot, env.org || undefined);
    console.log(JSON.stringify(report, null, 2));
  });

busCommand
  .command('scrape-usage')
  .description('Parse Claude Code /usage output and store usage data')
  .argument('<agent>', 'Agent name')
  .argument('<output>', 'Usage output text to parse')
  .action((agent: string, output: string) => {
    const env = resolveEnv();
    const data = parseUsageOutput(output, agent);
    storeUsageData(env.ctxRoot, data);
    console.log(JSON.stringify(data, null, 2));
  });

busCommand
  .command('check-upstream')
  .description('Check canonical repo for framework updates')
  .option('--apply', 'Merge upstream changes (requires user approval)')
  .action((opts: { apply?: boolean }) => {
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || env.projectRoot || process.cwd();
    const result = checkUpstream(frameworkRoot, { apply: opts.apply });
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('register-telegram-commands')
  .description('Register skills as Telegram bot commands')
  .argument('<bot-token>', 'Telegram bot token')
  .argument('<scan-dirs...>', 'Directories to scan for skills')
  .action(async (botToken: string, scanDirs: string[]) => {
    const commands = collectTelegramCommands(scanDirs);
    const result = await registerTelegramCommands(botToken, commands);
    console.log(JSON.stringify(result, null, 2));
  });

busCommand
  .command('send-telegram')
  .description('Send a message to a Telegram chat')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message>', 'Message text (supports Telegram Markdown unless --plain-text is set)')
  .option('--image <path>', 'Send a photo with caption')
  .option('--file <path>', 'Send a document/file with caption (any file type)')
  .option('--plain-text', 'Skip Telegram Markdown parsing entirely. Use this when the message contains unescaped _, *, backtick, or [ that would otherwise trip the Markdown parser. Without this flag, sendMessage still retries once with parse_mode disabled on a parse-entity error — so it is purely an opt-in to save the retry roundtrip.', false)
  .option('--policy-approval-id <id>', 'Approval ID authorizing a policy-gated direct Telegram send')
  .action(async (chatId: string, message: string, opts: { image?: string; file?: string; plainText?: boolean; policyApprovalId?: string }) => {
    // Codex agents emit literal '\n'/'\t' inside single-quoted bash where bash
    // does not expand escapes, so they arrive at argv as 2-char literals and
    // Telegram renders them as visible text. Normalize before send + log.
    message = message.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

    // P6 Duplicate Suppression: drop sends that are near-duplicates of a
    // recent outbound message (<60s, >70% Jaccard token overlap).
    {
      const dupEnv = resolveEnv();
      if (dupEnv.ctxRoot && dupEnv.agentName) {
        const dup = checkDuplicate(dupEnv.ctxRoot, dupEnv.agentName, chatId, message);
        if (dup.isDuplicate) {
          const paths = resolvePaths(dupEnv.agentName, dupEnv.instanceId, dupEnv.org);
          logEvent(paths, dupEnv.agentName, dupEnv.org, 'action', 'p6_dup_suppressed', 'info',
            JSON.stringify({ chat_id: chatId, matched_at: dup.matchedTimestamp, score: dup.matchedScore }));
          console.log('p6_dup_suppressed: duplicate message dropped');
          process.exit(0);
        }
      }
    }

    await enforcePolicyOrExit('externalEmail', 'send-telegram', chatId, {
      policyApprovalId: opts.policyApprovalId,
      exemptOrchestrator: true,
    });
    // Resolve bot token: agent .env first, then process.env
    const env = resolveEnv();
    let botToken = '';

    // 1. Check agent .env (most specific)
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const agentEnv = join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const content = readFileSync(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match && match[1].trim()) botToken = match[1].trim();
      }
    }

    // 2. Fall back to process env
    if (!botToken) {
      botToken = process.env.BOT_TOKEN || '';
    }

    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      let sentMessageId = 0;
      if (opts.image) {
        const result = await api.sendPhoto(chatId, opts.image, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else if (opts.file) {
        const result = await api.sendDocument(chatId, opts.file, message);
        sentMessageId = result?.result?.message_id ?? 0;
      } else {
        const result = await api.sendMessage(chatId, message, undefined, {
          parseMode: opts.plainText ? null : 'HTML',
        });
        sentMessageId = result?.result?.message_id ?? 0;
      }

      // Log outbound and cache last-sent for context injection.
      //
      // When the send included --image or --file, publish the same file to
      // {ctxRoot}/dashboard-uploads/ and append its /api/media/... URL to
      // the logged text. The dashboard /comms channel-view detects media
      // URLs in message text and renders inline images / audio players,
      // so this is what makes the Telegram attachment visible in the bus
      // terminal. The Telegram send above is unchanged.
      const env = resolveEnv();
      if (env.agentName && env.ctxRoot) {
        let dashText = message;
        const attachmentPath = opts.image || opts.file;
        if (attachmentPath) {
          const mediaUrl = publishFileToDashboardUploads(env.ctxRoot, env.agentName, attachmentPath);
          if (mediaUrl) {
            dashText = message ? `${message}\n${mediaUrl}` : mediaUrl;
          }
        }
        logOutboundMessage(env.ctxRoot, env.agentName, chatId, dashText, sentMessageId, {
          parseMode: opts.plainText ? 'none' : 'html',
        });
        cacheLastSent(env.ctxRoot, env.agentName, chatId, dashText);
        // Auto-emit activity event so dashboard sees every Telegram send,
        // even from agents that never call log-event directly.
        try {
          const paths = resolvePaths(env.agentName, env.instanceId, env.org);
          const preview = message.length > 120 ? message.slice(0, 120) + '…' : message;
          logEvent(paths, env.agentName, env.org, 'message', 'telegram_sent', 'info', JSON.stringify({ chat_id: chatId, message_id: sentMessageId, preview }));
        } catch { /* non-fatal */ }
      }

      console.log('Message sent');
    } catch (err: any) {
      console.error(`Failed to send: ${err.message || err}`);
      process.exit(1);
    }
    // Exit immediately after all local writes complete. The bus-mirror
    // retry-drain (drainRetryQueue) is launched via setImmediate and uses
    // long-timeout fetch calls that keep the Node event loop alive
    // indefinitely when Supabase is slow or unreachable. The drain is
    // fire-and-forget: the retry queue is persisted to disk and will be
    // drained on the next bus write or daemon cycle. Calling process.exit(0)
    // here fires before any setImmediate callbacks, so the drain never runs
    // in this short-lived process — which is the correct behaviour for a CLI
    // command. Without this, send-telegram can hang for hours (one 10s
    // timeout x N queued entries) and leave zombie processes.
    process.exit(0);
  });

busCommand
  .command('send-telegram-voice')
  .description('Synthesize text with OpenAI tts-1 and send it as a Telegram voice message')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<text>', 'Text to speak')
  .option('--policy-approval-id <id>', 'Approval ID authorizing a policy-gated direct Telegram send')
  .action(async (chatId: string, text: string, opts: { policyApprovalId?: string }) => {
    await enforcePolicyOrExit('externalEmail', 'send-telegram-voice', chatId, {
      policyApprovalId: opts.policyApprovalId,
      exemptOrchestrator: true,
    });
    const result = await sendTelegramVoice(chatId, text);
    if (!result.ok) {
      console.error(`send-telegram-voice failed: ${result.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, message_id: result.messageId ?? null }));
  });

busCommand
  .command('voice-reply')
  .description(
    "Generate an MP3 from text and send to Telegram. Engine: google-tts-neural2 (default when GOOGLE_TTS_API_KEY set) " +
    "or edge-tts (free fallback). Usage logged to voice_usage. Hard cap $5/day → auto-fallback to edge-tts."
  )
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<text>', 'Text to speak')
  .option('--voice <name>', 'Override edge-tts voice name (e.g. en-US-AndrewNeural). Defaults to config.json voice field.')
  .option('--engine <name>', 'TTS engine: google-tts-neural2 | edge-tts. Default: google-tts-neural2 if key set, else edge-tts.')
  .option('--local', 'Also play through Mac speakers via afplay after sending')
  .action(async (chatId: string, text: string, opts: { voice?: string; engine?: string; local?: boolean }) => {
    const { execFileSync: execFile, spawnSync: spawnCmd } = require('child_process') as typeof import('child_process');
    const { unlinkSync, existsSync: fsExists, readFileSync: fsRead, mkdirSync: fsMkdir,
            copyFileSync: fsCopy, writeFileSync: fsWrite, appendFileSync: fsAppend } =
      require('fs') as typeof import('fs');
    const { join: pathJoin } = require('path') as typeof import('path');
    const os = require('os') as typeof import('os');
    const https = require('https') as typeof import('https');

    const env = resolveEnv();
    const DAILY_CAP_USD = 5.0;

    // Resolve bot token
    let botToken = '';
    if (env.agentDir) {
      const agentEnv = pathJoin(env.agentDir, '.env');
      if (fsExists(agentEnv)) {
        const content = fsRead(agentEnv, 'utf-8');
        const match = content.match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured.');
      process.exit(1);
    }

    // Resolve edge-tts voice name: CLI flag > config.json > fallback
    let edgeTtsVoice = opts.voice || '';
    if (!edgeTtsVoice && env.agentDir) {
      const configPath = pathJoin(env.agentDir, 'config.json');
      if (fsExists(configPath)) {
        try { const cfg = JSON.parse(fsRead(configPath, 'utf-8')); if (cfg.voice) edgeTtsVoice = cfg.voice; } catch { /* */ }
      }
    }
    if (!edgeTtsVoice) edgeTtsVoice = 'en-US-AndrewNeural';

    // Determine engine: CLI flag > config.json voice_engine > auto (google if key present, else edge-tts)
    const gcpKey = process.env.GOOGLE_TTS_API_KEY || '';
    let desiredEngine: 'google-tts-neural2' | 'edge-tts' = 'edge-tts';
    if (opts.engine === 'google-tts-neural2') {
      desiredEngine = 'google-tts-neural2';
    } else if (opts.engine === 'edge-tts') {
      desiredEngine = 'edge-tts';
    } else {
      // Read from config or auto-detect
      if (env.agentDir) {
        const cfgPath = pathJoin(env.agentDir, 'config.json');
        if (fsExists(cfgPath)) {
          try {
            const cfg = JSON.parse(fsRead(cfgPath, 'utf-8'));
            if (cfg.voice_engine === 'google-tts-neural2') desiredEngine = 'google-tts-neural2';
          } catch { /* */ }
        }
      }
      // Auto: use google if key is available
      if (desiredEngine === 'edge-tts' && gcpKey) desiredEngine = 'google-tts-neural2';
    }

    // Check daily cap → fall back to edge-tts if exceeded
    const spentToday = await todayTtsCost();
    let usedEngine = desiredEngine;
    if (desiredEngine === 'google-tts-neural2' && spentToday >= DAILY_CAP_USD) {
      usedEngine = 'edge-tts';
      console.warn(`[voice-reply] daily cap $${DAILY_CAP_USD} hit ($${spentToday.toFixed(4)} today). Falling back to edge-tts.`);
      try {
        const { execFileSync: ef } = require('child_process') as typeof import('child_process');
        ef('cortextos', ['bus', 'send-message', 'orchestrator', 'normal',
          `Voice cap hit: $${spentToday.toFixed(4)} today. Falling back to edge-tts until tomorrow.`],
          { stdio: 'pipe', timeout: 10000 });
      } catch { /* non-fatal */ }
    }

    // Also fall back if google engine selected but no key
    if (usedEngine === 'google-tts-neural2' && !gcpKey) {
      console.warn('[voice-reply] GOOGLE_TTS_API_KEY not set — falling back to edge-tts.');
      usedEngine = 'edge-tts';
    }

    const tmpFile = pathJoin(os.tmpdir(), `voice-reply-${Date.now()}.mp3`);
    const t0 = Date.now();

    if (usedEngine === 'google-tts-neural2') {
      // Google Cloud TTS Neural2
      const body = JSON.stringify({
        input: { text },
        voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
        audioConfig: { audioEncoding: 'MP3' },
      });
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'texttospeech.googleapis.com',
            path: `/v1/text:synthesize?key=${gcpKey}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          },
          (res: any) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              if (res.statusCode !== 200) {
                reject(new Error(`Google TTS ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
                return;
              }
              try {
                const json = JSON.parse(Buffer.concat(chunks).toString());
                fsWrite(tmpFile, Buffer.from(json.audioContent, 'base64'));
                resolve();
              } catch (e: any) { reject(e); }
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      }).catch(async (err: Error) => {
        console.warn(`[voice-reply] Google TTS failed (${err.message}), falling back to edge-tts.`);
        usedEngine = 'edge-tts';
        try {
          execFile('python3', ['-m', 'edge_tts', '--voice', edgeTtsVoice, '--text', text, '--write-media', tmpFile], { stdio: 'pipe' });
        } catch (e: any) {
          console.error(`edge-tts fallback failed: ${e.message}`);
          process.exit(1);
        }
      });
    } else {
      // edge-tts (free)
      try {
        execFile('python3', ['-m', 'edge_tts', '--voice', edgeTtsVoice, '--text', text, '--write-media', tmpFile], { stdio: 'pipe' });
      } catch (err: any) {
        console.error(`edge-tts failed: ${err.message || err}`);
        process.exit(1);
      }
    }

    const durationSeconds = (Date.now() - t0) / 1000;

    if (!fsExists(tmpFile)) {
      console.error('TTS did not produce output file');
      process.exit(1);
    }

    try {
      if (opts.local) spawnCmd('afplay', [tmpFile], { stdio: 'inherit' });

      // Publish the MP3 under {ctxRoot}/dashboard-uploads so /api/media/...
      // can serve it back to the dashboard chat UI.
      let audioUrl = '';
      if (env.ctxRoot) {
        try {
          const uploadsDir = pathJoin(env.ctxRoot, 'dashboard-uploads');
          fsMkdir(uploadsDir, { recursive: true });
          const safeAgent = (env.agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
          const audioFilename = `${Date.now()}-voice-${safeAgent}.mp3`;
          fsCopy(tmpFile, pathJoin(uploadsDir, audioFilename));
          audioUrl = `/api/media/dashboard-uploads/${audioFilename}`;
        } catch (err: any) {
          console.error(`[voice-reply] publish to dashboard-uploads failed: ${err.message || err}`);
        }
      }

      // Send via Telegram
      const api = new TelegramAPI(botToken);
      await api.sendDocument(chatId, tmpFile, '');

      // Log to outbound-messages.jsonl so the dashboard chat shows text + audio player.
      if (env.agentName && env.ctxRoot) {
        const dashboardText = audioUrl ? `${text}\n${audioUrl}` : text;
        logOutboundMessage(env.ctxRoot, env.agentName, chatId, dashboardText, 0, {});
        cacheLastSent(env.ctxRoot, env.agentName, chatId, dashboardText);
        try {
          const paths = resolvePaths(env.agentName, env.instanceId, env.org);
          logEvent(paths, env.agentName, env.org, 'message', 'voice_sent', 'info',
            JSON.stringify({ chat_id: chatId, engine: usedEngine, chars: text.length, audio_url: audioUrl || null }));
        } catch { /* non-fatal */ }
      }

      // Log usage to voice_usage (all engines — edge-tts logs $0 for cost visibility)
      const costEstimate = estimateTtsCost(usedEngine, text.length);
      const modelName = usedEngine === 'google-tts-neural2' ? 'en-US-Neural2-D' : edgeTtsVoice;
      await logTtsUsage({
        agent: env.agentName || 'unknown',
        engine: usedEngine,
        model: modelName,
        input_chars: text.length,
        duration_seconds: durationSeconds,
        cost_estimate_usd: costEstimate,
      });

      console.log(`Voice message sent (engine=${usedEngine}, ${durationSeconds.toFixed(1)}s, cost=$${costEstimate.toFixed(5)})`);
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// Voice POC L1 helpers — used by voice-reply and voice-usage-report
// ---------------------------------------------------------------------------

type TtsEngine = 'edge-tts' | 'google-tts-neural2';

/** USD per character. edge-tts is free. */
const TTS_COST_PER_CHAR: Record<TtsEngine, number> = {
  'edge-tts':           0,
  'google-tts-neural2': 0.004 / 1000, // $0.004 per 1K chars (Neural2)
};

function estimateTtsCost(engine: TtsEngine, chars: number): number {
  return (TTS_COST_PER_CHAR[engine] ?? 0) * chars;
}

/**
 * Query today's total TTS spend from SUPABASE_RGOS voice_usage table.
 * Returns 0 if Supabase is not configured or query fails.
 */
async function todayTtsCost(): Promise<number> {
  const sbUrl = process.env.SUPABASE_RGOS_URL;
  const sbKey = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.RGOS_SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/voice_usage?select=cost_estimate_usd&ts=gte.${today}T00:00:00Z`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!res.ok) return 0;
    const rows = await res.json() as Array<{ cost_estimate_usd: number }>;
    return rows.reduce((s, r) => s + (r.cost_estimate_usd ?? 0), 0);
  } catch { return 0; }
}

/**
 * Log a TTS usage record to SUPABASE_RGOS voice_usage table.
 * Fire-and-forget — failures are logged but do not abort the command.
 */
async function logTtsUsage(record: {
  agent: string; engine: TtsEngine; model: string;
  input_chars: number; duration_seconds: number; cost_estimate_usd: number;
}): Promise<void> {
  const sbUrl = process.env.SUPABASE_RGOS_URL;
  const sbKey = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.RGOS_SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return;
  try {
    await fetch(`${sbUrl}/rest/v1/voice_usage`, {
      method: 'POST',
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        agent:             record.agent,
        engine:            record.engine,
        model:             record.model,
        input_chars:       record.input_chars,
        duration_seconds:  record.duration_seconds,
        cost_estimate_usd: record.cost_estimate_usd,
        ts:                new Date().toISOString(),
      }),
    });
  } catch (err: any) {
    console.error(`[voice-reply] usage log failed: ${err.message}`);
  }
}

busCommand
  .command('voice-usage-report')
  .description('Query voice_usage for yesterday and send a cost summary to orchestrator. Runs daily at 09:00 PT via cron.')
  .action(async () => {
    const sbUrl = process.env.SUPABASE_RGOS_URL;
    const sbKey = process.env.SUPABASE_RGOS_SERVICE_KEY || process.env.RGOS_SUPABASE_SERVICE_KEY;
    if (!sbUrl || !sbKey) {
      console.error('SUPABASE_RGOS_URL / SUPABASE_RGOS_SERVICE_KEY not set — cannot generate report.');
      process.exit(1);
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toISOString().slice(0, 10);
    const startTs = `${yDate}T00:00:00Z`;
    const endTs   = `${yDate}T23:59:59Z`;

    try {
      const res = await fetch(
        `${sbUrl}/rest/v1/voice_usage?select=agent,engine,model,input_chars,cost_estimate_usd,ts&ts=gte.${startTs}&ts=lte.${endTs}&order=ts.desc`,
        { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
      );
      if (!res.ok) {
        console.error(`Supabase query failed: ${res.status}`);
        process.exit(1);
      }
      const rows = await res.json() as Array<{ agent: string; engine: string; model: string; input_chars: number; cost_estimate_usd: number }>;

      const totalCost  = rows.reduce((s, r) => s + (r.cost_estimate_usd ?? 0), 0);
      const totalCalls = rows.length;
      const byEngine: Record<string, { calls: number; cost: number }> = {};
      for (const r of rows) {
        const e = r.engine || 'unknown';
        if (!byEngine[e]) byEngine[e] = { calls: 0, cost: 0 };
        byEngine[e].calls++;
        byEngine[e].cost += r.cost_estimate_usd ?? 0;
      }

      const lines = [`Voice usage ${yDate}: ${totalCalls} calls, $${totalCost.toFixed(4)} total`];
      for (const [eng, { calls, cost }] of Object.entries(byEngine)) {
        lines.push(`  ${eng}: ${calls} calls, $${cost.toFixed(4)}`);
      }
      if (totalCalls === 0) lines.push('  No calls logged yesterday.');

      const summary = lines.join('\n');
      console.log(summary);

      try {
        const { execFileSync: ef } = require('child_process') as typeof import('child_process');
        ef('cortextos', ['bus', 'send-message', 'orchestrator', 'normal', summary], { stdio: 'pipe', timeout: 10000 });
        console.log('[voice-usage-report] sent to orchestrator');
      } catch (err: any) {
        console.error(`[voice-usage-report] send-message failed: ${err.message}`);
      }
    } catch (err: any) {
      console.error(`[voice-usage-report] error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// Reply-mode preference
//
// The dashboard user can choose how an agent should reply: text only,
// voice only, or both. The preference is stored per-agent at
// {ctxRoot}/state/{agent}/reply-mode so the same preference applies whether
// the reply goes out over Telegram or into a bus channel.
//
// Default is "text" — agents should ONLY switch to voice/both when the file
// explicitly asks for it.
// ---------------------------------------------------------------------------
busCommand
  .command('reply-mode')
  .description("Read or set the user's preferred reply mode for this agent (text | voice | both). Default is text.")
  .argument('[mode]', 'Set the mode. Omit to read the current mode.')
  .option('--agent <name>', 'Agent name (default: current agent from CTX_AGENT_NAME)')
  .action((mode: string | undefined, opts: { agent?: string }) => {
    const { readFileSync: fsRead, writeFileSync: fsWrite, mkdirSync: fsMkdir, renameSync: fsRename } = require('fs') as typeof import('fs');
    const { join: pathJoin } = require('path') as typeof import('path');
    const env = resolveEnv();
    const agent = opts.agent || env.agentName;
    if (!agent) {
      console.error('ERROR: --agent or CTX_ARGENT_NAME required');
      process.exit(1);
    }
    if (!env.ctxRoot) {
      console.error('ERROR: CTX_ROOT not resolvable');
      process.exit(1);
    }
    const stateDir = pathJoin(env.ctxRoot, 'state', agent);
    const file = pathJoin(stateDir, 'reply-mode');
    if (mode === undefined) {
      try {
        const v = fsRead(file, 'utf-8').trim();
        if (v === 'voice' || v === 'both' || v === 'text') {
          console.log(v);
          return;
        }
      } catch { /* fall through to default */ }
      console.log('text');
      return;
    }
    if (mode !== 'text' && mode !== 'voice' && mode !== 'both') {
      console.error('ERROR: mode must be one of text | voice | both');
      process.exit(1);
    }
    fsMkdir(stateDir, { recursive: true });
    const tmp = file + '.tmp';
    fsWrite(tmp, mode);
    fsRename(tmp, file);
    console.log(mode);
  });

busCommand
  .command('create-approval')
  .description('Request human approval for a high-stakes action')
  .argument('<title>', 'What you are requesting approval for')
  .argument('<category>', 'Category: external-comms, financial, deployment, data-deletion, other')
  .argument('[context]', 'Additional context')
  .action(async (title: string, category: string, context?: string) => {
    const validCategories: ApprovalCategory[] = ['external-comms', 'financial', 'deployment', 'data-deletion', 'other'];
    if (!validCategories.includes(category as ApprovalCategory)) {
      console.error(`Invalid category '${category}'. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    // await — createApproval fan-out posts to the activity channel, which
    // must complete before the CLI process exits or the post silently
    // never sends. env.frameworkRoot is passed so the activity-channel
    // orgDir resolves to where activity-channel.env actually lives (the
    // framework repo path, NOT the runtime state path — see
    // src/bus/approval.ts:postApprovalToActivityChannel for the history).
    const id = await createApproval(paths, env.agentName, env.org, title, category as ApprovalCategory, context || '', env.frameworkRoot, env.agentDir);
    console.log(id);
  });

busCommand
  .command('update-approval')
  .description('Resolve an approval request')
  .argument('<id>', 'Approval ID')
  .argument('<status>', 'Resolution: approved or denied')
  .argument('[note]', 'Resolution note')
  .action((id: string, status: string, note?: string) => {
    const validStatuses: ApprovalStatus[] = ['approved', 'rejected'];
    if (!validStatuses.includes(status as ApprovalStatus)) {
      console.error(`Invalid status '${status}'. Must be one of: approved, rejected`);
      process.exit(1);
    }
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    updateApproval(paths, id, status as ApprovalStatus, note);
    console.log(`Approval ${id} -> ${status}`);
  });

// ---------------------------------------------------------------------------
// Knowledge Base commands
// ---------------------------------------------------------------------------

busCommand
  .command('kb-query')
  .description('Query the knowledge base (RAG search)')
  .argument('<question>', 'Question or search query')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared, private, or all', 'all')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--threshold <f>', 'Minimum similarity score (0-1)', '0.5')
  .option('--no-embed', 'Skip embedding provider; use wiki-grep fallback only')
  .option('--json', 'Output raw JSON')
  .action((question: string, opts: { org?: string; agent?: string; scope?: string; topK?: string; threshold?: string; noEmbed?: boolean; json?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const result = queryKnowledgeBase(
      resolvePaths(env.agentName, env.instanceId, org),
      question,
      {
        org,
        agent: opts.agent || env.agentName,
        scope: (opts.scope as 'shared' | 'private' | 'all') || 'all',
        topK: parseInt(opts.topK || '5', 10),
        threshold: parseFloat(opts.threshold || '0.5'),
        frameworkRoot: env.frameworkRoot || process.cwd(),
        instanceId: env.instanceId,
        noEmbed: opts.noEmbed,
      },
    );

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.results.length === 0) {
      console.log(`No results found for: "${question}"`);
      return;
    }

    console.log(`\n  Knowledge Base Results (${result.results.length}/${result.total})\n`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  [${i + 1}] Score: ${r.score.toFixed(3)} | ${r.source_file}`);
      console.log(`      ${r.content.substring(0, 200).replace(/\n/g, ' ')}...`);
      console.log('');
    }
  });

busCommand
  .command('kb-ingest')
  .description('Ingest files or directories into the knowledge base')
  .argument('<paths...>', 'Files or directories to ingest')
  .option('--org <org>', 'Organization name')
  .option('--agent <name>', 'Agent name (for private scope)')
  .option('--scope <s>', 'Scope: shared or private', 'shared')
  .option('--force', 'Re-ingest even if already indexed')
  .action((paths: string[], opts: { org?: string; agent?: string; scope?: string; force?: boolean }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    ensureKBDirs(env.instanceId, env.frameworkRoot, org);

    ingestKnowledgeBase(paths, {
      org,
      agent: opts.agent || env.agentName,
      scope: (opts.scope as 'shared' | 'private') || 'shared',
      force: opts.force,
      frameworkRoot: env.frameworkRoot || process.cwd(),
      instanceId: env.instanceId,
    });
  });

busCommand
  .command('kb-collections')
  .description('List knowledge base collections and document counts')
  .option('--org <org>', 'Organization name')
  .action((opts: { org?: string }) => {
    const env = resolveEnv();
    const org = opts.org || env.org;
    if (!org) {
      console.error('ERROR: --org or CTX_ORG required');
      process.exit(1);
    }

    const { execSync } = require('child_process');
    const { existsSync } = require('fs');
    const { join: pjoin } = require('path');
    const { homedir: hdir } = require('os');

    const wikiDir = process.env.WIKI_PATH || pjoin(hdir(), 'work', 'team-brain');
    if (!existsSync(wikiDir)) {
      console.log('Collection        Count');
      console.log('---------------- -----');
      console.log('wiki-grep         0');
      console.log('open-brain        0');
      return;
    }

    const countFiles = (pattern: string): number => {
      try {
        const out = execSync(`find ${pattern} -type f -name '*.md' 2>/dev/null | wc -l`, {
          cwd: wikiDir,
          encoding: 'utf-8',
          timeout: 10000,
        });
        return parseInt(out.trim(), 10) || 0;
      } catch {
        return 0;
      }
    };

    const wikiCount = countFiles('docs wiki .claude');
    const openBrainCount = countFiles('wiki/sources/thoughts');
    console.log('Collection        Count');
    console.log('---------------- -----');
    console.log(`wiki-grep         ${wikiCount}`);
    console.log(`open-brain        ${openBrainCount}`);
    console.log(`[kb] ChromaDB collections are deprecated for org ${org}; retrieval uses team-brain wiki-grep.`);
  });

// ---------------------------------------------------------------------------
// Hook subcommands — cross-platform replacements for hook-*.sh bash scripts
// These are invoked by Claude Code settings.json hooks on all platforms.
// ---------------------------------------------------------------------------

function runHook(hookName: string): void {
  const hookPath = join(__dirname, `hooks/${hookName}.js`);
  const result = spawnSync(process.execPath, [hookPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

function runHookStatus(): void {
  const { existsSync, readFileSync } = require('fs');
  const hooks = [
    'hook-policy-check',
    'hook-policy-check-mcp',
    'hook-loop-detector',
  ];
  let allOk = true;
  for (const hook of hooks) {
    const hookPath = join(__dirname, `hooks/${hook}.js`);
    const exists = existsSync(hookPath);
    console.log(`${exists ? '✅' : '❌'} ${hook}.js — ${exists ? 'present' : 'MISSING in dist/'}`);
    if (!exists) allOk = false;
  }

  // Check settings.json for PreToolUse policy hook entries
  const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
  const settingsPath = join(agentDir, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const preToolUse: any[] = settings?.hooks?.PreToolUse ?? [];
      const hasBashHook = preToolUse.some((entry: any) =>
        JSON.stringify(entry).includes('hook-policy-check') &&
        !JSON.stringify(entry).includes('hook-policy-check-mcp'),
      );
      const hasMcpHook = preToolUse.some((entry: any) =>
        JSON.stringify(entry).includes('hook-policy-check-mcp'),
      );
      console.log(`${hasBashHook ? '✅' : '❌'} settings.json PreToolUse — hook-policy-check (Bash/P1+P2+P4)`);
      console.log(`${hasMcpHook ? '✅' : '❌'} settings.json PreToolUse — hook-policy-check-mcp (MCP/P3)`);
      if (!hasBashHook || !hasMcpHook) allOk = false;
    } catch {
      console.log(`❌ settings.json — parse error`);
      allOk = false;
    }
  } else {
    console.log(`❌ settings.json — not found at ${settingsPath}`);
    allOk = false;
  }

  console.log(allOk ? '\nAll policy hooks healthy.' : '\nSome hooks are missing or not registered. Re-run install or check dist/.');
  process.exit(allOk ? 0 : 1);
}

function runTestHooks(): void {
  const { spawnSync: sp } = require('child_process');
  const hookPath = join(__dirname, 'hooks/hook-policy-check.js');
  const mcpHookPath = join(__dirname, 'hooks/hook-policy-check-mcp.js');

  interface TestCase {
    policy: string;
    input: Record<string, unknown>;
    agent?: string;
    expect: 'BLOCKED' | 'ALLOWED';
    description: string;
  }

  const cases: TestCase[] = [
    // P1 — external sends
    { policy: 'P1', input: { tool_name: 'Bash', tool_input: { command: 'cortextos bus send-telegram 123456789 "hello"' } }, agent: 'analyst', expect: 'BLOCKED', description: 'P1: analyst send-telegram to numeric ID' },
    { policy: 'P1', input: { tool_name: 'Bash', tool_input: { command: 'cortextos bus send-telegram 123456789 "hello"' } }, agent: 'orchestrator', expect: 'ALLOWED', description: 'P1: orchestrator send-telegram (exempt)' },
    { policy: 'P1', input: { tool_name: 'Bash', tool_input: { command: 'cortextos bus send-message orchestrator normal "hi"' } }, agent: 'analyst', expect: 'ALLOWED', description: 'P1: send-message to orchestrator (not a direct Telegram send)' },
    // P2 — git push
    { policy: 'P2', input: { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, agent: 'dev', expect: 'BLOCKED', description: 'P2: git push origin main' },
    { policy: 'P2', input: { tool_name: 'Bash', tool_input: { command: 'git push fork feat/my-branch' } }, agent: 'dev', expect: 'ALLOWED', description: 'P2: git push fork (allowed)' },
    { policy: 'P2', input: { tool_name: 'Bash', tool_input: { command: 'git status' } }, agent: 'dev', expect: 'ALLOWED', description: 'P2: git status (not a push)' },
    // P4 — staging discipline
    { policy: 'P4', input: { tool_name: 'Bash', tool_input: { command: 'git add -A' } }, agent: 'dev', expect: 'BLOCKED', description: 'P4: git add -A' },
    { policy: 'P4', input: { tool_name: 'Bash', tool_input: { command: 'git add .' } }, agent: 'dev', expect: 'BLOCKED', description: 'P4: git add .' },
    { policy: 'P4', input: { tool_name: 'Bash', tool_input: { command: 'git add ./src/bus/task.ts' } }, agent: 'dev', expect: 'ALLOWED', description: 'P4: git add ./relative/path (allowed)' },
    { policy: 'P4', input: { tool_name: 'Bash', tool_input: { command: 'git add src/bus/task.ts orgs/dev/CLAUDE.md' } }, agent: 'dev', expect: 'ALLOWED', description: 'P4: git add specific files (allowed)' },
    // P3 — MCP hook (always blocks when hook fires)
    { policy: 'P3', input: { tool_name: 'mcp__rgos__instantly_activate_campaign', tool_input: {} }, agent: 'orchestrator', expect: 'BLOCKED', description: 'P3: MCP instantly activate campaign' },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const isMcp = tc.policy === 'P3';
    const path = isMcp ? mcpHookPath : hookPath;
    const env = { ...process.env, CTX_AGENT_NAME: tc.agent ?? 'dev' };
    const result = sp(process.execPath, [path], {
      input: JSON.stringify(tc.input),
      env,
      encoding: 'utf-8',
    });
    const stdout = (result.stdout ?? '').trim();
    let decision = 'ALLOWED';
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.decision === 'block') decision = 'BLOCKED';
      } catch { /* non-JSON stdout = allow */ }
    }
    const ok = decision === tc.expect;
    console.log(`${ok ? '✅' : '❌'} ${tc.description} → ${decision} (expected ${tc.expect})`);
    if (ok) passed++; else failed++;
  }

  console.log(`\n${passed}/${passed + failed} policy tests passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Telegram utility commands — parity with bash edit-message / answer-callback
// ---------------------------------------------------------------------------

busCommand
  .command('edit-message')
  .description('Edit an existing Telegram message text and optionally update inline keyboard')
  .argument('<chat-id>', 'Telegram chat ID')
  .argument('<message-id>', 'Message ID to edit')
  .argument('<new-text>', 'Replacement text (Telegram Markdown)')
  .argument('[reply-markup]', 'Optional JSON inline keyboard markup (pass "null" to clear)')
  .action(async (chatId: string, messageId: string, newText: string, replyMarkup?: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    let markup: object | undefined;
    if (replyMarkup && replyMarkup !== 'null') {
      try { markup = JSON.parse(replyMarkup); } catch { console.error('Invalid reply-markup JSON'); process.exit(1); }
    } else {
      markup = { inline_keyboard: [] }; // clear keyboard
    }

    try {
      await api.editMessageText(parseInt(chatId, 10), parseInt(messageId, 10), newText, markup);
      console.log('Message edited');
    } catch (err: any) {
      console.error(`Failed to edit message: ${err.message || err}`);
      process.exit(1);
    }
  });

busCommand
  .command('answer-callback')
  .description('Answer a Telegram callback query to dismiss button loading state')
  .argument('<callback-query-id>', 'Callback query ID from Telegram update')
  .argument('[toast-text]', 'Optional toast notification text', 'Got it')
  .action(async (callbackQueryId: string, toastText: string) => {
    const env = resolveEnv();
    let botToken = '';
    if (env.agentDir) {
      const { readFileSync, existsSync } = require('fs');
      const agentEnv = require('path').join(env.agentDir, '.env');
      if (existsSync(agentEnv)) {
        const match = readFileSync(agentEnv, 'utf-8').match(/^BOT_TOKEN=(.+)$/m);
        if (match?.[1]?.trim()) botToken = match[1].trim();
      }
    }
    if (!botToken) botToken = process.env.BOT_TOKEN || '';
    if (!botToken) {
      console.error('Error: BOT_TOKEN not configured. Set it in your agent .env file or as an environment variable to enable Telegram.');
      process.exit(1);
    }

    const api = new TelegramAPI(botToken);
    try {
      await api.answerCallbackQuery(callbackQueryId, toastText);
      console.log('Callback answered');
    } catch (err: any) {
      console.error(`Failed to answer callback: ${err.message || err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// Agent discovery and skill discovery
// ---------------------------------------------------------------------------

busCommand
  .command('list-agents')
  .description('Discover all agents in the system with their status and roles')
  .option('--org <org>', 'Filter by organization')
  .option('--status <filter>', 'Filter by status: running|all', 'all')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action(async (opts: { org?: string; status?: string; format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const frameworkRoot = env.frameworkRoot || process.cwd();

    // Collect agents from enabled-agents.json + filesystem scan
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    const agentMap: Record<string, { org: string; enabled: boolean }> = {};

    if (existsSync(enabledFile)) {
      try {
        const data = JSON.parse(readFileSync(enabledFile, 'utf-8'));
        for (const [name, cfg] of Object.entries(data as Record<string, any>)) {
          agentMap[name] = { org: cfg.org ?? '', enabled: cfg.enabled !== false };
        }
      } catch { /* skip corrupt */ }
    }

    // Also scan org agent directories
    const orgsDir = join(frameworkRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir)) {
        const agentsDir = join(orgsDir, org, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const name of readdirSync(agentsDir)) {
          if (!agentMap[name]) agentMap[name] = { org, enabled: true };
        }
      }
    }

    // Determine running agents via IPC daemon.
    const runningAgents = new Set<string>();
    const ipc = new IPCClient(env.instanceId);
    try {
      const resp = await ipc.send({ type: 'status', source: 'cortextos bus' });
      if (resp.success && Array.isArray(resp.data)) {
        for (const a of resp.data as Array<{ name: string; status: string }>) {
          if (a.status === 'running') runningAgents.add(a.name);
        }
      }
    } catch {
      // Daemon not running — no running agent data available
    }

    const results = [];
    for (const [name, info] of Object.entries(agentMap)) {
      if (opts.org && info.org !== opts.org) continue;

      const running = runningAgents.has(name);
      if (opts.status === 'running' && !running) continue;

      // Read role from IDENTITY.md
      let role = '';
      const agentDir = info.org
        ? join(frameworkRoot, 'orgs', info.org, 'agents', name)
        : join(frameworkRoot, 'agents', name);
      const identityFile = join(agentDir, 'IDENTITY.md');
      if (existsSync(identityFile)) {
        const content = readFileSync(identityFile, 'utf-8');
        const m = content.match(/^## Role\s*\n(.+)/m);
        if (m) role = m[1].trim();
      }

      // Read heartbeat
      const hbFile = join(ctxRoot, 'state', name, 'heartbeat.json');
      let lastHeartbeat = '', currentTask = '', mode = '';
      if (existsSync(hbFile)) {
        try {
          const hb = JSON.parse(readFileSync(hbFile, 'utf-8'));
          lastHeartbeat = hb.last_heartbeat ?? '';
          currentTask = hb.current_task ?? '';
          mode = hb.mode ?? '';
        } catch { /* skip */ }
      }

      results.push({ name, org: info.org, role, enabled: info.enabled, running, last_heartbeat: lastHeartbeat, current_task: currentTask, mode });
    }

    if (opts.format === 'text') {
      console.log(`Agents in system:\n`);
      for (const a of results) {
        const status = a.running ? 'RUNNING' : 'stopped';
        console.log(`  ${a.name} (${a.org || 'root'}) [${status}]`);
        if (a.role) console.log(`    Role: ${a.role}`);
        if (a.current_task) console.log(`    Working on: ${a.current_task}`);
        console.log('');
      }
      console.log(`Total: ${results.length} agents`);
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  });

busCommand
  .command('list-skills')
  .description('Discover available skills for the current agent')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .action((opts: { format?: string }) => {
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const agentDir = env.agentDir || process.cwd();

    // Read template from config.json
    let template = '';
    const configFile = join(agentDir, 'config.json');
    if (existsSync(configFile)) {
      try { template = JSON.parse(readFileSync(configFile, 'utf-8')).template ?? ''; } catch { /* skip */ }
    }

    // Parse YAML frontmatter from SKILL.md
    function parseSkillFrontmatter(filePath: string): { name: string; description: string } | null {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let name = '', description = '';
        for (const line of lines) {
          if (line.trim() === '---') {
            if (inFrontmatter) break;
            inFrontmatter = true;
            continue;
          }
          if (!inFrontmatter) continue;
          const nm = line.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
          if (nm) name = nm[1];
          const dm = line.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
          if (dm) description = dm[1];
        }
        return name ? { name, description } : null;
      } catch { return null; }
    }

    type SkillInfo = { name: string; description: string; path: string; source: string };

    // Scan a skills directory, returns map of name -> skill info
    function scanSkillsDir(dir: string, source: string): Map<string, SkillInfo> {
      const map = new Map<string, SkillInfo>();
      if (!existsSync(dir)) return map;
      for (const entry of readdirSync(dir)) {
        const skillFile = join(dir, entry, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        const parsed = parseSkillFrontmatter(skillFile);
        if (parsed) map.set(parsed.name, { ...parsed, path: skillFile, source });
      }
      return map;
    }

    // Merge in priority order: framework < template < agent (agent wins)
    const merged = new Map<string, SkillInfo>();
    for (const [k, v] of scanSkillsDir(join(frameworkRoot, '.claude', 'skills'), 'framework')) merged.set(k, v);
    if (template) {
      for (const [k, v] of scanSkillsDir(join(frameworkRoot, 'templates', template, '.claude', 'skills'), `template:${template}`)) merged.set(k, v);
    }
    for (const [k, v] of scanSkillsDir(join(agentDir, '.claude', 'skills'), 'agent')) merged.set(k, v);

    const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (opts.format === 'text') {
      console.log(`Available skills for ${env.agentName}:\n`);
      for (const s of skills) {
        console.log(`  ${s.name} (${s.source})`);
        if (s.description) console.log(`    ${s.description}`);
        console.log('');
      }
      console.log(`Total: ${skills.length} skills`);
    } else {
      console.log(JSON.stringify(skills, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Agent coordination: notify-agent, soft-restart, send-mobile-reply
// ---------------------------------------------------------------------------

busCommand
  .command('notify-agent')
  .description('Send urgent signal to another agent for immediate delivery via fast-checker')
  .argument('<agent>', 'Target agent name')
  .argument('<message>', 'Urgent message text')
  .action((targetAgent: string, message: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Write urgent signal file that fast-checker checks on every poll
    const signalDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(signalDir, { recursive: true });
    const signal = {
      from: env.agentName,
      message,
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    writeFileSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

    // Also send via normal message bus for persistence
    try {
      sendMessage(paths, env.agentName, targetAgent, 'urgent', message);
    } catch { /* signal already written */ }

    console.log(`Signal sent to ${targetAgent}`);
  });

busCommand
  .command('soft-restart')
  .description('Gracefully restart another agent by writing the restart marker then sending /exit')
  .argument('<agent>', 'Target agent name to restart')
  .argument('[reason]', 'Reason for restart', 'user request via soft-restart')
  .action(async (targetAgent: string, reason: string) => {
    const { mkdirSync, writeFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Step 1: Write .user-restart marker BEFORE triggering exit
    const stateDir = join(ctxRoot, 'state', targetAgent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-restart'), reason);
    console.log(`Wrote .user-restart marker for ${targetAgent}: ${reason}`);

    // Step 2: Send restart via IPC daemon (cross-platform — named pipe on Windows, socket on Unix).
    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();

    if (daemonRunning) {
      const resp = await ipc.send({ type: 'restart-agent', agent: targetAgent, source: 'cortextos bus soft-restart' });
      if (resp.success) {
        console.log(`Restarted ${targetAgent} via daemon IPC`);
      } else {
        console.error(`Daemon restart failed: ${resp.error}`);
        process.exit(1);
      }
    } else {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }
  });

busCommand
  .command('soft-restart-all')
  .description('Soft-restart all enabled agents in the org with optional stagger delay')
  .option('--stagger <seconds>', 'Seconds between each agent restart', '5')
  .option('--reason <why>', 'Reason for restart', 'soft-restart-all requested')
  .action(async (opts: { stagger: string; reason: string }) => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);
    const staggerMs = parseInt(opts.stagger, 10) * 1000;

    // Read enabled agents from config
    const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) {
      console.error('ERROR: enabled-agents.json not found at', enabledFile);
      process.exit(1);
    }
    const enabledAgents: Record<string, { enabled: boolean; org?: string }> =
      JSON.parse(readFileSync(enabledFile, 'utf-8'));

    // Filter to enabled agents in this org (if org set)
    const targets = Object.entries(enabledAgents)
      .filter(([, cfg]) => cfg.enabled !== false)
      .filter(([, cfg]) => !env.org || !cfg.org || cfg.org === env.org)
      .map(([name]) => name);

    if (targets.length === 0) {
      console.log('No enabled agents found for org:', env.org || '(all)');
      process.exit(0);
    }

    const ipc = new IPCClient(env.instanceId);
    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('ERROR: Node daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting ${targets.length} agent(s) with ${opts.stagger}s stagger: ${targets.join(', ')}`);

    for (let i = 0; i < targets.length; i++) {
      const agent = targets[i];
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }
      // Write .user-restart marker
      const stateDir = join(ctxRoot, 'state', agent);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, '.user-restart'), opts.reason);

      // Send IPC restart signal
      const resp = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos bus soft-restart-all' });
      if (resp.success) {
        console.log(`[${i + 1}/${targets.length}] Restarted ${agent}`);
      } else {
        console.error(`[${i + 1}/${targets.length}] Failed to restart ${agent}: ${resp.error}`);
      }
    }

    console.log('soft-restart-all complete.');
  });

busCommand
  .command('send-mobile-reply')
  .description('Reply to a mobile app user message and ACK the inbox message')
  .argument('<agent>', 'Agent name sending the reply')
  .argument('<reply>', 'Reply text')
  .argument('[msg-id]', 'Inbox message ID to ACK')
  .action((agent: string, reply: string, msgId?: string) => {
    // Same literal '\n'/'\t' normalize as send-telegram (codex agent fix).
    reply = reply.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const { mkdirSync, appendFileSync } = require('fs');
    const { join } = require('path');
    const env = resolveEnv();
    const ctxRoot = require('path').join(require('os').homedir(), '.cortextos', env.instanceId);

    // Write to outbound-messages.jsonl so iOS app chat history picks it up
    const logDir = join(ctxRoot, 'logs', agent);
    mkdirSync(logDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent,
      text: reply,
      message_id: `mobile-reply-${Date.now()}`,
      type: 'text',
    });
    appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n');

    // ACK the original inbox message
    if (msgId) {
      const paths = resolvePaths(agent, env.instanceId, env.org);
      try { ackInbox(paths, msgId); } catch { /* best effort */ }
    }

    console.log('Replied to mobile user');
  });

// ---------------------------------------------------------------------------
// list-approvals — was missing from CLI, only available via dashboard
// ---------------------------------------------------------------------------

busCommand
  .command('list-approvals')
  .description('List pending approval requests')
  .option('--format <fmt>', 'Output format: json|text', 'json')
  .option('--all-orgs', 'Scan all orgs under CTX_ROOT (matches dashboard view)', false)
  .action((opts: { format?: string; allOrgs?: boolean }) => {
    const { listPendingApprovals } = require('../bus/approval.js');
    const { readdirSync, existsSync } = require('fs');
    const { join, homedir: _homedir } = require('path');
    const { homedir } = require('os');
    const env = resolveEnv();

    let approvals: unknown[] = [];

    if (opts.allOrgs) {
      // Scan every org directory under CTX_ROOT — mirrors dashboard syncAll() behaviour
      const ctxRoot = join(homedir(), '.cortextos', env.instanceId);
      const orgsDir = join(ctxRoot, 'orgs');
      const orgs: string[] = existsSync(orgsDir)
        ? readdirSync(orgsDir, { withFileTypes: true })
            .filter((d: { isDirectory(): boolean }) => d.isDirectory())
            .map((d: { name: string }) => d.name)
        : [];
      for (const org of orgs) {
        const orgPaths = resolvePaths(env.agentName, env.instanceId, org);
        approvals = approvals.concat(listPendingApprovals(orgPaths));
      }
    } else {
      const paths = resolvePaths(env.agentName, env.instanceId, env.org);
      approvals = listPendingApprovals(paths);
    }

    if (opts.format === 'text') {
      if (approvals.length === 0) { console.log('No pending approvals'); return; }
      for (const a of approvals as Array<{ id: string; title: string; category: string; requesting_agent: string; created_at: string; description?: string; org?: string }>) {
        console.log(`[${a.id}] ${a.title}`);
        console.log(`  Category: ${a.category} | Agent: ${a.requesting_agent} | Org: ${a.org ?? env.org} | Created: ${a.created_at}`);
        if (a.description) console.log(`  Context: ${a.description}`);
        console.log('');
      }
      console.log(`Total: ${approvals.length} pending`);
    } else {
      console.log(JSON.stringify(approvals, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Reminder commands — persistent cron state that survives hard-restarts (#69)
// ---------------------------------------------------------------------------

busCommand
  .command('create-reminder')
  .argument('<fire-at>', 'When to fire, ISO 8601 UTC (e.g. 2026-04-05T08:00:00Z)')
  .argument('<prompt>', 'Text to inject into boot prompt when overdue')
  .description('Create a persistent reminder that survives hard-restarts')
  .action((fireAt: string, prompt: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reminder = createReminder(paths, fireAt, prompt);
    console.log(reminder.id);
  });

busCommand
  .command('list-reminders')
  .option('--all', 'Include acked reminders', false)
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .description('List pending (or all) reminders')
  .action((opts: { all?: boolean; format?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const reminders = listReminders(paths, { all: opts.all });

    if (opts.format === 'json') {
      console.log(JSON.stringify(reminders, null, 2));
      return;
    }

    if (reminders.length === 0) {
      console.log('No pending reminders');
      return;
    }

    const now = Date.now();
    for (const r of reminders) {
      const overdue = Date.parse(r.fire_at) <= now;
      const overdueTag = overdue ? ' [OVERDUE]' : '';
      console.log(`[${r.id}]${overdueTag}`);
      console.log(`  fire_at: ${r.fire_at}  status: ${r.status}`);
      console.log(`  prompt:  ${r.prompt}`);
      console.log('');
    }
  });

busCommand
  .command('ack-reminder')
  .argument('<id>', 'Reminder ID to acknowledge')
  .description('Mark a reminder as handled')
  .action((id: string) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    ackReminder(paths, id);
    console.log(`ACK'd reminder ${id}`);
  });

busCommand
  .command('prune-reminders')
  .option('--days <n>', 'Retain acked reminders for N days', '7')
  .description('Delete acked reminders older than N days')
  .action((opts: { days?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const pruned = pruneReminders(paths, parseInt(opts.days ?? '7', 10));
    console.log(`Pruned ${pruned} acked reminder(s)`);
  });

busCommand
  .command('update-cron-fire')
  .argument('<cron-name>', 'Name of the cron as defined in config.json')
  .option('--interval <interval>', 'Expected interval, e.g. "6h", "24h", "30m"')
  .description('Record that a named cron just fired (enables daemon gap detection for dead zones)')
  .action((cronName: string, opts: { interval?: string }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    updateCronFire(paths.stateDir, cronName, opts.interval);
    console.log(`Recorded fire for cron "${cronName}"`);
  });

// ---------------------------------------------------------------------------
// External Persistent Cron Management (Subtask 1.4)
// ---------------------------------------------------------------------------

/**
 * Validate a schedule string — either an interval shorthand ("6h", "30m") or
 * a 5-field cron expression ("0 8 * * *").  Returns the normalised schedule
 * string, or throws an Error with a human-readable message on failure.
 */
function validateSchedule(raw: string): string {
  const trimmed = raw.trim();
  // Detect format by counting whitespace-separated tokens
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    // Interval shorthand: must match parseDurationMs
    if (isNaN(parseDurationMs(trimmed))) {
      throw new Error(
        `Invalid interval '${trimmed}'. Expected formats: "6h", "30m", "1d", "2w".`
      );
    }
    return trimmed;
  }
  if (tokens.length === 5) {
    // 5-field cron expression: validate by computing a next fire time
    const probe = nextFireFromCron(trimmed, Date.now());
    if (isNaN(probe)) {
      throw new Error(
        `Invalid cron expression '${trimmed}'. Expected 5-field cron ("0 8 * * *", "*/30 * * * *", etc.).`
      );
    }
    return trimmed;
  }
  throw new Error(
    `Invalid schedule '${trimmed}'. Use an interval ("6h") or a 5-field cron expression ("0 8 * * *").`
  );
}

/**
 * Check whether an agent exists in the current framework root.
 * Returns false if the framework root is unknown (graceful degradation).
 */
function agentExistsInFramework(agentName: string, frameworkRoot: string): boolean {
  if (!frameworkRoot) return true; // can't check — allow
  const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs');
  const { join: pjoin } = require('path');
  const orgsDir = pjoin(frameworkRoot, 'orgs');
  if (!fsExists(orgsDir)) return true; // no orgs dir — allow
  try {
    for (const org of fsReaddir(orgsDir)) {
      if (fsExists(pjoin(orgsDir, org, 'agents', agentName))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Format an ISO timestamp for display (shortens to "YYYY-MM-DD HH:mm UTC").
 */
function fmtTs(iso: string | undefined): string {
  if (!iso) return '-';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Send a reload-crons IPC signal to the daemon (non-blocking, best-effort).
 * Silently swallows errors — the daemon will pick up changes on its next tick.
 */
async function signalCronReload(agentName: string, instanceId: string): Promise<void> {
  try {
    const ipc = new IPCClient(instanceId);
    await ipc.send({ type: 'reload-crons', agent: agentName, source: 'cortextos bus cron-cmd' });
  } catch { /* non-fatal — scheduler picks up file change on next 30s tick */ }
}

busCommand
  .command('add-cron')
  .description('Add a new persistent cron for an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name (unique per agent, slug format recommended)')
  .argument('<interval>', 'Schedule: interval ("6h", "30m", "1d") or 5-field cron expr ("0 8 * * *")')
  .argument('<prompt...>', 'Prompt text injected when the cron fires (all remaining words joined)')
  .option('--desc <description>', 'Human-readable description (optional)')
  .action(async (agent: string, name: string, interval: string, promptWords: string[], opts: { desc?: string }) => {
    // Validate agent name format
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const env = resolveEnv();

    // Validate agent exists in framework
    if (!agentExistsInFramework(agent, env.frameworkRoot)) {
      console.error(`Error: agent '${agent}' not found in framework. Check orgs/*/agents/ directory.`);
      process.exit(1);
    }

    // Validate schedule
    let schedule: string;
    try { schedule = validateSchedule(interval); } catch (err) { console.error(String(err)); process.exit(1); }

    const prompt = promptWords.join(' ');
    const cron: CronDefinition = {
      name,
      prompt,
      schedule,
      enabled: true,
      created_at: new Date().toISOString(),
      ...(opts.desc ? { description: opts.desc } : {}),
    };

    try {
      addCron(agent, cron);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    await signalCronReload(agent, env.instanceId);
    console.log(`Added cron '${name}' for ${agent}`);
  });

busCommand
  .command('remove-cron')
  .description('Remove a persistent cron from an agent')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to remove')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const removed = removeCron(agent, name);
    if (!removed) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Removed cron '${name}' from ${agent}`);
  });

busCommand
  .command('list-crons')
  .description('List all persistent crons configured for an agent')
  .argument('<agent>', 'Agent name')
  .option('--json', 'Emit raw JSON instead of a formatted table')
  .action((agent: string, opts: { json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const crons = readCrons(agent);

    // BUG 1 fix: merge cron-state.json's `last_fire` records into the displayed
    // last-fire timestamp. The daemon writes fire timestamps to two surfaces:
    //   - crons.json `last_fired_at` (via cron-scheduler.updateCron)
    //   - cron-state.json `last_fire` (via bus update-cron-fire from agent skills)
    // For a single source of truth in the CLI, take the most recent of the two.
    const env = resolveEnv();
    const paths = resolvePaths(agent, env.instanceId, env.org);
    const stateRecords = readCronState(paths.stateDir).crons;
    const fireByName = new Map<string, string>();
    for (const rec of stateRecords) fireByName.set(rec.name, rec.last_fire);

    const mostRecent = (a?: string, b?: string): string | undefined => {
      if (!a) return b;
      if (!b) return a;
      return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
    };

    if (opts.json) {
      const enriched = crons.map(c => ({
        ...c,
        last_fired_at: mostRecent(c.last_fired_at, fireByName.get(c.name)),
      }));
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    if (crons.length === 0) {
      console.log(`No crons configured for ${agent}`);
      return;
    }

    // Compute next_fire_at for each cron so the table is informative
    const now = Date.now();
    const rows = crons.map(c => {
      const lastFire = mostRecent(c.last_fired_at, fireByName.get(c.name));
      let nextFire = '-';
      const dms = parseDurationMs(c.schedule);
      if (!isNaN(dms)) {
        const refMs = lastFire ? new Date(lastFire).getTime() : now;
        nextFire = fmtTs(new Date(refMs + dms).toISOString());
      } else {
        const nf = nextFireFromCron(c.schedule, now);
        if (!isNaN(nf)) nextFire = fmtTs(new Date(nf).toISOString());
      }
      const promptPreview = c.prompt.length > 60 ? c.prompt.slice(0, 57) + '...' : c.prompt;
      return {
        name: c.name,
        schedule: c.schedule,
        enabled: c.enabled ? 'yes' : 'no',
        last_fire: fmtTs(lastFire),
        next_fire: nextFire,
        prompt: promptPreview,
      };
    });

    // Column widths
    const nameW = Math.max(4, ...rows.map(r => r.name.length));
    const schedW = Math.max(8, ...rows.map(r => r.schedule.length));
    const enW = 7;
    const lastW = 18;
    const nextW = 18;

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = '-'.repeat(nameW + schedW + enW + lastW + nextW + 63 + 5);

    console.log(`\nCrons for ${agent} (${rows.length})\n`);
    console.log(`  ${pad('Name', nameW)}  ${pad('Schedule', schedW)}  ${pad('Enabled', enW)}  ${pad('Last Fire', lastW)}  ${pad('Next Fire', nextW)}  Prompt`);
    console.log(`  ${sep}`);
    for (const r of rows) {
      console.log(`  ${pad(r.name, nameW)}  ${pad(r.schedule, schedW)}  ${pad(r.enabled, enW)}  ${pad(r.last_fire, lastW)}  ${pad(r.next_fire, nextW)}  ${r.prompt}`);
    }
    console.log('');
  });

busCommand
  .command('update-cron')
  .description('Update fields of an existing persistent cron')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to update')
  .option('--interval <i>', 'New schedule (interval or cron expression)')
  .option('--cron-expr <e>', 'Alias for --interval (5-field cron expression)')
  .option('--prompt <p>', 'New prompt text')
  .option('--enabled <bool>', 'Enable (true) or disable (false) the cron')
  .option('--desc <d>', 'New description')
  .action(async (agent: string, name: string, opts: { interval?: string; cronExpr?: string; prompt?: string; enabled?: string; desc?: string }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const rawSchedule = opts.interval ?? opts.cronExpr;
    if (!rawSchedule && opts.prompt === undefined && opts.enabled === undefined && opts.desc === undefined) {
      console.error('Error: at least one of --interval, --cron-expr, --prompt, --enabled, or --desc is required.');
      process.exit(1);
    }

    const patch: Partial<CronDefinition> = {};

    if (rawSchedule !== undefined) {
      try { patch.schedule = validateSchedule(rawSchedule); } catch (err) { console.error(String(err)); process.exit(1); }
    }
    if (opts.prompt !== undefined) {
      patch.prompt = opts.prompt;
    }
    if (opts.enabled !== undefined) {
      if (opts.enabled !== 'true' && opts.enabled !== 'false') {
        console.error(`Error: --enabled must be 'true' or 'false', got '${opts.enabled}'.`);
        process.exit(1);
      }
      patch.enabled = opts.enabled === 'true';
    }
    if (opts.desc !== undefined) {
      patch.description = opts.desc;
    }

    const ok = updateCronDef(agent, name, patch);
    if (!ok) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    await signalCronReload(agent, env.instanceId);
    console.log(`Updated cron '${name}' for ${agent}`);
  });

busCommand
  .command('test-cron-fire')
  .description('Fire a cron immediately for testing (injects prompt into agent PTY via daemon IPC)')
  .argument('<agent>', 'Agent name')
  .argument('<name>', 'Cron name to fire')
  .action(async (agent: string, name: string) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const cron = getCronByName(agent, name);
    if (!cron) {
      console.error(`Error: cron '${name}' not found for agent '${agent}'.`);
      process.exit(1);
    }

    const env = resolveEnv();
    const ipc = new IPCClient(env.instanceId);

    const daemonRunning = await ipc.isDaemonRunning();
    if (!daemonRunning) {
      console.error('Error: daemon is not running. Start it with: cortextos start');
      process.exit(1);
    }

    const resp = await ipc.send({
      type: 'fire-cron',
      agent,
      data: { name: cron.name, prompt: cron.prompt },
      source: 'cortextos bus test-cron-fire',
    });

    if (!resp.success) {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    console.log(`Fired cron '${name}' for ${agent}`);
  });

busCommand
  .command('get-cron-log')
  .description('Display cron execution log entries for an agent')
  .argument('<agent>', 'Agent name')
  .argument('[name]', 'Cron name to filter by (optional — omit to show all crons)')
  .option('--limit <n>', 'Maximum number of entries to show (default: 50)', '50')
  .option('--json', 'Emit raw JSON array instead of a formatted table')
  .action((agent: string, name: string | undefined, opts: { limit?: string; json?: boolean }) => {
    try { validateAgentName(agent); } catch (err) { console.error(String(err)); process.exit(1); }

    const limit = parseInt(opts.limit ?? '50', 10);
    if (isNaN(limit) || limit < 0) {
      console.error(`Error: --limit must be a non-negative integer, got '${opts.limit}'.`);
      process.exit(1);
    }

    const entries = getExecutionLog(agent, name, limit);

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      if (name !== undefined) {
        console.log(`No log entries for cron '${name}' on ${agent}`);
      } else {
        console.log(`No log entries for ${agent}`);
      }
      return;
    }

    // Human-readable table: ts | cron | status | attempt | duration | error
    const pad = (s: string, w: number) => s.padEnd(w);
    const header = `  ${pad('Timestamp', 20)}  ${pad('Cron', 22)}  ${pad('Status', 7)}  ${pad('Att', 3)}  ${pad('ms', 7)}  Error`;
    const sep = '-'.repeat(header.length);

    console.log(`\nExecution log for ${agent}${name ? ` / ${name}` : ''} (${entries.length} entries)\n`);
    console.log(header);
    console.log(`  ${sep}`);

    for (const e of entries) {
      const ts = e.ts.replace('T', ' ').slice(0, 19) + 'Z';
      const status = e.status;
      const att = String(e.attempt);
      const ms = String(e.duration_ms);
      const error = e.error ?? '';
      const cronPad = pad(e.cron.length > 22 ? e.cron.slice(0, 19) + '...' : e.cron, 22);
      console.log(
        `  ${pad(ts, 20)}  ${cronPad}  ${pad(status, 7)}  ${pad(att, 3)}  ${pad(ms, 7)}  ${error}`
      );
    }
    console.log('');
  });

// ---------------------------------------------------------------------------
// migrate-crons — Subtask 2.2: Manual one-shot migration command
// ---------------------------------------------------------------------------

busCommand
  .command('migrate-crons')
  .description('Migrate crons from config.json to crons.json for one or all agents')
  .argument('[agent]', 'Agent name to migrate (omit to migrate all enabled agents)')
  .option('--force', 'Re-run migration even if the marker file already exists')
  .action(async (agentArg: string | undefined, opts: { force?: boolean }) => {
    const { migrateCronsForAgent: migrateSingle, migrateAllAgents: migrateAll } = await import('../daemon/cron-migration.js');
    const env = resolveEnv();
    const ctxRoot = env.ctxRoot;
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const log = (msg: string) => console.log(msg);
    const migOpts = { force: opts.force ?? false, log };

    if (agentArg) {
      // Single-agent migration
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }

      // Resolve config.json path via filesystem scan
      const { existsSync: fsExists, readdirSync: fsReaddir } = require('fs') as typeof import('fs');
      const orgsDir = join(frameworkRoot, 'orgs');
      let configPath: string | undefined;
      if (fsExists(orgsDir)) {
        try {
          for (const org of fsReaddir(orgsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
            const candidate = join(orgsDir, org, 'agents', agentArg, 'config.json');
            if (fsExists(candidate)) { configPath = candidate; break; }
          }
        } catch { /* ignore scan errors */ }
      }

      if (!configPath) {
        console.error(`Error: agent '${agentArg}' not found in framework. Check orgs/*/agents/ directory.`);
        process.exit(1);
      }

      const result = migrateSingle(agentArg, configPath, ctxRoot, migOpts);

      switch (result.status) {
        case 'skipped-already-migrated':
          console.log(`Skipped ${agentArg}: already migrated (use --force to re-run)`);
          break;
        case 'no-config':
          console.log(`Skipped ${agentArg}: no config.json found`);
          break;
        case 'no-crons':
          console.log(`Skipped ${agentArg}: config.json has no crons — empty crons.json written`);
          break;
        case 'migrated':
          console.log(
            `Migrated ${agentArg}: ${result.cronsMigrated} cron(s) migrated` +
            (result.cronsSkipped?.length ? `, ${result.cronsSkipped.length} skipped (${result.cronsSkipped.join(', ')})` : '')
          );
          break;
      }
    } else {
      // All-agents migration
      const summary = migrateAll(frameworkRoot, ctxRoot, migOpts);

      const migrated = summary.results.filter(r => r.status === 'migrated').length;
      const skippedAlready = summary.results.filter(r => r.status === 'skipped-already-migrated').length;
      const noConfig = summary.results.filter(r => r.status === 'no-config').length;
      const noCrons = summary.results.filter(r => r.status === 'no-crons').length;

      console.log(`\nMigration summary:`);
      console.log(`  Agents processed    : ${summary.processed}`);
      console.log(`  Agents migrated     : ${migrated} (${summary.totalCronsMigrated} crons)`);
      console.log(`  Already migrated    : ${skippedAlready}`);
      console.log(`  No config.json      : ${noConfig}`);
      console.log(`  No crons in config  : ${noCrons}`);
    }
  });

// ---------------------------------------------------------------------------
// upgrade-cron-teaching — Subtask 2.4: scan agent workspace for stale
// CronCreate / /loop / config.json cron-registration teaching that predates
// the external-persistent-crons migration.  Scan-only by default; --apply
// performs only the safe literal substitutions known not to depend on
// surrounding context.
// ---------------------------------------------------------------------------

busCommand
  .command('upgrade-cron-teaching')
  .description('Scan agent workspace files for stale CronCreate/loop/config.json cron teaching')
  .argument('[agent]', 'Agent name to scan (omit to scan all agents under orgs/)')
  .option('--apply', 'Perform safe literal substitutions in place (does not rewrite CronCreate references)')
  .option('--json', 'Emit JSON instead of human-readable text')
  .action(async (
    agentArg: string | undefined,
    opts: { apply?: boolean; json?: boolean },
  ) => {
    const { scanAgentDir, groupMatchesByFile } =
      await import('../utils/cron-teaching-scanner.js');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();

    const { existsSync: fsExists, readdirSync: fsReaddir } =
      require('fs') as typeof import('fs');

    // Resolve agent name to its absolute workspace dir (orgs/*/agents/AGENT).
    function resolveAgentDir(agent: string): string | undefined {
      const orgsDir = join(frameworkRoot, 'orgs');
      if (!fsExists(orgsDir)) return undefined;
      try {
        for (const entry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = join(orgsDir, entry.name, 'agents', agent);
          if (fsExists(candidate)) return candidate;
        }
      } catch {
        // ignore scan errors
      }
      return undefined;
    }

    // List every agent dir under orgs/ORG/agents/.
    function listAllAgents(): { agent: string; dir: string }[] {
      const orgsDir = join(frameworkRoot, 'orgs');
      const out: { agent: string; dir: string }[] = [];
      if (!fsExists(orgsDir)) return out;
      try {
        for (const orgEntry of fsReaddir(orgsDir, { withFileTypes: true })) {
          if (!orgEntry.isDirectory()) continue;
          const agentsRoot = join(orgsDir, orgEntry.name, 'agents');
          if (!fsExists(agentsRoot)) continue;
          for (const a of fsReaddir(agentsRoot, { withFileTypes: true })) {
            if (a.isDirectory() && !a.name.startsWith('.')) {
              out.push({ agent: a.name, dir: join(agentsRoot, a.name) });
            }
          }
        }
      } catch {
        // ignore scan errors
      }
      return out;
    }

    type Report = {
      agent: string;
      result: ReturnType<typeof scanAgentDir>;
    };

    const reports: Report[] = [];
    if (agentArg) {
      try { validateAgentName(agentArg); } catch (err) { console.error(String(err)); process.exit(1); }
      const dir = resolveAgentDir(agentArg);
      if (!dir) {
        console.error(`Error: agent '${agentArg}' not found under ${join(frameworkRoot, 'orgs')}/*/agents/`);
        process.exit(1);
      }
      reports.push({ agent: agentArg, result: scanAgentDir(dir, { apply: opts.apply }) });
    } else {
      for (const { agent, dir } of listAllAgents()) {
        reports.push({ agent, result: scanAgentDir(dir, { apply: opts.apply }) });
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(
        reports.map((r) => ({
          agent: r.agent,
          agentDir: r.result.agentDir,
          scannedFiles: r.result.scannedFiles,
          skippedSentinelFiles: r.result.skippedSentinelFiles,
          appliedSubstitutions: r.result.appliedSubstitutions,
          matches: r.result.matches,
        })),
        null,
        2,
      ));
      const totalMatches = reports.reduce((sum, r) => sum + r.result.matches.length, 0);
      process.exit(totalMatches === 0 ? 0 : 1);
    }

    let totalMatches = 0;
    let totalApplied = 0;
    for (const { agent, result } of reports) {
      totalMatches += result.matches.length;
      totalApplied += result.appliedSubstitutions;

      if (result.matches.length === 0 && result.appliedSubstitutions === 0) {
        console.log(`✓ ${agent}: no stale cron-teaching references (${result.scannedFiles.length} files scanned)`);
        continue;
      }

      console.log(`\n${agent}: ${result.matches.length} stale reference(s) in ${result.scannedFiles.length} files`);
      if (result.skippedSentinelFiles.length > 0) {
        console.log(`  (skipped ${result.skippedSentinelFiles.length} sentinel-marked file(s): ${result.skippedSentinelFiles.map((f) => f.replace(result.agentDir + '/', '')).join(', ')})`);
      }
      const grouped = groupMatchesByFile(result.matches);
      for (const [file, matches] of grouped) {
        const rel = file.replace(result.agentDir + '/', '');
        console.log(`\n  ${rel}`);
        for (const m of matches) {
          console.log(`    L${m.line} [${m.pattern}]: ${m.excerpt}`);
          console.log(`      → ${m.suggestion}`);
        }
      }
      if (result.appliedSubstitutions > 0) {
        console.log(`\n  Applied ${result.appliedSubstitutions} safe substitution(s) in place.`);
      }
    }

    console.log(`\nSummary: ${totalMatches} stale reference(s) across ${reports.length} agent(s)` +
      (opts.apply ? `, ${totalApplied} substitution(s) applied.` : '.'));
    if (totalMatches > 0 && !opts.apply) {
      console.log(`Run with --apply to substitute the safe-rewritable patterns. CronCreate / /loop references must be updated manually.`);
    }
    process.exit(totalMatches === 0 ? 0 : 1);
  });

busCommand
  .command('hook-context-status')
  .description('StatusLine hook: writes context window % to state/context_status.json')
  .action(() => runHook('hook-context-status'));

busCommand
  .command('hook-ask-telegram')
  .description('PreToolUse hook: forward AskUserQuestion to Telegram (cross-platform)')
  .action(() => runHook('hook-ask-telegram'));

busCommand
  .command('hook-permission-telegram')
  .description('PermissionRequest hook: send approve/deny request to Telegram (cross-platform)')
  .action(() => runHook('hook-permission-telegram'));

busCommand
  .command('hook-planmode-telegram')
  .description('ExitPlanMode hook: send plan for review to Telegram (cross-platform)')
  .action(() => runHook('hook-planmode-telegram'));

busCommand
  .command('hook-idle-flag')
  .description('Stop hook: writes last_idle.flag timestamp so fast-checker knows agent finished its turn')
  .action(() => runHook('hook-idle-flag'));

busCommand
  .command('hook-extract-facts')
  .description('PreCompact hook: extracts and stores session summary as structured fact entry for cross-session memory')
  .action(() => runHook('hook-extract-facts'));

busCommand
  .command('hook-session-restore')
  .description('SessionStart hook: injects the most recent compaction snapshot as additionalContext to restore working state')
  .action(() => runHook('hook-session-restore'));

busCommand
  .command('hook-loop-detector')
  .description('PreToolUse hook: detects and blocks repeated tool loops (repetition and ping-pong patterns)')
  .action(() => runHook('hook-loop-detector'));

busCommand
  .command('hook-policy-check')
  .description('PreToolUse hook (Bash): enforces P1 (external sends funnel), P2 (push to fork), P4 (git staging discipline)')
  .action(() => runHook('hook-policy-check'));

busCommand
  .command('hook-policy-check-mcp')
  .description('PreToolUse hook (MCP): enforces P3 (no email automation without approval) for instantly_* MCP tools')
  .action(() => runHook('hook-policy-check-mcp'));

busCommand
  .command('hook-status')
  .description('Diagnostic: checks that A4 policy hooks are installed and registered in settings.json')
  .action(() => runHookStatus());

busCommand
  .command('test-hooks')
  .description('Test runner: validates A4 policy hook patterns against sample inputs')
  .action(() => runTestHooks());

busCommand
  .command('hook-skill-autopr')
  .description('PostToolUse hook: auto-stages community skill writes and opens a draft PR against grandamenium/cortextos')
  .action(() => runHook('hook-skill-autopr'));

busCommand
  .command('hook-skill-telemetry')
  .description('PostToolUse hook: logs Skill tool calls and SKILL.md Read tool calls to orch_skill_invocations')
  .action(() => runHook('hook-skill-telemetry'));

busCommand
  .command('create-skill-pr')
  .description('Background worker: commits and draft-PRs a community skill (called by hook-skill-autopr)')
  .argument('<skill-name>', 'Skill directory name under community/skills/')
  .action(async (skillName: string) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skillName)) {
      console.error(`create-skill-pr: invalid skill name "${skillName}" — must be a lowercase alphanumeric slug`);
      process.exit(1);
    }
    try {
      await createSkillPr(skillName);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`create-skill-pr failed: ${msg}`);
      process.exit(1);
    }
  });

// --- Brand name command ---

busCommand
  .command('set-brand-name')
  .description('Set the business name shown in the dashboard sidebar (written to dashboard-settings.json)')
  .argument('<name>', 'Business or team name to display (max 100 characters, use empty string "" to clear)')
  .action((name: string) => {
    const trimmed = name.trim().slice(0, 100);
    const env = resolveEnv();
    const settingsPath = join(env.ctxRoot, 'config', 'dashboard-settings.json');
    try {
      let current: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try { current = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* ignore corrupt file */ }
      }
      if (trimmed) {
        current.brand_name = trimmed;
      } else {
        delete current.brand_name;
      }
      // Atomic write — prevents corrupt file on crash or concurrent access
      atomicWriteSync(settingsPath, JSON.stringify(current, null, 2));
      console.log(trimmed ? `Brand name set to: ${trimmed}` : 'Brand name cleared');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`set-brand-name failed: ${msg}`);
      process.exit(1);
    }
  });

// --- OAuth token rotation commands ---

busCommand
  .command('check-usage-api')
  .description('Fetch Claude OAuth utilization from Anthropic usage API (3-min TTL cache)')
  .option('--account <name>', 'Check specific account (default: active account)')
  .option('--force', 'Bypass cache and fetch fresh data')
  .option('--json', 'Output as JSON')
  .action(async (opts: { account?: string; force?: boolean; json?: boolean }) => {
    const env = resolveEnv();
    try {
      const result = await checkUsageApi(env.ctxRoot, { force: opts.force, account: opts.account });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const cached = result.cached ? ' (cached)' : '';
        const warn5h = result.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
        const warn7d = result.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
        console.log(`Account: ${result.account}${cached}`);
        console.log(`5h utilization:  ${pct(result.five_hour_utilization)}${warn5h}`);
        console.log(`7d utilization:  ${pct(result.seven_day_utilization)}${warn7d}`);
        console.log(`Fetched at: ${result.fetched_at}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('refresh-oauth-token')
  .description('Refresh OAuth token for an account using its refresh_token (one-time use — writes atomically)')
  .option('--account <name>', 'Account to refresh (default: active account)')
  .action(async (opts: { account?: string }) => {
    const env = resolveEnv();
    try {
      const result = await refreshOAuthToken(env.ctxRoot, opts.account);
      const expiresIn = Math.round((result.expires_at - Date.now()) / 1000 / 60);
      console.log(`Refreshed account: ${result.account}`);
      console.log(`New token expires in: ${expiresIn} minutes`);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('rotate-oauth')
  .description('Rotate to the next OAuth account if utilization thresholds are met')
  .option('--force', 'Force rotation regardless of utilization')
  .option('--agent <name>', 'Only update this agent\'s .env (default: all agents in org)')
  .option('--reason <text>', 'Reason for rotation (logged)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { force?: boolean; agent?: string; reason?: string; json?: boolean }) => {
    const env = resolveEnv();
    if (!env.frameworkRoot) {
      console.error('CTX_FRAMEWORK_ROOT is required for rotate-oauth');
      process.exit(1);
    }
    try {
      const result = await rotateOAuth(env.ctxRoot, env.frameworkRoot, env.org, {
        force: opts.force,
        agent: opts.agent,
        reason: opts.reason,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.rotated) {
        console.log(`Rotated: ${result.from} → ${result.to}`);
        console.log(`Reason: ${result.reason}`);
      } else {
        console.log(`No rotation needed: ${result.reason}`);
      }
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

busCommand
  .command('list-oauth-accounts')
  .description('List all OAuth accounts and their utilization')
  .action((opts: Record<string, unknown>) => {
    const env = resolveEnv();
    const store = loadAccounts(env.ctxRoot);
    if (!store) {
      console.log('No accounts.json found at state/oauth/accounts.json');
      return;
    }
    for (const [name, acct] of Object.entries(store.accounts)) {
      const active = name === store.active ? ' (active)' : '';
      const expiry = new Date(acct.expires_at).toISOString();
      const warn5h = acct.five_hour_utilization >= ALERT_5H ? ' ⚠️' : '';
      const warn7d = acct.seven_day_utilization >= ALERT_7D ? ' ⚠️' : '';
      console.log(`${name}${active}`);
      console.log(`  5h: ${pct(acct.five_hour_utilization)}${warn5h}  7d: ${pct(acct.seven_day_utilization)}${warn7d}  expires: ${expiry}`);
    }
  });

busCommand
  .command('tui-stream')
  .description('Stream Claude Code TUI tool activity to the event log and optionally Telegram')
  .option('--session <name>', 'tmux session name (defaults to CTX_AGENT_NAME)')
  .option('--interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('--telegram', 'Forward high-signal events to Telegram chat', false)
  .option('--dry-run', 'Print events to stdout instead of logging', false)
  .action(async (opts: { session?: string; interval: string; telegram: boolean; dryRun: boolean }) => {
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    const sessionName = opts.session || env.agentName;
    const pollMs = Math.max(500, parseInt(opts.interval, 10) || 2000);

    // High-signal patterns: tool calls that indicate real work
    const HIGH_SIGNAL = [
      /^[├│└].*Tool:\s*(Bash|Edit|Write|Read|Glob|Grep|WebFetch|WebSearch|Agent)/i,
      /^[├│└].*Running bash command/i,
      /^[├│└].*Editing file/i,
      /^[├│└].*Writing file/i,
      /^[├│└].*Reading file/i,
      /error|Error|ERROR/,
      /✓.*completed|✗.*failed/i,
      /Permission (request|denied|approved)/i,
    ];

    const TOOL_LINE = /^[├│└▶◆●]|^(Tool|Bash|Edit|Write|Read|Glob|Grep|Agent):/i;

    let prevOutput = '';
    let telegramApi: any = null;
    let chatId: string | undefined;

    // Set up Telegram if requested
    if (opts.telegram) {
      const { TelegramAPI } = await import('../telegram/api.js');
      const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
      const envPath = join(agentDir, '.env');
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8');
        const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
        const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
        if (botTokenMatch && chatIdMatch) {
          telegramApi = new TelegramAPI(botTokenMatch[1].trim());
          chatId = chatIdMatch[1].trim();
        }
      }
    }

    const logLine = (msg: string) => {
      if (opts.dryRun) {
        console.log(msg);
      }
    };

    let lastTelegramSent = 0;
    const TELEGRAM_COOLDOWN_MS = 10000; // max 1 Telegram message per 10s

    logLine(`[tui-stream] Watching tmux session: ${sessionName} (poll: ${pollMs}ms)`);

    // Poll loop
    while (true) {
      try {
        // Capture current tmux pane content
        let currentOutput = '';
        try {
          const result = execFileSync('tmux', ['capture-pane', '-t', sessionName, '-p'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          currentOutput = result;
        } catch {
          // Session not found or tmux not available — wait and retry
          await sleepMs(pollMs * 5);
          continue;
        }

        // Diff: find new lines appended since last poll
        const prevLines = prevOutput.split('\n');
        const currLines = currentOutput.split('\n');
        const newLines = currLines.length > prevLines.length
          ? currLines.slice(prevLines.length - 1)
          : currLines.filter(l => !prevOutput.includes(l));

        prevOutput = currentOutput;

        if (newLines.length === 0) {
          await sleepMs(pollMs);
          continue;
        }

        // Filter to tool-call lines only
        const toolLines = newLines.filter(l => {
          const t = l.trim();
          return t.length > 0 && (TOOL_LINE.test(t) || t.startsWith('●') || t.startsWith('◆'));
        });

        for (const line of toolLines) {
          const trimmed = line.trim().slice(0, 200);
          const isHighSignal = HIGH_SIGNAL.some(re => re.test(trimmed));

          // Log to event bus
          if (!opts.dryRun) {
            try {
              logEvent(paths, env.agentName, env.org, 'agent_activity' as any, 'tool_call', 'info', {
                line: trimmed,
                session: sessionName,
                high_signal: isHighSignal,
              });
            } catch { /* Never fail the stream */ }
          } else {
            logLine(`[event] ${trimmed}`);
          }

          // Forward high-signal events to Telegram (rate-limited)
          if (isHighSignal && opts.telegram && telegramApi && chatId) {
            const now = Date.now();
            if (now - lastTelegramSent >= TELEGRAM_COOLDOWN_MS) {
              lastTelegramSent = now;
              try {
                await telegramApi.sendMessage(chatId, `[${env.agentName}] ${trimmed}`);
              } catch { /* Never fail the stream */ }
            }
          }
        }
      } catch {
        // Continue on any error
      }

      await sleepMs(pollMs);
    }
  });


busCommand
  .command('run-workflow')
  .description('Execute a declarative workflow YAML file (sequential multi-agent orchestration)')
  .argument('<file>', 'Path to workflow YAML file')
  .option('--dry-run', 'Print steps without sending any messages')
  .option('--timeout <seconds>', 'Override default step timeout', (v) => parseInt(v, 10))
  .action(async (file: string, opts: { dryRun?: boolean; timeout?: number }) => {
    try {
      const result = await runWorkflow({
        workflowPath: file,
        dryRun: opts.dryRun,
        timeout: opts.timeout,
        log: (msg) => console.error(msg), // progress to stderr, result to stdout
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.failed > 0 && !opts.dryRun) process.exit(1);
    } catch (err) {
      console.error(`run-workflow failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

busCommand
  .command('sync-skills')
  .description('Upsert agent SKILL.md files into the orch_skills Supabase table')
  .option('--agent <dir>', 'Absolute path to agent root (default: CTX_AGENT_DIR env)')
  .option('--dry-run', 'Print skills that would be synced without writing to DB')
  .action(async (opts: { agent?: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    try {
      const result = await syncSkills({
        agentDir: opts.agent ?? env.agentDir,
        agentName: env.agentName,
        dryRun: opts.dryRun,
      });
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error(`sync-skills failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

busCommand
  .command('sync-experiments')
  .description('Bulk-sync all local experiments to the orch_experiments Supabase table')
  .option('--agent <name>', 'Agent whose experiments to sync (default: current agent)')
  .action(async (opts: { agent?: string }) => {
    const env = resolveEnv();
    const agentDir = opts.agent && env.frameworkRoot
      ? join(env.frameworkRoot, 'orgs', env.org, 'agents', opts.agent)
      : (env.agentDir || process.cwd());
    const result = await syncAllExperimentsToSupabase(agentDir);
    console.log(JSON.stringify(result));
  });

busCommand
  .command('generate-skill')
  .description('Generate a SKILL.md from a completed task so agents improve over time')
  .requiredOption('--from-task <id>', 'Task ID. Prefix "cortex:" to query RGOS kanban (e.g. cortex:abc-123).')
  .option('--agent <dir>', 'Absolute path to agent root (default: CTX_AGENT_DIR env)')
  .option('--dry-run', 'Print the generated skill without writing to disk')
  .action(async (opts: { fromTask: string; agent?: string; dryRun?: boolean }) => {
    const env = resolveEnv();
    const busPaths = resolvePaths(env.agentName, env.instanceId, env.org);
    try {
      const result = await generateSkill(
        { taskId: opts.fromTask, agentDir: opts.agent, dryRun: opts.dryRun },
        { taskDir: busPaths.taskDir, frameworkRoot: env.frameworkRoot },
      );
      if (opts.dryRun) {
        console.log(`--- dry-run: would ${result.action === 'dry-run' ? 'write' : 'refine'} ${result.skillPath} ---`);
        console.log(result.content);
      } else {
        console.log(JSON.stringify({ action: result.action, path: result.skillPath, slug: result.slug }));
      }
    } catch (err) {
      console.error(`generate-skill failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

busCommand
  .command('send-slack')
  .description('Post a Slack reply as the current agent')
  .argument('<channel>', 'Slack channel ID (C..., D..., G...) or user ID')
  .argument('<text>', 'Reply text')
  .option('--thread-ts <ts>', 'Thread anchor ts; set to keep the reply in the original thread')
  .option('--inbox-id <id>', 'agent_slack_inbox.id — marks the row processed + records response_ts')
  .option('--agent <title>', 'Override agent title (default: derived from CORTEXTOS_AGENT_NAME)')
  .option('--policy-approval-id <id>', 'Approval ID authorizing a policy-gated Slack post')
  .action(async (channel: string, text: string, opts: { threadTs?: string; inboxId?: string; agent?: string; policyApprovalId?: string }) => {
    const gate = channel.startsWith('C') || channel.startsWith('G') ? 'slackPublicPost' : 'internalSlack';
    await enforcePolicyOrExit(gate, 'send-slack', channel, { policyApprovalId: opts.policyApprovalId });
    const result = await sendSlack(channel, text, {
      threadTs: opts.threadTs,
      inboxId: opts.inboxId,
      agent: opts.agent,
    });
    if (!result.ok) {
      console.error(`send-slack failed: ${result.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
  });

// --- fix-agent-settings ---

busCommand
  .command('fix-agent-settings')
  .description('Patch all agent settings.json files: add missing allowlist tools and statusLine hook')
  .option('--dry-run', 'Show what would be changed without writing')
  .action((opts: { dryRun?: boolean }) => {
    const { existsSync: fsExists, readdirSync: fsReaddir, readFileSync: fsRead, writeFileSync: fsWrite } = require('fs');
    const env = resolveEnv();
    const frameworkRoot = env.frameworkRoot || process.cwd();
    const orgsDir = join(frameworkRoot, 'orgs');

    const REQUIRED_ALLOW = [
      'Bash', 'Read', 'Edit', 'Write',
      'Glob', 'Grep',
      'WebFetch', 'WebSearch',
      'ToolSearch', 'CronCreate', 'CronList', 'CronDelete',
      'Skill', 'Agent',
    ];
    const STATUS_LINE = {
      type: 'command',
      command: 'cortextos bus hook-context-status',
      refreshInterval: 5,
      timeout: 2,
    };

    if (!fsExists(orgsDir)) {
      console.error('orgs/ directory not found at', orgsDir);
      process.exit(1);
    }

    let patched = 0;
    let skipped = 0;

    for (const org of fsReaddir(orgsDir)) {
      const agentsDir = join(orgsDir, org, 'agents');
      if (!fsExists(agentsDir)) continue;
      for (const agent of fsReaddir(agentsDir)) {
        const settingsPath = join(agentsDir, agent, '.claude', 'settings.json');
        if (!fsExists(settingsPath)) continue;

        let settings: any;
        try { settings = JSON.parse(fsRead(settingsPath, 'utf-8')); }
        catch { console.warn(`  SKIP ${agent}: could not parse settings.json`); skipped++; continue; }

        const changes: string[] = [];

        // Check allow list
        const current: string[] = settings?.permissions?.allow ?? [];
        const missing = REQUIRED_ALLOW.filter(t => !current.includes(t));
        if (missing.length > 0) changes.push(`allow: +[${missing.join(', ')}]`);

        // Check statusLine
        if (!settings.statusLine) changes.push('statusLine: add hook-context-status');

        if (changes.length === 0) {
          console.log(`  OK   ${agent}: already up to date`);
          skipped++;
          continue;
        }

        if (opts.dryRun) {
          console.log(`  DRY  ${agent}: would apply [${changes.join('; ')}]`);
          patched++;
        } else {
          settings.permissions = settings.permissions ?? {};
          settings.permissions.allow = [...current, ...missing];
          settings.statusLine = STATUS_LINE;
          fsWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          console.log(`  FIX  ${agent}: applied [${changes.join('; ')}]`);
          patched++;
        }
      }
    }

    const verb = opts.dryRun ? 'Would patch' : 'Patched';
    console.log(`\n${verb} ${patched} agent(s). ${skipped} already up to date or skipped.`);
    if (!opts.dryRun && patched > 0) {
      console.log('\nRestart affected agents to apply the new settings:');
      console.log('  cortextos restart <agent-name>');
    }
  });

// --- computer-use ---

busCommand
  .command('drain-mirror')
  .description('Synchronously drain the RGOS mirror retry queue — for post-deploy verification or manual recovery')
  .option('--json', 'Output result as JSON', false)
  .action(async (opts: { json?: boolean }) => {
    const qPath = retryQueuePath();

    if (!isEnabled()) {
      const msg = 'RGOS mirror is disabled (kill switch or missing env). Nothing to drain.';
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, skipped: true, reason: msg }));
      } else {
        console.log(msg);
      }
      return;
    }

    if (!qPath) {
      const msg = 'Cannot locate retry queue: CTX_ROOT or CTX_AGENT_NAME not set.';
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: msg }));
      } else {
        console.error(msg);
        process.exit(1);
      }
      return;
    }

    const before = readRetryQueue(qPath).length;
    if (before === 0) {
      const msg = 'Retry queue is empty — nothing to drain.';
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, before: 0, after: 0, drained: 0 }));
      } else {
        console.log(msg);
      }
      return;
    }

    if (!opts.json) {
      console.log(`drain-mirror: ${before} entr${before === 1 ? 'y' : 'ies'} in queue — draining…`);
    }

    await drainRetryQueue();

    const after = readRetryQueue(qPath).length;
    const drained = before - after;

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, before, after, drained }));
    } else if (after === 0) {
      console.log(`drain-mirror: drained ${drained}/${before} — queue is now empty.`);
    } else {
      console.log(`drain-mirror: drained ${drained}/${before} — ${after} still failed (PostgREST unreachable?).`);
      process.exit(1);
    }
  });

busCommand
  .command('computer-use <prompt>')
  .description('Run a prompt on Codex with @Computer Use plugin via SSH to Greg\'s Mac')
  .option('--no-plugin', 'Send a plain Codex prompt without the Computer Use plugin')
  .option('--workdir <dir>', 'Working directory for Codex on the Mac')
  .option('--timeout <seconds>', 'Max wait time in seconds (default: 300)', '300')
  .option('--ssh-host <host>', 'SSH host (default: gregs-mac)', 'gregs-mac')
  .option('--dispatch-script <path>', 'Path to codex-dispatch.sh on the Mac', '/Users/gregharned/work/team-brain/scripts/codex-dispatch.sh')
  .option('--orgo-failure-artifact <path>', 'Recent failed Orgo lease attempt artifact required before Mac SSH fallback')
  .option('--disable-fallback', 'Disable localhost codex exec fallback when Mac SSH is unreachable')
  .action(async (
    prompt: string,
    opts: {
      noPlugin?: boolean;
      plugin?: boolean;
      workdir?: string;
      timeout?: string;
      sshHost?: string;
      dispatchScript?: string;
      orgoFailureArtifact?: string;
      disableFallback?: boolean;
    },
  ) => {
    const result = await computerUse(prompt, {
      noPlugin: opts.noPlugin === true || opts.plugin === false,
      workdir: opts.workdir,
      timeout: parseInt(opts.timeout ?? '300', 10),
      sshHost: opts.sshHost,
      dispatchScript: opts.dispatchScript,
      orgoFailureArtifact: opts.orgoFailureArtifact,
      noFallback: opts.disableFallback,
    });

    if (!result.ok) {
      console.error(`computer-use failed: ${result.error}`);
      process.exit(1);
    }

    // Log the event
    const env = resolveEnv();
    const paths = resolvePaths(env.agentName, env.instanceId, env.org);
    logEvent(paths, env.agentName, env.org, 'action', 'computer_use_task', 'info', { prompt: prompt.slice(0, 200), duration_ms: result.durationMs, used_fallback: result.usedFallback ?? false });

    if (result.usedFallback) {
      console.log('[via cortex VM fallback — Mac SSH was unreachable]');
    }
    console.log(result.output);
  });

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
