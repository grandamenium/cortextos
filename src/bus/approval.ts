import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths, EmailMeta } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseEnvFile } from '../utils/env.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { TelegramAPI } from '../telegram/api.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Returns a promise that resolves once the
 * post attempt has settled.
 *
 * Path resolution: activity-channel.env lives under the FRAMEWORK root
 * (frameworkRoot/orgs/<org>/activity-channel.env), NOT the runtime state
 * dir (ctxRoot/orgs/<org>/). The earlier version of this helper used
 * paths.ctxRoot to derive orgDir, which silently resolved to the wrong
 * filesystem root and caused every activity-channel post to fail as
 * "not configured" — a bug that hid for hours because of the silent
 * .catch below. Fallback chain is now: explicit frameworkRoot arg →
 * process.env.CTX_FRAMEWORK_ROOT → SKIP WITH WARN (no further fallback;
 * the paths.ctxRoot fallback that caused the original bug was removed
 * deliberately per post-incident review — silently using a known-wrong
 * path is worse than skipping loudly).
 *
 * Errors from postActivity (thrown rejections) are suppressed so
 * activity-channel unreachability does not block approval creation. The
 * "not configured" signal (postActivity returns false) is now logged as
 * a visible warn — preserves the best-effort behavior but surfaces
 * misconfiguration immediately instead of debugging it silently.
 *
 * The returned promise MUST be awaited by the caller in short-lived
 * contexts (CLI action handlers) or the process may exit before the
 * underlying fetch completes and the post silently never sends.
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  frameworkRoot: string | undefined,
): Promise<void> {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} — skipping activity-channel post. ` +
      `Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`,
    );
    return Promise.resolve();
  }

  const orgDir = join(root, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId))
    .then((posted) => {
      if (!posted) {
        // postActivity returns false when activity-channel.env is missing
        // or cannot be parsed. Surface this visibly — the silent-false
        // pattern is what hid tonight's path-resolution bug for hours.
        console.warn(
          `[approval] Activity-channel post failed for ${approvalId} — ` +
          `check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`,
        );
      }
    })
    .catch(() => undefined); // Thrown rejections still suppressed — activity-channel unreachable must not fail approval creation.
}

/**
 * Best-effort: ping the requesting agent's own Telegram chat (the operator's
 * 1:1 conversation with the agent's bot) when a new approval is created.
 * The activity-channel post handles "Approve / Deny" inline routing for the
 * operator-via-orchestrator UX, but operators on a per-agent bot would
 * otherwise miss approvals entirely — that's the source of the observed
 * 50h+ Repo-B-style stalls. This pings them on the bot they're actually
 * watching so they can hop to the orchestrator chat or dashboard to act.
 *
 * Reads BOT_TOKEN + CHAT_ID from `<agentDir>/.env`. Skips silently with a
 * single warn line when either is missing — approvals from a bot-less
 * agent (e.g. a hermes runtime, or pre-onboarding) must still succeed.
 *
 * Errors from the network round-trip are suppressed: a Telegram outage
 * must not block approval creation.
 */
function pingAgentChatId(
  agentDir: string | undefined,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
): Promise<void> {
  if (!agentDir) {
    console.warn(
      `[approval] No agentDir available for ${approvalId} — skipping agent-bot Telegram ping.`,
    );
    return Promise.resolve();
  }
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return Promise.resolve();
  }
  const env = parseEnvFile(envPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      `[approval] BOT_TOKEN or CHAT_ID missing in ${envPath} — skipping agent-bot Telegram ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  lines.push('', 'Approve via the orchestrator chat (Approve/Deny buttons) or the dashboard.');
  const message = lines.join('\n');

  const api = new TelegramAPI(botToken);
  return api.sendMessage(chatId, message, undefined, { parseMode: null })
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not fail approval creation.
}

/**
 * Best-effort: send the approval notification WITH inline Approve/Deny buttons
 * directly to the orchestrator's primary Telegram chat.
 *
 * The activity-channel post (above) also carries buttons, but that is a
 * separate bot/chat that operators may not be watching. The orchestrator's
 * own bot chat is the primary surface Greg uses — this ensures inline buttons
 * appear there so he can tap Approve/Deny without leaving the conversation.
 *
 * Skips silently when:
 *   - frameworkRoot is not available (cannot resolve orchestrator agent dir)
 *   - org is empty (multi-org ambiguity)
 *   - orchestratorName resolves to the requesting agent (would duplicate pingAgentChatId)
 *   - BOT_TOKEN or CHAT_ID missing from orchestrator .env
 *
 * Errors from the network round-trip are suppressed — Telegram outage must
 * not block approval creation.
 */
