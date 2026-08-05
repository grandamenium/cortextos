import { Command } from 'commander';
import { execFileSync } from 'child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import type { AgentConfig } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { stripBom } from '../utils/strip-bom.js';

type CheckStatus = 'OK' | 'WARN' | 'FAIL';

interface DoctorCheck {
  group: string;
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

interface DoctorReport {
  instance: string;
  frameworkRoot: string;
  ctxRoot: string;
  generatedAt: string;
  checks: DoctorCheck[];
  summary: Record<CheckStatus, number>;
}

interface EnabledAgentEntry {
  enabled?: boolean;
  org?: string;
  status?: string;
}

interface AgentRecord {
  name: string;
  org: string;
  dir?: string;
  enabled: boolean;
  fromEnabledFile: boolean;
  config?: AgentConfig;
  configPath?: string;
  configError?: string;
  envPath?: string;
  env?: Record<string, string>;
}

interface Pm2Process {
  name?: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    pm_id?: number;
    restart_time?: number;
    unstable_restarts?: number;
    pm_uptime?: number;
  };
}

interface LivenessInput {
  agent: string;
  heartbeatTimestampMs: number | null;
  heartbeatLabel: string;
  stdoutMtimeMs: number | null;
  stdoutLabel: string;
  nowMs: number;
  heartbeatStaleMs?: number;
  stdoutStaleMs?: number;
}

interface LivenessClassification {
  status: CheckStatus;
  message: string;
  fix?: string;
}

const HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000;
// Idle agents on a long heartbeat cadence (e.g. 4h orchestrator agents) only
// write stdout when a cron fires or a message arrives, so a 20m gap is normal
// idle, not a freeze. 90m separates "ran something recently" from "genuinely
// dark" without false-flagging long-cadence agents like concierge.
const STDOUT_STALE_MS = 90 * 60 * 1000;
const PM2_CHRONIC_RESTARTS = 10;
const DAEMON_CRON_STALE_MS = 8 * 60 * 60 * 1000;
const ANALYTICS_STALE_MS = 8 * 60 * 60 * 1000;

export const doctorCommand = new Command('doctor')
  .option('--instance <id>', 'Instance ID', process.env.CTX_INSTANCE_ID || 'default')
  .option('--json', 'Emit machine-readable JSON')
  .description('Diagnose cortextOS framework and agent fleet health')
  .action(async (options: { instance: string; json?: boolean }) => {
    const report = await runDoctor(options.instance);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }

    if (report.summary.FAIL > 0) {
      process.exit(1);
    }
  });

export async function runDoctor(instanceId: string): Promise<DoctorReport> {
  const frameworkRoot = discoverFrameworkRoot();
  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const agents = discoverAgents(frameworkRoot, ctxRoot);
  const checks: DoctorCheck[] = [];

  checks.push(...checkStateAndAgents(ctxRoot, agents));
  checks.push(...checkPm2(frameworkRoot));
  checks.push(...checkAgentLiveness(ctxRoot, agents));
  checks.push(...checkCrashLoops(ctxRoot, agents, Date.now()));
  checks.push(...checkRateLimits(ctxRoot, agents, Date.now()));
  checks.push(...checkWorkingDirectories(agents));
  checks.push(...checkEnabledAgentGhosts(agents));
  checks.push(...await checkTelegramPrivacy(agents));
  checks.push(checkFullDiskAccess());
  checks.push(checkDaemonCronHealth(ctxRoot, agents));
  checks.push(checkBuildFreshness(frameworkRoot));

  const summary = summarize(checks);

  return {
    instance: instanceId,
    frameworkRoot,
    ctxRoot,
    generatedAt: new Date().toISOString(),
    checks,
    summary,
  };
}

