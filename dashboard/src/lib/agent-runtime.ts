import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { CTX_FRAMEWORK_ROOT, getAgentDir, getAllAgents, getOrgs, getAgentsForOrg } from '@/lib/config';

export type AgentRuntime = 'hermes' | 'claude-code';

export type AgentRuntimeInfo = {
  runtime: AgentRuntime;
  home: string;
  workingDir: string;
  org: string;
  hermesGateway?: string;
  hermesDashboard?: string;
};

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeRuntime(value: unknown): AgentRuntime {
  return value === 'hermes' ? 'hermes' : 'claude-code';
}

function findAgent(name: string): { name: string; org: string } {
  const decoded = decodeURIComponent(name);
  const all = getAllAgents();
  const found = all.find((agent) => agent.name.toLowerCase() === decoded.toLowerCase());
  if (found) return found;

  for (const org of getOrgs()) {
    const match = getAgentsForOrg(org).find((agent) => agent.toLowerCase() === decoded.toLowerCase());
    if (match) return { name: match, org };
  }

  return { name: decoded, org: getOrgs()[0] ?? 'default' };
}

export async function getAgentRuntime(name: string): Promise<AgentRuntimeInfo> {
  const agent = findAgent(name);
  const home = getAgentDir(agent.name, agent.org);
  const configPath = path.join(home, 'config.json');

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    config = {};
  }

  const configuredWorkingDir =
    typeof config.working_directory === 'string' ? config.working_directory.trim() : '';
  const workingDir = configuredWorkingDir
    ? path.resolve(expandHome(configuredWorkingDir))
    : home;

  return {
    runtime: normalizeRuntime(config.runtime),
    home,
    workingDir: fsSync.existsSync(workingDir) ? workingDir : home,
    org: agent.org,
    hermesGateway: 'http://127.0.0.1:8642',
    hermesDashboard: 'http://127.0.0.1:9119',
  };
}

export function getHermesHome(): string {
  return expandHome(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
}

export function getCommunitySkillsDir(): string {
  return path.join(CTX_FRAMEWORK_ROOT, 'community');
}
