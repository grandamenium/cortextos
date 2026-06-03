import path from 'path';
import fs from 'fs';
import {
  getCtxRoot,
  getInstanceId,
  getOrgDir as resolveOrgDir,
  getKnowledgeBaseDir as resolveKnowledgeBaseDir,
} from './paths';

// Core identity
// Resolve the instance id, but NEVER hard-crash the dashboard at module load on
// a malformed CTX_INSTANCE_ID. The resolver validates the id (lowercase /
// digits / _ / - only); the old config.ts tolerated invalid ids silently, so on
// a validation failure we warn and fall back to 'default' rather than throwing
// during import and taking the whole Next.js server down on boot.
const CTX_INSTANCE_ID = (() => {
  const raw = getInstanceId();
  try {
    getCtxRoot(raw); // throws if `raw` is not a valid instance id
    return raw;
  } catch {
    console.warn(
      `[config] Invalid CTX_INSTANCE_ID '${raw}' — falling back to 'default'. ` +
        `Instance ids must match /^[a-z0-9_-]+$/.`,
    );
    return 'default';
  }
})();

// Core path constants — resolved through the shared dashboard path resolver
// (dashboard/src/lib/paths.ts) so the dashboard and the daemon agree on the
// data root (#38 #40). CTX_ROOT, when set, IS the full per-instance root.
//
// Neither CTX_ROOT nor CTX_FRAMEWORK_ROOT is tilde-expanded: the daemon reads
// CTX_ROOT verbatim (src/utils/paths.ts) and resolves CTX_FRAMEWORK_ROOT with
// path.resolve (src/utils/env.ts) — both treat a leading "~" literally. The
// dashboard MUST match, so a relocated root resolves to the SAME physical tree
// in both processes. Always set these to absolute paths.
export const CTX_ROOT = getCtxRoot(CTX_INSTANCE_ID);

export const CTX_FRAMEWORK_ROOT =
  process.env.CTX_FRAMEWORK_ROOT ??
  process.env.CTX_PROJECT_ROOT ??
  path.resolve(process.cwd(), '..');

// Helper functions required by downstream tasks

export function getCTXRoot(): string {
  return CTX_ROOT;
}

export function getFrameworkRoot(): string {
  return CTX_FRAMEWORK_ROOT;
}

/**
 * The instance id resolved at module-load time (CTX_INSTANCE_ID env, defaulting
 * to 'default'). Captured once at import, consistent with CTX_ROOT /
 * CTX_FRAMEWORK_ROOT above — env is fixed for the lifetime of a Next.js server
 * process, so a snapshot is the intended invariant here.
 */
export function getCTXInstanceId(): string {
  return CTX_INSTANCE_ID;
}

// -- Org-scoped paths --

export function getOrgDir(org: string): string {
  return resolveOrgDir(org, CTX_INSTANCE_ID, CTX_ROOT);
}

/**
 * Knowledge-base data dir for an org (#38): `$CTX_ROOT/orgs/<org>/knowledge-base`.
 * Honours CTX_ROOT so the dashboard reads the SAME tree the bus-side KB writer
 * (src/bus/knowledge-base.ts) ingests into. The previous dashboard routes
 * rebuilt this path from `~/.cortextos/<instanceId>` via path.basename(ctxRoot),
 * which broke whenever CTX_ROOT was relocated (e.g. ~/agentic/cortextos-data).
 */
export function getKnowledgeBaseDir(org: string): string {
  return resolveKnowledgeBaseDir(org, CTX_INSTANCE_ID, CTX_ROOT);
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

/**
 * Returns all agents by merging enabled-agents.json with filesystem scan.
 * Filesystem scan ensures CLI-created agents are always visible.
 */
export function getAllAgents(): Array<{ name: string; org: string }> {
  const seen = new Set<string>();
  const agents: Array<{ name: string; org: string }> = [];

  // 1. Read enabled-agents.json for explicitly registered agents
  const enabledFile = path.join(CTX_ROOT, 'config', 'enabled-agents.json');
  if (fs.existsSync(enabledFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(enabledFile, 'utf-8'));
      for (const [name, config] of Object.entries(data)) {
        const cfg = config as { enabled?: boolean; org?: string };
        if (cfg.enabled !== false) {
          agents.push({ name, org: cfg.org ?? '' });
          seen.add(name);
        }
      }
    } catch {
      // Skip corrupt file
    }
  }

  // 2. Always scan org directories to pick up CLI-created agents
  for (const org of getOrgs()) {
    for (const name of getAgentsForOrg(org)) {
      if (!seen.has(name)) {
        agents.push({ name, org });
        seen.add(name);
      }
    }
  }

  return agents;
}

export function getAllowedRootsConfigPath(): string {
  return path.join(CTX_ROOT, 'config', 'allowed-roots.json');
}
