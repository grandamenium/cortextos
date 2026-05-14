import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

interface GhReview {
  author?: { login?: string };
  state?: string;
  submittedAt?: string;
}

interface GhStatusCheck {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
  name?: string;
  workflowName?: string;
}

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author?: { login?: string };
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: GhStatusCheck[];
  reviews?: GhReview[];
}

export interface PrStuckWatcherOptions {
  repos?: string[];
  stuckHours?: number;
  alertHours?: number;
  outputDir?: string;
}

export interface PrStuckItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  ageHours: number;
  updatedHoursAgo: number;
  ciState: string;
  ciPassing: boolean;
  mergeState: string;
  autoMergeEligible: boolean;
  reviewDecision: string;
  lastReview: string;
  author: string;
}

export interface PrStuckWatcherResult {
  generatedAt: string;
  watchedRepos: string[];
  checkedRepos: string[];
  failedRepos: Array<{ repo: string; error: string }>;
  stuckThresholdHours: number;
  alertThresholdHours: number;
  stuckPrs: PrStuckItem[];
  alertPrs: PrStuckItem[];
  reportPath?: string;
}

function runGh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function parseGhJson<T>(args: string[]): T {
  const output = runGh(args).trim();
  return output ? JSON.parse(output) as T : JSON.parse('[]') as T;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(v => v.trim()).filter(Boolean))).sort();
}

function discoverRepos(explicitRepos?: string[]): string[] {
  if (explicitRepos && explicitRepos.length > 0) return unique(explicitRepos);

  return [
    'RevOps-Global-GIT/cortextos',
    'RevOps-Global-GIT/rgos',
    'RevOps-Global-GIT/team-brain',
    'RevOps-Global-GIT/ob1-app',
    'RevOps-Global-GIT/ob1-parents',
  ];
}

function ageHours(iso: string, nowMs: number): number {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (nowMs - ts) / 3_600_000);
}

function summarizeChecks(checks: GhStatusCheck[] | undefined): { summary: string; passing: boolean } {
  if (!checks || checks.length === 0) return { summary: 'no checks', passing: false };

  let passing = 0;
  let failing = 0;
  let pending = 0;
  let skipped = 0;

  for (const check of checks) {
    const raw = String(check.conclusion || check.state || check.status || '').toUpperCase();
    if (['SUCCESS', 'PASS', 'PASSED', 'COMPLETED'].includes(raw)) passing += 1;
    else if (['FAILURE', 'FAILED', 'ERROR', 'ACTION_REQUIRED', 'TIMED_OUT', 'CANCELLED'].includes(raw)) failing += 1;
    else if (['SKIPPED', 'NEUTRAL'].includes(raw)) skipped += 1;
    else pending += 1;
  }

  const parts = [
    passing ? `${passing} passing` : '',
    pending ? `${pending} pending` : '',
    failing ? `${failing} failing` : '',
    skipped ? `${skipped} skipped` : '',
  ].filter(Boolean);
  const summary = parts.length ? parts.join(', ') : 'unknown';
  return { summary, passing: passing > 0 && failing === 0 && pending === 0 };
}

function lastReview(reviews: GhReview[] | undefined): string {
  if (!reviews || reviews.length === 0) return 'none';
  const latest = [...reviews]
    .filter(review => review.submittedAt)
    .sort((a, b) => Date.parse(b.submittedAt || '') - Date.parse(a.submittedAt || ''))[0];
  if (!latest) return 'none';
  const reviewer = latest.author?.login || 'unknown';
  const state = latest.state || 'reviewed';
  return `${state} by ${reviewer} at ${latest.submittedAt}`;
}