export function classifyAgentLiveness(input: LivenessInput): LivenessClassification {
  const heartbeatStaleMs = input.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  const stdoutStaleMs = input.stdoutStaleMs ?? STDOUT_STALE_MS;

  const heartbeatAgeMs = input.heartbeatTimestampMs === null
    ? Number.POSITIVE_INFINITY
    : input.nowMs - input.heartbeatTimestampMs;
  const stdoutAgeMs = input.stdoutMtimeMs === null
    ? Number.POSITIVE_INFINITY
    : input.nowMs - input.stdoutMtimeMs;

  const heartbeatStale = heartbeatAgeMs > heartbeatStaleMs;
  const stdoutStale = stdoutAgeMs > stdoutStaleMs;
  const heartbeatAge = input.heartbeatTimestampMs === null ? 'missing' : `${formatDuration(heartbeatAgeMs)} ago`;
  const stdoutAge = input.stdoutMtimeMs === null ? 'missing' : `${formatDuration(stdoutAgeMs)} ago`;

  if (heartbeatStale && stdoutStale) {
    // Both stale looks like a freeze, but it can't be proven from logs alone —
    // an idle agent past its cron cadence presents identically. Surface it as a
    // WARN to INVESTIGATE (verify the process + stdout-in-UTC) rather than a FAIL
    // that implies a reflexive restart. Restarting a busy/idle agent is worse
    // than leaving it; a restart mid-task can even corrupt work.
    return {
      status: 'WARN',
      message: `heartbeat ${heartbeatAge} (${input.heartbeatLabel}); stdout ${stdoutAge} (${input.stdoutLabel}); possibly stalled — verify before restarting`,
      fix: `Verify first: TZ=UTC stat -f %Sm -t '%FT%TZ' logs/${input.agent}/stdout.log and check the process is alive. Only \`cortextos bus soft-restart ${input.agent}\` if stdout is genuinely dark and the session is wedged (not mid-task / not idle on cadence).`,
    };
  }

  if (heartbeatStale && !stdoutStale) {
    return {
      status: 'WARN',
      message: `heartbeat stale ${heartbeatAge} (${input.heartbeatLabel}), but stdout is recent ${stdoutAge} (${input.stdoutLabel}); busy/heads-down, do NOT restart`,
      fix: `Do not restart. Tail logs/${input.agent}/stdout.log and only soft-restart if stdout also goes stale.`,
    };
  }

  return {
    status: 'OK',
    message: `heartbeat ${heartbeatAge} (${input.heartbeatLabel}); stdout ${stdoutAge} (${input.stdoutLabel})`,
  };
}

function checkStateAndAgents(ctxRoot: string, agents: AgentRecord[]): DoctorCheck[] {
  const enabledCount = agents.filter(a => a.enabled).length;
  return [
    {
      group: 'Framework',
      name: 'State directory',
      status: existsSync(ctxRoot) ? 'OK' : 'WARN',
      message: existsSync(ctxRoot) ? ctxRoot : `${ctxRoot} not found`,
      fix: existsSync(ctxRoot) ? undefined : 'Run: cortextos init <org-name>',
    },
    {
      group: 'Framework',
      name: 'Enabled agents discovered',
      status: enabledCount > 0 ? 'OK' : 'WARN',
      message: `${enabledCount} enabled agent(s) discovered`,
      fix: enabledCount > 0 ? undefined : 'Run: cortextos add-agent <name> or cortextos enable <agent>',
    },
  ];
}

