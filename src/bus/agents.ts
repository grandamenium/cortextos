import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentInfo, AgentConfig, BusPaths, Task } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { sendMessage } from './message.js';
import { fetchRemoteHeartbeats } from './heartbeat.js';

/**
 * List all agents in the system.
 *
 * Merges three sources of truth:
 *   1. The framework directory scan (`${CTX_FRAMEWORK_ROOT}/orgs/<org>/agents/`)
 *      — this is what the daemon discovers and runs.
 *   2. `enabled-agents.json` — explicit user-set enable/disable state from
 *      `cortextos enable`/`disable` and the dashboard.
 *   3. `orch_agent_heartbeats` Supabase table — heartbeats pushed by remote agents
 *      on other VMs (instance_id != local CTX_INSTANCE_ID). Remote agents that share
 *      a name with a local agent are deduplicated (local takes precedence).
 *
 * BUG-028: previously this function treated `enabled-agents.json` as
 * authoritative — if the file existed, the directory scan was skipped, causing
 * `cortextos list-agents` to miss agents that the daemon was actually running.
 * Now both sources are always merged, with the file providing the explicit
 * enabled flag and the directory scan providing the canonical existence check.
 */
export async function listAgents(ctxRoot: string, org?: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];
  const seen = new Set<string>();

  // 1. Read enabled-agents.json for explicit enable/disable state.
  // This is treated as metadata, not as the list of agents to display.
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let enabledAgents: Record<string, { org?: string; enabled?: boolean; status?: string }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // Skip corrupt file — fall through to directory scan only.
    }
  }

  // 2. ALWAYS scan org agent directories (BUG-028 fix).
  // The directory scan is now the primary source for "what agents exist".
  // The enabled-agents.json entries are merged in as metadata.
  const cliProjectRoot = process.env.CTX_FRAMEWORK_ROOT;
  const scanRoots: string[] = [];
  if (cliProjectRoot && existsSync(join(cliProjectRoot, 'orgs'))) {
    scanRoots.push(cliProjectRoot);
  }
  // Fallback: cwd, but ONLY when CTX_FRAMEWORK_ROOT is completely unset.
  // If CTX_FRAMEWORK_ROOT is set (even to a path without orgs/), respect it and
  // do not scan cwd — the caller explicitly configured a root that has no agents.
  // This prevents test contamination when cwd happens to be the framework repo.
  if (scanRoots.length === 0 && !cliProjectRoot) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'orgs'))) {
      scanRoots.push(cwd);
    }
  }

  for (const root of scanRoots) {
    const orgsDir = join(root, 'orgs');
    if (!existsSync(orgsDir)) continue;

    let orgDirs: string[];
    try {
      orgDirs = readdirSync(orgsDir);
    } catch {
      continue;
    }

    for (const orgName of orgDirs) {
      if (org && orgName !== org) continue;

      const agentsDir = join(orgsDir, orgName, 'agents');
      if (!existsSync(agentsDir)) continue;

      let agentDirs: string[];
      try {
        agentDirs = readdirSync(agentsDir);
      } catch {
        continue;
      }

      for (const agentName of agentDirs) {
        if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
        if (seen.has(agentName)) continue;

        seen.add(agentName);

        // Determine enabled state: explicit from enabled-agents.json if present,
        // otherwise default to enabled (matches the daemon's discoverAndStart
        // default-on behavior).
        const explicitEntry = enabledAgents[agentName];
        if (isDeletedRegistryEntry(agentName, explicitEntry)) continue;
        const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;

        agents.push(buildAgentInfo(agentName, orgName, isEnabled, ctxRoot));
      }
    }
  }

  // 3. Append any entries from enabled-agents.json that don't have a corresponding
  // directory on disk (stale registrations — file has them but the dir was deleted
  // or never existed). These are surfaced so users can clean them up.
  for (const [name, cfg] of Object.entries(enabledAgents)) {
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    if (isDeletedRegistryEntry(name, cfg)) continue;
    if (seen.has(name)) continue;
    const agentOrg = cfg.org || '';
    if (org && agentOrg !== org) continue;
    seen.add(name);
    agents.push(buildAgentInfo(name, agentOrg, cfg.enabled !== false, ctxRoot));
  }

  // 4. Append remote agents from Supabase orch_agent_heartbeats.
  // These are agents on other VMs (different CTX_INSTANCE_ID) whose heartbeats
  // have been pushed to the shared table. Local agents take precedence — if a
  // remote row has the same agent_name as a local agent, it is skipped.
  try {
    const remoteRows = await fetchRemoteHeartbeats();
    for (const row of remoteRows) {
      if (seen.has(row.agent_name)) continue; // local agent wins
      if (org && row.org !== org) continue;
      seen.add(row.agent_name);

      const age = Date.now() - new Date(row.last_heartbeat).getTime();
      const running = age < 10 * 60 * 1000;

      agents.push({
        name: row.agent_name,
        org: row.org,
        role: '',
        enabled: true,
        running,
        last_heartbeat: row.last_heartbeat,
        current_task: row.current_task || null,
        mode: row.mode || null,
        remote: true,
        host: row.host,
        instance_id: row.instance_id,
      });
    }
  } catch {
    // Supabase unavailable — return local agents only, no error
  }

  return agents;
}

