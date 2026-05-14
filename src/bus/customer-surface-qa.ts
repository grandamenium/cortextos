import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { BusPaths, TaskStatus } from '../types/index.js';
import { createTask } from './task.js';
import { logEvent } from './event.js';

export interface CustomerSurfaceQaOptions {
  pages?: string[];
  outputDir?: string;
  createTasks?: boolean;
  user?: string;
}

interface PageQaResult {
  page: string;
  passed: number;
  failed: number;
  deferred: number;
  exitCode: number;
  reportPath?: string;
  failureSummary: string[];
}

export interface CustomerSurfaceQaReport {
  generatedAt: string;
  pages: PageQaResult[];
  failures: PageQaResult[];
  taskIds: string[];
  reportPath?: string;
}

const DEFAULT_PAGES = ['/', '/tasks', '/companies', '/pipeline', '/app/fleet/agents'];

function parseSummary(output: string): { passed: number; failed: number; deferred: number } {
  const match = output.match(/Summary:\s+(\d+)\s+passed,\s+(\d+)\s+failed,\s+(\d+)\s+deferred/i);
  if (!match) return { passed: 0, failed: 0, deferred: 0 };
  return { passed: Number(match[1]), failed: Number(match[2]), deferred: Number(match[3]) };
}

function parseReportPath(output: string): string | undefined {
  return output.match(/Report:\s+(.+)/)?.[1]?.trim();
}

function parseFailures(reportPath: string | undefined): string[] {
  if (!reportPath || !existsSync(reportPath)) return [];
  const text = readFileSync(reportPath, 'utf-8');
  const failureSection = text.split('\n## Failures\n')[1] || '';
  return failureSection
    .split('\n### ')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split('\n').slice(0, 2).join(' — '));
}

function existingTaskWithTitle(paths: BusPaths, title: string): boolean {
  if (!existsSync(paths.taskDir)) return false;
  for (const file of readdirSync(paths.taskDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const task = JSON.parse(readFileSync(join(paths.taskDir, file), 'utf-8')) as { title?: string; status?: TaskStatus };
      if (task.title === title && task.status && !['completed', 'cancelled'].includes(task.status)) return true;
    } catch {
      // Ignore corrupt task file.
    }
  }
  return false;
}

function renderReport(report: CustomerSurfaceQaReport): string {
  const lines = [
    '# Customer Surface Deep QA',
    '',
    `Generated: ${report.generatedAt}`,
    `Pages checked: ${report.pages.length}`,
    `Pages with failures: ${report.failures.length}`,
    `Tasks created: ${report.taskIds.length}`,
    '',
    '| Page | Pass | Fail | Deferred | Report |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const page of report.pages) {
    lines.push(`| ${page.page} | ${page.passed} | ${page.failed} | ${page.deferred} | ${page.reportPath || '-'} |`);
  }
  lines.push('');

  if (report.failures.length > 0) {
    lines.push('## Failures', '');
    for (const page of report.failures) {
      lines.push(`### ${page.page}`, '');
      for (const failure of page.failureSummary) lines.push(`- ${failure}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function runCustomerSurfaceQa(
  paths: BusPaths,
  agentName: string,
  org: string,
  projectRoot: string,
  options: CustomerSurfaceQaOptions = {},
): CustomerSurfaceQaReport {
  const generatedAt = new Date().toISOString();
  const pages = options.pages && options.pages.length > 0 ? options.pages : DEFAULT_PAGES;
  const outputDir = options.outputDir || join(projectRoot, 'orgs', org, 'agents', agentName, 'output');
  mkdirSync(outputDir, { recursive: true });
  const scriptPath = join(projectRoot, 'scripts', 'hub-qa-playwright.ts');
  const results: PageQaResult[] = [];
  const taskIds: string[] = [];

  for (const page of pages) {
    const args = ['tsx', scriptPath, '--page', page, '--no-send'];
    if (options.user) args.push('--user', options.user);
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('npx', args, {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 90_000,
      });
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; message?: string };
      stdout = String(e.stdout || '');
      stderr = String(e.stderr || e.message || '');
      exitCode = typeof e.status === 'number' ? e.status : 1;
    }

    const summary = parseSummary(`${stdout}\n${stderr}`);
    const reportPath = parseReportPath(`${stdout}\n${stderr}`);
    const failureSummary = parseFailures(reportPath);
    results.push({ page, ...summary, exitCode, reportPath, failureSummary });
  }

  const failedPages = results.filter(result => result.failed > 0 || result.exitCode > 0);
  if (options.createTasks !== false) {
    for (const page of failedPages) {
      const title = `Hub QA failure: ${page.page}`;
      if (existingTaskWithTitle(paths, title)) continue;
      const taskId = createTask(paths, agentName, org, title, {
        description: `Customer-surface QA found ${page.failed} failing check(s) on ${page.page}. Report: ${page.reportPath || 'not written'}. Failures: ${page.failureSummary.join(' | ') || 'see report'}`,
        assignee: 'codex',
        priority: 'high',
        project: 'quality',
        meta: {
          source: 'customer-surface-qa',
          page: page.page,
          report_path: page.reportPath || null,
        },
      });
      taskIds.push(taskId);
    }
  }

  const report: CustomerSurfaceQaReport = {
    generatedAt,
    pages: results,
    failures: failedPages,
    taskIds,
  };
  report.reportPath = join(outputDir, `${generatedAt.slice(0, 10)}-customer-surface-qa.md`);
  writeFileSync(report.reportPath, renderReport(report), 'utf-8');

  logEvent(paths, agentName, org, 'action', 'customer_surface_qa_completed', 'info', {
    pages_checked: results.length,
    failing_pages: failedPages.map(page => page.page),
    tasks_created: taskIds,
    report_path: report.reportPath,
    harness: basename(scriptPath),
  });

  return report;
}
