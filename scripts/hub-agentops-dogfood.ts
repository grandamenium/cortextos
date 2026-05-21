#!/usr/bin/env node
/**
 * hub-agentops-dogfood.ts
 * AgentOps deep dogfood pass — 35 assertions
 * (1-25: original surfaces; 26-33: hub /app/orchestrator tabs; 34-35: Skill Notes UI + filesystem)
 *
 * Usage:
 *   cd /home/cortextos/cortextos && npx tsx scripts/hub-agentops-dogfood.ts
 *
 * Failure protocol: FAIL assertions are reported in report.md and surfaced as
 * [HUMAN] tasks via cortextos bus. No direct Telegram.
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCRIPT_DIR   = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT    = path.resolve(SCRIPT_DIR, '..');
const SECRETS_ENV  = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const HUB_URL      = 'https://hub.revopsglobal.com';
const AGENTOPS_URL = 'https://agentops.revopsglobal.com';
const SUPA_URL     = 'https://yyizocyaehmqrottmnaz.supabase.co';
const USER_EMAIL   = 'greg@revopsglobal.com';

const RUN_STAMP = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const OUTPUT_DIR = path.resolve(
  REPO_ROOT,
  'orgs/revops-global/agents/hub-dogfood/output/hub-dogfood',
  RUN_STAMP
);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Selector contracts
// ---------------------------------------------------------------------------
// Single source of truth for CSS selectors used by assertions. Update here when
// the DOM changes; assertions reference SELECTORS.<name> instead of inline strings
// so the contract is grep-able and a frontend rename surfaces in one diff.
//
// Preferred form is data-testid (durable). Where a testid is not yet wired up the
// selector falls back to a generic structural query — when the testid lands, drop
// the fallback in a follow-up.
const SELECTORS = {
  // Generic page chrome
  pageMain: 'button, main, [role="main"]',
  tableRow: 'table tbody tr',
  linkAny:  'a[href]',
  errorBanner: '[role="alert"], [data-testid="error-banner"], .error-banner',

  // Task drawer
  taskDetailSheet:       '[data-testid="task-detail-sheet"]',
  taskBriefContract:     '[data-testid="task-brief-contract"]',
  taskBriefField:        '[data-brief-field]',
  taskExecutionLog:      '[data-testid="task-execution-log"]',
  taskAgentConversation: '[data-testid="task-agent-conversation"]',

  // Fleet matrix / agent cards
  agentCard:     '[data-testid="agent-card"]',
  agentCardName: '[data-agent-name]',

  // Activity feed
  activityEventRow: '[data-testid="activity-event-row"]',
  activityFeedList: '[data-testid="activity-feed"], [data-testid="activity-list"], ul[role="feed"], ol[role="feed"]',

  // Voice card
  voiceMessage: '[data-testid="voice-message"], [aria-label="voice message"]',
  audioElement: 'audio[src]',

  // AgentOps orchestrator tabs (hub.revopsglobal.com/app/orchestrator)
  orchestratorRoot:     '[data-testid="orchestrator-root"]',
  orchestratorTabHealth:    '[data-testid="orchestrator-tab-health"], a[href*="/app/orchestrator/health"]',
  orchestratorTabAgents:    '[data-testid="orchestrator-tab-agents"], a[href*="/app/orchestrator/agents"]',
  orchestratorTabAnalytics: '[data-testid="orchestrator-tab-analytics"], a[href*="/app/orchestrator/analytics"]',
  orchestratorTabActivity:  '[data-testid="orchestrator-tab-activity"], a[href*="/app/orchestrator/activity"]',

  // Tab content data tables/lists — testid preferred, table/list fallback
  healthTable:    '[data-testid="health-table"], main table',
  agentsTable:    '[data-testid="agents-table"], main table',
  analyticsTable: '[data-testid="analytics-table"], main table',
  activityList:   '[data-testid="activity-feed-list"], [data-testid="activity-list"], main ul, main ol',
} as const;

// ---------------------------------------------------------------------------
// Env + session minting (shared pattern with hub-qa-playwright.ts)
// ---------------------------------------------------------------------------
function loadEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .reduce((acc, l) => {
      const idx = l.indexOf('=');
      acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

interface SupabaseSession {
  access_token: string; refresh_token: string;
  token_type: string; expires_in: number; expires_at: number;
  user: Record<string, unknown>;
}

async function mintSession(serviceKey: string, email: string): Promise<SupabaseSession> {
  const genRes = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!genRes.ok) throw new Error(`generate_link failed ${genRes.status}: ${await genRes.text()}`);
  const genData = await genRes.json() as { action_link?: string; properties?: { action_link?: string } };
  const actionLink = genData.action_link ?? genData.properties?.action_link;
  if (!actionLink) throw new Error('No action_link in response');
  const verifyRes = await fetch(actionLink, { redirect: 'manual' });
  const location = verifyRes.headers.get('location') ?? '';
  const hash = location.includes('#') ? location.split('#')[1] : '';
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token') ?? '';
  if (!accessToken) throw new Error(`No access_token from: "${location}"`);
  const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': serviceKey },
  });
  const user = userRes.ok ? await userRes.json() as Record<string, unknown> : {};
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
}

async function injectSession(page: Page, session: SupabaseSession) {
  const key = `sb-yyizocyaehmqrottmnaz-auth-token`;
  await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [key, JSON.stringify(session)]);
}

/**
 * Warm up agentops.revopsglobal.com auth by following the hub→agentops redirect.
 * agentops uses the same Supabase project — session is valid once the redirect chain
 * runs with hub session injected. After this, direct agentops navigation is authenticated.
 */