function isDeletedRegistryEntry(
  name: string,
  cfg?: { status?: string },
): boolean {
  return name === 'deleted_agents' || cfg?.status === 'deleted';
}

/**
 * Build an AgentInfo object by reading heartbeat, IDENTITY.md, and config.
 */
function buildAgentInfo(
  name: string,
  org: string,
  enabled: boolean,
  ctxRoot: string,
): AgentInfo {
  // Read heartbeat from state dir (bash uses state/{agent}/heartbeat.json)
  let lastHeartbeat: string | null = null;
  let currentTask: string | null = null;
  let mode: string | null = null;
  let running = false;

  const stateHeartbeat = join(ctxRoot, 'state', name, 'heartbeat.json');
  if (existsSync(stateHeartbeat)) {
    try {
      const hb = JSON.parse(readFileSync(stateHeartbeat, 'utf-8'));
      lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
      currentTask = hb.current_task || null;
      mode = hb.mode || null;
      // Running = heartbeat written within last 10 minutes
      if (lastHeartbeat) {
        const age = Date.now() - new Date(lastHeartbeat).getTime();
        running = age < 10 * 60 * 1000;
      }
    } catch {
      // Skip corrupt
    }
  }

  currentTask = currentTask || readCurrentTaskFromTaskStore(ctxRoot, org, name);

  // Get display name and role from IDENTITY.md
  let role = '';
  let displayName: string | undefined;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (frameworkRoot) {
    const identityPaths = [
      join(frameworkRoot, 'orgs', org, 'agents', name, 'IDENTITY.md'),
      join(frameworkRoot, 'agents', name, 'IDENTITY.md'),
    ];
    for (const idPath of identityPaths) {
      if (existsSync(idPath)) {
        try {
          const content = readFileSync(idPath, 'utf-8');
          const lines = content.split('\n');

          // Parse "## Name" — user-configured display name (e.g. "Alpha", "Beta")
          const nameIdx = lines.findIndex(l => l.trim() === '## Name');
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith('<!--')) continue;
              if (line.startsWith('##')) break;
              displayName = line;
              break;
            }
          }

          // Find "## Role" then take the first non-empty, non-comment line after it
          const roleIdx = lines.findIndex(l => l.startsWith('## Role'));
          if (roleIdx >= 0) {
            for (let i = roleIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              // Skip empty lines and HTML comment placeholders
              if (!line || line.startsWith('<!--') || line.startsWith('##')) break;
              role = line;
              break;
            }
          }
          // Fallback: first non-comment, non-heading line
          if (!role) {
            for (const line of lines) {
              const t = line.trim();
              if (t && !t.startsWith('#') && !t.startsWith('<!--')) {
                role = t;
                break;
              }
            }
          }
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  // Read config.json for model info
  const configFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (configFrameworkRoot) {
    const configPaths = [
      join(configFrameworkRoot, 'orgs', org, 'agents', name, 'config.json'),
      join(configFrameworkRoot, 'agents', name, 'config.json'),
    ];
    for (const cfgPath of configPaths) {
      if (existsSync(cfgPath)) {
        try {
          const cfg: AgentConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.enabled !== undefined) enabled = cfg.enabled;
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  return {
    name,
    org,
    display_name: displayName,
    role,
    enabled,
    running,
    last_heartbeat: lastHeartbeat,
    current_task: currentTask,
    mode,
  };
}

function readCurrentTaskFromTaskStore(ctxRoot: string, org: string, agentName: string): string | null {
  const taskDirs = [
    org ? join(ctxRoot, 'orgs', org, 'tasks') : '',
    join(ctxRoot, 'tasks'),
  ].filter(Boolean);
  const tasks: Task[] = [];

  for (const taskDir of taskDirs) {
    if (!existsSync(taskDir)) continue;
    let files: string[];
    try {
      files = readdirSync(taskDir).filter(file => file.startsWith('task_') && file.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(taskDir, file), 'utf-8')) as Task;
        if (task.archived) continue;
        if (task.status !== 'in_progress') continue;
        if (task.assigned_to !== agentName) continue;
        tasks.push(task);
      } catch {
        // Skip corrupt task files.
      }
    }
  }

  tasks.sort((a, b) => {
    const bTime = new Date(b.updated_at || b.created_at).getTime();
    const aTime = new Date(a.updated_at || a.created_at).getTime();
    return bTime - aTime;
  });

  const task = tasks[0];
  return task ? `${task.id}: ${task.title}` : null;
}

/**
 * Send an urgent notification to an agent.
 * Writes .urgent-signal file and sends a bus message.
 * Mirrors bash notify-agent.sh behavior.
 */
export function notifyAgent(
  paths: BusPaths,
  from: string,
  targetAgent: string,
  message: string,
  ctxRoot: string,
): void {
  // Write signal file to state dir
  const signalDir = join(ctxRoot, 'state', targetAgent);
  ensureDir(signalDir);

  const signal = {
    from,
    message,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  atomicWriteSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

  // Also send via normal message bus for persistence
  try {
    sendMessage(paths, from, targetAgent, 'urgent', message);
  } catch {
    // Ignore bus send failures - signal file is the primary mechanism
  }
}
