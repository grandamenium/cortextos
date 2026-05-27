import path from 'path';
import fs from 'fs';
import os from 'os';

// Expand tilde in paths (Node.js doesn't do this automatically)
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Core identity. Some long-running dashboard processes may be started with
// CTX_INSTANCE_ID=default while CTX_ROOT points at a symlinked active instance.
// Resolve CTX_ROOT below and derive the effective instance from that real path
// so API metadata, DB names, and VM file readback all describe the same ledger.
const RAW_CTX_INSTANCE_ID = process.env.CTX_INSTANCE_ID ?? 'default';

// Core path constants - mirror bus/_ctx-env.sh logic
const RAW_CTX_ROOT = expandTilde(
  process.env.CTX_ROOT ??
  path.join(os.homedir(), '.cortextos', RAW_CTX_INSTANCE_ID),
);

export const CTX_ROOT_REAL = fs.existsSync(RAW_CTX_ROOT)
  ? fs.realpathSync(RAW_CTX_ROOT)
  : RAW_CTX_ROOT;

export const CTX_ROOT = CTX_ROOT_REAL;

export const CTX_INSTANCE_ID = path.basename(CTX_ROOT_REAL) || RAW_CTX_INSTANCE_ID;

export const CTX_FRAMEWORK_ROOT = expandTilde(
  process.env.CTX_FRAMEWORK_ROOT ??
  process.env.CTX_PROJECT_ROOT ??
  path.resolve(process.cwd(), '..'),
);

// Helper functions required by downstream tasks

export function getCTXRoot(): string {
  return CTX_ROOT_REAL;
}

export function getFrameworkRoot(): string {
  return CTX_FRAMEWORK_ROOT;
}

/**
 * Read the brand_name from dashboard-settings.json, if set.
 * Returns undefined when not configured (callers fall back to the default name).
 * Safe to call from server components — reads directly from the filesystem.
 */
export function getBrandName(): string | undefined {
  const configPath = path.join(CTX_ROOT, 'config', 'dashboard-settings.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const name = typeof data.brand_name === 'string' ? data.brand_name.trim() : '';
      return name || undefined;
    }
  } catch { /* ignore read errors */ }
  return undefined;
}

// -- Org-scoped paths --

export function getOrgDir(org: string): string {
  return path.join(CTX_ROOT, 'orgs', org);
}

export function getTaskDir(org?: string): string {
  if (org) {
    return path.join(CTX_ROOT, 'orgs', org, 'tasks');
  }
  return path.join(CTX_ROOT, 'tasks');
}

export function getApprovalDir(org?: string): string {
  if (org) {
    return path.join(CTX_ROOT, 'orgs', org, 'approvals');
  }
  return path.join(CTX_ROOT, 'approvals');
}

export function getAnalyticsDir(org?: string): string {
  if (org) {
    return path.join(CTX_ROOT, 'orgs', org, 'analytics');
  }
  return path.join(CTX_ROOT, 'analytics');
}

export function getEventsDir(org: string, agent: string): string {
  return path.join(CTX_ROOT, 'orgs', org, 'analytics', 'events', agent);
}

export function getGoalsPath(org: string): string {
  // Check framework root first (where the repo/source lives), then state dir
  const frameworkPath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'goals.json');
  if (fs.existsSync(frameworkPath)) return frameworkPath;
  const statePath = path.join(CTX_ROOT, 'orgs', org, 'goals.json');
  if (fs.existsSync(statePath)) return statePath;
  // Default to state dir for writes (will create if needed)
  return statePath;
}

export function getOrgContextPath(org: string): string {
  // Org metadata lives in the framework root (the repo), not the state dir
  return path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'context.json');
}

export function getOrgBrandVoicePath(org: string): string {
  return path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'brand-voice.md');
}

// -- Agent-scoped paths (flat, not org-nested) --

export function getAgentStateDir(agent: string): string {
  return path.join(CTX_ROOT, 'state', agent);
}

export function getHeartbeatPath(agent: string): string {
  return path.join(CTX_ROOT, 'state', agent, 'heartbeat.json');
}

export function getInboxDir(agent: string): string {
  return path.join(CTX_ROOT, 'inbox', agent);
}

export function getLogDir(agent: string): string {
  return path.join(CTX_ROOT, 'logs', agent);
}

// -- Agent dir within org (IDENTITY.md, SOUL.md, MEMORY.md, .env) --