function checkPm2(frameworkRoot: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let processes: Pm2Process[];

  try {
    const raw = execFileSync('pm2', ['jlist'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    processes = JSON.parse(raw) as Pm2Process[];
  } catch (err) {
    return [{
      group: 'PM2',
      name: 'pm2 jlist',
      status: 'FAIL',
      message: `Could not read PM2 process list: ${errorMessage(err)}`,
      fix: 'Install/start PM2, then run: cortextos ecosystem && pm2 start ecosystem.config.js',
    }];
  }

  const expected = new Set<string>(['cortextos-daemon']);
  const hasDashboardDeps = existsSync(join(frameworkRoot, 'dashboard', 'package.json')) &&
    existsSync(join(frameworkRoot, 'dashboard', 'node_modules', '.bin', 'next'));
  if (hasDashboardDeps || processes.some(p => p.name === 'cortextos-dashboard')) {
    expected.add('cortextos-dashboard');
  }
  for (const proc of processes) {
    if (proc.name?.startsWith('cortextos-')) {
      expected.add(proc.name);
    }
  }

  for (const name of [...expected].sort()) {
    const matches = processes.filter(p => p.name === name);
    if (matches.length === 0) {
      checks.push({
        group: 'PM2',
        name,
        status: 'FAIL',
        message: 'Expected PM2 process is missing',
        fix: name === 'cortextos-daemon'
          ? 'Run: cortextos ecosystem && pm2 start ecosystem.config.js'
          : `Run: pm2 start ecosystem.config.js --only ${name}`,
      });
      continue;
    }

    const statuses = matches.map(p => p.pm2_env?.status ?? 'unknown');
    const restartCount = matches.reduce((max, p) => Math.max(max, p.pm2_env?.restart_time ?? 0), 0);
    const unstableCount = matches.reduce((max, p) => Math.max(max, p.pm2_env?.unstable_restarts ?? 0), 0);
    const online = statuses.every(status => status === 'online');
    const chronicRestart = restartCount >= PM2_CHRONIC_RESTARTS || unstableCount >= PM2_CHRONIC_RESTARTS;

    if (!online) {
      checks.push({
        group: 'PM2',
        name,
        status: 'FAIL',
        message: `Not online (status: ${statuses.join(', ')}, restart_time: ${restartCount})`,
        fix: `pm2 restart ${name}`,
      });
    } else if (chronicRestart) {
      checks.push({
        group: 'PM2',
        name,
        status: 'WARN',
        message: `Online but restart_time is high (${restartCount}, unstable_restarts: ${unstableCount})`,
        fix: `pm2 restart ${name}; if restart_time climbs again, inspect: pm2 logs ${name}`,
      });
    } else {
      checks.push({
        group: 'PM2',
        name,
        status: 'OK',
        message: `online (restart_time: ${restartCount})`,
      });
    }
  }

  return checks;
}

function checkAgentLiveness(ctxRoot: string, agents: AgentRecord[]): DoctorCheck[] {
  const nowMs = Date.now();
  const enabledAgents = agents.filter(a => a.enabled);

  return enabledAgents.map(agent => {
    const hb = readHeartbeat(ctxRoot, agent.name);
    const stdout = readMtime(join(ctxRoot, 'logs', agent.name, 'stdout.log'));
    const classification = classifyAgentLiveness({
      agent: agent.name,
      heartbeatTimestampMs: hb.timestampMs,
      heartbeatLabel: hb.label,
      stdoutMtimeMs: stdout.mtimeMs,
      stdoutLabel: stdout.label,
      nowMs,
    });

    return {
      group: 'Agent liveness',
      name: agent.name,
      status: classification.status,
      message: classification.message,
      fix: classification.fix,
      details: {
        heartbeatUtc: hb.timestampMs === null ? null : new Date(hb.timestampMs).toISOString(),
        stdoutMtimeUtc: stdout.mtimeMs === null ? null : new Date(stdout.mtimeMs).toISOString(),
      },
    };
  });
}

function checkWorkingDirectories(agents: AgentRecord[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  for (const agent of agents.filter(a => a.enabled)) {
    if (!agent.dir) {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} working_directory`,
        status: 'FAIL',
        message: 'Agent directory is missing, so config.json cannot point at it',
        fix: 'Restore the agent directory or set enabled:false in ~/.cortextos/<instance>/config/enabled-agents.json',
      });
      continue;
    }

    if (agent.configError) {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} config.json`,
        status: 'FAIL',
        message: agent.configError,
        fix: `Fix JSON in ${agent.configPath}, then set working_directory to ${agent.dir}`,
      });
      continue;
    }

    // Bootstrap files (IDENTITY.md, etc.) always load from the agent dir, NOT
    // from working_directory — working_directory is just the cwd for shell ops.
    // So: empty is fine (daemon defaults to the agent dir); a project dir is a
    // legitimate, intentional choice (e.g. fingers runs in its newsletter repo).
    // The only real breakage is a working_directory that points at a path which
    // does NOT EXIST — then the agent can't cd into it on boot.
    const configured = agent.config?.working_directory;
    const agentDir = normalizePath(agent.dir);

    if (typeof configured !== 'string' || configured.trim() === '') {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} working_directory`,
        status: 'OK',
        message: `empty; daemon defaults to the agent dir (${agentDir})`,
      });
      continue;
    }

    const configuredPath = normalizePath(configured, agent.dir);
    if (!existsSync(configuredPath)) {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} working_directory`,
        status: 'FAIL',
        message: `working_directory points to ${configuredPath}, which does not exist; the agent cannot cd into it on boot`,
        fix: `Fix working_directory in ${join(agent.dir, 'config.json')} — set it to the agent dir ${agentDir} or to a real project directory`,
      });
    } else if (configuredPath === agentDir) {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} working_directory`,
        status: 'OK',
        message: `points at agent dir (${agentDir})`,
      });
    } else {
      checks.push({
        group: 'Agent config',
        name: `${agent.name} working_directory`,
        status: 'OK',
        message: `runs in project dir ${configuredPath} (intentional; bootstrap still loads from the agent dir)`,
      });
    }
  }

  return checks;
}

function checkEnabledAgentGhosts(agents: AgentRecord[]): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  for (const agent of agents.filter(a => a.fromEnabledFile && a.enabled)) {
    // A real ghost = enabled:true with nothing the daemon can actually run
    // (no agent dir, or a dir with no config.json). Missing BOT_TOKEN/CHAT_ID is
    // NOT a ghost — plenty of healthy agents have no Telegram bot (sureladder is
    // iMessage, ig-campaigns is Instagram, internal agents have no channel).
    if (!agent.dir) {
      checks.push({
        group: 'Enabled agents',
        name: agent.name,
        status: 'WARN',
        message: 'enabled:true but the agent directory is missing (ghost-spawn risk)',
        fix: `Restore orgs/${agent.org}/agents/${agent.name} or set enabled:false in enabled-agents.json`,
      });
      continue;
    }

    if (agent.configError || !agent.config) {
      checks.push({
        group: 'Enabled agents',
        name: agent.name,
        status: 'WARN',
        message: `enabled:true but config.json is missing or invalid (${agent.configError ?? 'no config'}) — daemon may fail to spawn it`,
        fix: `Fix ${agent.configPath ?? join(agent.dir, 'config.json')} or set enabled:false in enabled-agents.json`,
      });
      continue;
    }

    const hasTelegram = !!(agent.env?.BOT_TOKEN && agent.env?.CHAT_ID);
    checks.push({
      group: 'Enabled agents',
      name: agent.name,
      status: 'OK',
      message: hasTelegram
        ? 'enabled:true, has agent dir, config, and Telegram env'
        : 'enabled:true, has agent dir and config (no Telegram bot — iMessage/Instagram/internal agent)',
    });
  }

  if (checks.length === 0) {
    checks.push({
      group: 'Enabled agents',
      name: 'enabled-agents.json',
      status: 'OK',
      message: 'No enabled:true entries found in enabled-agents.json',
    });
  }

  return checks;
}

// Real crashes are `type=crash`; everything else in crashes.log is a benign
// restart (daemon-stop, user-stop, session-refresh, session-time-cap, rate-limited,
// planned-restart, user-restart, user-disable). Calibrated against the live fleet.
function countCrashesToday(crashesLogPath: string, nowMs: number): number {
  try {
    const text = readFileSync(crashesLogPath, 'utf-8');
    const today = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.includes('type=crash')) continue;
      const ts = line.slice(0, 10);
      if (ts === today) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// An agent burning toward max_crashes_per_day stops auto-restarting once it hits
// the cap, then goes dark. Catch it before that. (Surfaced by graphing the daemon
// crash subsystem — countRecentCrashes / readMaxCrashesPerDay / CrashHistory.)
function checkCrashLoops(ctxRoot: string, agents: AgentRecord[], nowMs: number): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const agent of agents.filter(a => a.enabled && a.dir)) {
    const crashesLog = join(ctxRoot, 'logs', agent.name, 'crashes.log');
    const crashesToday = countCrashesToday(crashesLog, nowMs);
    const max = typeof agent.config?.max_crashes_per_day === 'number'
      ? agent.config.max_crashes_per_day
      : null;

    if (crashesToday === 0) continue; // nothing to report
    if (max !== null && crashesToday >= max) {
      checks.push({
        group: 'Agent stability',
        name: `${agent.name} crash loop`,
        status: 'FAIL',
        message: `${crashesToday} crashes today >= max_crashes_per_day (${max}); the daemon will stop auto-restarting it and the agent goes dark`,
        fix: `Read logs/${agent.name}/crashes.log + stdout.log for the root cause, fix it, then restart: cortextos restart ${agent.name}`,
      });
    } else if (max !== null && crashesToday >= Math.ceil(max * 0.6)) {
      checks.push({
        group: 'Agent stability',
        name: `${agent.name} crash loop`,
        status: 'WARN',
        message: `${crashesToday} crashes today, approaching max_crashes_per_day (${max})`,
        fix: `Investigate logs/${agent.name}/crashes.log before it hits the cap and stops restarting`,
      });
    } else {
      checks.push({
        group: 'Agent stability',
        name: `${agent.name} crash loop`,
        status: 'OK',
        message: `${crashesToday} crash(es) today${max !== null ? ` (limit ${max})` : ''}`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({ group: 'Agent stability', name: 'Crash loops', status: 'OK', message: 'No agent has crashed today' });
  }
  return checks;
}

// Use the STRUCTURED signal, not stdout prose: when an agent is actually
// rate-limited, the daemon records a `type=rate-limited` line in crashes.log with
// a timestamp. Scanning stdout for the words "rate limit" cries wolf on any agent
// that merely discusses rate limits or edits this very file. Count today's
// rate-limited events instead. Sam runs the fleet on Claude Max, so this is a real
// recurring failure surface (surfaced by graphing the rate-limit subsystem).
function countRateLimitedToday(crashesLogPath: string, nowMs: number): number {
  try {
    const text = readFileSync(crashesLogPath, 'utf-8');
    const today = new Date(nowMs).toISOString().slice(0, 10);
    let count = 0;
    for (const line of text.split('\n')) {
      if (line.includes('type=rate-limited') && line.slice(0, 10) === today) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function checkRateLimits(ctxRoot: string, agents: AgentRecord[], nowMs: number): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const agent of agents.filter(a => a.enabled && a.dir)) {
    const crashesLog = join(ctxRoot, 'logs', agent.name, 'crashes.log');
    const hits = countRateLimitedToday(crashesLog, nowMs);
    if (hits > 0) {
      checks.push({
        group: 'Agent stability',
        name: `${agent.name} rate limit`,
        status: 'WARN',
        message: `${hits} rate-limited event(s) today (daemon-logged in crashes.log); the agent was throttled and may have paused/restarted`,
        fix: `If on Claude Max, the agent hit a usage window — check account rotation (cortextos may rotate) or wait out the window. Persistent hits: switch the agent's model/account.`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({ group: 'Agent stability', name: 'Rate limits', status: 'OK', message: 'No daemon-logged rate-limit events today' });
  }
  return checks;
}

