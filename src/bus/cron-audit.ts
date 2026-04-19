/**
 * cron-audit.ts — Audit and auto-optimize agent cron prompts
 *
 * Detects inline cron prompts that exceed a character threshold and should
 * be extracted to skill files. Can generate skill files and slim prompts
 * automatically with --fix.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

export interface CronAuditEntry {
  agent: string;
  cronName: string;
  cronType: string;
  interval: string;
  promptLength: number;
  hasSkillFile: boolean;
  skillPath: string;
  fixed: boolean;
  charsSaved: number;
}

export interface CronAuditReport {
  org: string;
  threshold: number;
  mode: 'report' | 'fix';
  agentsScanned: number;
  flagged: CronAuditEntry[];
  totalFixed: number;
  totalCharsSaved: number;
}

export function cronAudit(
  frameworkRoot: string,
  org: string,
  options: { fix?: boolean; threshold?: number } = {}
): CronAuditReport {
  const threshold = options.threshold ?? 100;
  const fix = options.fix ?? false;
  const agentsDir = join(frameworkRoot, 'orgs', org, 'agents');

  if (!existsSync(agentsDir)) {
    throw new Error(`Agents directory not found: ${agentsDir}`);
  }

  const report: CronAuditReport = {
    org,
    threshold,
    mode: fix ? 'fix' : 'report',
    agentsScanned: 0,
    flagged: [],
    totalFixed: 0,
    totalCharsSaved: 0,
  };

  const agents = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const agentName of agents) {
    const agentDir = join(agentsDir, agentName);
    const configPath = join(agentDir, 'config.json');

    if (!existsSync(configPath)) continue;
    report.agentsScanned++;

    let config: { crons?: Array<{ name: string; type?: string; interval?: string; cron?: string; prompt: string }> };
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }

    if (!config.crons || !Array.isArray(config.crons)) continue;

    let configChanged = false;

    for (let i = 0; i < config.crons.length; i++) {
      const cron = config.crons[i];
      const prompt = cron.prompt || '';

      // Skip if already a skill pointer
      if (/^\s*Read.*\.claude\/skills\/.*\/SKILL\.md/.test(prompt)) continue;

      // Skip if under threshold
      if (prompt.length <= threshold) continue;

      const skillName = cron.name.replace(/_/g, '-');
      const skillDir = join(agentDir, '.claude', 'skills', skillName);
      const skillFile = join(skillDir, 'SKILL.md');
      const hasSkillFile = existsSync(skillFile);

      const entry: CronAuditEntry = {
        agent: agentName,
        cronName: cron.name,
        cronType: cron.type || 'recurring',
        interval: cron.interval || cron.cron || '?',
        promptLength: prompt.length,
        hasSkillFile,
        skillPath: `.claude/skills/${skillName}/SKILL.md`,
        fixed: false,
        charsSaved: 0,
      };

      if (fix) {
        // Create skill file if missing
        if (!hasSkillFile) {
          mkdirSync(skillDir, { recursive: true });
          const title = cron.name
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
          const content = [
            `# ${title} Skill`,
            '',
            'Auto-generated from inline cron prompt by cron-audit.',
            'Review and refine this skill file, then verify the cron works correctly.',
            '',
            '## Workflow',
            '',
            prompt,
            '',
          ].join('\n');
          writeFileSync(skillFile, content);
        }

        // Slim the prompt
        const newPrompt = `Read and follow .claude/skills/${skillName}/SKILL.md`;
        entry.charsSaved = prompt.length - newPrompt.length;
        config.crons[i].prompt = newPrompt;
        entry.fixed = true;
        configChanged = true;

        report.totalFixed++;
        report.totalCharsSaved += entry.charsSaved;
      }

      report.flagged.push(entry);
    }

    if (configChanged) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    }
  }

  return report;
}