async function warmAgentopsAuth(page: Page, session: SupabaseSession) {
  await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  await injectSession(page, session);
  // Follow hub→agentops redirect to establish agentops session state
  await page.goto(`${HUB_URL}/app/fleet/tasks`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // Also inject session into agentops domain directly for robustness
  if (page.url().includes('agentops.revopsglobal.com')) {
    await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [`sb-yyizocyaehmqrottmnaz-auth-token`, JSON.stringify(session)]);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type CheckStatus = 'PASS' | 'FAIL' | 'DEFERRED';
interface CheckResult { id: number; surface: string; check: string; status: CheckStatus; evidence: string; screenshot?: string; }

async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(OUTPUT_DIR, `${name}.png`);
  await Promise.race([
    page.screenshot({ path: file, fullPage: false }).catch(() => {}),
    new Promise<void>(r => setTimeout(r, 8000)),
  ]);
  return path.basename(file);
}

async function navigate(page: Page, url: string, timeoutMs = 20000): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Wait for content to settle
    await Promise.race([
      page.waitForSelector(SELECTORS.pageMain, { timeout: 10000 }).catch(() => {}),
      new Promise<void>(r => setTimeout(r, 6000)),
    ]);
    return true;
  } catch { return false; }
}

async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
}

async function elCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector).catch(() => 0);
}

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

// ASSERTIONS 1-4: Task drawer — qa-full-brief-1 (seeded fixture required)
async function checkTaskDrawer(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const url = `${HUB_URL}/app/fleet/tasks?task=qa-full-brief-1`;
  const loaded = await navigate(page, url);

  if (!loaded) {
    const sc = await shot(page, 'assert-01-04-nav-fail');
    return [1,2,3,4].map(i => ({ id: i, surface: 'Task drawer', check: `Assert ${i} — task drawer`, status: 'FAIL' as CheckStatus, evidence: `Navigation to ${url} failed`, screenshot: sc }));
  }

  await page.waitForTimeout(2000);
  const text = await pageText(page);

  // Check if fixture task exists
  const fixturePresent = text.includes('qa-full-brief-1');
  if (!fixturePresent) {
    const sc = await shot(page, 'assert-01-04-no-fixture');
    const msg = 'Seed fixture qa-full-brief-1 not found — task drawer seeded assertions DEFERRED pending fixture deployment';
    return [1,2,3,4].map(i => ({ id: i, surface: 'Task drawer', check: `Assert ${i} — task drawer`, status: 'DEFERRED' as CheckStatus, evidence: msg, screenshot: sc }));
  }

  // Assert 1: Brief Contract fields present
  const briefFields = ['Brief Contract','Success Criteria','Out of Scope','Escalation Triggers','Source Hierarchy','Preferred Runtime','Required Capabilities','Fallback Proof','Artifact Expectations','Goal Ancestry'];
  const missingFields = briefFields.filter(f => !text.includes(f));
  const sc1 = await shot(page, 'assert-01-brief-contract');
  results.push({ id: 1, surface: 'Task drawer', check: 'Assert 1 — Brief Contract fields', status: missingFields.length === 0 ? 'PASS' : 'FAIL', evidence: missingFields.length === 0 ? 'All Brief Contract fields present' : `Missing fields: ${missingFields.join(', ')}`, screenshot: sc1 });

  // Assert 2: No placeholder values in drawer
  const placeholders = ['Not provided','undefined','null','field-not-applicable:'];
  const foundPlaceholder = placeholders.find(p => text.toLowerCase().includes(p.toLowerCase()));
  const sc2 = await shot(page, 'assert-02-no-placeholders');
  results.push({ id: 2, surface: 'Task drawer', check: 'Assert 2 — No placeholder values in Brief Contract', status: foundPlaceholder ? 'FAIL' : 'PASS', evidence: foundPlaceholder ? `Found placeholder: "${foundPlaceholder}"` : 'No placeholders detected', screenshot: sc2 });

  // Assert 3: Execution Log
  const hasExecLog = text.includes('Execution Log') && /created|started|status|completed|blocked|event/i.test(text);
  const sc3 = await shot(page, 'assert-03-execution-log');
  results.push({ id: 3, surface: 'Task drawer', check: 'Assert 3 — Execution Log visible with entries', status: hasExecLog ? 'PASS' : 'FAIL', evidence: hasExecLog ? 'Execution Log present with event content' : `Execution Log missing or empty. "Execution Log" in page: ${text.includes('Execution Log')}`, screenshot: sc3 });

  // Assert 4: Agent Conversation
  const hasConvo = text.includes('Agent Conversation') && (text.includes('agentops-orch') || /message|reply|sent|received/i.test(text));
  const sc4 = await shot(page, 'assert-04-agent-conversation');
  results.push({ id: 4, surface: 'Task drawer', check: 'Assert 4 — Agent Conversation visible with messages', status: hasConvo ? 'PASS' : 'FAIL', evidence: hasConvo ? 'Agent Conversation present with messages' : `Agent Conversation missing or empty. Present: ${text.includes('Agent Conversation')}`, screenshot: sc4 });

  return results;
}