async function checkTelegramPrivacy(agents: AgentRecord[]): Promise<DoctorCheck[]> {
  const groupChatAgents = agents
    .filter(a => a.enabled && a.env?.BOT_TOKEN && isNegativeChatId(a.env.CHAT_ID));

  if (groupChatAgents.length === 0) {
    return [{
      group: 'Telegram',
      name: 'Group privacy mode',
      status: 'OK',
      message: 'No enabled agents with negative CHAT_ID group chats found',
    }];
  }

  const checks: DoctorCheck[] = [];
  for (const agent of groupChatAgents) {
    const token = agent.env!.BOT_TOKEN!;
    const chatId = agent.env!.CHAT_ID!;
    try {
      // Retry transient network failures. A bad token returns {ok:false} (handled
      // in the else branch below), so a thrown error here is a network blip, not
      // a config problem — don't let a flaky fetch cry wolf.
      let me: Awaited<ReturnType<TelegramAPI['getMe']>> | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          me = await new TelegramAPI(token).getMe();
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
      const canReadAll = me?.result?.can_read_all_group_messages;
      const username = me?.result?.username ? `@${me.result.username}` : '(unknown bot)';

      if (canReadAll === true) {
        checks.push({
          group: 'Telegram',
          name: `${agent.name} privacy`,
          status: 'OK',
          message: `${username} can read all group messages for CHAT_ID ${redactChatId(chatId)}`,
        });
      } else if (canReadAll === false) {
        checks.push({
          group: 'Telegram',
          name: `${agent.name} privacy`,
          status: 'FAIL',
          message: `${username} has can_read_all_group_messages=false; bot cannot read normal group messages`,
          fix: 'BotFather /setprivacy -> Disable -> remove+re-add bot to the group',
        });
      } else {
        checks.push({
          group: 'Telegram',
          name: `${agent.name} privacy`,
          status: 'WARN',
          message: `${username} getMe response did not include can_read_all_group_messages; group privacy could not be proven`,
          fix: 'Open BotFather /setprivacy and confirm privacy is Disabled, then remove+re-add bot to the group',
        });
      }
    } catch (err) {
      // Exhausted retries = Telegram unreachable (transient network), which says
      // nothing about privacy config and isn't a fleet problem. Report as a skip,
      // not a WARN, so it doesn't show up as a recurring false alarm.
      checks.push({
        group: 'Telegram',
        name: `${agent.name} privacy`,
        status: 'OK',
        message: `skipped — could not reach Telegram for CHAT_ID ${redactChatId(chatId)} after 3 tries (${errorMessage(err)}); privacy not checked this run`,
      });
    }
  }

  return checks;
}