export function getAgentDir(name: string, org?: string): string {
  // Check project root first (where agent markdown files live), then state dir
  if (org) {
    const projectPath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents', name);
    if (fs.existsSync(projectPath)) return projectPath;
    return path.join(CTX_ROOT, 'orgs', org, 'agents', name);
  }
  const projectPath = path.join(CTX_FRAMEWORK_ROOT, 'agents', name);
  if (fs.existsSync(projectPath)) return projectPath;
  return path.join(CTX_ROOT, 'agents', name);
}

// -- Discovery functions --

export function getOrgs(): string[] {
  // Read framework root FIRST — it is the source of truth for org naming.
  // When the same org exists in both dirs with drifted casing (e.g. a ghost
  // `acmecorp/` in state + canonical `AcmeCorp/` in framework),
  // we keep the framework casing and discard the state-dir variant. Without
  // this, dashboard sync hits both names and floods the log with lookup
  // failures against the non-existent lowercase dir.
  const frameworkOrgsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs');
  const stateOrgsDir = path.join(CTX_ROOT, 'orgs');

  // Map lowercase key -> canonical casing. Framework entries win over state
  // entries. Within a single dir, we trust fs.readdirSync uniqueness.
  const byLower = new Map<string, string>();

  if (fs.existsSync(frameworkOrgsDir)) {
    for (const d of fs.readdirSync(frameworkOrgsDir, { withFileTypes: true })) {
      if (d.isDirectory()) byLower.set(d.name.toLowerCase(), d.name);
    }
  }

  if (frameworkOrgsDir !== stateOrgsDir && fs.existsSync(stateOrgsDir)) {
    for (const d of fs.readdirSync(stateOrgsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !byLower.has(d.name.toLowerCase())) {
        byLower.set(d.name.toLowerCase(), d.name);
      }
    }
  }

  return Array.from(byLower.values());
}

export function getAgentsForOrg(org: string): string[] {
  const agents = new Set<string>();

  // Check state dir (CTX_ROOT)
  const stateAgentsDir = path.join(CTX_ROOT, 'orgs', org, 'agents');
  if (fs.existsSync(stateAgentsDir)) {
    for (const d of fs.readdirSync(stateAgentsDir, { withFileTypes: true })) {
      if (d.isDirectory()) agents.add(d.name);
    }
  }

  // Check framework root (where agent identity/config files live)
  const frameworkAgentsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'agents');
  if (fs.existsSync(frameworkAgentsDir)) {
    for (const d of fs.readdirSync(frameworkAgentsDir, { withFileTypes: true })) {
      if (d.isDirectory()) agents.add(d.name);
    }
  }

  return Array.from(agents);
}

interface EnabledAgentRegistryEntry {
  enabled?: boolean;
  org?: string;
  status?: string;
}

function readEnabledAgentRegistry(): Record<string, EnabledAgentRegistryEntry> {
  const enabledFile = path.join(CTX_ROOT, 'config', 'enabled-agents.json');
  if (!fs.existsSync(enabledFile)) return {};

  try {
    return JSON.parse(fs.readFileSync(enabledFile, 'utf-8')) as Record<string, EnabledAgentRegistryEntry>;
  } catch {
    return {};
  }
}

/**
 * Returns all agents by merging enabled-agents.json with filesystem scan.
 * Filesystem scan ensures CLI-created agents are always visible.
 */
export function getAllAgents(): Array<{ name: string; org: string }> {
  const seen = new Set<string>();
  const disabled = new Set<string>();
  const agents: Array<{ name: string; org: string }> = [];

  // 1. Read enabled-agents.json for explicitly registered agents
  const registry = readEnabledAgentRegistry();
  for (const [name, config] of Object.entries(registry)) {
    if (isDeletedRegistryEntry(name, config) || config.enabled === false) {
      disabled.add(name);
    } else {
      agents.push({ name, org: config.org ?? '' });
      seen.add(name);
    }
  }

  for (const name of Object.keys(registry)) {
    if (isDeletedRegistryEntry(name, registry[name]) || registry[name]?.enabled === false) {
      disabled.add(name);
    }
  }

  // 2. Scan org directories to pick up CLI-created agents, but do not resurrect
  // agents that the registry explicitly disabled or retired.
  for (const org of getOrgs()) {
    for (const name of getAgentsForOrg(org)) {
      if (!seen.has(name) && !disabled.has(name)) {
        agents.push({ name, org });
        seen.add(name);
      }
    }
  }

  return agents;
}

function isDeletedRegistryEntry(name: string, config?: EnabledAgentRegistryEntry): boolean {
  return name === 'deleted_agents' || config?.status === 'deleted';
}

export function getAllowedRootsConfigPath(): string {
  return path.join(CTX_ROOT, 'config', 'allowed-roots.json');
}