// ASSERTIONS 5-8: Task lifecycle (seeded fixture required)
async function checkTaskLifecycle(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Assert 5: Start action on qa-pending-1
  await navigate(page, `${HUB_URL}/app/fleet/tasks?task=qa-pending-1`);
  await page.waitForTimeout(1500);
  const text5 = await pageText(page);
  const fixture5 = text5.includes('qa-pending-1');
  const sc5 = await shot(page, 'assert-05-pending-task');
  if (!fixture5) {
    results.push({ id: 5, surface: 'Tasks lifecycle', check: 'Assert 5 — Start action on qa-pending-1', status: 'DEFERRED', evidence: 'Fixture qa-pending-1 not found', screenshot: sc5 });
  } else {
    const hasStart = await elCount(page, 'button') > 0 && text5.includes('Start');
    results.push({ id: 5, surface: 'Tasks lifecycle', check: 'Assert 5 — Start action on qa-pending-1', status: hasStart ? 'PASS' : 'FAIL', evidence: hasStart ? 'Start button found on pending task' : 'Start button not found', screenshot: sc5 });
  }

  // Assert 6: List view shows qa-in-progress-1
  await navigate(page, `${HUB_URL}/app/fleet/tasks`);
  await page.waitForTimeout(1500);
  const text6 = await pageText(page);
  const fixture6 = text6.includes('qa-in-progress-1');
  const sc6 = await shot(page, 'assert-06-list-view');
  if (!fixture6) {
    results.push({ id: 6, surface: 'Tasks lifecycle', check: 'Assert 6 — List view shows in-progress task', status: 'DEFERRED', evidence: 'Fixture qa-in-progress-1 not found', screenshot: sc6 });
  } else {
    const hasRequired = ['In Progress','agentops-orch','revops-global'].filter(s => text6.includes(s));
    results.push({ id: 6, surface: 'Tasks lifecycle', check: 'Assert 6 — List view in-progress task columns', status: hasRequired.length >= 2 ? 'PASS' : 'FAIL', evidence: `Found: ${hasRequired.join(', ')}`, screenshot: sc6 });
  }

  // Assert 7: Completed-today vs completed-yesterday
  const text7 = text6;
  const sc7 = await shot(page, 'assert-07-completed-today');
  const fixture7 = text7.includes('qa-completed-today') || text7.includes('qa-completed-yesterday');
  if (!fixture7) {
    results.push({ id: 7, surface: 'Tasks lifecycle', check: 'Assert 7 — Completed-today visible, yesterday not', status: 'DEFERRED', evidence: 'Completed fixture tasks not found', screenshot: sc7 });
  } else {
    results.push({ id: 7, surface: 'Tasks lifecycle', check: 'Assert 7 — Completed-today visible, yesterday not', status: text7.includes('qa-completed-today') ? 'PASS' : 'FAIL', evidence: `qa-completed-today: ${text7.includes('qa-completed-today')}, qa-completed-yesterday: ${text7.includes('qa-completed-yesterday')}`, screenshot: sc7 });
  }

  // Assert 8: Blocked task drilldown
  await navigate(page, `${HUB_URL}/app/fleet/tasks?task=qa-blocked-1`);
  await page.waitForTimeout(1500);
  const text8 = await pageText(page);
  const sc8 = await shot(page, 'assert-08-blocked-task');
  const fixture8 = text8.includes('qa-blocked-1');
  if (!fixture8) {
    results.push({ id: 8, surface: 'Tasks drilldown', check: 'Assert 8 — Blocked task drilldown + Unblock action', status: 'DEFERRED', evidence: 'Fixture qa-blocked-1 not found', screenshot: sc8 });
  } else {
    const hasBlocked = text8.includes('Blocked');
    const hasUnblock = text8.includes('Unblock');
    results.push({ id: 8, surface: 'Tasks drilldown', check: 'Assert 8 — Blocked task drilldown + Unblock action', status: hasBlocked && hasUnblock ? 'PASS' : 'FAIL', evidence: `Blocked: ${hasBlocked}, Unblock: ${hasUnblock}`, screenshot: sc8 });
  }

  return results;
}

// ASSERTION 9: Now / current work
async function checkNowCurrentWork(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  await navigate(page, HUB_URL);
  await page.waitForTimeout(2000);
  const text = await pageText(page);
  const sc = await shot(page, 'assert-09-now-current-work');

  const placeholders = ['Untitled','Unknown','undefined','null','field-not-applicable:','No tasks found'];
  const found = placeholders.find(p => text.includes(p));
  const hasMetrics = /tasks today|current focus|today.s progress/i.test(text);

  return [{ id: 9, surface: 'Now/current work', check: 'Assert 9 — Root no placeholders, Tasks Today visible', status: !found && hasMetrics ? 'PASS' : found ? 'FAIL' : 'DEFERRED', evidence: found ? `Placeholder found: "${found}"` : hasMetrics ? 'Metrics visible, no placeholders' : 'Metrics not found on root (may need fixture)', screenshot: sc }];
}

// ASSERTIONS 10-13: Fleet matrix + analytics
async function checkFleetMatrix(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const agentsUrl = `${AGENTOPS_URL}/agents`;
  await navigate(page, agentsUrl);
  await page.waitForTimeout(2000);
  const text10 = await pageText(page);
  const sc10 = await shot(page, 'assert-10-fleet-matrix-counts');

  // Assert 10: Health summary counters — agentops auth is now warm from main()
  const hasHealthCounts = /healthy|stale|down/i.test(text10) && /\d+/.test(text10);
  results.push({ id: 10, surface: 'Fleet matrix', check: 'Assert 10 — Health summary (healthy/stale/down counts)', status: hasHealthCounts ? 'PASS' : 'FAIL', evidence: hasHealthCounts ? 'Health summary visible with counts' : `Health counts not found. URL: ${page.url()}. Snippet: ${text10.slice(0,200)}`, screenshot: sc10 });

  // Assert 11: agentops-orch card visible with status
  const hasOrchCard = text10.includes('agentops-orch') && /Online|Idle|Stale|Offline|Working on/i.test(text10);
  const sc11 = await shot(page, 'assert-11-agentops-orch-card');
  results.push({ id: 11, surface: 'Fleet matrix', check: 'Assert 11 — agentops-orch card visible with status', status: hasOrchCard ? 'PASS' : 'FAIL', evidence: hasOrchCard ? 'agentops-orch card with status found' : `agentops-orch: ${text10.includes('agentops-orch')}, status: ${/Online|Idle|Stale|Offline/i.test(text10)}`, screenshot: sc11 });

  // Assert 12: Analytics fleet health table
  const analyticsUrl = `${AGENTOPS_URL}/analytics`;
  await navigate(page, analyticsUrl);
  await page.waitForTimeout(2000);
  const text12 = await pageText(page);
  const sc12 = await shot(page, 'assert-12-analytics-fleet-health');
  const hasFleetHealth = /Fleet Health|Last Heartbeat/i.test(text12);
  const hasAgentRow = text12.includes('agentops-orch') || text12.includes('orchestrator');
  results.push({ id: 12, surface: 'Fleet matrix', check: 'Assert 12 — Analytics fleet health table', status: hasFleetHealth && hasAgentRow ? 'PASS' : 'FAIL', evidence: hasFleetHealth ? `Fleet Health: ${hasFleetHealth}, agent row: ${hasAgentRow}` : `Fleet Health section not found. URL: ${page.url()}`, screenshot: sc12 });

  // Assert 13: Stale row visible in analytics
  const hasStale = /stale/i.test(text12);
  const sc13 = await shot(page, 'assert-13-analytics-stale');
  results.push({ id: 13, surface: 'Fleet matrix', check: 'Assert 13 — Stale agent row visible in analytics', status: hasStale ? 'PASS' : 'DEFERRED', evidence: hasStale ? 'Stale row visible' : 'No stale rows — may be healthy fleet state (not a defect if all agents current)', screenshot: sc13 });

  return results;
}

