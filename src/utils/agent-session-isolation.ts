import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, resolve, sep } from 'path';
import type { AgentConfig } from '../types/index.js';

export interface EnabledAgentRecord {
  enabled?: boolean;
  org?: string;
}

export interface AgentLocation {
  agentDir: string;
  org?: string;
}

export interface WorkingDirectoryValidationOk {
  ok: true;
  effectiveLaunchDir: string;
}

export interface WorkingDirectoryValidationError {
  ok: false;
  error: string;
}

export type WorkingDirectoryValidationResult =
  | WorkingDirectoryValidationOk
  | WorkingDirectoryValidationError;

const SESSION_ID_NAMESPACE = 'cortextos-agent-session';

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function getDeterministicAgentSessionId(agentName: string, org?: string): string {
  const digest = createHash('sha1')
    .update(SESSION_ID_NAMESPACE)
    .update('\0')
    .update(`${org ?? ''}:${agentName}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  // RFC 4122 version 5 UUID bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

export function normalizeConfiguredWorkingDirectory(agentDir: string, configured?: string): string {
  const trimmed = configured?.trim() ?? '';
  if (!trimmed) return resolve(agentDir);
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(agentDir, trimmed);
}

export function escapeClaudeProjectPath(launchDir: string): string {
  return launchDir.split(sep).join('-');
}

export function getClaudeProjectsRoot(homeDir = homedir()): string {
  return join(homeDir, '.claude', 'projects');
}

export function getClaudeProjectDirForLaunchDir(launchDir: string, homeDir = homedir()): string {
  return join(getClaudeProjectsRoot(homeDir), escapeClaudeProjectPath(launchDir));
}

export function findClaudeSessionFile(sessionId: string, homeDir = homedir()): string | null {
  const projectsRoot = getClaudeProjectsRoot(homeDir);
  if (!existsSync(projectsRoot)) return null;
  try {
    const entries = readdirSync(projectsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export function readAgentConfigSafe(agentDir: string): AgentConfig {
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;
  } catch {
    return {};
  }
}

export function findAgentDirAndOrg(projectRoot: string, agentName: string, preferredOrg?: string): AgentLocation | null {
  if (preferredOrg) {
    const preferred = join(projectRoot, 'orgs', preferredOrg, 'agents', agentName);
    if (existsSync(preferred)) return { agentDir: preferred, org: preferredOrg };
  }

  const orgsDir = join(projectRoot, 'orgs');
  if (existsSync(orgsDir)) {
    try {
      const orgEntries = readdirSync(orgsDir, { withFileTypes: true });
      for (const entry of orgEntries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(orgsDir, entry.name, 'agents', agentName);
        if (existsSync(candidate)) return { agentDir: candidate, org: entry.name };
      }
    } catch {
      // fall through to legacy flat-agents path
    }
  }

  const legacy = join(projectRoot, 'agents', agentName);
  if (existsSync(legacy)) return { agentDir: legacy };
  return null;
}

interface ValidateWorkingDirectoryPolicyInput {
  agentName: string;
  agentDir: string;
  config: AgentConfig;
  projectRoot: string;
  enabledAgents: Record<string, EnabledAgentRecord>;
  allowExternalCwd?: boolean;
}

export function validateClaudeWorkingDirectoryPolicy(
  input: ValidateWorkingDirectoryPolicyInput,
): WorkingDirectoryValidationResult {
  const runtime = input.config.runtime ?? 'claude-code';
  const effectiveLaunchDir = normalizeConfiguredWorkingDirectory(input.agentDir, input.config.working_directory);
  const normalizedAgentDir = resolve(input.agentDir);
  const configuredWorkingDirectory = input.config.working_directory?.trim() ?? '';

  if (runtime !== 'claude-code') {
    return { ok: true, effectiveLaunchDir };
  }

  if (configuredWorkingDirectory && effectiveLaunchDir !== normalizedAgentDir && !input.allowExternalCwd) {
    return {
      ok: false,
      error: `Agent "${input.agentName}" working_directory "${effectiveLaunchDir}" is outside its agent dir "${normalizedAgentDir}". Re-run with --allow-external-cwd if this is intentional.`,
    };
  }

  for (const [otherAgentName, otherEntry] of Object.entries(input.enabledAgents)) {
    if (otherAgentName === input.agentName) continue;
    if (otherEntry.enabled === false) continue;

    const otherLocation = findAgentDirAndOrg(input.projectRoot, otherAgentName, otherEntry.org);
    if (!otherLocation) continue;
    const otherConfig = readAgentConfigSafe(otherLocation.agentDir);
    if ((otherConfig.runtime ?? 'claude-code') !== 'claude-code') continue;

    const otherLaunchDir = normalizeConfiguredWorkingDirectory(
      otherLocation.agentDir,
      otherConfig.working_directory,
    );

    if (otherLaunchDir === effectiveLaunchDir) {
      const locationLabel = otherEntry.org ? `${otherAgentName} (${otherEntry.org})` : otherAgentName;
      return {
        ok: false,
        error: `working_directory "${effectiveLaunchDir}" is already used by enabled Claude agent "${locationLabel}". Shared Claude working directories are forbidden because they can share resume state.`,
      };
    }
  }

  return { ok: true, effectiveLaunchDir };
}

export function archiveClaudeProjectDirForLaunchDir(
  launchDir: string,
  homeDir = homedir(),
  now = new Date(),
): string | null {
  const projectDir = getClaudeProjectDirForLaunchDir(launchDir, homeDir);
  if (!existsSync(projectDir)) return null;

  const archiveRoot = join(homeDir, '.claude', 'projects-archived');
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archived = join(archiveRoot, `${basename(projectDir)}.disabled-${stamp}`);
  renameSync(projectDir, archived);
  return archived;
}