function pingOrchestratorChat(
  frameworkRoot: string | undefined,
  org: string,
  orchestratorName: string,
  requestingAgent: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  context: string | undefined,
): Promise<void> {
  if (!frameworkRoot || !org) return Promise.resolve();
  // Don't duplicate if the orchestrator itself created the approval
  if (orchestratorName === requestingAgent) return Promise.resolve();

  const orchEnvPath = join(frameworkRoot, 'orgs', org, 'agents', orchestratorName, '.env');
  if (!existsSync(orchEnvPath)) {
    console.warn(`[approval] Orchestrator .env not found at ${orchEnvPath} — skipping orchestrator chat ping for ${approvalId}.`);
    return Promise.resolve();
  }
  const env = parseEnvFile(orchEnvPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(`[approval] BOT_TOKEN or CHAT_ID missing in orchestrator .env — skipping orchestrator chat ping for ${approvalId}.`);
    return Promise.resolve();
  }

  // Dedup guard: if the orchestrator's bot+chat match the activity channel's
  // bot+chat, postApprovalToActivityChannel already sent a message with
  // Approve/Deny buttons to this exact chat. Sending again produces the
  // double-approval-buttons bug Greg reported.
  const activityEnvPath = join(frameworkRoot, 'orgs', org, 'activity-channel.env');
  if (existsSync(activityEnvPath)) {
    try {
      const activityEnv = parseEnvFile(activityEnvPath);
      if (activityEnv.ACTIVITY_BOT_TOKEN === botToken && activityEnv.ACTIVITY_CHAT_ID === chatId) {
        return Promise.resolve();
      }
    } catch {
      // Unreadable activity-channel.env — proceed with orchestrator ping.
    }
  }

  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${requestingAgent}`,
  ];
  if (context) lines.push('', context);
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  const api = new TelegramAPI(botToken);
  return api.sendMessage(chatId, message, buildApprovalKeyboard(approvalId), { parseMode: null })
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not block approval creation.
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 *
 * Returns a Promise that resolves to the approval id AFTER the
 * activity-channel fan-out has settled. Callers in short-lived contexts
 * (CLI action handlers) MUST await — otherwise the process may exit before
 * the Telegram post completes and the post silently never sends.
 *
 * `frameworkRoot` (optional) is the filesystem root where
 * orgs/<org>/activity-channel.env lives. Without it the activity-channel
 * post is skipped with a warn — see postApprovalToActivityChannel for the
 * fallback chain (explicit arg → CTX_FRAMEWORK_ROOT env → skip). CLI call
 * sites should pass env.frameworkRoot explicitly; daemon-side callers
 * may rely on the env var.
 */
export async function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  frameworkRoot?: string,
  agentDir?: string,
  emailMeta?: EmailMeta,
): Promise<string> {
  validateApprovalCategory(category);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    ...(emailMeta ? { email_meta: emailMeta } : {}),
  };

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  // Fan-out to the activity channel so the operator can approve/deny from
  // Telegram without opening the dashboard. AWAITED so short-lived CLI callers do
  // not exit before the Telegram post fetch completes. Errors are
  // suppressed inside postApprovalToActivityChannel — activity-channel
  // unreachable must not block approval creation. Callbacks route back
  // via the orchestrator's activity-channel poller (see
  // daemon/agent-manager.ts).
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);

  // Best-effort ping to the requesting agent's own Telegram bot (the
  // operator's 1:1 conversation with the agent). Closes the gap where
  // operators not in the activity channel would miss approvals entirely
  // (the 50h+ Repo-B-style stall). Errors suppressed — see helper.
  await pingAgentChatId(agentDir, approvalId, title, category, agentName, context);

  // Best-effort: send inline Approve/Deny buttons directly to the orchestrator's
  // primary Telegram chat. The operator expects to act from the orchestrator
  // conversation — without this, the message text says "Approve via orchestrator
  // chat" but no buttons are present there. The orchestrator fast-checker's
  // handleCallback already handles appr_allow|deny_* so callbacks route correctly.
  const orchName = process.env.CTX_ORCHESTRATOR || 'orchestrator';
  await pingOrchestratorChat(frameworkRoot, org, orchName, agentName, approvalId, title, category, context);

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
): void {
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval: Approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;

    // Move to resolved/ directory (matches bash version)
    const destDir = join(paths.approvalDir, 'resolved');
    ensureDir(destDir);
    atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

    // Notify requesting agent via inbox BEFORE removing from pending.
    //
    // Race fix (bug B4): the previous order was write-resolved → unlink-pending →
    // send-inbox. If the daemon crashed between unlink and send-inbox, the approval
    // was resolved on disk but the requesting agent never received the decision —
    // permanently blocking it.
    //
    // New order: write-resolved → send-inbox → unlink-pending.
    // If the daemon crashes between send-inbox and unlink-pending, the pending file
    // becomes a stale orphan. listPendingApprovals() filters these out by checking
    // whether the same id also exists in resolved/. The worst outcome is a harmless
    // duplicate inbox message if the daemon restarts and retries — far better than
    // a silently lost decision.
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : '';
      const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
      sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
    }

    // Remove from pending (after inbox notification is safely on disk)
    const { unlinkSync } = require('fs');
    try {
      unlinkSync(filePath);
    } catch {
      // If unlink fails (e.g. concurrent resolution or crash-recovery retry),
      // the notification was already delivered — this is non-fatal.
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}

/**
 * List pending approvals.
 *
 * Filters out stale orphaned pending files: if a file exists in both pending/
 * and resolved/ (possible when a daemon crash occurs between inbox notification
 * and unlink-pending in updateApproval), the entry is already resolved and
 * must not be surfaced as pending. The orphaned pending file will be cleaned up
 * on the next updateApproval call for that id (unlinkSync is now wrapped in
 * try/catch for this case).
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  const resolvedDir = join(paths.approvalDir, 'resolved');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    // Skip stale pending entries that are already in resolved/ (crash-recovery orphans)
    if (existsSync(join(resolvedDir, file))) continue;

    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      approvals.push(JSON.parse(content));
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Read a single approval by id. Searches resolved/ first, then pending/.
 * Returns null if not found.
 */
export function readApproval(paths: BusPaths, approvalId: string): Approval | null {
  const resolvedPath = join(paths.approvalDir, 'resolved', `${approvalId}.json`);
  const pendingPath = join(paths.approvalDir, 'pending', `${approvalId}.json`);
  for (const p of [resolvedPath, pendingPath]) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8')) as Approval;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Build a base64url-encoded RFC 2822 email message suitable for the Gmail
 * API `users.messages.send` body: `{ "raw": "<base64url>" }`.
 */
function buildRawEmail(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  cc?: string;
}): string {
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  const raw = `${headers.join('\r\n')}\r\n\r\n${opts.body}`;
  return Buffer.from(raw).toString('base64url');
}

/**
 * Send an approved email by approval id.
 *
 * Validates:
 *   - approval exists and status === 'approved'
 *   - approval has email_meta (to, subject, body)
 *
 * Sends via `gws gmail users messages send` using the configured
 * GOOGLE_REFRESH_TOKEN / gws credentials.
 *
 * The `from` address defaults to the AGENT_EMAIL env var, falling back to
 * support@revopsglobal.ai — override in email_meta.from if needed.
 *
 * Writes a send-audit entry to approvals/resolved/<id>-sent.json.
 */
export function sendApprovedEmail(
  paths: BusPaths,
  approvalId: string,
  opts: { dryRun?: boolean } = {},
): { id: string; threadId?: string } {
  const approval = readApproval(paths, approvalId);
  if (!approval) {
    throw new Error(`Approval ${approvalId} not found`);
  }
  if (approval.status !== 'approved') {
    throw new Error(`Approval ${approvalId} is ${approval.status}, not approved`);
  }
  if (!approval.email_meta) {
    throw new Error(`Approval ${approvalId} has no email_meta — use create-approval with --email-meta`);
  }

  const { to, subject, body, reply_to, cc, from } = approval.email_meta;
  const fromAddress = from || process.env.AGENT_EMAIL || 'support@revopsglobal.ai';

  const raw = buildRawEmail({ from: fromAddress, to, subject, body, replyTo: reply_to, cc });

  if (opts.dryRun) {
    return { id: 'dry-run' };
  }

  const result = execFileSync('gws', [
    'gmail', 'users', 'messages', 'send',
    '--json', JSON.stringify({ raw }),
    '--format', 'json',
  ], { encoding: 'utf-8' });

  const parsed = JSON.parse(result) as { id: string; threadId?: string };

  // Write audit record so the approval is traceable
  const auditPath = join(paths.approvalDir, 'resolved', `${approvalId}-sent.json`);
  writeFileSync(auditPath, JSON.stringify({
    approval_id: approvalId,
    sent_at: new Date().toISOString(),
    message_id: parsed.id,
    thread_id: parsed.threadId ?? null,
    to,
    subject,
  }));

  return parsed;
}