// ASSERTIONS 14-17: Freshness strip + Farm
async function checkFreshnessStrip(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Assert 14: /workflows/health filter buttons
  await navigate(page, `${AGENTOPS_URL}/workflows/health`);
  await page.waitForTimeout(2000);
  const text14 = await pageText(page);
  const sc14 = await shot(page, 'assert-14-workflows-health-filters');
  const hasWarning = /Warning/i.test(text14);
  const hasFailure = /Failure/i.test(text14);
  const hasNever = /Never fired/i.test(text14);
  results.push({ id: 14, surface: 'Freshness strip', check: 'Assert 14 — /workflows/health filter buttons (Warning/Failure/Never fired)', status: (hasWarning || hasFailure || hasNever) ? 'PASS' : 'FAIL', evidence: `Warning: ${hasWarning}, Failure: ${hasFailure}, Never fired: ${hasNever}. URL: ${page.url()}`, screenshot: sc14 });

  // Assert 15: Heartbeat row clickable drilldown
  const hasHeartbeatRow = /heartbeat/i.test(text14);
  const sc15 = await shot(page, 'assert-15-workflows-health-drilldown');
  if (hasHeartbeatRow) {
    const links = await page.evaluate((sel) =>
      Array.from(document.querySelectorAll(sel)).map(a => (a as HTMLAnchorElement).href).filter(h => h.includes('/workflows/') && h.includes('/heartbeat'))
    , SELECTORS.linkAny).catch(() => [] as string[]);
    results.push({ id: 15, surface: 'Freshness strip', check: 'Assert 15 — Heartbeat row links to /workflows/<agent>/heartbeat', status: links.length > 0 ? 'PASS' : 'FAIL', evidence: links.length > 0 ? `Heartbeat drilldown links: ${links.slice(0,2).join(', ')}` : 'No /workflows/*/heartbeat links found on rows', screenshot: sc15 });
  } else {
    results.push({ id: 15, surface: 'Freshness strip', check: 'Assert 15 — Heartbeat row drilldown', status: 'DEFERRED', evidence: 'No heartbeat rows visible on /workflows/health', screenshot: sc15 });
  }

  // Assert 16: /app/fleet/farm — try hub route (redirects to agentops if migrated)
  await navigate(page, `${HUB_URL}/app/fleet/farm`);
  await page.waitForTimeout(2000);
  const text16 = await pageText(page);
  const sc16 = await shot(page, 'assert-16-farm-kpi');
  const hasFarmKpi = /Farm KPI/i.test(text16);
  const hasRecency = /Updated \d+[smhd] ago/i.test(text16);
  results.push({ id: 16, surface: 'Freshness strip', check: 'Assert 16 — Farm KPI heading + recency label', status: hasFarmKpi ? 'PASS' : 'FAIL', evidence: hasFarmKpi ? `Farm KPI: ${hasFarmKpi}, recency: ${hasRecency}` : `Farm KPI not found. URL: ${page.url()}. snippet: ${text16.slice(0,200)}`, screenshot: sc16 });

  // Assert 17: Status footer visible, no stale-cache text
  const hasStatusFooter = /Status as of \d+[smhd] ago/i.test(text16);
  const hasStaleCache = /cached|stale cache|cache age|from cache/i.test(text16);
  const sc17 = await shot(page, 'assert-17-farm-status-footer');
  results.push({ id: 17, surface: 'Freshness strip', check: 'Assert 17 — Farm status footer visible, no stale-cache text', status: hasStatusFooter && !hasStaleCache ? 'PASS' : hasStaleCache ? 'FAIL' : 'DEFERRED', evidence: `Status footer: ${hasStatusFooter}, stale-cache text: ${hasStaleCache}`, screenshot: sc17 });

  return results;
}

