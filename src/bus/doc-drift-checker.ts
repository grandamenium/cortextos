import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { createTask } from './task.js';
import { logEvent } from './event.js';

interface DriftFinding {
  scope: string;
  file: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface DocDriftReport {
  generatedAt: string;
  thresholdLines: number;
  findings: DriftFinding[];
  driftLines: number;
  taskCreated: boolean;
  taskId?: string;
  reportPath?: string;
}

const IGNORED_TOP_LEVEL = new Set([
  '.git',
  '.github',
  '.claude',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'output',
]);

const IMPORTANT_TOP_LEVEL = new Set([
  'bus',
  'community',
  'dashboard',
  'docs',
  'orgs',
  'scripts',
  'src',
  'templates',
  'tests',
]);

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/\n## /);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

function documentedCodePaths(text: string): Set<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const raw = match[1].trim().replace(/\/$/, '');
    if (/^[A-Za-z0-9._/-]+$/.test(raw)) paths.add(raw.split('/')[0]);
  }
  return paths;
}

function actualImportantDirs(projectRoot: string): string[] {
  return readdirSync(projectRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !IGNORED_TOP_LEVEL.has(name))
    .filter(name => IMPORTANT_TOP_LEVEL.has(name))
    .sort();
}

function listSkillNames(agentDir: string): string[] {
  const names = new Set<string>();
  for (const rel of ['.claude/skills', 'skills']) {
    const dir = join(agentDir, rel);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }
  return Array.from(names).sort();
}

function listCronNames(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { crons?: Array<{ name?: string }> };
    return (cfg.crons || []).map(cron => cron.name).filter((name): name is string => Boolean(name)).sort();
  } catch {
    return [];
  }
}

function existingTaskWithTitle(paths: BusPaths, title: string): boolean {
  if (!existsSync(paths.taskDir)) return false;
  for (const file of readdirSync(paths.taskDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const task = JSON.parse(readFileSync(join(paths.taskDir, file), 'utf-8')) as { title?: string; status?: string };
      if (task.title === title && task.status && !['completed', 'cancelled'].includes(task.status)) return true;
    } catch {
      // Ignore corrupt local task files.
    }
  }
  return false;
}

function renderReport(report: DocDriftReport): string {
  const lines = [
    '# Doc Drift Checker',
    '',
    `Generated: ${report.generatedAt}`,
    `Threshold: ${report.thresholdLines} drift lines`,
    `Drift lines: ${report.driftLines}`,
    `Task created: ${report.taskCreated ? 'yes' : 'no'}`,
    report.taskId ? `Task: ${report.taskId}` : '',
    '',
  ].filter(Boolean);

  if (report.findings.length === 0) {
    lines.push('No doc drift detected.', '');
    return lines.join('\n');
  }

  lines.push('## Findings', '');
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.scope}: ${finding.message} (${finding.file})`);
  }
  lines.push('');
  return lines.join('\n');
}

export function runDocDriftChecker(
  paths: BusPaths,
  agentName: string,
  org: string,
  projectRoot: string,
  options: { thresholdLines?: number; outputDir?: string; createTasks?: boolean } = {},
): DocDriftReport {
  const generatedAt = new Date().toISOString();
  const thresholdLines = options.thresholdLines ?? 5;
  const findings: DriftFinding[] = [];

  const rootClaudePath = join(projectRoot, 'CLAUDE.md');
  const structure = section(readText(rootClaudePath), 'Project Structure');
  const documented = documentedCodePaths(structure);
  for (const dir of actualImportantDirs(projectRoot)) {
    if (!documented.has(dir)) {
      findings.push({
        scope: 'root-project-structure',
        file: rootClaudePath,
        severity: 'warning',
        message: `actual top-level directory \`${dir}/\` is not documented in Project Structure`,
      });
    }
  }
  for (const dir of documented) {
    if (IMPORTANT_TOP_LEVEL.has(dir) && !existsSync(join(projectRoot, dir))) {
      findings.push({
        scope: 'root-project-structure',
        file: rootClaudePath,
        severity: 'warning',
        message: `documented top-level directory \`${dir}/\` does not exist`,
      });
    }
  }

  const agentsDir = join(projectRoot, 'orgs', org, 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(agentsDir, entry.name);
      const claudePath = join(agentDir, 'CLAUDE.md');
      const claude = readText(claudePath);
      const skills = listSkillNames(agentDir);
      const crons = listCronNames(join(agentDir, 'config.json'));

      if (existsSync(claudePath)) {
        for (const skill of skills) {
          if (!claude.includes(skill)) {
            findings.push({
              scope: `agent:${entry.name}`,
              file: claudePath,
              severity: 'info',
              message: `skill \`${skill}\` exists but is not mentioned in CLAUDE.md`,
            });
          }
        }
        for (const cron of crons) {
          if (!claude.includes(cron)) {
            findings.push({
              scope: `agent:${entry.name}`,
              file: claudePath,
              severity: 'info',
              message: `cron \`${cron}\` exists in config.json but is not mentioned in CLAUDE.md`,
            });
          }
        }
      } else if (skills.length > 0 || crons.length > 0) {
        findings.push({
          scope: `agent:${entry.name}`,
          file: claudePath,
          severity: 'warning',
          message: `agent has ${skills.length} skills and ${crons.length} crons but no CLAUDE.md`,
        });
      }
    }
  }

  const report: DocDriftReport = {
    generatedAt,
    thresholdLines,
    findings,
    driftLines: findings.length,
    taskCreated: false,
  };

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    const reportPath = join(options.outputDir, `${generatedAt.slice(0, 10)}-doc-drift-checker.md`);
    report.reportPath = reportPath;
    writeFileSync(reportPath, renderReport(report), 'utf-8');
  }

  if (options.createTasks !== false && findings.length > thresholdLines) {
    const title = 'Doc drift detected in cortextOS';
    if (!existingTaskWithTitle(paths, title)) {
      report.taskId = createTask(paths, agentName, org, title, {
        description: `Doc drift checker found ${findings.length} findings. Report: ${report.reportPath || 'not written'}`,
        assignee: 'dev',
        priority: 'normal',
        project: 'maintenance',
        meta: {
          source: 'doc-drift-checker',
          report_path: report.reportPath || null,
          drift_lines: findings.length,
        },
      });
      report.taskCreated = true;
    }
  }

  if (report.reportPath) {
    writeFileSync(report.reportPath, renderReport(report), 'utf-8');
  }

  logEvent(paths, agentName, org, 'action', 'doc_drift_checker_completed', 'info', {
    findings: findings.length,
    threshold_lines: thresholdLines,
    task_created: report.taskCreated,
    task_id: report.taskId || null,
    report_path: report.reportPath || null,
  });

  return report;
}