function checkFullDiskAccess(): DoctorCheck {
  if (process.platform !== 'darwin') {
    return {
      group: 'macOS',
      name: 'Full Disk Access',
      status: 'OK',
      message: 'Not macOS; FDA check is not applicable',
    };
  }

  const nodePath = process.execPath;
  const messagesDb = join(homedir(), 'Library', 'Messages', 'chat.db');

  try {
    const fd = openSync(messagesDb, 'r');
    closeSync(fd);
    return {
      group: 'macOS',
      name: 'Full Disk Access',
      status: 'OK',
      message: `running node can open ${messagesDb}`,
      details: { nodePath },
    };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        group: 'macOS',
        name: 'Full Disk Access',
        status: 'WARN',
        message: `${nodePath} cannot read ${messagesDb} (${code}); FDA is per-binary and can be lost after a brew node upgrade`,
        fix: `Grant Full Disk Access to ${nodePath}, then restart affected agents`,
        details: { nodePath, code },
      };
    }

    return {
      group: 'macOS',
      name: 'Full Disk Access',
      status: 'WARN',
      message: `Could not verify FDA against ${messagesDb}: ${errorMessage(err)}`,
      fix: `If agents need Messages access, grant Full Disk Access to ${nodePath} and restart affected agents`,
      details: { nodePath, code: code || undefined },
    };
  }
}