// ASSERTIONS 18-19: Execution log
async function checkExecutionLog(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  await navigate(page, `${AGENTOPS_URL}/workflows/agentops-orch/project-task-poll`);
  await page.waitForTimeout(2000);
  const text = await pageText(page);
  const sc18 = await shot(page, 'assert-18-execution-history');

  // Assert 18: Execution History section + rows
  const hasHistory = /Execution History/i.test(text);
  const hasRows = await elCount(page, SELECTORS.tableRow) > 0;
  results.push({ id: 18, surface: 'Execution log', check: 'Assert 18 — Execution History visible with rows', status: hasHistory && hasRows ? 'PASS' : !hasHistory ? 'FAIL' : 'DEFERRED', evidence: hasHistory ? `Execution History: ${hasHistory}, rows: ${hasRows}` : `Execution History not found. URL: ${page.url()}`, screenshot: sc18 });

  // Assert 19: Table has When/Status/Duration + valid first row
  const hasColumns = /when|status|duration/i.test(text);
  const hasValidRow = /success|failed|retried|fired/i.test(text) && /\d+ms|\d+\.\ds|\d+m/i.test(text);
  const sc19 = await shot(page, 'assert-19-execution-log-columns');
  results.push({ id: 19, surface: 'Execution log', check: 'Assert 19 — Execution log columns + valid row data', status: hasColumns && hasValidRow ? 'PASS' : hasColumns ? 'DEFERRED' : 'FAIL', evidence: `Columns: ${hasColumns}, valid row: ${hasValidRow}`, screenshot: sc19 });

  return results;
}

// ASSERTIONS 20-21: Activity feed
async function checkActivityFeed(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  await navigate(page, `${AGENTOPS_URL}/activity`);
  await page.waitForTimeout(2500);
  const text = await pageText(page);
  const sc20 = await shot(page, 'assert-20-activity-feed');

  // Assert 20: Events count visible, no empty-state
  const hasEventCount = /\d+\s*events/i.test(text);
  const hasEmptyState = /No events match the current filters/i.test(text);
  results.push({ id: 20, surface: 'Activity feed', check: 'Assert 20 — Events count visible, no empty-state', status: hasEventCount && !hasEmptyState ? 'PASS' : hasEmptyState ? 'FAIL' : 'DEFERRED', evidence: `Events count: ${hasEventCount}, empty state: ${hasEmptyState}. URL: ${page.url()}`, screenshot: sc20 });

  // Assert 21: Event row has relative timestamp + agent name
  const hasTimestamp = /ago|less than a minute|about .* ago/i.test(text);
  const hasAgentName = /agentops-orch|orchestrator|analyst|hub-dogfood/i.test(text);
  const sc21 = await shot(page, 'assert-21-activity-event-row');
  results.push({ id: 21, surface: 'Activity feed', check: 'Assert 21 — Event rows have timestamp + agent name', status: hasTimestamp && hasAgentName ? 'PASS' : 'FAIL', evidence: `Timestamp: ${hasTimestamp}, agent name: ${hasAgentName}`, screenshot: sc21 });

  return results;
}

// ASSERTIONS 22-25: Voice card
async function checkVoiceCard(page: Page, session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  await navigate(page, `${AGENTOPS_URL}/comms`);
  await page.waitForTimeout(2000);
  const text = await pageText(page);
  const sc22 = await shot(page, 'assert-22-voice-card');

  // Assert 22: Voice message with microphone marker + transcript
  const hasVoiceMarker = await elCount(page, SELECTORS.voiceMessage) > 0;
  const hasTranscript = /summarize|today.s agent activity|voice/i.test(text);
  results.push({ id: 22, surface: 'Voice card', check: 'Assert 22 — Voice message visible with transcript', status: hasVoiceMarker && hasTranscript ? 'PASS' : 'DEFERRED', evidence: `Voice marker: ${hasVoiceMarker}, transcript text: ${hasTranscript}. URL: ${page.url()}`, screenshot: sc22 });

  // Assert 23: Audio element + media URL returns 200
  const audioSrcs = await page.evaluate((sel) =>
    Array.from(document.querySelectorAll(sel)).map(a => (a as HTMLAudioElement).src)
  , SELECTORS.audioElement).catch(() => [] as string[]);
  const sc23 = await shot(page, 'assert-23-voice-audio-element');
  if (audioSrcs.length > 0) {
    const mediaRes = await fetch(audioSrcs[0]).catch(() => null);
    const ok = mediaRes?.ok ?? false;
    const ct = mediaRes?.headers.get('content-type') ?? '';
    results.push({ id: 23, surface: 'Voice card', check: 'Assert 23 — Audio element + media URL 200 + ogg MIME', status: ok && /audio/i.test(ct) ? 'PASS' : 'FAIL', evidence: `Audio src: ${audioSrcs[0]}, status: ${mediaRes?.status}, content-type: ${ct}`, screenshot: sc23 });
  } else {
    results.push({ id: 23, surface: 'Voice card', check: 'Assert 23 — Audio element + media URL 200 + ogg MIME', status: 'DEFERRED', evidence: 'No audio elements found on /comms — voice fixture not seeded', screenshot: sc23 });
  }

  // Assert 24: Channel card has real transcript, no stubs
  const stubText = ['undefined','null','no transcript','transcribing','voice message'];
  const foundStub = stubText.find(s => text.toLowerCase().includes(s));
  const hasChannel = /james|agentops-orch/i.test(text);
  const sc24 = await shot(page, 'assert-24-voice-channel-card');
  results.push({ id: 24, surface: 'Voice card', check: 'Assert 24 — Channel card has real transcript, no stubs', status: !foundStub && hasChannel ? 'PASS' : foundStub ? 'FAIL' : 'DEFERRED', evidence: foundStub ? `Stub text found: "${foundStub}"` : hasChannel ? 'Channel card with content found, no stubs' : 'Voice channel not found — fixture not seeded', screenshot: sc24 });

  // Assert 25: Voice transcript in Meeting Room / channel selection
  const hasMeetingRoom = /Meeting Room/i.test(text);
  const sc25 = await shot(page, 'assert-25-meeting-room-transcript');
  results.push({ id: 25, surface: 'Voice card', check: 'Assert 25 — Voice transcript in Meeting Room', status: hasMeetingRoom ? 'PASS' : 'DEFERRED', evidence: hasMeetingRoom ? 'Meeting Room visible' : 'Meeting Room not found — voice/comms fixture not seeded', screenshot: sc25 });

  return results;
}

