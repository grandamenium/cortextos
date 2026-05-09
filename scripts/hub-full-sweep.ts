#!/usr/bin/env node
/**
 * hub-full-sweep.ts
 * Comprehensive QA sweep of hub.revopsglobal.com.
 * Visits every /app/* page, checks render, data, interactions, network errors.
 *
 * Usage:
 *   DISPLAY=:99 npx tsx scripts/hub-full-sweep.ts
 */

import { chromium, Browser, Page, Route } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCRIPT_DIR  = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT   = path.resolve(SCRIPT_DIR, '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const OUTPUT_DIR  = path.resolve(REPO_ROOT, 'orgs/revops-global/agents/codex/output/playwright-qa/sweep');
const REPORT_PATH = path.resolve(REPO_ROOT, 'orgs/revops-global/agents/codex/output/2026-05-08-hub-full-review.md');
const HUB_URL     = 'https://hub.revopsglobal.com';
const SUPA_URL    = 'https://yyizocyaehmqrottmnaz.supabase.co';
const USER_EMAIL  = 'greg@revopsglobal.com';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Env + session minting (same as hub-qa-playwright.ts)
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
  if (!actionLink) throw new Error(`No action_link in response`);
  const verifyRes = await fetch(actionLink, { redirect: 'manual' });
  const location = verifyRes.headers.get('location') ?? '';
  const hash = location.includes('#') ? location.split('#')[1] : '';
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token') ?? '';
  if (!accessToken) throw new Error(`No access_token from redirect: "${location}"`);
  const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'apikey': serviceKey },
  });
  const user = userRes.ok ? await userRes.json() as Record<string, unknown> : {};
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
}

// ---------------------------------------------------------------------------
// Page result type
// ---------------------------------------------------------------------------
interface PageResult {
  page: string;
  renders: string;       // PASS / FAIL / WARN
  freshness: string;     // description of newest record seen
  interactions: string;  // PASS / FAIL / WARN / N/A
  networkErrors: string; // list of 5xx or "none"
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'OK';
  notes: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slug(s: string) { return s.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }

async function shot(page: Page, label: string) {
  const file = path.join(OUTPUT_DIR, `${label}.png`);
  await Promise.race([
    page.screenshot({ path: file, fullPage: false }).catch(() => {}),
    new Promise<void>(r => setTimeout(r, 6000)),
  ]);
  return file;
}

/**
 * Wait for the page to settle after navigation.
 * Waits for networkidle (React Query requests complete) with a hard cap,
 * then gates on the app shell mounting before returning.
 *
 * Cap raised to 15s (was 8s): pages like /pipeline fire 10+ Supabase queries;
 * during a Supabase latency spike the 8s cap could fire while the auth shell
 * (main > div) was still loading, producing false-positive HIGH findings.
 * After networkidle/cap, waitForSelector('main') ensures the React app shell
 * has mounted before the hasContent check runs.
 */
async function waitForSettle(page: Page, extraMs = 500) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // networkidle means no in-flight requests for 500ms — catches React Query fetches.
  // Cap at 15s: handles Supabase latency spikes without stalling indefinitely.
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    new Promise<void>(r => setTimeout(r, 15_000)),
  ]);
  // Gate on the app shell mounting so hasContent never runs against a skeleton.
  // Fail-open: if main never appears (true error), hasContent will catch it.
  await page.waitForSelector('main', { timeout: 5_000 }).catch(() => {});
  if (extraMs > 0) await page.waitForTimeout(extraMs);
}

function severity(renders: string, networkErrors: string, interactions: string): PageResult['severity'] {
  if (renders === 'FAIL') return 'CRITICAL';
  if (networkErrors !== 'none' && networkErrors !== '') return 'HIGH';
  if (renders === 'WARN' || interactions === 'FAIL') return 'HIGH';
  if (interactions === 'WARN') return 'MEDIUM';
  return 'OK';
}