function checkDaemonCronHealth(ctxRoot: string, agents: AgentRecord[]): DoctorCheck {
  const enabledAgents = agents.filter(a => a.enabled);
  if (enabledAgents.length === 0) {
    return {
      group: 'Daemon',
      name: 'Cron scheduler',
      status: 'OK',
      message: 'No enabled agents; scheduler has nothing to fire',
    };
  }

  const nowMs = Date.now();
  let latestHeartbeatCronMs: number | null = null;
  let latestCronMs: number | null = null;

  for (const agent of enabledAgents) {
    const logPath = join(ctxRoot, '.cortextOS', 'state', 'agents', agent.name, 'cron-execution.log');
    for (const entry of readJsonlTail(logPath, 300)) {
      const ts = typeof entry.ts === 'string' ? new Date(entry.ts).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      latestCronMs = Math.max(latestCronMs ?? ts, ts);
      const cronName = typeof entry.cron === 'string' ? entry.cron.toLowerCase() : '';
      if (cronName.includes('heartbeat')) {
        latestHeartbeatCronMs = Math.max(latestHeartbeatCronMs ?? ts, ts);
      }
    }
  }

  const latestAnalyticsMs = findLatestAnalyticsEventMs(ctxRoot);
  const heartbeatAge = latestHeartbeatCronMs === null ? Number.POSITIVE_INFINITY : nowMs - latestHeartbeatCronMs;
  const analyticsAge = latestAnalyticsMs === null ? Number.POSITIVE_INFINITY : nowMs - latestAnalyticsMs;

  if (latestHeartbeatCronMs !== null && heartbeatAge <= DAEMON_CRON_STALE_MS) {
    return {
      group: 'Daemon',
      name: 'Cron scheduler',
      status: 'OK',
      message: `latest heartbeat cron fired ${formatDuration(heartbeatAge)} ago (${formatUtc(latestHeartbeatCronMs)})`,
      details: {
        latestHeartbeatCronUtc: formatUtc(latestHeartbeatCronMs),
        latestCronUtc: latestCronMs === null ? null : formatUtc(latestCronMs),
        latestAnalyticsUtc: latestAnalyticsMs === null ? null : formatUtc(latestAnalyticsMs),
      },
    };
  }

  const pieces = [
    latestHeartbeatCronMs === null
      ? 'no heartbeat cron execution found'
      : `latest heartbeat cron was ${formatDuration(heartbeatAge)} ago (${formatUtc(latestHeartbeatCronMs)})`,
    latestCronMs === null
      ? 'no daemon cron execution log found'
      : `latest cron attempt was ${formatDuration(nowMs - latestCronMs)} ago (${formatUtc(latestCronMs)})`,
    latestAnalyticsMs === null
      ? 'no analytics event found'
      : `latest analytics event was ${formatDuration(analyticsAge)} ago (${formatUtc(latestAnalyticsMs)})`,
  ];

  return {
    group: 'Daemon',
    name: 'Cron scheduler',
    status: 'WARN',
    message: pieces.join('; '),
    fix: analyticsAge > ANALYTICS_STALE_MS
      ? 'Inspect pm2 logs cortextos-daemon, then restart the daemon if the scheduler is stalled: pm2 restart cortextos-daemon'
      : 'Verify heartbeat crons are installed/reloaded; inspect: pm2 logs cortextos-daemon',
    details: {
      latestHeartbeatCronUtc: latestHeartbeatCronMs === null ? null : formatUtc(latestHeartbeatCronMs),
      latestCronUtc: latestCronMs === null ? null : formatUtc(latestCronMs),
      latestAnalyticsUtc: latestAnalyticsMs === null ? null : formatUtc(latestAnalyticsMs),
    },
  };
}

function checkBuildFreshness(frameworkRoot: string): DoctorCheck {
  const srcNewest = newestMtime(join(frameworkRoot, 'src'));
  const distNewest = newestMtime(join(frameworkRoot, 'dist'));

  if (srcNewest === null) {
    return {
      group: 'Build',
      name: 'dist freshness',
      status: 'WARN',
      message: 'src/ not found; cannot compare build freshness',
      fix: 'Run doctor from the framework root or set CTX_FRAMEWORK_ROOT',
    };
  }

  if (distNewest === null) {
    return {
      group: 'Build',
      name: 'dist freshness',
      status: 'FAIL',
      message: 'dist/ not found; daemon cannot run built CLI/daemon code',
      fix: 'npm run build && pm2 restart cortextos-daemon',
      details: { srcNewestUtc: formatUtc(srcNewest), distNewestUtc: null },
    };
  }

  if (srcNewest > distNewest + 1000) {
    return {
      group: 'Build',
      name: 'dist freshness',
      status: 'WARN',
      message: `src/ is newer than dist/ (src ${formatUtc(srcNewest)}, dist ${formatUtc(distNewest)})`,
      fix: 'npm run build && pm2 restart cortextos-daemon',
      details: { srcNewestUtc: formatUtc(srcNewest), distNewestUtc: formatUtc(distNewest) },
    };
  }

  return {
    group: 'Build',
    name: 'dist freshness',
    status: 'OK',
    message: `dist/ is at least as fresh as src/ (dist ${formatUtc(distNewest)})`,
    details: { srcNewestUtc: formatUtc(srcNewest), distNewestUtc: formatUtc(distNewest) },
  };
}