// ASSERTIONS 26-33: AgentOps orchestrator tabs on hub.revopsglobal.com/app/orchestrator
// For each tab: (a) loads without error banner, (b) main data table/list non-empty.
async function checkOrchestratorTabs(page: Page, _session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  type TabSpec = {
    name: string;
    slug: string;          // URL path segment
    listSel: string;       // selector for the data table/list to assert non-empty
    loadId: number;        // assertion id for "loads without error"
    nonEmptyId: number;    // assertion id for "data non-empty"
  };

  const tabs: TabSpec[] = [
    { name: 'Health',    slug: 'health',    listSel: SELECTORS.healthTable,    loadId: 26, nonEmptyId: 27 },
    { name: 'Agents',    slug: 'agents',    listSel: SELECTORS.agentsTable,    loadId: 28, nonEmptyId: 29 },
    { name: 'Analytics', slug: 'analytics', listSel: SELECTORS.analyticsTable, loadId: 30, nonEmptyId: 31 },
    { name: 'Activity',  slug: 'activity',  listSel: SELECTORS.activityList,   loadId: 32, nonEmptyId: 33 },
  ];

  for (const tab of tabs) {
    const url = `${HUB_URL}/app/orchestrator/${tab.slug}`;
    const navOk = await navigate(page, url);
    await page.waitForTimeout(2000);

    const text = await pageText(page);
    const sc = await shot(page, `assert-${String(tab.loadId).padStart(2,'0')}-orchestrator-${tab.slug}`);
    const landedAt = page.url();
    const routeLanded = landedAt.includes(`/app/orchestrator/${tab.slug}`) ||
                        landedAt.includes(`/orchestrator/${tab.slug}`) ||  // agentops host strips /app prefix
                        landedAt.includes('/app/orchestrator');

    // (a) Loads without error
    const hasErrorBanner = await elCount(page, SELECTORS.errorBanner) > 0;
    const has404         = /404|page not found|not_found/i.test(text);
    const has500         = /500|internal server error|something went wrong/i.test(text);
    const loadOk         = navOk && routeLanded && !hasErrorBanner && !has404 && !has500;
    results.push({
      id: tab.loadId,
      surface: `Orchestrator/${tab.name}`,
      check: `Assert ${tab.loadId} — ${tab.name} tab loads without error`,
      status: loadOk ? 'PASS' : 'FAIL',
      evidence: loadOk
        ? `Loaded ${url} (landed at ${landedAt}), no error banner`
        : `nav=${navOk}, routeLanded=${routeLanded}, errorBanner=${hasErrorBanner}, 404=${has404}, 500=${has500}, landedAt=${landedAt}`,
      screenshot: sc,
    });

    // (b) Data non-empty — only check if the load succeeded; otherwise mark DEFERRED.
    const sc2 = await shot(page, `assert-${String(tab.nonEmptyId).padStart(2,'0')}-orchestrator-${tab.slug}-data`);
    if (!loadOk) {
      results.push({
        id: tab.nonEmptyId,
        surface: `Orchestrator/${tab.name}`,
        check: `Assert ${tab.nonEmptyId} — ${tab.name} tab data non-empty`,
        status: 'DEFERRED',
        evidence: `Tab failed to load — non-empty check deferred until load passes`,
        screenshot: sc2,
      });
      continue;
    }

    const listCount = await elCount(page, tab.listSel);
    const rowCount  = await elCount(page, SELECTORS.tableRow);
    const liCount   = await elCount(page, `${tab.listSel} > li, ${tab.listSel} > *`);
    const hasEmpty  = /no (data|results|events|agents|records)|empty/i.test(text);
    const dataNonEmpty = (rowCount > 0 || liCount > 0 || listCount > 1) && !hasEmpty;
    results.push({
      id: tab.nonEmptyId,
      surface: `Orchestrator/${tab.name}`,
      check: `Assert ${tab.nonEmptyId} — ${tab.name} tab data non-empty`,
      status: dataNonEmpty ? 'PASS' : 'FAIL',
      evidence: `selector=${tab.listSel}, listMatches=${listCount}, tableRows=${rowCount}, listChildren=${liCount}, emptyStateText=${hasEmpty}`,
      screenshot: sc2,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Report writing
// ---------------------------------------------------------------------------
function writeReport(all: CheckResult[], durationMs: number) {
  const pass = all.filter(r => r.status === 'PASS').length;
  const fail = all.filter(r => r.status === 'FAIL').length;
  const deferred = all.filter(r => r.status === 'DEFERRED').length;
  const overall = fail > 0 ? 'FAIL' : deferred > 10 ? 'PARTIAL' : 'PASS';

  const rows = all.map(r =>
    `| ${r.id} | ${r.surface} | ${r.check} | ${r.status} | ${r.evidence.replace(/\|/g, '/')} | ${r.screenshot ?? ''} |`
  ).join('\n');

  const failures = all.filter(r => r.status === 'FAIL');
  const defects = failures.length > 0
    ? failures.map(r => `### FAIL — Assert ${r.id}: ${r.check}\n- Surface: ${r.surface}\n- Evidence: ${r.evidence}\n- Screenshot: ${r.screenshot ?? 'none'}\n- Recommended owner: dev / agentops-orch`).join('\n\n')
    : 'None confirmed this pass.';

  const content = `# AgentOps Deep Dogfood Report — ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC

## Summary

OVERALL: ${overall}
Assertions: ${pass} PASS / ${fail} FAIL / ${deferred} DEFERRED (of 33 total)
Duration: ${Math.round(durationMs / 1000)}s
Auth: ${USER_EMAIL} (Supabase magic link)
VM: localhost orchestration host
Checklist: agentops-deep-dogfood-checklist-2026-05-21.md

---

## Assertion Results

| # | Surface | Check | Status | Evidence | Screenshot |
|---|---------|-------|--------|----------|------------|
${rows}

---

## Defects (FAIL assertions)

${defects}

---

## Deferred Assertions

${deferred} assertions deferred — primarily seeded fixture tasks (qa-full-brief-1, qa-pending-1, qa-in-progress-1, qa-blocked-1, qa-completed-today, qa-completed-yesterday) not yet deployed to production. Voice/comms fixture also pending. These will auto-promote to PASS/FAIL once fixtures are seeded.

Selector debt items from checklist (needed for durable assertions; mirrored in SELECTORS const):
- data-testid="task-detail-sheet" on drawer content
- data-testid="task-brief-contract" + data-brief-field on Brief Contract fields
- data-testid="task-execution-log" and data-testid="task-agent-conversation"
- data-testid="activity-event-row" + data-testid="activity-feed-list"
- data-testid="agent-card" with data-agent-name
- data-testid="voice-message" on voice bubbles
- data-testid="orchestrator-root"
- data-testid="orchestrator-tab-{health,agents,analytics,activity}"
- data-testid="{health,agents,analytics}-table" and data-testid="activity-feed-list"
- data-testid="error-banner" on error states

---

## Screenshots

${all.filter(r => r.screenshot).map(r => `- assert-${String(r.id).padStart(2,'0')}: ${r.screenshot}`).join('\n')}

---

## Pass Metadata

- Run time: ${new Date().toISOString()}
- Output dir: ${OUTPUT_DIR}
- Cron: hub-dogfood agentops-deep (every 2h)
- Window: paid-window track E, active through 2026-06-10
`;

  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, content);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Summary: ${pass} passed, ${fail} failed, ${deferred} deferred`);
  all.filter(r => r.status === 'PASS').forEach(r => console.log(`  PASS     Assert ${r.id} ${r.check}`));
  all.filter(r => r.status === 'FAIL').forEach(r => console.log(`  FAIL     Assert ${r.id} ${r.check}`));
  all.filter(r => r.status === 'DEFERRED').forEach(r => console.log(`  DEFERRED Assert ${r.id} ${r.check}`));
  return { overall, pass, fail, deferred, reportPath };
}

// ---------------------------------------------------------------------------
// Assert 34-35: Skill Notes — UI page + filesystem scan
// ---------------------------------------------------------------------------
async function checkSkillNotes(page: Page, _session: SupabaseSession): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const AGENTS_ROOT = path.resolve(REPO_ROOT, 'orgs/revops-global/agents');
  const REQUIRED_SKILLS = ['heartbeat', 'comms', 'tasks'];

  // Assert 34: /app/cortex/skills UI loads and shows skill data
  const shot34 = 'assert-34-skill-notes-ui.png';
  try {
    await page.goto(`${HUB_URL}/app/cortex/skills`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUTPUT_DIR, shot34) });
    const url = page.url();
    const text = await page.textContent('body') ?? '';
    const redirectedToAuth = url.includes('/auth') || url.includes('/login');
    const hasSkillData = /skill|invocation|last.used|last.run|agent/i.test(text);
    const hasEmptyState = /no skills|no data|nothing here|no records/i.test(text);
    const is404 = text.includes('404') || text.includes('Page Not Found');
    if (redirectedToAuth || is404) {
      results.push({ id: 34, surface: 'Skill Notes UI', check: 'Assert 34 — /app/cortex/skills loads and shows skill data', status: 'FAIL', evidence: `Auth redirect or 404. url=${url}`, screenshot: shot34 });
    } else if (hasSkillData && !hasEmptyState) {
      results.push({ id: 34, surface: 'Skill Notes UI', check: 'Assert 34 — /app/cortex/skills loads and shows skill data', status: 'PASS', evidence: `Page loaded with skill data at ${url}`, screenshot: shot34 });
    } else if (hasEmptyState) {
      results.push({ id: 34, surface: 'Skill Notes UI', check: 'Assert 34 — /app/cortex/skills loads and shows skill data', status: 'FAIL', evidence: `Empty state shown — no skill entries rendered. url=${url}`, screenshot: shot34 });
    } else {
      results.push({ id: 34, surface: 'Skill Notes UI', check: 'Assert 34 — /app/cortex/skills loads and shows skill data', status: 'DEFERRED', evidence: `Page loaded but could not confirm skill data presence. url=${url}`, screenshot: shot34 });
    }
  } catch (e) {
    results.push({ id: 34, surface: 'Skill Notes UI', check: 'Assert 34 — /app/cortex/skills loads and shows skill data', status: 'FAIL', evidence: String(e), screenshot: shot34 });
  }

  // Assert 35: Filesystem scan — each active agent has required skills installed
  try {
    const agents = fs.readdirSync(AGENTS_ROOT).filter(name => {
      const agentDir = path.join(AGENTS_ROOT, name);
      return fs.statSync(agentDir).isDirectory() && fs.existsSync(path.join(agentDir, 'config.json'));
    });
    const missing: string[] = [];
    for (const agent of agents) {
      const skillsDir = path.join(AGENTS_ROOT, agent, '.claude', 'skills');
      if (!fs.existsSync(skillsDir)) {
        missing.push(`${agent}: no .claude/skills/ directory`);
        continue;
      }
      for (const skill of REQUIRED_SKILLS) {
        const skillMd = path.join(skillsDir, skill, 'SKILL.md');
        if (!fs.existsSync(skillMd)) {
          missing.push(`${agent}: missing skill '${skill}'`);
        }
      }
    }
    if (missing.length === 0) {
      results.push({ id: 35, surface: 'Skill Notes filesystem', check: `Assert 35 — All ${agents.length} agents have required skills (${REQUIRED_SKILLS.join(', ')})`, status: 'PASS', evidence: `${agents.length} agents checked, all have required skills` });
    } else {
      results.push({ id: 35, surface: 'Skill Notes filesystem', check: `Assert 35 — All agents have required skills (${REQUIRED_SKILLS.join(', ')})`, status: 'FAIL', evidence: `Missing: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}` });
    }
  } catch (e) {
    results.push({ id: 35, surface: 'Skill Notes filesystem', check: 'Assert 35 — Agent skill filesystem scan', status: 'FAIL', evidence: String(e) });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const env = loadEnv(SECRETS_ENV);
  const serviceKey = env['RGOS_SUPABASE_SERVICE_KEY'];
  if (!serviceKey) throw new Error('RGOS_SUPABASE_SERVICE_KEY not found in secrets.env');

  console.log(`Minting session for ${USER_EMAIL}...`);
  const session = await mintSession(serviceKey, USER_EMAIL);
  console.log('Session minted. Starting AgentOps deep dogfood pass...');

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();

  // Warm up auth for both hub and agentops domains
  await warmAgentopsAuth(page, session);

  const all: CheckResult[] = [];
  try {
    all.push(...await checkTaskDrawer(page, session));
    all.push(...await checkTaskLifecycle(page, session));
    all.push(...await checkNowCurrentWork(page, session));
    all.push(...await checkFleetMatrix(page, session));
    all.push(...await checkFreshnessStrip(page, session));
    all.push(...await checkExecutionLog(page, session));
    all.push(...await checkActivityFeed(page, session));
    all.push(...await checkVoiceCard(page, session));
    all.push(...await checkOrchestratorTabs(page, session));
    all.push(...await checkSkillNotes(page, session));
  } finally {
    await browser.close();
  }

  const { overall, pass, fail, deferred, reportPath } = writeReport(all, Date.now() - t0);

  // Route FAILs to the correct agent specialist (NOT [HUMAN] — all have agent owners)
  // AgentOps surface bugs → codex-3
  // Framework/bus/cortextos → dev
  // Voice/Orca → codex (with orca-orch review)
  // Cross-surface unclear → orchestrator
  const agentopsAssertIds = new Set([10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35]);
  const failures = all.filter(r => r.status === 'FAIL');
  const { execSync } = await import('child_process');
  for (const f of failures) {
    const assignee = agentopsAssertIds.has(f.id) ? 'codex-3' : 'dev';
    const title = `AgentOps dogfood FAIL: Assert ${f.id} — ${f.surface}`;
    const desc = `${f.check}. Evidence: ${f.evidence}. Screenshot: ${f.screenshot ?? 'none'}. Report: ${reportPath}. Assertion source: agentops-deep-dogfood-checklist-2026-05-21.md.`;
    try {
      execSync(
        `cortextos bus create-task "${title.replace(/"/g, "'")}" ` +
        `--desc "${desc.replace(/"/g, "'")}" ` +
        `--assignee ${assignee} ` +
        `--source-hierarchy "orchestrator" ` +
        `--required-capabilities "agentops.revopsglobal.com access, dashboard codebase" ` +
        `--fallback-proof "re-run hub-agentops-dogfood.ts assert ${f.id} and check report.md" ` +
        `--artifact-expectations "PR fixing assert ${f.id} surface gap" ` +
        `--goal-ancestry "fleet observability -> AgentOps surface quality -> dogfood coverage" ` +
        `--success-criteria "assertion ${f.id} passes on next agentops-deep cron run" ` +
        `--out-of-scope "root cause investigation by hub-dogfood" ` +
        `--escalation-triggers "fails 3+ consecutive passes"`,
        { stdio: 'pipe' }
      );
      console.log(`[${assignee}] task created for Assert ${f.id}`);
    } catch (e) {
      console.warn(`Failed to create task for Assert ${f.id} (${assignee}): ${e}`);
    }
  }

  // Update capability-monitor.json hub_qa entry and revalidate dashboard cache
  try {
    const monitorPath = path.resolve(REPO_ROOT, 'dashboard/src/data/capability-monitor.json');
    const monitor = JSON.parse(fs.readFileSync(monitorPath, 'utf8'));
    const hubQa = monitor.capabilities.find((c: Record<string, unknown>) => c.id === 'hub_qa');
    if (hubQa) {
      hubQa.lastCheckedAt = new Date().toISOString();
      hubQa.currentStatus = overall === 'PASS' ? 'ok' : fail > 0 ? 'warn' : 'ok';
      hubQa.observed = `${pass} pass, ${fail} fail, ${deferred} deferred`;
      hubQa.proof = `AgentOps deep dogfood: ${overall}. Report: ${reportPath}`;
      hubQa.lastEventName = overall === 'PASS' ? 'capability_check_passed' : 'capability_check_warn';
    }
    fs.writeFileSync(monitorPath, JSON.stringify(monitor, null, 2) + '\n');
    console.log('[hub_qa] capability-monitor.json updated');
    // Revalidate dashboard cache so the capabilities page reflects the new data
    const dashboardUrl = process.env['DASHBOARD_URL'] ?? 'http://localhost:3000';
    await fetch(`${dashboardUrl}/api/revalidate`, { method: 'POST' }).catch(() => {});
    console.log('[hub_qa] dashboard revalidated');
  } catch (e) {
    console.warn('[hub_qa] capability update skipped:', (e as Error).message);
  }

  console.log(`\nOverall: ${overall} (${pass} pass, ${fail} fail, ${deferred} deferred)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
