// cortextOS Dashboard - Agent discovery and data reading module
// Discovers agents, reads identity/config files, returns typed agent data

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import {
  CTX_ROOT,
  getAgentDir,
  getHeartbeatPath,
  getAgentStateDir,
  getAllAgents,
} from '@/lib/config';
import { getHeartbeat, getHealthStatus } from '@/lib/data/heartbeats';
import { getTasksByAgent } from '@/lib/data/tasks';
import { parseIdentityMd } from '@/lib/markdown-parser';
import type {
  AgentSummary,
  AgentDetail,
  AgentIdentity,
  AgentPaths,
  AgentRuntime,
  HealthStatus,
  Heartbeat,
  MemoryFile,
  LogFile,
} from '@/lib/types';

/**
 * Read agent config.json and extract runtime ("claude-code" | "codex-app-server"
 * | "hermes"). Defaults to "claude-code" for legacy agents that pre-date the
 * runtime field, matching what the daemon does on agent boot.
 */
async function getAgentRuntime(name: string, org?: string): Promise<AgentRuntime> {
  const agentDir = getAgentDir(name, org);
  try {
    const raw = await fs.readFile(path.join(agentDir, 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { runtime?: string };
    if (cfg.runtime === 'codex-app-server' || cfg.runtime === 'hermes' || cfg.runtime === 'claude-code') {
      return cfg.runtime;
    }
  } catch {
    // missing/malformed config — fall through to default
  }
  return 'claude-code';
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all filesystem paths for an agent.
 */
export function getAgentPaths(name: string, org?: string): AgentPaths {
  const agentDir = getAgentDir(name, org);
  const claudeDir = path.join(agentDir, '.claude');
  return {
    agentDir,
    claudeDir,
    identityMd: path.join(agentDir, 'IDENTITY.md'),
    soulMd: path.join(agentDir, 'SOUL.md'),
    goalsMd: path.join(agentDir, 'GOALS.md'),
    memoryMd: path.join(agentDir, 'MEMORY.md'),
    memoryDir: path.join(agentDir, 'memory'),
    heartbeat: getHeartbeatPath(name),
    logsDir: path.join(CTX_ROOT, 'logs', name),
  };
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/**
 * Read and parse an agent's IDENTITY.md. Returns defaults if missing.
 */
export async function getAgentIdentity(
  name: string,
  org?: string,
): Promise<AgentIdentity> {
  const paths = getAgentPaths(name, org);
  const raw = await readFileOrEmpty(paths.identityMd);

  if (!raw) {
    return {
      name,
      role: '',
      emoji: '',
      vibe: '',
      workStyle: '',
      raw: '',
    };
  }

  const { fields } = parseIdentityMd(raw);
  return {
    name: fields.name || name,
    role: fields.role,
    emoji: fields.emoji,
    vibe: fields.vibe,
    workStyle: fields.workStyle,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

/**
 * Discover all agents, enriched with heartbeat data.
 * If org is provided, filters to that org only.
 */
export async function discoverAgents(org?: string): Promise<AgentSummary[]> {
  const allAgents = getAllAgents();
  const agents = org ? allAgents.filter((a) => a.org === org) : allAgents;

  const summaries = await Promise.all(
    agents.map(async (agent) => {
      const [identity, hb, runtime] = await Promise.all([
        getAgentIdentity(agent.name, agent.org),
        getHeartbeat(agent.name),
        getAgentRuntime(agent.name, agent.org),
      ]);

      let health: HealthStatus = 'down';
      if (hb) {
        health = getHealthStatus(hb);
      }

      // Get tasks for today count and current task
      let currentTask: string | undefined;
      let tasksToday = 0;
      try {
        const agentTasks = getTasksByAgent(agent.name, agent.org);
        const inProgress = agentTasks.find((t) => t.status === 'in_progress');
        currentTask = inProgress?.title ?? hb?.current_task ?? undefined;

        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const todayISO = todayStart.toISOString();
        tasksToday = agentTasks.filter(
          (t) => t.completed_at && t.completed_at >= todayISO,
        ).length;
      } catch {
        // Tasks DB may not be available
        currentTask = hb?.current_task ?? undefined;
      }

      const summary: AgentSummary & {
        systemName: string;
        emoji: string;
        role: string;
        tasksToday: number;
      } = {
        systemName: agent.name,
        name: identity.name,
        org: agent.org,
        health,
        lastHeartbeat: hb?.last_heartbeat,
        currentTask,
        emoji: identity.emoji,
        role: identity.role,
        tasksToday,
        runtime,
      };

      return summary;
    }),
  );

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

/**
 * Get comprehensive data for the agent detail page.
 */
export async function getAgentDetail(
  name: string,
  org?: string,
): Promise<AgentDetail> {
  const paths = getAgentPaths(name, org);

  const [identity, soulRaw, goalsRaw, memoryRaw, hb, memoryFiles, logFiles, runtime] =
    await Promise.all([
      getAgentIdentity(name, org),
      readFileOrEmpty(paths.soulMd),
      readFileOrEmpty(paths.goalsMd),
      readFileOrEmpty(paths.memoryMd),
      getHeartbeat(name),
      getAgentMemoryFiles(name, org),
      getAgentLogFiles(name, org),
      getAgentRuntime(name, org),
    ]);

  let health: HealthStatus = 'down';
  if (hb) {
    health = getHealthStatus(hb);
  }

  return {
    name: identity.name,
    org: org ?? '',
    identity,
    soulRaw,
    goalsRaw,
    memoryRaw,
    memoryFiles,
    heartbeat: hb,
    health,
    logFiles,
    agentDir: paths.agentDir,
    runtime,
  };
}

// ---------------------------------------------------------------------------
// Memory file listing
// ---------------------------------------------------------------------------

/**
 * List daily memory files from agent's memory directory, sorted newest first.
 */
export async function getAgentMemoryFiles(
  name: string,
  org?: string,
): Promise<MemoryFile[]> {
  const paths = getAgentPaths(name, org);
  const memDir = paths.memoryDir;

  try {
    const entries = await fs.readdir(memDir, { withFileTypes: true });
    // Only include daily memory files matching YYYY-MM-DD.md pattern
    const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
    const mdFiles = entries.filter(
      (e) => e.isFile() && datePattern.test(e.name),
    );

    const files: MemoryFile[] = await Promise.all(
      mdFiles.map(async (entry) => {
        const fullPath = path.join(memDir, entry.name);
        const stat = await fs.stat(fullPath);
        // Extract date from filename (e.g., 2025-01-15.md)
        const date = entry.name.replace(/\.md$/, '');
        return {
          date,
          path: fullPath,
          size: stat.size,
        };
      }),
    );

    // Sort newest first
    return files.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Log file listing
// ---------------------------------------------------------------------------

const LOG_TYPES: Record<string, string> = {
  'activity.log': 'activity',
  'stdout.log': 'stdout',
  'stderr.log': 'stderr',
  'crash.log': 'crash',
  'fast-checker.log': 'fast-checker',
};

/**
 * List available log files for an agent.
 */
export async function getAgentLogFiles(
  name: string,
  org?: string,
): Promise<LogFile[]> {
  const paths = getAgentPaths(name, org);
  const logsDir = paths.logsDir;

  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    const logEntries = entries.filter((e) => e.isFile());

    const allFiles: LogFile[] = await Promise.all(
      logEntries.map(async (entry) => {
        const fullPath = path.join(logsDir, entry.name);
        const stat = await fs.stat(fullPath);
        const type = LOG_TYPES[entry.name] ?? entry.name.replace(/\.log$/, '');
        return {
          type,
          path: fullPath,
          lastModified: stat.mtime.toISOString(),
          size: stat.size,
        };
      }),
    );

    // Filter out empty log files (size 0) and hidden files starting with .
    const files = allFiles.filter((f) => (f as LogFile & { size: number }).size > 0);

    return files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}