function discoverFrameworkRoot(): string {
  if (process.env.CTX_FRAMEWORK_ROOT) return process.env.CTX_FRAMEWORK_ROOT;
  if (process.env.CTX_PROJECT_ROOT) return process.env.CTX_PROJECT_ROOT;

  const canonical = join(homedir(), 'cortextos');
  if (existsSync(join(canonical, 'orgs'))) return canonical;

  return process.cwd();
}

function discoverAgents(frameworkRoot: string, ctxRoot: string): AgentRecord[] {
  const enabledEntries = readEnabledAgents(ctxRoot);
  const records = new Map<string, AgentRecord>();
  const orgsDir = join(frameworkRoot, 'orgs');

  if (existsSync(orgsDir)) {
    for (const org of safeReadDirs(orgsDir)) {
      const agentsDir = join(orgsDir, org, 'agents');
      for (const agentName of safeReadDirs(agentsDir)) {
        if (agentName.startsWith('.')) continue;
        if (records.has(agentName)) continue;

        const dir = join(agentsDir, agentName);
        const enabledEntry = enabledEntries[agentName];
        const configInfo = readAgentConfig(dir);
        const envInfo = readAgentEnv(dir);
        const enabled = enabledEntry?.enabled === false || configInfo.config?.enabled === false ? false : true;

        records.set(agentName, {
          name: agentName,
          org,
          dir,
          enabled,
          fromEnabledFile: enabledEntry !== undefined,
          config: configInfo.config,
          configPath: configInfo.path,
          configError: configInfo.error,
          envPath: envInfo.path,
          env: envInfo.env,
        });
      }
    }
  }

  for (const [name, entry] of Object.entries(enabledEntries)) {
    if (records.has(name)) {
      const existing = records.get(name)!;
      existing.fromEnabledFile = true;
      existing.org = entry.org || existing.org;
      existing.enabled = entry.enabled === false || existing.config?.enabled === false ? false : true;
      continue;
    }

    const org = entry.org || '';
    const possibleDir = org ? join(frameworkRoot, 'orgs', org, 'agents', name) : undefined;
    const dir = possibleDir && existsSync(possibleDir) ? possibleDir : undefined;
    const configInfo = dir ? readAgentConfig(dir) : {};
    const envInfo = dir ? readAgentEnv(dir) : {};

    records.set(name, {
      name,
      org,
      dir,
      enabled: entry.enabled !== false && configInfo.config?.enabled !== false,
      fromEnabledFile: true,
      config: configInfo.config,
      configPath: configInfo.path,
      configError: configInfo.error,
      envPath: envInfo.path,
      env: envInfo.env,
    });
  }

  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readEnabledAgents(ctxRoot: string): Record<string, EnabledAgentEntry> {
  const path = join(ctxRoot, 'config', 'enabled-agents.json');
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, EnabledAgentEntry>;
  } catch {
    return {};
  }
}

function readAgentConfig(agentDir: string): { path?: string; config?: AgentConfig; error?: string } {
  const path = join(agentDir, 'config.json');
  if (!existsSync(path)) {
    return { path, config: {} };
  }

  try {
    return { path, config: JSON.parse(readFileSync(path, 'utf-8')) as AgentConfig };
  } catch (err) {
    return { path, config: {}, error: `Could not parse ${path}: ${errorMessage(err)}` };
  }
}

function readAgentEnv(agentDir: string): { path?: string; env?: Record<string, string> } {
  const path = join(agentDir, '.env');
  if (!existsSync(path)) return {};

  try {
    return { path, env: parseEnvFile(path) };
  } catch {
    return { path, env: {} };
  }
}

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = stripBom(readFileSync(path, 'utf-8')).split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }

  return vars;
}

function readHeartbeat(ctxRoot: string, agentName: string): { timestampMs: number | null; label: string } {
  const hbPath = join(ctxRoot, 'state', agentName, 'heartbeat.json');
  if (!existsSync(hbPath)) return { timestampMs: null, label: 'missing' };

  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    const ts = typeof hb.last_heartbeat === 'string'
      ? hb.last_heartbeat
      : typeof hb.timestamp === 'string'
        ? hb.timestamp
        : '';
    const timestampMs = new Date(ts).getTime();
    if (!ts || !Number.isFinite(timestampMs)) {
      return { timestampMs: null, label: 'invalid timestamp' };
    }
    return { timestampMs, label: formatUtc(timestampMs) };
  } catch (err) {
    return { timestampMs: null, label: `unreadable heartbeat (${errorMessage(err)})` };
  }
}

