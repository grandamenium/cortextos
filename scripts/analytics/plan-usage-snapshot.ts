/**
 * scripts/analytics/plan-usage-snapshot.ts
 *
 * Phase 1 of the plan-utilization monitor (analyst spec
 * orgs/sb-personal/agents/analyst/specs/plan-utilization-monitoring.md).
 *
 * Connects via puppeteer-core to Saurav's running Chrome on
 * localhost:9222 (persisted by PR #68's LaunchAgent), opens or focuses a
 * claude.ai/settings/usage tab, reads three numeric values from the DOM,
 * and emits a structured action/plan_usage_sample event into the cortextos
 * analytics event log. On any failure path the script emits
 * action/plan_usage_scrape_failed with a reason code + an HTML + PNG dump
 * to ~/.cortextos/<instance>/analytics/debug/, never crashes, never silent-
 * skips. Boss directive 2026-05-15: Saurav must be able to tell "monitor
 * broken" from "no data yet."
 *
 * Usage:
 *   npx tsx scripts/analytics/plan-usage-snapshot.ts
 *
 * Flags:
 *   --browser-url <url>   Chrome DevTools endpoint (default http://localhost:9222)
 *   --dry-run             Skip event emit; print sample object to stdout
 *   --debug-dir <path>    Override the debug dump directory
 *
 * Selector contract — read this before changing any constant below.
 * The DOM at claude.ai/settings/usage is Anthropic-owned and can change
 * without notice. To keep selector-update PRs surgical:
 *  - Every selector lives as a SELECTOR_* constant at the top of the
 *    file with a one-line comment describing what it targets.
 *  - On the first scrape after a UI change, the fail-loud path writes
 *    the rendered HTML and a full-page PNG into the debug directory,
 *    so the follow-up PR is "look at the dump, update the constant."
 *  - Tokens marked PLACEHOLDER are guesses — replace after the first
 *    real scrape attempt (grep "PLACEHOLDER:" to find them).
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

// puppeteer-core is the only runtime dependency — we ship no Chromium of our
// own, we reuse Saurav's logged-in Chrome via CDP. See package.json.
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { parsePercent } from './plan-usage-parsers.js';

// --- selectors (single locus of UI-churn drift) -----------------------------

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the rendered "weekly plan usage" percentage (e.g. "47%").
const SELECTOR_WEEKLY_PCT = '[data-testid="weekly-usage-pct"]';

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the rendered "5-hour rolling window" percentage.
const SELECTOR_ROLLING_5H_PCT = '[data-testid="rolling-5h-pct"]';

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the timestamp/relative-time string showing when the weekly window resets.
const SELECTOR_WEEKLY_RESET_AT = '[data-testid="weekly-reset-at"]';

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the timestamp/relative-time string showing when the 5h window resets.
const SELECTOR_5H_RESET_AT = '[data-testid="rolling-5h-reset-at"]';

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the Opus-share-of-weekly-quota number in the per-model breakdown.
const SELECTOR_OPUS_BREAKDOWN_PCT = '[data-testid="model-breakdown-opus-pct"]';

// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: the Sonnet-share-of-weekly-quota number in the per-model breakdown.
const SELECTOR_SONNET_BREAKDOWN_PCT = '[data-testid="model-breakdown-sonnet-pct"]';

// Login-sentinel: if this matches, the tab is logged-out — every other
// scrape will fail; emit claude_logged_out reason and dump page.
// PLACEHOLDER: replace with real selector after first scrape attempt.
// Target: any element that exists ONLY on the login/sign-in page.
const SELECTOR_LOGIN_SENTINEL = 'form[action*="/login"], button[data-testid="login-with-google"]';

// --- types ------------------------------------------------------------------

interface PlanUsageSample {
  agent: string;
  source: 'puppeteer_remote_debug';
  sampled_at: string;
  plan_tier: 'max_20x';
  weekly_pct: number;
  rolling_5h_pct: number;
  weekly_window_resets_at: string | null;
  rolling_5h_resets_at: string | null;
  model_breakdown: {
    opus_4_pct_of_weekly: number | null;
    sonnet_4_pct_of_weekly: number | null;
  };
  lag_seconds: number;
}

type FailureReason =
  | 'chrome_not_running'
  | 'claude_tab_not_found'
  | 'claude_logged_out'
  | 'page_nav_timeout'
  | 'selector_drift'
  | 'parse_error'
  | 'unexpected';

interface Args {
  browserUrl: string;
  dryRun: boolean;
  debugDir: string;
}

// --- arg parsing ------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    browserUrl: 'http://localhost:9222',
    dryRun: false,
    debugDir: defaultDebugDir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser-url' && argv[i + 1]) {
      args.browserUrl = argv[++i]!;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--debug-dir' && argv[i + 1]) {
      args.debugDir = argv[++i]!;
    }
  }
  return args;
}

function defaultDebugDir(): string {
  const instance = process.env.CTX_INSTANCE_ID ?? 'default';
  return join(homedir(), '.cortextos', instance, 'analytics', 'debug', 'plan-usage');
}

// --- selector helpers -------------------------------------------------------

async function readPercentText(page: Page, selector: string): Promise<number> {
  const handle = await page.$(selector);
  if (!handle) {
    throw new SelectorMissError(selector);
  }
  const text = (await page.evaluate((el) => (el as HTMLElement).textContent ?? '', handle)).trim();
  const num = parsePercent(text);
  if (num === null) {
    throw new ParseError(`selector ${selector} returned non-numeric "${text}"`);
  }
  return num;
}

async function readOptionalPercentText(page: Page, selector: string): Promise<number | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  const text = (await page.evaluate((el) => (el as HTMLElement).textContent ?? '', handle)).trim();
  return parsePercent(text);
}

async function readOptionalText(page: Page, selector: string): Promise<string | null> {
  const handle = await page.$(selector);
  if (!handle) return null;
  return (await page.evaluate((el) => (el as HTMLElement).textContent ?? '', handle)).trim() || null;
}

class SelectorMissError extends Error {
  constructor(public selector: string) {
    super(`selector miss: ${selector}`);
  }
}
class ParseError extends Error {}
// Distinct typed errors instead of string-prefix sentinels on a generic
// SelectorMissError — the main() dispatcher routes by `instanceof` so a
// reword of the error message can't silently shift the reason code.
class LoggedOutError extends Error {}
class PageNavTimeoutError extends Error {}

// --- core flow --------------------------------------------------------------

async function findOrOpenUsageTab(browser: Browser): Promise<Page> {
  const targets = browser.targets();
  for (const t of targets) {
    const url = t.url();
    if (url.includes('claude.ai/settings/usage')) {
      const page = await t.page();
      if (page) return page;
    }
  }
  // No existing tab — open a new one.
  const page = await browser.newPage();
  await page.goto('https://claude.ai/settings/usage', {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  return page;
}

async function scrape(page: Page): Promise<PlanUsageSample> {
  const t0 = Date.now();

  // Refresh page state if reused (existing tab may be stale).
  await page.bringToFront();
  try {
    await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 });
  } catch (err) {
    // Surface reload failure as the proximate cause rather than letting
    // downstream selector misses get mis-attributed to selector_drift.
    // Reload errors are typically nav timeouts on a stale/offline tab.
    throw new PageNavTimeoutError(`reload failed: ${(err as Error).message}`);
  }

  // Login sentinel — fail fast with a precise reason.
  const loggedOut = await page.$(SELECTOR_LOGIN_SENTINEL);
  if (loggedOut) {
    throw new LoggedOutError(`tab is logged out (matched ${SELECTOR_LOGIN_SENTINEL})`);
  }

  const weekly_pct = await readPercentText(page, SELECTOR_WEEKLY_PCT);
  const rolling_5h_pct = await readPercentText(page, SELECTOR_ROLLING_5H_PCT);
  const weekly_window_resets_at = await readOptionalText(page, SELECTOR_WEEKLY_RESET_AT);
  const rolling_5h_resets_at = await readOptionalText(page, SELECTOR_5H_RESET_AT);
  const opus_4_pct_of_weekly = await readOptionalPercentText(page, SELECTOR_OPUS_BREAKDOWN_PCT);
  const sonnet_4_pct_of_weekly = await readOptionalPercentText(page, SELECTOR_SONNET_BREAKDOWN_PCT);

  return {
    agent: process.env.CTX_AGENT_NAME ?? 'analyst',
    source: 'puppeteer_remote_debug',
    sampled_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    plan_tier: 'max_20x',
    weekly_pct,
    rolling_5h_pct,
    weekly_window_resets_at,
    rolling_5h_resets_at,
    model_breakdown: {
      opus_4_pct_of_weekly,
      sonnet_4_pct_of_weekly,
    },
    lag_seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// --- failure dump -----------------------------------------------------------

async function dumpDebugArtifacts(
  page: Page | null,
  debugDir: string,
  reason: FailureReason,
): Promise<{ htmlPath: string | null; screenshotPath: string | null }> {
  if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const stem = `${ts}_${reason}`;
  let htmlPath: string | null = null;
  let screenshotPath: string | null = null;
  if (page) {
    try {
      const html = await page.content();
      htmlPath = join(debugDir, `${stem}.html`);
      writeFileSync(htmlPath, html, 'utf-8');
    } catch {
      htmlPath = null;
    }
    try {
      screenshotPath = join(debugDir, `${stem}.png`);
      await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: true });
    } catch {
      screenshotPath = null;
    }
  }
  return { htmlPath, screenshotPath };
}

// --- event emit -------------------------------------------------------------

function emitEvent(eventName: string, severity: 'info' | 'warn' | 'error', meta: Record<string, unknown>): void {
  const json = JSON.stringify(meta);
  // Shell out to cortextos bus log-event — single quote the JSON body to
  // survive zsh `$var` expansion (community/skills/comms-discipline rule 8).
  const result = spawnSync(
    'cortextos',
    ['bus', 'log-event', 'action', eventName, severity, '--meta', json],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    // Last-resort fallback: write the meta to stderr so cron output captures
    // the data even if log-event itself is broken. Do not throw.
    process.stderr.write(
      `[plan-usage-snapshot] log-event failed (exit ${result.status}): ${result.stderr || result.stdout || 'no output'}\n`,
    );
    process.stderr.write(`[plan-usage-snapshot] event payload: ${json}\n`);
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    try {
      browser = await puppeteer.connect({ browserURL: args.browserUrl });
    } catch (err) {
      const dump = await dumpDebugArtifacts(null, args.debugDir, 'chrome_not_running');
      emitEvent('plan_usage_scrape_failed', 'warn', {
        agent: process.env.CTX_AGENT_NAME ?? 'analyst',
        reason: 'chrome_not_running' as FailureReason,
        browser_url: args.browserUrl,
        error: (err as Error).message,
        html_dump_path: dump.htmlPath,
        screenshot_path: dump.screenshotPath,
      });
      return 1;
    }

    try {
      page = await findOrOpenUsageTab(browser);
    } catch (err) {
      // Dump filename and emitted reason must match — one source of truth
      // for "where do I look in debug/?" vs "what does the event say?"
      const dump = await dumpDebugArtifacts(null, args.debugDir, 'page_nav_timeout');
      emitEvent('plan_usage_scrape_failed', 'warn', {
        agent: process.env.CTX_AGENT_NAME ?? 'analyst',
        reason: 'page_nav_timeout' as FailureReason,
        error: (err as Error).message,
        html_dump_path: dump.htmlPath,
        screenshot_path: dump.screenshotPath,
      });
      return 1;
    }

    let sample: PlanUsageSample;
    try {
      sample = await scrape(page);
    } catch (err) {
      const reason: FailureReason =
        err instanceof LoggedOutError
          ? 'claude_logged_out'
          : err instanceof PageNavTimeoutError
            ? 'page_nav_timeout'
            : err instanceof SelectorMissError
              ? 'selector_drift'
              : err instanceof ParseError
                ? 'parse_error'
                : 'unexpected';
      const dump = await dumpDebugArtifacts(page, args.debugDir, reason);
      emitEvent('plan_usage_scrape_failed', 'warn', {
        agent: process.env.CTX_AGENT_NAME ?? 'analyst',
        reason,
        error: (err as Error).message,
        html_dump_path: dump.htmlPath,
        screenshot_path: dump.screenshotPath,
      });
      return 1;
    }

    if (args.dryRun) {
      process.stdout.write(JSON.stringify(sample, null, 2) + '\n');
    } else {
      emitEvent('plan_usage_sample', 'info', sample as unknown as Record<string, unknown>);
    }
    return 0;
  } catch (err) {
    // Catch-all — should never hit, but the contract is "never crash."
    const dump = await dumpDebugArtifacts(page, args.debugDir, 'unexpected');
    emitEvent('plan_usage_scrape_failed', 'error', {
      agent: process.env.CTX_AGENT_NAME ?? 'analyst',
      reason: 'unexpected' as FailureReason,
      error: (err as Error).message,
      stack: (err as Error).stack,
      html_dump_path: dump.htmlPath,
      screenshot_path: dump.screenshotPath,
    });
    return 1;
  } finally {
    // Disconnect — do NOT close the browser; it's Saurav's session.
    if (browser) {
      try {
        await browser.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Reachable only if the finally block (browser.disconnect) throws past
    // the inner catch-all — every business-logic failure is already handled
    // inside main(). Exit 2 distinguishes "framework died" from "scrape
    // failed cleanly" (exit 1) for cron consumers.
    process.stderr.write(`[plan-usage-snapshot] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  });
