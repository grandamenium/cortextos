import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

interface AgentGoals {
  focus?: string;
  goals?: string[];
  bottleneck?: string;
  updated_at?: string;
}

export interface GoalProbeAgentResult {
  agent: string;
  goalCount: number;
  mentioned: boolean;
  matchedTerms: string[];
  latestMemoryFiles: string[];
  bottleneck: string;
}

export interface GoalProgressProbeResult {
  generatedAt: string;
  agentsChecked: number;
  stalledAgents: GoalProbeAgentResult[];
  agents: GoalProbeAgentResult[];
  reportPath?: string;
  memoryPath?: string;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'agent',
  'agents',
  'also',
  'and',
  'any',
  'are',
  'but',
  'for',
  'from',
  'has',
  'have',
  'into',
  'not',
  'now',
  'only',
  'or',
  'per',
  'run',
  'task',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

function todayUtc(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function memoryText(agentDir: string): { text: string; files: string[] } {
  const memoryDir = join(agentDir, 'memory');
  const files = [todayUtc(0), todayUtc(-1)]
    .map(day => join(memoryDir, `${day}.md`))
    .filter(path => existsSync(path));
  return {
    text: files.map(path => readFileSync(path, 'utf-8')).join('\n').toLowerCase(),
    files,
  };
}

function keywords(input: string): string[] {
  return Array.from(new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map(word => word.trim())
      .filter(word => word.length >= 4)
      .filter(word => !STOP_WORDS.has(word)),
  )).slice(0, 12);
}

function goalTerms(goals: AgentGoals): string[] {
  const parts = [goals.focus || '', ...(goals.goals || [])];
  return Array.from(new Set(parts.flatMap(keywords)));
}

function renderReport(result: GoalProgressProbeResult): string {
  const lines = [
    '# Goal Progress Probe',
    '',
    `Generated: ${result.generatedAt}`,
    `Agents checked: ${result.agentsChecked}`,
    `Stalled agents: ${result.stalledAgents.length}`,
    '',
  ];

  if (result.stalledAgents.length > 0) {
    lines.push('## Stalled', '');
    for (const agent of result.stalledAgents) {
      lines.push(`- ${agent.agent}: ${agent.goalCount} goals, no goal keywords found in last 24h memory. Bottleneck: ${agent.bottleneck || 'none'}`);
    }
    lines.push('');
  }

  lines.push('## Agent Results', '');
  lines.push('| Agent | Goals | Mentioned | Matched terms |');
  lines.push('| --- | ---: | --- | --- |');
  for (const agent of result.agents) {
    lines.push(`| ${agent.agent} | ${agent.goalCount} | ${agent.mentioned ? 'yes' : 'no'} | ${agent.matchedTerms.join(', ') || '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function runGoalProgressProbe(
  paths: BusPaths,
  agentName: string,
  org: string,
  projectRoot: string,
  options: { outputDir?: string; orchestratorMemoryDir?: string } = {},
): GoalProgressProbeResult {
  const generatedAt = new Date().toISOString();
  const agentsDir = join(projectRoot, 'orgs', org, 'agents');
  const agents: GoalProbeAgentResult[] = [];

  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
      const agentDir = join(agentsDir, entry.name);
      const goals = readJson<AgentGoals>(join(agentDir, 'goals.json'));
      if (!goals || !(goals.focus || (goals.goals && goals.goals.length > 0))) continue;
      const terms = goalTerms(goals);
      const memory = memoryText(agentDir);
      const matchedTerms = terms.filter(term => memory.text.includes(term));
      agents.push({
        agent: entry.name,
        goalCount: goals.goals?.length || 0,
        mentioned: matchedTerms.length > 0,
        matchedTerms: matchedTerms.slice(0, 8),
        latestMemoryFiles: memory.files,
        bottleneck: goals.bottleneck || '',
      });
    }
  }

  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  const stalledAgents = agents.filter(agent => !agent.mentioned);
  const result: GoalProgressProbeResult = {
    generatedAt,
    agentsChecked: agents.length,
    stalledAgents,
    agents,
  };

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    const reportPath = join(options.outputDir, `${generatedAt.slice(0, 10)}-goal-progress-probe.md`);
    result.reportPath = reportPath;
    writeFileSync(reportPath, renderReport(result), 'utf-8');
  }

  const memoryDir = options.orchestratorMemoryDir || join(projectRoot, 'orgs', org, 'agents', 'orchestrator', 'memory');
  if (existsSync(memoryDir)) {
    const memoryPath = join(memoryDir, `${generatedAt.slice(0, 10)}.md`);
    result.memoryPath = memoryPath;
    appendFileSync(memoryPath, `\n## Goal Progress Probe - ${generatedAt.slice(11, 19)} UTC\n- Agents checked: ${agents.length}\n- Stalled agents: ${stalledAgents.map(a => a.agent).join(', ') || 'none'}\n- Report: ${result.reportPath || 'not written'}\n`, 'utf-8');
  }

  logEvent(paths, agentName, org, 'action', 'goal_progress_probe_completed', 'info', {
    agents_checked: agents.length,
    stalled_agents: stalledAgents.map(a => a.agent),
    report_path: result.reportPath || null,
  });

  return result;
}
