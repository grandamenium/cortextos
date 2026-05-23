#!/usr/bin/env node
/**
 * hub-surface-sweep.js
 * Detects uncovered web surfaces and zombie crons across the RevOps fleet.
 *
 * Category A: enumerate app/** /page.tsx + src/pages/**\/*.tsx from GitHub repos,
 *   diff against hub-qa-playwright.ts KNOWN_QA_ROUTES, flag blind spots.
 * Category B: per-agent cron zombie detection — last-fire-age vs interval,
 *   plus success-event cross-check where available.
 *
 * Writes report to agents/dev/output/YYYY-MM-DD-surface-sweep.md
 * Exit code 0 always (informational).
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const REPO_ROOT  = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'orgs/revops-global/agents/dev/output');
const TODAY      = new Date().toISOString().slice(0, 10);
const REPORT     = path.join(OUTPUT_DIR, `${TODAY}-surface-sweep.md`);

const SCAN_REPOS = [
  'RevOps-Global-GIT/rgos',
  'RevOps-Global-GIT/ob1-parents',
  'RevOps-Global-GIT/ob1-app',
  'RevOps-Global-GIT/charlie-holstine',
];

const KNOWN_QA_ROUTES = new Set([
  '/time', '/my-day', '/tasks', '/', '/dashboard', '/app/orchestrator',
  '/app/fleet/activity', '/app/work/inbox', '/app/work/approvals',
  '/companies', '/projects', '/reports', '/pipeline',
  '/app/fleet/tasks', '/app/fleet/agents', '/social-content',
  '/attribution-deployer', '/content-attribution', '/content-review', '/app/wiki', '/app/cortex/theta', '/app/presence',
  '/app/signals', '/app/supreme-outstanding',
  '/assessment-detail', '/assessment-rubric', '/assessments',
  '/clients', '/company-detail', '/contact-detail', '/contacts', '/deal-room', '/deal-rooms',
  '/cortext-osguide', '/database-hygiene', '/detailed-report',
  '/invoice-detail', '/invoices', '/knowledge-base', '/meeting-review',
  '/pipeline-detail', '/project-detail', '/sales-agent', '/settings', '/team',
  '/financials', '/workflow-deployer',
  '/outreach', '/outreach-preview', '/outreach-upload',
  '/pipeline-guide', '/sales-materials', '/territory-planning',
  '/beta-autopilot', '/engine-adoption', '/scoring-review', '/scoring-snapshot',
  '/deduplication-queue', '/hygiene-report', '/inbox-triage', '/lifecycle-builder',
  '/linked-in-presence', '/poc/linked-in-presence-poc', '/review-aa-frd', '/slack-link',
  '/skill-claude-code-best-practices', '/skill-dispatching-agents', '/skill-library',
  '/skill-open-brain-to-kb', '/skill-rev-ops-global-brand', '/skill-subagent-driven-development',
  '/skill-database-hygiene', '/skill-salesforce-audit', '/skill-salesforce-campaigns',
  '/skill-salesforce-cli', '/skill-sf-integration-arch', '/skill-sf-pipeline-snapshot',
  '/skill-buying-group', '/skill-eloqua-audit', '/skill-flow-builder',
  '/skill-hub-spot-audit', '/skill-lead-scoring', '/skill-marketo-audit',
  '/skill-martech-audit', '/skill-renewal-playbooks',
  '/skill-docx', '/skill-email-sequence', '/skill-google-doc', '/skill-pdf',
  '/skill-pptx', '/skill-sales-asset', '/skill-slide-deck-storytelling', '/skill-xlsx',
  '/skill-audit', '/skill-audit-data-extraction', '/skill-data-sql-queries',
  '/skill-data-visualization', '/skill-kb-extract', '/skill-knowledge-base',
  '/skill-multimodal-ingest', '/skill-open-brain-weekly',
  '/skill-attribution-modeling', '/skill-four-pillars', '/skill-lifecycle-modeling',
  '/skill-rev-ops-context', '/skill-rev-ops-cro-frameworks', '/skill-rev-ops-wp-page',
  '/skill-rgos-platform', '/skill-sow-creator',
  '/skill-copy-editing', '/skill-copywriting', '/skill-greg-social-media',
  '/skill-launch-strategy', '/skill-prompting-guide', '/skill-sales-outreach',
  '/skill-sales-research', '/skill-social-content',
  '/skill-churn-prevention', '/skill-cowork-best-practices', '/skill-cowork-debrief',
  '/skill-hub-spot-migration', '/skill-multi-instance-orchestration',
  '/skill-skill-creator', '/skill-supreme-optimization-brand', '/skill-tech-stack-audit',
  '/skill-salesforce-data-cleanup', '/skill-salesforce-data-model-relationships',
  '/skill-salesforce-dashboard-strategy', '/skill-salesforce-cpq-configuration',
  '/skill-sf-admin-daily-dashboard', '/skill-sf-data-completeness-score',
  '/skill-sf-duplicate-management', '/skill-sf-dynamic-forms-migration',
]);

// Routes to skip — auth/redirects/portals/guides not worth QA-scanning
// Uses startsWith so /guide/ covers /guide/foo, and /guide covers /guide-admin etc.
const SKIP_PREFIXES = ['/guide', '/auth', '/login', '/callback', '/portal/', '/not-found', '/diagnostic-public', '/company-portal', '/hygiene-report-public'];

const AGENTS_DIR = path.join(REPO_ROOT, 'orgs/revops-global/agents');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd, { silent = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? ['pipe','pipe','pipe'] : undefined });
  } catch (e) {
    return e.stdout || '';
  }
}

function ghApiTree(repo) {
  const raw = run(`gh api "repos/${repo}/git/trees/main?recursive=1" --jq '.tree[].path' 2>/dev/null`, { silent: true });
  return raw.trim().split('\n').filter(Boolean);
}

/** Convert App Router path (app/foo/bar/page.tsx) → /foo/bar */
function appRouterToRoute(filePath) {
  // Strip leading app/ and trailing /page.tsx
  return '/' + filePath.replace(/^app\//, '').replace(/\/page\.tsx$/, '').replace(/\/+$/, '') || '/';
}

/** Convert Pages Router path (src/pages/Foo/Bar.tsx) → /foo/bar */
function pagesRouterToRoute(filePath) {
  // Strip src/pages/ prefix, .tsx suffix
  let route = filePath.replace(/^src\/pages\//, '').replace(/\.tsx$/, '');
  // PascalCase segments → kebab-case
  route = route.split('/').map(seg => seg.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()).join('/');
  // portal/ prefix → /app/
  route = route.replace(/^portal\//, 'app/');
  // index → ''
  route = route.replace(/\/index$/, '').replace(/^index$/, '');
  return '/' + route;
}

function shouldSkip(route) {
  return SKIP_PREFIXES.some(p => route.startsWith(p));
}

// Parse "Xd Xh Xm" or ISO duration strings from bus list-crons output
function parseAgeMs(ageStr) {
  if (!ageStr) return null;
  let ms = 0;
  const d = ageStr.match(/(\d+)d/);  if (d) ms += parseInt(d[1]) * 86400000;
  const h = ageStr.match(/(\d+)h/);  if (h) ms += parseInt(h[1]) * 3600000;
  const m = ageStr.match(/(\d+)m/);  if (m) ms += parseInt(m[1]) * 60000;
  return ms || null;
}

function intervalToMs(interval) {
  if (!interval) return null;
  if (interval.endsWith('m')) return parseInt(interval) * 60000;
  if (interval.endsWith('h')) return parseInt(interval) * 3600000;
  if (interval.endsWith('d')) return parseInt(interval) * 86400000;
  return null;
}

// Parse cron schedule expression to approximate ms interval (best-effort)
function cronExprToMs(expr) {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hour] = parts;
  if (min.startsWith('*/')) return parseInt(min.slice(2)) * 60000;
  if (hour.startsWith('*/')) return parseInt(hour.slice(2)) * 3600000;
  // daily/weekly patterns → rough multiplier
  if (parts[2] === '*' && parts[3] === '*') {
    const dow = parts[4];
    if (dow === '*') return 86400000;          // daily
    if (dow.includes(',')) return 86400000 * 3.5; // ~mid-week
    return 86400000 * 7;                       // weekly
  }
  return null; // can't infer
}

// ---------------------------------------------------------------------------
// Category A: Web Surface Coverage
// ---------------------------------------------------------------------------
async function scanWebSurfaces() {
  const blindSpots = [];
  const covered    = [];
  const repoResults = {};

  for (const repo of SCAN_REPOS) {
    const files = ghApiTree(repo);
    const pages = files.filter(f =>
      (f.startsWith('app/') && f.endsWith('/page.tsx')) ||
      (f.startsWith('src/pages/') && f.endsWith('.tsx') && !f.includes('/_'))
    );

    const routes = [];
    for (const f of pages) {
      const route = f.startsWith('app/') ? appRouterToRoute(f) : pagesRouterToRoute(f);
      if (!shouldSkip(route)) routes.push({ route, file: f });
    }

    repoResults[repo] = routes;

    for (const { route, file } of routes) {
      if (KNOWN_QA_ROUTES.has(route)) {
        covered.push({ route, repo, file });
      } else {
        blindSpots.push({ route, repo, file });
      }
    }
  }

  return { blindSpots, covered, repoResults };
}

// ---------------------------------------------------------------------------
// Category B: Zombie Cron Detection
// ---------------------------------------------------------------------------
function scanZombieCrons() {
  const agents = fs.readdirSync(AGENTS_DIR).filter(a => {
    const cfgPath = path.join(AGENTS_DIR, a, 'config.json');
    return fs.existsSync(cfgPath) && a !== '_archive';
  });

  const zombies  = [];
  const healthy  = [];
  const noData   = [];

  for (const agent of agents) {
    const cfgPath = path.join(AGENTS_DIR, agent, 'config.json');
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { continue; }

    // Skip intentionally-disabled agents — their crons are correctly suppressed, not zombies
    if (cfg.enabled === false) continue;

    const crons = cfg.crons || [];
    if (crons.length === 0) continue;

    // Get live cron data from daemon
    const raw = run(`cortextos bus list-crons ${agent} 2>/dev/null`, { silent: true });

    // Build map: cron name → last fire + success info
    // Output format: "  name    schedule    enabled  Last Fire    Next Fire    Prompt"
    const cronMap = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Name') || trimmed.startsWith('-') || trimmed.startsWith('Crons')) continue;
      // Fields are whitespace-separated; grab first token as name
      const parts = trimmed.split(/\s{2,}/);
      if (parts.length < 4) continue;
      const name     = parts[0];
      const schedule = parts[1];
      const enabled  = parts[2];
      const lastFire = parts[3]; // "2026-05-22 06:06 UTC" or "-"
      cronMap[name] = { schedule, enabled, lastFire };
    }

    for (const cron of crons) {
      const name     = cron.name;
      const interval = cron.interval;
      const cronExpr = cron.cron;
      const live     = cronMap[name];

      if (!live) {
        noData.push({ agent, name, reason: 'not found in bus list-crons' });
        continue;
      }

      if (live.enabled !== 'yes') {
        zombies.push({ agent, name, reason: 'disabled', lastFire: live.lastFire, schedule: live.schedule });
        continue;
      }

      const lastFireStr = live.lastFire;
      if (!lastFireStr || lastFireStr === '-') {
        // Never fired — only a zombie if the agent has been running long enough
        noData.push({ agent, name, reason: 'never fired', schedule: live.schedule });
        continue;
      }

      // Parse last fire timestamp and compute age
      let lastFireMs;
      try {
        lastFireMs = new Date(lastFireStr.replace(' UTC', 'Z')).getTime();
      } catch { continue; }

      const ageMs = Date.now() - lastFireMs;
      const intervalMs = interval ? intervalToMs(interval) : cronExprToMs(cronExpr);

      if (!intervalMs) {
        healthy.push({ agent, name, lastFire: lastFireStr });
        continue;
      }

      const ratio = ageMs / intervalMs;

      // Check for success signal in activity log (best-effort)
      const activityLog = path.join(
        process.env.HOME || '/home/cortextos',
        `.cortextos/${process.env.CTX_INSTANCE_ID || ''}/logs/${agent}/activity.log`
      );
      let hasRecentSuccess = false;
      if (fs.existsSync(activityLog)) {
        try {
          const logTail = execSync(`tail -200 "${activityLog}" 2>/dev/null`, { encoding: 'utf8' });
          // Look for success events from this cron within 2x interval
          const successPattern = new RegExp(`${name}.*success|success.*${name}`, 'i');
          for (const logLine of logTail.split('\n')) {
            if (!successPattern.test(logLine)) continue;
            const tsMatch = logLine.match(/\d{4}-\d{2}-\d{2}T?\d{2}:\d{2}/);
            if (!tsMatch) continue;
            const eventAge = Date.now() - new Date(tsMatch[0]).getTime();
            if (eventAge < intervalMs * 2) { hasRecentSuccess = true; break; }
          }
        } catch { /* log unreadable */ }
      }

      if (ratio > 2) {
        const status = hasRecentSuccess ? 'fired-but-check-success' : 'zombie';
        zombies.push({
          agent, name,
          reason: `age=${Math.round(ageMs/60000)}m > 2x interval=${Math.round(intervalMs/60000)}m`,
          lastFire: lastFireStr,
          schedule: live.schedule,
          hasRecentSuccess,
          status,
        });
      } else {
        healthy.push({ agent, name, lastFire: lastFireStr, ratio: Math.round(ratio * 10) / 10 });
      }
    }
  }

  return { zombies, healthy, noData };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function buildReport(webResult, cronResult) {
  const lines = [];
  const ts = new Date().toISOString();
  lines.push(`# Hub Surface Sweep — ${TODAY}`);
  lines.push(`_Generated ${ts}_`);
  lines.push('');

  // ── Category A ──
  lines.push('## Category A: Web Surface Coverage');
  lines.push('');
  lines.push(`**Repos scanned:** ${SCAN_REPOS.join(', ')}`);
  lines.push(`**Known QA routes:** ${KNOWN_QA_ROUTES.size}`);
  lines.push(`**Covered:** ${webResult.covered.length}`);
  lines.push(`**Blind spots (uncovered):** ${webResult.blindSpots.length}`);
  lines.push('');

  if (webResult.blindSpots.length > 0) {
    lines.push('### Uncovered Routes');
    lines.push('');
    lines.push('| Route | Repo | File |');
    lines.push('|-------|------|------|');
    for (const { route, repo, file } of webResult.blindSpots) {
      lines.push(`| \`${route}\` | ${repo.split('/')[1]} | \`${file}\` |`);
    }
    lines.push('');
  } else {
    lines.push('All discovered routes are covered by the QA harness.');
    lines.push('');
  }

  if (webResult.covered.length > 0) {
    lines.push('<details><summary>Covered routes</summary>');
    lines.push('');
    for (const { route, repo } of webResult.covered) {
      lines.push(`- \`${route}\` (${repo.split('/')[1]})`);
    }
    lines.push('</details>');
    lines.push('');
  }

  // ── Category B ──
  lines.push('## Category B: Automation Zombies');
  lines.push('');
  lines.push(`**Healthy:** ${cronResult.healthy.length}  **Zombies:** ${cronResult.zombies.length}  **No data:** ${cronResult.noData.length}`);
  lines.push('');

  if (cronResult.zombies.length > 0) {
    lines.push('### Zombie Crons');
    lines.push('');
    lines.push('| Agent | Cron | Reason | Last Fire | Success Signal |');
    lines.push('|-------|------|--------|-----------|----------------|');
    for (const z of cronResult.zombies) {
      const success = z.hasRecentSuccess ? 'yes' : 'no';
      lines.push(`| ${z.agent} | ${z.name} | ${z.reason} | ${z.lastFire || '-'} | ${success} |`);
    }
    lines.push('');
  } else {
    lines.push('No zombie crons detected.');
    lines.push('');
  }

  if (cronResult.noData.length > 0) {
    lines.push('### Crons With No Fire Data');
    lines.push('');
    for (const n of cronResult.noData) {
      lines.push(`- **${n.agent}/${n.name}**: ${n.reason}`);
    }
    lines.push('');
  }

  // Summary
  const issueCount = webResult.blindSpots.length + cronResult.zombies.length;
  lines.push('## Summary');
  lines.push('');
  if (issueCount === 0) {
    lines.push('No issues found. All surfaces covered, all crons healthy.');
  } else {
    lines.push(`**${issueCount} issue(s) found:** ${webResult.blindSpots.length} uncovered route(s), ${cronResult.zombies.length} zombie cron(s).`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('[surface-sweep] Scanning web surfaces...');
  const webResult  = await scanWebSurfaces();
  console.log(`[surface-sweep] Found ${webResult.blindSpots.length} blind spots, ${webResult.covered.length} covered`);

  console.log('[surface-sweep] Scanning crons for zombies...');
  const cronResult = scanZombieCrons();
  console.log(`[surface-sweep] ${cronResult.zombies.length} zombies, ${cronResult.healthy.length} healthy, ${cronResult.noData.length} no-data`);

  const report = buildReport(webResult, cronResult);
  fs.writeFileSync(REPORT, report, 'utf8');
  console.log(`[surface-sweep] Report written: ${REPORT}`);

  // Log event
  run(`cortextos bus log-event action surface_sweep info --meta '{"blind_spots":${webResult.blindSpots.length},"zombies":${cronResult.zombies.length}}'`, { silent: true });

  // Notify orchestrator if issues found
  const issueCount = webResult.blindSpots.length + cronResult.zombies.length;
  if (issueCount > 0) {
    const summary = `Surface sweep: ${webResult.blindSpots.length} uncovered route(s), ${cronResult.zombies.length} zombie cron(s). Report: ${REPORT}`;
    run(`cortextos bus send-message orchestrator normal '${summary.replace(/'/g, "\\'")}' `, { silent: true });
  }

  process.exit(0);
})();