// ---------------------------------------------------------------------------
// Generic page sweep
// ---------------------------------------------------------------------------
async function sweepPage(
  page: Page,
  route: string,
  label: string,
  interactionFn?: (page: Page) => Promise<{ status: string; note: string }>,
): Promise<PageResult> {
  const networkErrors: string[] = [];
  const listener = (response: Awaited<ReturnType<Page['goto']>> extends null ? never : import('playwright').Response) => {
    if (response.status() >= 500 && response.url().includes('revopsglobal')) {
      networkErrors.push(`${response.status()} ${response.url().split('?')[0].replace(HUB_URL, '')}`);
    }
  };
  page.on('response', listener as Parameters<Page['on']>[1]);

  let renders = 'PASS';
  let freshness = 'not checked';
  let interactions = 'N/A';
  let notes = '';

  try {
    await page.goto(`${HUB_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await waitForSettle(page);

    // Check for React error boundary (title-level 404, not empty-state "No X found")
    const errBoundary = await page.locator('[data-nextjs-error]').count().catch(() => 0);
    const errText = await page.locator('h1, h2').filter({ hasText: /something went wrong|application error/i }).count().catch(() => 0);
    // Only flag 404 if the page title/h1 explicitly says it — not empty-state messages
    const pageTitle = await page.title().catch(() => '');
    const h1Text = await page.locator('h1').first().textContent().catch(() => '') ?? '';
    const is404 = /404|page not found/i.test(pageTitle) || /^404$|^not found$/i.test(h1Text.trim());
    const hasContent = await page.locator('h1, h2, h3, table, [role="grid"], [role="tabpanel"], nav, main, main > div').count().catch(() => 0);

    if (errBoundary > 0 || errText > 0) {
      renders = 'FAIL';
      notes += 'React error boundary triggered. ';
    } else if (is404) {
      renders = 'FAIL';
      notes += `404/Not Found (title: "${pageTitle}", h1: "${h1Text.trim()}"). `;
    } else if (hasContent === 0) {
      renders = 'WARN';
      notes += 'No main content elements detected. ';
    } else {
      renders = 'PASS';
    }

    // Freshness: find most recent 2024/2025/2026 dates visible on the page
    const dateText = await page.evaluate(() => {
      // Look for ISO dates (2026-05-07), relative dates (2 days ago), or formatted (May 7, 2026)
      const all = Array.from(document.querySelectorAll('td, span, p, div, time, [data-date]'))
        .map(el => el.textContent?.trim() ?? '')
        .filter(t => /202[456]/.test(t) && t.length < 80 && t.length > 3)
        .slice(0, 8);
      return all.join(' | ');
    }).catch(() => '');
    freshness = dateText ? dateText.slice(0, 120) : 'no dates visible';
    // Also grab page heading for context
    const heading = await page.locator('h1, h2').first().textContent().catch(() => '') ?? '';
    if (heading) notes += `Heading: "${heading.trim().slice(0, 40)}". `;

    // Screenshot
    const shotLabel = slug(`${label}-load`);
    await shot(page, shotLabel);

    // Run interaction if provided
    if (interactionFn) {
      try {
        const r = await interactionFn(page);
        interactions = r.status;
        if (r.note) notes += r.note + ' ';
      } catch (e) {
        interactions = 'FAIL';
        notes += `Interaction error: ${(e as Error).message?.split('\n')[0]}. `;
      }
    }
  } catch (e) {
    renders = 'FAIL';
    notes += `Navigation failed: ${(e as Error).message?.split('\n')[0]}. `;
  }

  page.off('response', listener as Parameters<Page['on']>[1]);

  const netStr = networkErrors.length > 0 ? networkErrors.slice(0, 3).join('; ') : 'none';
  return {
    page: route,
    renders,
    freshness: freshness.slice(0, 100),
    interactions,
    networkErrors: netStr,
    severity: severity(renders, netStr, interactions),
    notes: notes.trim().slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Specific interaction helpers
// ---------------------------------------------------------------------------
async function interactTable(page: Page): Promise<{ status: string; note: string }> {
  // Wait for either a data row OR an explicit empty-state message to appear.
  // React Query pages mount then fetch — a fixed delay races with that fetch.
  // Retry once with an extra 3s pause if the first check finds nothing.
  const rowSel = 'table tbody tr:not(.skeleton):not([aria-hidden="true"]), [role="row"][aria-rowindex]';
  const emptySelectors = [
    '[data-empty-state]',
    'text=No results',
    'text=Nothing here',
    'text=No agents registered',
    'text=No tasks found',
    'text=No skills found',
    'text=No rows',
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    // Wait for data row or explicit empty-state (up to 5s)
    const found = await Promise.race([
      page.locator(rowSel).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'row').catch(() => null),
      ...emptySelectors.map(sel =>
        page.locator(sel).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'empty').catch(() => null)
      ),
      new Promise<null>(r => setTimeout(() => r(null), 5_000)),
    ]);

    if (found === 'row') break;      // data loaded — proceed
    if (found === 'empty') break;    // genuine empty state — proceed
    if (attempt === 0) {
      // Nothing yet — wait an extra 3s and retry
      await page.waitForTimeout(3_000);
    }
  }

  // Now check rows
  const row = page.locator('table tbody tr, [role="row"]').nth(1);
  if (await row.count() > 0) {
    await row.click().catch(() => {});
    await page.waitForTimeout(1000);
    const url = page.url();
    await page.goBack().catch(() => {});
    await page.waitForTimeout(800);
    return { status: 'PASS', note: `Row click navigated to: ${url.replace(HUB_URL, '')}` };
  }
  return { status: 'N/A', note: 'No table rows found.' };
}

async function interactTabs(page: Page): Promise<{ status: string; note: string }> {
  const tabs = page.locator('[role="tab"], button[data-state]').all();
  const tabList = await tabs;
  if (tabList.length > 1) {
    try {
      await tabList[1].click();
      await page.waitForTimeout(1000);
      return { status: 'PASS', note: `Clicked tab 2/${tabList.length}.` };
    } catch {
      return { status: 'WARN', note: 'Tab click failed.' };
    }
  }
  return { status: 'N/A', note: 'No tabs found.' };
}

async function interactFilter(page: Page): Promise<{ status: string; note: string }> {
  const select = page.locator('select, [role="combobox"], button[aria-haspopup="listbox"]').first();
  if (await select.count() > 0) {
    await select.click().catch(() => {});
    await page.waitForTimeout(600);
    const options = await page.locator('[role="option"], option').count();
    await page.keyboard.press('Escape').catch(() => {});
    return { status: options > 0 ? 'PASS' : 'WARN', note: `Filter/select opened: ${options} options.` };
  }
  return { status: 'N/A', note: 'No filter/select found.' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const env = loadEnv(SECRETS_ENV);
  const serviceKey = env['SUPABASE_SERVICE_ROLE_KEY'] ?? env['SUPABASE_RGOS_SERVICE_KEY'] ?? '';
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY not found in secrets.env');

  console.log('[sweep] Minting session...');
  const session = await mintSession(serviceKey, USER_EMAIL);
  console.log(`[sweep] Session minted for ${USER_EMAIL}`);

  const browser = await chromium.launch({
    headless: !process.env['DISPLAY'],
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // Inject session via cookies (for Next.js SSR middleware) AND localStorage (for client-side)
  const SUPA_PROJECT = 'yyizocyaehmqrottmnaz';
  const cookieName = `sb-${SUPA_PROJECT}-auth-token`;
  await context.addCookies([
    {
      name: cookieName,
      value: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, token_type: 'bearer', expires_in: session.expires_in, expires_at: session.expires_at }),
      domain: 'hub.revopsglobal.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
    // Supabase SSR v1 also checks -access-token and -refresh-token separately
    {
      name: `sb-${SUPA_PROJECT}-auth-token.0`,
      value: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, token_type: 'bearer', expires_in: session.expires_in, expires_at: session.expires_at }),
      domain: 'hub.revopsglobal.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  await context.addInitScript((sess) => {
    const key = `sb-yyizocyaehmqrottmnaz-auth-token`;
    localStorage.setItem(key, JSON.stringify(sess));
  }, session);

  const page = await context.newPage();

  // Navigate to hub root first to warm up session
  await page.goto(HUB_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
  await page.evaluate((sess) => {
    const key = 'sb-yyizocyaehmqrottmnaz-auth-token';
    localStorage.setItem(key, JSON.stringify(sess));
  }, session);
  await page.waitForTimeout(2000);

  const results: PageResult[] = [];

  const pages: Array<[string, string, ((p: Page) => Promise<{status:string;note:string}>) | undefined]> = [
    // Orchestrator + Cortex (confirmed /app/ prefix from previous QA)
    ['/app/orchestrator', 'orchestrator-main', interactTabs],
    ['/app/cortex/experiments', 'cortex-experiments', interactTable],
    ['/app/cortex/optimization', 'cortex-optimization', undefined],
    ['/app/cortex/skills', 'cortex-skills', interactTable],
    ['/app/cortex/memory', 'cortex-memory', interactFilter],
    ['/app/cortex/theta', 'cortex-theta', undefined],
    // Work queue (confirmed /app/ prefix)
    ['/app/work/approvals', 'work-approvals', interactTable],
    ['/app/work/inbox', 'work-inbox', interactTable],
    // Fleet (confirmed /app/fleet/ prefix from previous QA screenshots)
    ['/app/fleet/agents', 'fleet-agents', interactTable],
    ['/app/fleet/tasks', 'fleet-tasks', interactTable],
    ['/app/fleet/activity', 'fleet-activity', undefined],
    // Agents
    ['/app/agents', 'agents-list', interactTable],
    // Clients (confirmed /app/ prefix)
    ['/app/clients', 'clients-list', interactTable],
    // LinkedIn Presence Engine v0 (#710)
    ['/app/presence', 'linkedin-presence', undefined],
    // Wiki (confirmed /app/ prefix)
    ['/app/wiki', 'wiki', undefined],
    // Root-level routes (confirmed no /app/ prefix from previous QA reports)
    ['/time', 'time', undefined],
    ['/my-day', 'my-day', undefined],
    ['/pipeline', 'pipeline', interactTabs],
    ['/projects', 'projects-list', interactTable],
    ['/reports', 'reports', interactFilter],
    ['/social-content', 'social-content', interactTabs],
    ['/companies', 'companies-list', interactTable],
    ['/content-review', 'content-review', interactTabs],
    ['/tasks', 'tasks-list', interactTable],
    // Try these — may or may not exist
    ['/outreach', 'outreach', interactTabs],
    ['/invoices', 'invoices-list', interactTable],
    ['/contacts', 'contacts-list', interactTable],
  ];

  for (const [route, label, interactionFn] of pages) {
    console.log(`[sweep] ${route}...`);
    const r = await sweepPage(page, route, label, interactionFn);
    results.push(r);
    console.log(`  → renders=${r.renders} net=${r.networkErrors !== 'none' ? r.networkErrors : 'ok'} interact=${r.interactions} sev=${r.severity}`);
  }

  await browser.close();

  // Sort: CRITICAL > HIGH > MEDIUM > LOW > OK
  const sevOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, OK: 4 };
  results.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

  // Generate report
  const now = new Date().toISOString();
  let md = `# hub.revopsglobal.com — Full QA Review\n`;
  md += `**Date:** ${now.slice(0, 10)}  \n`;
  md += `**Run at:** ${now}  \n`;
  md += `**User:** ${USER_EMAIL}  \n`;
  md += `**Pages swept:** ${results.length}  \n\n`;

  const critical = results.filter(r => r.severity === 'CRITICAL');
  const high = results.filter(r => r.severity === 'HIGH');
  const ok = results.filter(r => r.severity === 'OK');
  md += `**Summary:** ${critical.length} CRITICAL, ${high.length} HIGH, ${results.length - critical.length - high.length} other, ${ok.length} OK\n\n`;

  md += `| Page | Renders | Data Freshness | Interactions | Network Errors | Severity | Notes |\n`;
  md += `|------|---------|----------------|--------------|----------------|----------|-------|\n`;
  for (const r of results) {
    const freshnessShort = r.freshness.slice(0, 60).replace(/\|/g, ',');
    const notesShort = r.notes.slice(0, 120).replace(/\|/g, ',');
    md += `| ${r.page} | ${r.renders} | ${freshnessShort} | ${r.interactions} | ${r.networkErrors.slice(0,40)} | **${r.severity}** | ${notesShort} |\n`;
  }

  md += `\n---\n\n## Detail: Issues Requiring Attention\n\n`;
  const issues = results.filter(r => r.severity !== 'OK');
  if (issues.length === 0) {
    md += `_No issues found._\n`;
  } else {
    for (const r of issues) {
      md += `### ${r.severity}: ${r.page}\n`;
      md += `- **Renders:** ${r.renders}\n`;
      md += `- **Freshness:** ${r.freshness}\n`;
      md += `- **Interactions:** ${r.interactions}\n`;
      md += `- **Network errors:** ${r.networkErrors}\n`;
      md += `- **Notes:** ${r.notes || 'none'}\n\n`;
    }
  }

  fs.writeFileSync(REPORT_PATH, md);
  console.log(`\n[sweep] Report written to ${REPORT_PATH}`);
  console.log(`[sweep] ${critical.length} CRITICAL, ${high.length} HIGH, ${ok.length} OK`);
}

main().catch(e => { console.error('[sweep] Fatal:', e); process.exit(1); });