function readMtime(path: string): { mtimeMs: number | null; label: string } {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, label: formatUtc(st.mtimeMs) };
  } catch {
    return { mtimeMs: null, label: 'missing' };
  }
}

function safeReadDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

function normalizePath(path: string, baseDir?: string): string {
  const absolute = isAbsolute(path) ? path : resolve(baseDir ?? process.cwd(), path);
  try {
    return realpathSync(absolute);
  } catch {
    return resolve(absolute);
  }
}

function newestMtime(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          const mtimeMs = statSync(fullPath).mtimeMs;
          newest = newest === null ? mtimeMs : Math.max(newest, mtimeMs);
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  return newest;
}

function readJsonlTail(path: string, limit: number): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(-limit);
    const entries: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') entries.push(parsed as Record<string, unknown>);
      } catch {
        // Ignore malformed lines.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function findLatestAnalyticsEventMs(ctxRoot: string): number | null {
  const roots = [join(ctxRoot, 'analytics', 'events')];
  const orgsRoot = join(ctxRoot, 'orgs');
  for (const org of safeReadDirs(orgsRoot)) {
    roots.push(join(orgsRoot, org, 'analytics', 'events'));
  }

  let latest: number | null = null;
  for (const root of roots) {
    for (const file of walkFiles(root, file => file.endsWith('.jsonl'))) {
      const fromLine = latestJsonlTimestamp(file);
      const timestampMs = fromLine ?? readMtime(file).mtimeMs;
      if (timestampMs !== null) latest = Math.max(latest ?? timestampMs, timestampMs);
    }
  }

  return latest;
}

function walkFiles(root: string, predicate?: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (!predicate || predicate(fullPath))) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function latestJsonlTimestamp(path: string): number | null {
  const entries = readJsonlTail(path, 20);
  for (let i = entries.length - 1; i >= 0; i--) {
    const ts = entries[i].timestamp;
    if (typeof ts !== 'string') continue;
    const ms = new Date(ts).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function isNegativeChatId(chatId: string | undefined): boolean {
  if (!chatId) return false;
  return /^-\d+$/.test(chatId.trim());
}

function redactChatId(chatId: string): string {
  const trimmed = chatId.trim();
  if (trimmed.length <= 5) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function summarize(checks: DoctorCheck[]): Record<CheckStatus, number> {
  return {
    OK: checks.filter(c => c.status === 'OK').length,
    WARN: checks.filter(c => c.status === 'WARN').length,
    FAIL: checks.filter(c => c.status === 'FAIL').length,
  };
}

function printHumanReport(report: DoctorReport): void {
  const color = makeColor(process.stdout.isTTY);
  const byGroup = new Map<string, DoctorCheck[]>();
  for (const check of report.checks) {
    if (!byGroup.has(check.group)) byGroup.set(check.group, []);
    byGroup.get(check.group)!.push(check);
  }

  console.log('\ncortextOS Doctor\n');
  console.log(`  Instance:  ${report.instance}`);
  console.log(`  Framework: ${report.frameworkRoot}`);
  console.log(`  State:     ${report.ctxRoot}`);
  console.log(`  UTC:       ${report.generatedAt}\n`);

  for (const [group, checks] of byGroup) {
    console.log(`${group}`);
    for (const check of checks) {
      const status = color.status(check.status, `[${check.status}]`);
      console.log(`  ${status.padEnd(process.stdout.isTTY ? 19 : 8)} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`           Fix: ${check.fix}`);
      }
    }
    console.log('');
  }

  const summaryText = `${report.summary.OK} OK, ${report.summary.WARN} WARN, ${report.summary.FAIL} FAIL`;
  const rendered = report.summary.FAIL > 0
    ? color.red(summaryText)
    : report.summary.WARN > 0
      ? color.yellow(summaryText)
      : color.green(summaryText);
  console.log(`Summary: ${rendered}\n`);
}

function makeColor(enabled: boolean): {
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  status: (status: CheckStatus, s: string) => string;
} {
  const wrap = (code: number, s: string) => enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  const green = (s: string) => wrap(32, s);
  const yellow = (s: string) => wrap(33, s);
  const red = (s: string) => wrap(31, s);
  return {
    red,
    yellow,
    green,
    status(status, s) {
      if (status === 'OK') return green(s);
      if (status === 'WARN') return yellow(s);
      return red(s);
    },
  };
}

function formatUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.max(0, ms);
  if (abs < 1000) return '0s';
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