function formatHours(hours: number): string {
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(1)}h`;
}

function renderReport(result: PrStuckWatcherResult): string {
  const lines = [
    `# PR Stuck Watcher`,
    '',
    `Generated: ${result.generatedAt}`,
    `Checked repos: ${result.checkedRepos.length}/${result.watchedRepos.length}`,
    `Thresholds: report >${result.stuckThresholdHours}h, alert >${result.alertThresholdHours}h`,
    '',
  ];

  if (result.failedRepos.length > 0) {
    lines.push('## Repo Errors', '');
    for (const failure of result.failedRepos) {
      lines.push(`- ${failure.repo}: ${failure.error}`);
    }
    lines.push('');
  }

  if (result.stuckPrs.length === 0) {
    lines.push('No open PRs exceeded the reporting threshold.', '');
    return lines.join('\n');
  }

  lines.push('## Open PRs Exceeding Threshold', '');
  lines.push('| Repo | PR | Age | Updated | CI | Merge | Review | Last review |');
  lines.push('| --- | --- | ---: | ---: | --- | --- | --- | --- |');
  for (const pr of result.stuckPrs) {
    lines.push([
      pr.repo,
      `[#${pr.number} ${pr.title.replace(/\|/g, '\\|')}](${pr.url})`,
      formatHours(pr.ageHours),
      `${formatHours(pr.updatedHoursAgo)} ago`,
      pr.ciState,
      pr.mergeState,
      pr.reviewDecision,
      pr.lastReview.replace(/\|/g, '\\|'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');

  if (result.alertPrs.length > 0) {
    lines.push('## Alert Threshold', '');
    for (const pr of result.alertPrs) {
      lines.push(`- ${pr.repo}#${pr.number} open for ${formatHours(pr.ageHours)}: ${pr.url}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function runPrStuckWatcher(
  paths: BusPaths,
  agentName: string,
  org: string,
  options: PrStuckWatcherOptions = {},
): PrStuckWatcherResult {
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  const stuckThresholdHours = options.stuckHours ?? 2;
  const alertThresholdHours = options.alertHours ?? 24;
  const watchedRepos = discoverRepos(options.repos);
  const checkedRepos: string[] = [];
  const failedRepos: Array<{ repo: string; error: string }> = [];
  const stuckPrs: PrStuckItem[] = [];

  for (const repo of watchedRepos) {
    let prs: GhPullRequest[];
    try {
      prs = parseGhJson<GhPullRequest[]>([
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,url,createdAt,updatedAt,author,reviewDecision,mergeStateStatus,statusCheckRollup,reviews',
      ]);
      checkedRepos.push(repo);
    } catch (err) {
      failedRepos.push({ repo, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const pr of prs) {
      const prAge = ageHours(pr.createdAt, now);
      const updatedHoursAgo = ageHours(pr.updatedAt, now);
      if (updatedHoursAgo <= stuckThresholdHours) continue;
      const checks = summarizeChecks(pr.statusCheckRollup);
      const mergeState = pr.mergeStateStatus || 'unknown';
      stuckPrs.push({
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        ageHours: prAge,
        updatedHoursAgo,
        ciState: checks.summary,
        ciPassing: checks.passing,
        mergeState,
        autoMergeEligible: checks.passing && mergeState === 'CLEAN',
        reviewDecision: pr.reviewDecision || 'none',
        lastReview: lastReview(pr.reviews),
        author: pr.author?.login || 'unknown',
      });
    }
  }

  stuckPrs.sort((a, b) => b.ageHours - a.ageHours);
  const alertPrs = stuckPrs.filter(pr => pr.updatedHoursAgo > alertThresholdHours);
  const result: PrStuckWatcherResult = {
    generatedAt,
    watchedRepos,
    checkedRepos,
    failedRepos,
    stuckThresholdHours,
    alertThresholdHours,
    stuckPrs,
    alertPrs,
  };

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    const reportPath = join(options.outputDir, `${generatedAt.slice(0, 10)}-pr-stuck-watcher.md`);
    writeFileSync(reportPath, renderReport(result), 'utf-8');
    result.reportPath = reportPath;
  }

  logEvent(paths, agentName, org, 'action', 'pr_stuck_watcher_completed', 'info', {
    watched_repos: watchedRepos.length,
    checked_repos: checkedRepos.length,
    stuck_prs: stuckPrs.length,
    alert_prs: alertPrs.length,
    report_path: result.reportPath || null,
  });

  return result;
}
