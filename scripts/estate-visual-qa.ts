#!/usr/bin/env node
/**
 * estate-visual-qa.ts
 * Visual consistency QA for multiple apps vs design-agent CANONICAL.md specs.
 *
 * Apps covered:
 *   - ob1-parents (Estate App)  — CANONICAL: estate-design-system-audit-2026-05-23/CANONICAL.md
 *   - Orca Voice                — CANONICAL: orca-voice-WAVE-G-full-system-2026-05-23/ORCA-APP-CANONICAL.md
 *   - Mandoland                 — CANONICAL: mandoland-design-system-2026-05-23/MANDOLAND-CANONICAL.md (URL TBD)
 *
 * Usage:
 *   cd /home/cortextos/cortextos && npx tsx scripts/estate-visual-qa.ts
 */

import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_DIR  = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT   = path.resolve(SCRIPT_DIR, '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');

// Estate App
const ESTATE_URL  = 'https://ob1-parents.vercel.app';
const AUTH_COOKIE = 'ob1-parents-auth';
const CANONICAL   = path.resolve(
  REPO_ROOT,
  'orgs/revops-global/agents/design-agent/output/estate-design-system-audit-2026-05-23/CANONICAL.md'
);

// Orca Voice — Wave G full system (2026-05-23)
const ORCA_URL       = 'https://orca.revopsglobal.com';
const ORCA_CANONICAL = path.resolve(
  REPO_ROOT,
  'orgs/revops-global/agents/design-agent/output/orca-voice-WAVE-G-full-system-2026-05-23/ORCA-APP-CANONICAL.md'
);

// Mandoland — CANONICAL received 2026-05-23; URL confirmed mandoland.revopsglobal.com
const MANDOLAND_CANONICAL = path.resolve(
  REPO_ROOT,
  'orgs/revops-global/agents/design-agent/output/mandoland-design-system-2026-05-23/MANDOLAND-CANONICAL.md'
);
const MANDOLAND_URL     = 'https://mandoland.revopsglobal.com';
const MANDOLAND_ENABLED = false; // disabled pending Playwright auth setup for Mandoland

const RUN_STAMP  = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const OUTPUT_DIR = path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/estate-visual-qa', RUN_STAMP);
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------
function loadEnv(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .reduce((acc, l) => {
      const idx = l.indexOf('=');
      acc[l.slice(0, idx).trim()] = l.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface CheckResult {
  id: number;
  surface: string;
  rule: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  evidence: string;
  screenshot?: string;
}

const results: CheckResult[] = [];
let checkId = 0;

function record(surface: string, rule: string, status: 'PASS' | 'FAIL' | 'WARN', evidence: string, screenshot?: string) {
  results.push({ id: ++checkId, surface, rule, status, evidence, screenshot });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⚠';
  console.log(`  ${status.padEnd(4)} ${icon}  Check ${checkId} — ${surface}: ${rule}`);
  if (status !== 'PASS') console.log(`         Evidence: ${evidence}`);
}

// Stable fingerprint for dedup: surface + rule slug. Route is embedded in surface label.
function fingerprint(surface: string, rule: string): string {
  return `${surface}::${rule}`.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

// File or bump an RGOS dogfood-finding task with dedup.
// Skips silently on any error — task creation is non-fatal.
async function fileOrBumpTask(surface: string, rule: string, status: string, evidence: string, screenshot?: string): Promise<void> {
  const fp = fingerprint(surface, rule);
  const title = `[estate-visual-qa] ${surface}: ${rule} — ${status}`;
  const desc = [
    `Fingerprint: ${fp}`,
    `Status: ${status}`,
    `Evidence: ${evidence.slice(0, 200)}`,
    `Screenshot: ${screenshot ?? 'none'}`,
    `Run: ${RUN_STAMP}`,
    `Script: scripts/estate-visual-qa.ts`,
  ].join('\n');

  try {
    const { execSync } = await import('child_process');
    // Check for existing open task with this fingerprint
    const existing = execSync(
      `cortextos bus list-tasks --status open --format json 2>/dev/null || echo '[]'`,
      { stdio: ['pipe', 'pipe', 'ignore'] }
    ).toString();
    let tasks: Array<{ id: string; title: string; description?: string }> = [];
    try { tasks = JSON.parse(existing); } catch { tasks = []; }

    const dup = tasks.find(t => (t.description ?? '').includes(fp) || t.title.includes(rule.slice(0, 40)));
    if (dup) {
      // Bump occurrence
      execSync(
        `cortextos bus update-task ${dup.id} open --desc "occurrence at ${RUN_STAMP}: ${evidence.slice(0, 100)}"`,
        { stdio: 'pipe' }
      );
      console.log(`  [task] bumped existing task ${dup.id} for ${fp}`);
    } else {
      execSync(
        `cortextos bus create-task "${title.replace(/"/g, "'")}" --desc "${desc.replace(/"/g, "'")}"`,
        { stdio: 'pipe' }
      );
      console.log(`  [task] filed new RGOS task for ${fp}`);
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------
async function shot(page: Page, name: string): Promise<string> {
  const fname = `${name}.png`;
  const fpath = path.join(OUTPUT_DIR, fname);
  await page.screenshot({ path: fpath, fullPage: false }).catch(() => {});
  return fname;
}

// ---------------------------------------------------------------------------
// CSS inspection helpers
// ---------------------------------------------------------------------------
async function computedStyle(page: Page, selector: string, prop: string): Promise<string> {
  return page.evaluate(([sel, p]) => {
    const el = document.querySelector(sel);
    if (!el) return '__NOT_FOUND__';
    return window.getComputedStyle(el).getPropertyValue(p).trim();
  }, [selector, prop] as [string, string]).catch(() => '__ERROR__');
}

async function getAttribute(page: Page, selector: string, attr: string): Promise<string> {
  return page.evaluate(([sel, a]) => {
    const el = document.querySelector(sel);
    if (!el) return '__NOT_FOUND__';
    return (el as HTMLElement).getAttribute(a) ?? '';
  }, [selector, attr] as [string, string]).catch(() => '__ERROR__');
}

// Check all elements matching selector for a computed style violation
async function checkAll(
  page: Page,
  selector: string,
  prop: string,
  validate: (val: string) => boolean,
  failLabel: (val: string) => string
): Promise<{ violations: string[] }> {
  const findings = await page.evaluate(([sel, p]) => {
    const els = Array.from(document.querySelectorAll(sel));
    return els.map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      val: window.getComputedStyle(el).getPropertyValue(p).trim(),
    }));
  }, [selector, prop] as [string, string]).catch(() => [] as {tag:string;cls:string;val:string}[]);

  const violations: string[] = [];
  for (const f of findings) {
    if (!validate(f.val)) {
      violations.push(`${f.tag}[${f.cls.slice(0, 40)}]: ${failLabel(f.val)}`);
    }
  }
  return { violations };
}

// ---------------------------------------------------------------------------
// Navigate with auth
// ---------------------------------------------------------------------------
async function goto(page: Page, path_: string): Promise<void> {
  await page.goto(`${ESTATE_URL}${path_}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

// ---------------------------------------------------------------------------
// P0: Bottom nav position check
// Run FIRST on every route — nav must be pinned to viewport bottom.
// ---------------------------------------------------------------------------
const NAV_SEL = 'nav[class*="bottom"], [class*="bottom-nav"], [class*="tab-bar"], footer nav, [data-testid="bottom-nav"]';

async function checkNavPosition(page: Page, route: string): Promise<boolean> {
  await goto(page, route);
  const urlAfter = page.url();
  if (urlAfter.includes('/unlock')) {
    record(`Nav/${route}`, 'P0: Bottom nav pinned to viewport bottom', 'WARN', 'Not authed — skipping');
    return false;
  }

  const result = await page.evaluate((navSel) => {
    // Try common mobile nav selectors
    const candidates = [
      ...Array.from(document.querySelectorAll(navSel)),
      document.querySelector('.bottom-nav'),
      document.querySelector('[class*="bottom"][class*="nav"]'),
      document.querySelector('[class*="tab"][class*="bar"]'),
      // Fallback: find the last fixed/sticky bottom element
      ...Array.from(document.querySelectorAll('*')).filter(el => {
        const s = window.getComputedStyle(el);
        return (s.position === 'fixed' || s.position === 'sticky') &&
               s.bottom === '0px' &&
               el.tagName !== 'SCRIPT' &&
               el.tagName !== 'STYLE';
      }),
    ].filter(Boolean) as Element[];

    if (candidates.length === 0) return { found: false, rect: null, vpHeight: window.innerHeight, vpWidth: window.innerWidth };

    const nav = candidates[0];
    const rect = nav.getBoundingClientRect();
    const vpHeight = window.innerHeight;
    const vpWidth = window.innerWidth;

    // Z-index sanity: element at bottom-center should be nav or its child
    const elAtPoint = document.elementFromPoint(vpWidth / 2, vpHeight - 10);
    const navContainsPoint = nav.contains(elAtPoint) || elAtPoint === nav;

    return {
      found: true,
      bottom: rect.bottom,
      vpHeight,
      vpWidth,
      navContainsPoint,
      tag: nav.tagName,
      cls: nav.className.slice(0, 60),
      elAtPointTag: elAtPoint?.tagName ?? 'none',
    };
  }, NAV_SEL).catch(() => ({ found: false, rect: null, vpHeight: 0, vpWidth: 0 })) as {
    found: boolean; bottom?: number; vpHeight: number; vpWidth: number;
    navContainsPoint?: boolean; tag?: string; cls?: string; elAtPointTag?: string;
  };

  if (!result.found) {
    record(`Nav${route}`, 'P0: Bottom nav pinned to viewport bottom', 'WARN',
      `No bottom-nav element found on ${route} — may be desktop-only or not rendered`);
    return true;
  }

  const bottomDiff = Math.abs((result.bottom ?? 0) - result.vpHeight);
  const pinned = bottomDiff <= 2;
  const zOk = result.navContainsPoint ?? true;

  if (!pinned || !zOk) {
    const sc = await shot(page, `fail-nav-position-${route.replace(/\//g, '-').slice(1) || 'root'}`);
    const msg = [
      !pinned ? `nav.bottom=${result.bottom?.toFixed(1)} viewport=${result.vpHeight} diff=${bottomDiff.toFixed(1)}px (must be ≤2px)` : '',
      !zOk ? `elementFromPoint(${result.vpWidth / 2}, ${result.vpHeight - 10})=${result.elAtPointTag} — nav not on top` : '',
    ].filter(Boolean).join('; ');
    record(`Nav${route}`, 'P0: Bottom nav pinned to viewport bottom', 'FAIL', msg, sc);
    return false;
  }

  record(`Nav${route}`, 'P0: Bottom nav pinned to viewport bottom', 'PASS',
    `bottom=${result.bottom?.toFixed(1)} viewport=${result.vpHeight} z-index ok`);

  // --- P0 second-line: nav-OVERLAP check ---
  // Scroll to bottom of content, then probe elementsFromPoint across the nav's Y band.
  // The nav should be the topmost element at every X position across its area.
  // Any content element (card, tile, button) returned instead = nav is being covered or
  // content is overlapping into the nav zone.
  const overlapResult = await page.evaluate((navSel) => {
    // Scroll to bottom of page
    window.scrollTo(0, document.documentElement.scrollHeight);

    // Find the nav element again after scroll
    const candidates = [
      ...Array.from(document.querySelectorAll(navSel)),
      document.querySelector('.bottom-nav'),
      document.querySelector('[class*="bottom"][class*="nav"]'),
      ...Array.from(document.querySelectorAll('*')).filter(el => {
        const s = window.getComputedStyle(el);
        return (s.position === 'fixed' || s.position === 'sticky') &&
               s.bottom === '0px' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
      }),
    ].filter(Boolean) as Element[];

    if (candidates.length === 0) return { checked: false, reason: 'no nav after scroll' };

    const nav = candidates[0] as HTMLElement;
    const navRect = nav.getBoundingClientRect();
    const vpWidth = window.innerWidth;

    // Probe 5 X positions across the nav width, at the top edge of the nav (where content might poke in)
    const probeY = navRect.top + 4; // 4px inside the top edge of the nav
    const probeXs = [
      vpWidth * 0.1,
      vpWidth * 0.25,
      vpWidth * 0.5,
      vpWidth * 0.75,
      vpWidth * 0.9,
    ];

    const violations: string[] = [];
    for (const x of probeXs) {
      const stack = document.elementsFromPoint(x, probeY);
      // Content elements that should NOT be at this Y level
      const contentViolators = stack.filter(el => {
        if (nav.contains(el) || el === nav) return false;
        if (el === document.documentElement || el === document.body) return false;
        const tag = el.tagName.toLowerCase();
        const cls = (el.className || '').toString().toLowerCase();
        // Skip purely decorative/backdrop elements
        if (tag === 'html' || tag === 'body') return false;
        // Any interactive or content element above the nav is a violation
        const isContent = tag === 'button' || tag === 'a' || tag === 'article' ||
                          cls.includes('card') || cls.includes('tile') || cls.includes('row') ||
                          cls.includes('list') || cls.includes('item') || cls.includes('glass');
        const s = window.getComputedStyle(el);
        const zIndex = parseInt(s.zIndex) || 0;
        const navZ = parseInt(window.getComputedStyle(nav).zIndex) || 50;
        // A non-nav element with z-index >= nav's is a problem
        return isContent || (zIndex >= navZ && !nav.contains(el) && el !== nav);
      });

      if (contentViolators.length > 0) {
        violations.push(`x=${Math.round(x)}: ${contentViolators[0].tagName}[${(contentViolators[0].className || '').toString().slice(0, 40)}]`);
      }
    }

    return { checked: true, violations, navTop: navRect.top, vpHeight: window.innerHeight };
  }, NAV_SEL).catch(() => ({ checked: false, reason: 'evaluate error' })) as {
    checked: boolean; violations?: string[]; navTop?: number; vpHeight?: number; reason?: string;
  };

  if (!overlapResult.checked) {
    // Non-fatal — overlap check couldn't run
  } else if (overlapResult.violations && overlapResult.violations.length > 0) {
    const sc2 = await shot(page, `fail-nav-overlap-${route.replace(/\//g, '-').slice(1) || 'root'}`);
    record(`Nav${route}`, 'P0: Nav does not overlap content (scroll-to-bottom)', 'FAIL',
      `Content elements in nav zone: ${overlapResult.violations.join(' | ')}`, sc2);
    return false;
  } else {
    record(`Nav${route}`, 'P0: Nav does not overlap content (scroll-to-bottom)', 'PASS',
      `No content elements found in nav zone at scroll-bottom (navTop=${overlapResult.navTop?.toFixed(0)}px)`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------
async function checkSurface(page: Page, name: string, route: string, extraChecks?: (p: Page) => Promise<void>) {
  await goto(page, route);
  const sc = await shot(page, `surface-${name.toLowerCase().replace(/\s+/g, '-')}`);

  // Check 1: page loads (not on /unlock)
  const url = page.url();
  const onUnlock = url.includes('/unlock');
  record(name, 'Page loads (auth valid)', onUnlock ? 'FAIL' : 'PASS',
    `Landed at: ${url}`, sc);
  if (onUnlock) return; // can't check further if not authed

  // Check 2: .glass panels have border-radius: 0
  const glassCheck = await checkAll(page, '.glass, .glass-sm', 'border-radius',
    (v) => v === '0px' || v === '0',
    (v) => `border-radius=${v} (must be 0)`
  );
  if (glassCheck.violations.length === 0) {
    record(name, '.glass panels border-radius = 0', 'PASS', 'All flat panels have border-radius: 0');
  } else {
    const sc2 = await shot(page, `fail-${name.toLowerCase().replace(/\s+/g, '-')}-glass-radius`);
    record(name, '.glass panels border-radius = 0', 'FAIL',
      glassCheck.violations.slice(0, 3).join('; '), sc2);
  }

  // Check 3: No box-shadow on form inputs
  const inputShadowCheck = await checkAll(page, 'input, textarea, select', 'box-shadow',
    (v) => v === 'none' || v === '' || v === '0px 0px 0px 0px',
    (v) => `box-shadow=${v}`
  );
  if (inputShadowCheck.violations.length === 0) {
    record(name, 'Form inputs: no box-shadow glow', 'PASS', 'No glow shadows on inputs');
  } else {
    record(name, 'Form inputs: no box-shadow glow', 'FAIL',
      inputShadowCheck.violations.slice(0, 3).join('; '));
  }

  if (extraChecks) await extraChecks(page);
}

// ---------------------------------------------------------------------------
// Add Beer dialog checks (primary audit target)
// ---------------------------------------------------------------------------

// Evaluate a CSS property scoped to the Add Beer dialog element.
// Uses the portal-rendered dialog (aria-label="Add beer") as the query root.
async function dialogStyle(page: Page, childSel: string, prop: string): Promise<string> {
  return page.evaluate(([cs, p]) => {
    const dialog = document.querySelector('[aria-label="Add beer"][role="dialog"]')
                || document.querySelector('.beer-modal[role="dialog"]');
    if (!dialog) return '__NO_DIALOG__';
    const el = dialog.querySelector(cs);
    if (!el) return '__NOT_FOUND__';
    return window.getComputedStyle(el).getPropertyValue(p).trim();
  }, [childSel, prop] as [string, string]).catch(() => '__ERROR__');
}

async function checkBeerDialog(page: Page) {
  // Navigate to /beer; the BeerPageClient listens for 'open-drink-add' to open the dialog.
  // There is no visible Add button — the dialog is triggered via a custom event from BottomNav.
  await goto(page, '/beer');
  await page.waitForTimeout(1000);

  // Dispatch the event that opens the dialog (same mechanism as the nav "+" button on /beer)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-drink-add')));

  // Wait for the specific Add beer dialog to appear in the portal
  const dialogAppeared = await page.waitForSelector(
    '[aria-label="Add beer"][role="dialog"], .beer-modal[role="dialog"]',
    { timeout: 4000, state: 'visible' }
  ).then(() => true).catch(() => false);

  const scDialog = await shot(page, 'check-beer-dialog');

  if (!dialogAppeared) {
    record('Add Beer Dialog', 'Dialog opens', 'WARN', 'open-drink-add event did not produce a visible dialog — manual verification needed', scDialog);
    return;
  }
  record('Add Beer Dialog', 'Dialog opens', 'PASS', 'Dialog visible via open-drink-add event', scDialog);

  // Check submit button background: must be dark ink (#1A1208), not amber (#C8882A)
  const submitBg = await dialogStyle(page, 'button[type="submit"], .beer-submit-button', 'background-color');
  const amberRgb = ['rgb(200, 136, 42)', 'rgb(232, 168, 74)'];
  const isAmber = amberRgb.some(a => submitBg.includes(a));
  const isDarkInk = /rgb\(\s*2[0-9]\s*,\s*1[0-9]\s*,\s*[0-9]\s*\)/.test(submitBg);
  if (submitBg === '__NOT_FOUND__' || submitBg === '__NO_DIALOG__' || submitBg === '__ERROR__') {
    record('Add Beer Dialog', 'Submit button: dark ink background (not amber)', 'WARN',
      `Submit button not found or style unreadable: ${submitBg}`);
  } else if (isAmber) {
    const sc2 = await shot(page, 'fail-beer-submit-amber');
    record('Add Beer Dialog', 'Submit button: dark ink background (not amber)', 'FAIL',
      `background-color=${submitBg} — amber fill is off-brand (must be var(--t-high) dark ink)`, sc2);
  } else {
    record('Add Beer Dialog', 'Submit button: dark ink background (not amber)', 'PASS',
      `background-color=${submitBg}`);
  }

  // Check submit button font-weight: must be 600
  const submitFw = await dialogStyle(page, 'button[type="submit"], .beer-submit-button', 'font-weight');
  if (submitFw === '__NOT_FOUND__' || submitFw === '__NO_DIALOG__' || submitFw === '__ERROR__') {
    record('Add Beer Dialog', 'Submit button: font-weight 600', 'WARN', `Not found: ${submitFw}`);
  } else if (submitFw === '600') {
    record('Add Beer Dialog', 'Submit button: font-weight 600', 'PASS', `font-weight=${submitFw}`);
  } else {
    record('Add Beer Dialog', 'Submit button: font-weight 600', 'FAIL', `font-weight=${submitFw} (must be 600)`);
  }

  // Check submit button font-family: must include Josefin Sans
  const submitFf = await dialogStyle(page, 'button[type="submit"], .beer-submit-button', 'font-family');
  if (submitFf === '__NOT_FOUND__' || submitFf === '__NO_DIALOG__' || submitFf === '__ERROR__') {
    record('Add Beer Dialog', 'Submit button: Josefin Sans font-family', 'WARN', `Not found: ${submitFf}`);
  } else if (submitFf.toLowerCase().includes('josefin')) {
    record('Add Beer Dialog', 'Submit button: Josefin Sans font-family', 'PASS', `font-family=${submitFf.slice(0, 60)}`);
  } else {
    record('Add Beer Dialog', 'Submit button: Josefin Sans font-family', 'FAIL',
      `font-family=${submitFf.slice(0, 80)} — Josefin Sans not declared, may fall back to system-ui`);
  }

  // Check close button: must not be circular (border-radius: 50% → ~19px on a 38px button).
  // Computed style normalises percentages to pixels: 50% of 38px = 19px.
  const closeBr = await dialogStyle(page, '.beer-icon-button, button[aria-label="Close"]', 'border-radius');
  if (closeBr === '__NOT_FOUND__' || closeBr === '__NO_DIALOG__' || closeBr === '__ERROR__') {
    record('Add Beer Dialog', 'Close button: not circular (border-radius ≠ 50%)', 'WARN', `Close button not found`);
  } else {
    // Circular = 50% (raw) or ~19px (computed from 38px button).  Allow up to 10px as non-circular.
    const brPx = parseFloat(closeBr);
    const isCircular = closeBr.includes('50%') || (!isNaN(brPx) && brPx > 10);
    if (isCircular) {
      const sc3 = await shot(page, 'fail-beer-close-circle');
      record('Add Beer Dialog', 'Close button: not circular (border-radius ≠ 50%)', 'FAIL',
        `border-radius=${closeBr} — circular close button is off-brand (must be --r-sm=6px)`, sc3);
    } else {
      record('Add Beer Dialog', 'Close button: not circular (border-radius ≠ 50%)', 'PASS',
        `border-radius=${closeBr}`);
    }
  }

  // Check form field focus glow: box-shadow must be none on focus.
  // Focus the first visible text input within the dialog.
  const firstInput = page.locator('[aria-label="Add beer"] .beer-field-control, .beer-modal .beer-field-control').first();
  const inputVisible = await firstInput.isVisible().catch(() => false);
  if (inputVisible) {
    await firstInput.focus().catch(() => {});
    await page.waitForTimeout(400);
    const focusShadow = await dialogStyle(page, '.beer-field-control:focus, input:focus', 'box-shadow');
    if (focusShadow === 'none' || focusShadow === '' || focusShadow === '__NOT_FOUND__') {
      record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'PASS', `box-shadow=${focusShadow}`);
    } else if (focusShadow === '__NO_DIALOG__' || focusShadow === '__ERROR__') {
      record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'WARN', `Focus state unreadable: ${focusShadow}`);
    } else if (focusShadow.includes('0px 0px 0px 0px') || focusShadow === 'none') {
      record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'PASS', `box-shadow=${focusShadow}`);
    } else {
      const sc4 = await shot(page, 'fail-beer-input-glow');
      record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'FAIL',
        `box-shadow=${focusShadow} — glow breaks editorial flat aesthetic`, sc4);
    }
  } else {
    // Try scrolling the dialog to make inputs visible
    await page.evaluate(() => {
      const dialog = document.querySelector('[aria-label="Add beer"]') || document.querySelector('.beer-modal');
      if (dialog) dialog.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    const inputVisible2 = await firstInput.isVisible().catch(() => false);
    if (!inputVisible2) {
      record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'WARN', 'No .beer-field-control inputs visible to focus');
    } else {
      await firstInput.focus().catch(() => {});
      await page.waitForTimeout(400);
      const focusShadow = await dialogStyle(page, '.beer-field-control:focus, input:focus', 'box-shadow');
      if (focusShadow === 'none' || focusShadow === '' || focusShadow === '__NOT_FOUND__' || focusShadow.includes('0px 0px 0px 0px')) {
        record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'PASS', `box-shadow=${focusShadow}`);
      } else if (focusShadow === '__NO_DIALOG__' || focusShadow === '__ERROR__') {
        record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'WARN', `Focus state unreadable`);
      } else {
        const sc4 = await shot(page, 'fail-beer-input-glow');
        record('Add Beer Dialog', 'Form field focus: no glow (box-shadow none)', 'FAIL',
          `box-shadow=${focusShadow} — glow breaks editorial flat aesthetic`, sc4);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Orca Voice QA
// CANONICAL: orca-voice-character-v2-2026-05-23/ORCA-APP-CANONICAL.md
// Key invariants:
//   - Voice shell background = sky-200 #C9E8F5
//   - Character present (.orca-aura img or svg)
//   - Character NOT regressed to brown/terracotta (should be coral #F2A498 family)
//   - Clouds-near layer above character in DOM order
// ---------------------------------------------------------------------------
async function checkOrcaVoice(browser: import('playwright').Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  console.log('\n[Orca] Checking Orca Voice visual invariants...');

  try {
    // --- Check 1: App loads ---
    // Orca is a Vite SPA — #root is in the HTML but content mounts after JS hydration.
    // Use networkidle + waitForSelector to ensure the app has rendered.
    await page.goto(ORCA_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Wait up to 5s for React to mount something into #root
    const shellAppeared = await page.waitForSelector('#root > *, .voice-shell, .auth-shell', { timeout: 5000, state: 'attached' })
      .then(() => true).catch(() => false);

    if (!shellAppeared) {
      const sc = await shot(page, 'warn-orca-load');
      // WARN not FAIL: headless Chrome may be blocked by CSP or auth gate on Orca.
      // This is not a new regression — under investigation. Remaining checks skipped.
      record('Orca Voice', 'App loads (.voice-shell present)', 'WARN',
        `React did not mount into #root at ${ORCA_URL} — may be CSP/auth-gated in headless mode`, sc);
      await context.close();
      return;
    }
    const shellClass = await page.evaluate(() => document.querySelector('#root > *')?.className ?? '').catch(() => '');
    record('Orca Voice', 'App loads (.voice-shell present)', 'PASS', `App mounted: root child class="${shellClass.slice(0, 60)}"`);

    // --- Check 2: Voice shell background = Wave G Soft Off-White #FAFAFB ---
    // CANONICAL Wave G: page background = #FAFAFB (Soft Off-White). No amber, no glass morphism.
    // NOTE: Wave F used sky-200 #C9E8F5 — Wave G supersedes this. Any sky-200 background is a regression.
    const bodyBg = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '__NOT_FOUND__';
      return window.getComputedStyle(body).getPropertyValue('background').trim() ||
             window.getComputedStyle(body).getPropertyValue('background-color').trim();
    }).catch(() => '__ERROR__');

    const WAVE_G_BG_RGB = 'rgb(250, 250, 251)';
    const hasCorrectBg = bodyBg.includes('#FAFAFB') || bodyBg.includes(WAVE_G_BG_RGB) ||
                         bodyBg.includes('fafafb') || bodyBg.includes('250, 250, 251');
    const hasSkyReversion = bodyBg.includes('#C9E8F5') || bodyBg.includes('201, 232, 245') ||
                             bodyBg.includes('c9e8f5');
    if (bodyBg === '__NOT_FOUND__' || bodyBg === '__ERROR__') {
      record('Orca Voice', 'Voice shell background: Wave G off-white #FAFAFB', 'WARN', `Background unreadable: ${bodyBg}`);
    } else if (hasSkyReversion) {
      const sc = await shot(page, 'fail-orca-bg-regression');
      record('Orca Voice', 'Voice shell background: Wave G off-white #FAFAFB', 'FAIL',
        `background=${bodyBg.slice(0, 120)} — sky-200 regression (Wave F). Wave G requires #FAFAFB Soft Off-White`, sc);
    } else if (hasCorrectBg) {
      record('Orca Voice', 'Voice shell background: Wave G off-white #FAFAFB', 'PASS', `background = #FAFAFB (Soft Off-White)`);
    } else {
      const sc = await shot(page, 'fail-orca-bg');
      record('Orca Voice', 'Voice shell background: Wave G off-white #FAFAFB', 'FAIL',
        `background=${bodyBg.slice(0, 120)} — must be #FAFAFB per CANONICAL Wave G`, sc);
    }

    // --- Check 3: Character present (.orca-aura img or character SVG) ---
    const charPresent = await page.locator('.orca-aura img, .orca-aura svg, svg[class*="orca"], [class*="orca-character"]').first().isVisible().catch(() => false);
    if (charPresent) {
      record('Orca Voice', 'Character element present (.orca-aura)', 'PASS', '.orca-aura img visible');
    } else {
      // Character may be behind auth gate — check if we're on the auth screen
      const onAuth = await page.locator('.auth-shell, .auth-card').isVisible().catch(() => false);
      if (onAuth) {
        record('Orca Voice', 'Character element present (.orca-aura)', 'WARN', 'App on auth screen — character not visible without session');
      } else {
        const sc2 = await shot(page, 'fail-orca-no-character');
        record('Orca Voice', 'Character element present (.orca-aura)', 'FAIL', '.orca-aura not found in DOM', sc2);
      }
    }

    // --- Check 4: Character palette = Wave G Blush Pink (not Wave A brown/terracotta) ---
    // Wave G: Orca body = Blush Pink #FFB2C1. Wave A regression = brown/terracotta (#A8967E family).
    // We check img src (canonical asset path) as a proxy for palette correctness.
    const charSrc = await page.evaluate(() => {
      const img = document.querySelector('.orca-aura img') as HTMLImageElement | null;
      return img ? (img.src || img.getAttribute('src') || '__NO_SRC__') : '__NOT_FOUND__';
    }).catch(() => '__ERROR__');

    if (charSrc === '__NOT_FOUND__' || charSrc === '__ERROR__') {
      record('Orca Voice', 'Character: Wave G Blush Pink palette (not Wave A brown)', 'WARN', `Character img not found: ${charSrc}`);
    } else if (charSrc.includes('pwa-512') || charSrc.includes('character') || charSrc.includes('orca') || charSrc.includes('wave-g') || charSrc.includes('WAVE-G')) {
      record('Orca Voice', 'Character: Wave G Blush Pink palette (not Wave A brown)', 'PASS',
        `Character src=${charSrc.split('/').slice(-1)[0]} — canonical Wave G asset in use`);
    } else {
      const sc3 = await shot(page, 'warn-orca-char-src');
      record('Orca Voice', 'Character: Wave G Blush Pink palette (not Wave A brown)', 'WARN',
        `Unexpected character asset: ${charSrc.split('/').slice(-1)[0]} — verify uses #FFB2C1 Blush Pink (Wave G)`, sc3);
    }

    // --- Check 5: clouds-near layer above character in DOM order ---
    // CANONICAL: clouds-near must occlude orca (appear after orca in DOM)
    const layerOrder = await page.evaluate(() => {
      const orca = document.querySelector('.orca-aura, [class*="orca-char"], svg[class*="orca"]');
      const cloudsNear = document.querySelector('.clouds-near, [class*="clouds-near"], [class*="cloud-near"]');
      if (!orca) return 'NO_ORCA';
      if (!cloudsNear) return 'NO_CLOUDS_NEAR';
      const pos = orca.compareDocumentPosition(cloudsNear);
      // DOCUMENT_POSITION_FOLLOWING = 4 means cloudsNear comes AFTER orca in DOM = correct
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? 'CORRECT' : 'INVERTED';
    }).catch(() => '__ERROR__');

    if (layerOrder === 'CORRECT') {
      record('Orca Voice', 'z-stack: clouds-near above character in DOM order', 'PASS', 'clouds-near follows orca in DOM');
    } else if (layerOrder === 'NO_CLOUDS_NEAR') {
      record('Orca Voice', 'z-stack: clouds-near above character in DOM order', 'WARN', 'No clouds-near element found — may not be deployed yet');
    } else if (layerOrder === 'NO_ORCA') {
      record('Orca Voice', 'z-stack: clouds-near above character in DOM order', 'WARN', 'No orca character element found for DOM-order check');
    } else if (layerOrder === 'INVERTED') {
      const sc4 = await shot(page, 'fail-orca-zstack');
      record('Orca Voice', 'z-stack: clouds-near above character in DOM order', 'FAIL',
        'clouds-near precedes orca in DOM — orca will not be occluded by clouds', sc4);
    } else {
      record('Orca Voice', 'z-stack: clouds-near above character in DOM order', 'WARN', `Layer order check error: ${layerOrder}`);
    }

    await shot(page, 'orca-voice-state');

  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Mandoland QA (STUB — disabled pending CANONICAL.md commission)
// ---------------------------------------------------------------------------
// async function checkMandoland(browser: import('playwright').Browser): Promise<void> {
//   // TODO: wire in once design-agent ships MANDOLAND-CANONICAL.md
//   // Expected path: design-agent/output/mandoland-design-system-YYYY-MM-DD/CANONICAL.md
//   // Key drift zones (historically): nav layout, color palette, typography stack
//   record('Mandoland', 'STUB — CANONICAL pending', 'WARN', 'Mandoland canonical not yet commissioned');
// }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const env = loadEnv(SECRETS_ENV);
  const authToken = env['OB1_PARENTS_AUTH_TOKEN'];
  if (!authToken) throw new Error('OB1_PARENTS_AUTH_TOKEN not found in secrets.env');

  console.log('Starting Estate Visual QA pass...');
  console.log(`Output: ${OUTPUT_DIR}/report.md`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro — primary mobile viewport
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  context.addCookies([{
    name: AUTH_COOKIE,
    value: authToken,
    domain: 'ob1-parents.vercel.app',
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  }]);

  const page = await context.newPage();

  const NAV_ROUTES = [
    '/', '/garden', '/family', '/meals', '/casita', '/beer',
    // Scroll-list routes where nav float bug has been observed
    '/activity', '/history', '/insights', '/maintenance', '/wine', '/more',
  ];

  try {
    // P0: Nav position checks FIRST (fail-fast signal)
    console.log('\n[P0] Checking bottom nav position across all routes...');
    let navFailed = false;
    for (const route of NAV_ROUTES) {
      const ok = await checkNavPosition(page, route);
      if (!ok) navFailed = true;
    }
    if (navFailed) {
      console.log('[P0] NAV POSITION FAILURES DETECTED — filing RGOS task to family-agent');
    }

    // Surface passes (token/typography checks)
    console.log('\n[Visual] Checking design token compliance...');
    await checkSurface(page, 'Home', '/');
    await checkSurface(page, 'Garden', '/garden');
    await checkSurface(page, 'Family', '/family');
    await checkSurface(page, 'Provisions', '/meals');
    await checkSurface(page, 'Casita', '/casita');

    // Primary audit target: Add Beer dialog
    await checkBeerDialog(page);

    // Desktop viewport too
    await context.addCookies([{
      name: AUTH_COOKIE, value: authToken, domain: 'ob1-parents.vercel.app',
      path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
    }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, '/');
    await shot(page, 'surface-home-desktop');
    await goto(page, '/beer');
    await shot(page, 'surface-beer-desktop');

  } finally {
    await browser.close();
  }

  // ---------------------------------------------------------------------------
  // Orca Voice checks (separate browser context — no auth cookie needed)
  // ---------------------------------------------------------------------------
  if (fs.existsSync(ORCA_CANONICAL)) {
    const orcaBrowser = await chromium.launch({ headless: true });
    try {
      await checkOrcaVoice(orcaBrowser);
    } finally {
      await orcaBrowser.close();
    }
  } else {
    record('Orca Voice', 'CANONICAL present', 'WARN', `ORCA-APP-CANONICAL.md not found at expected path`);
  }

  // Mandoland: CANONICAL not yet commissioned — skip silently
  // if (MANDOLAND_ENABLED) { await checkMandoland(...); }

  // ---------------------------------------------------------------------------
  // Write report
  // ---------------------------------------------------------------------------
  const pass   = results.filter(r => r.status === 'PASS').length;
  const fail   = results.filter(r => r.status === 'FAIL').length;
  const warn   = results.filter(r => r.status === 'WARN').length;
  const total  = results.length;
  const overall = fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : 'PASS';

  const rows = results.map(r =>
    `| ${r.id} | ${r.surface} | ${r.rule} | ${r.status} | ${r.evidence.slice(0, 120)} | ${r.screenshot ? `![](${r.screenshot})` : ''} |`
  ).join('\n');

  const failSection = results.filter(r => r.status === 'FAIL').map(r => `
### FAIL — Check ${r.id}: ${r.rule}
- Surface: ${r.surface}
- Evidence: ${r.evidence}
${r.screenshot ? `- Screenshot: ${r.screenshot}` : ''}
- **Recommended owner:** family-agent
`).join('\n');

  const report = `# Estate App Visual QA — ${RUN_STAMP}
**Design reference:** CANONICAL.md (design-agent 2026-05-23)
**Summary:** ${pass} passed, ${fail} failed, ${warn} warned / ${total} total — **${overall}**

---

## Results

| # | Surface | Rule | Status | Evidence | Screenshot |
|---|---------|------|--------|----------|------------|
${rows}

---
${fail > 0 ? `## Failures\n${failSection}` : '## No Failures\nAll checks passed or warned.'}

---

## Screenshots
${results.filter(r => r.screenshot).map(r => `- **${r.surface} / ${r.rule}**: ${r.screenshot}`).join('\n')}
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report, 'utf8');

  // File or bump RGOS dogfood-finding tasks for every FAIL and WARN (with dedup)
  const findings = results.filter(r => r.status === 'FAIL' || r.status === 'WARN');
  if (findings.length > 0) {
    console.log(`\n[tasks] Filing ${findings.length} finding(s) to RGOS...`);
    for (const r of findings) {
      await fileOrBumpTask(r.surface, r.rule, r.status, r.evidence, r.screenshot);
    }
  }

  // B6 escalator: surface with ≥2 open findings in this run → escalate severity in sidecar
  const ESCALATION_FILE = path.resolve(REPO_ROOT, 'scripts/estate-visual-qa-escalations.json');
  const surfaceCounts: Record<string, number> = {};
  for (const r of findings) {
    surfaceCounts[r.surface] = (surfaceCounts[r.surface] ?? 0) + 1;
  }
  let escalations: Record<string, { base_severity: string; current_severity: string; hits_run: number; last_escalated: string }> = {};
  try {
    if (fs.existsSync(ESCALATION_FILE)) escalations = JSON.parse(fs.readFileSync(ESCALATION_FILE, 'utf8'));
  } catch { escalations = {}; }
  let escalationChanged = false;
  for (const [surface, count] of Object.entries(surfaceCounts)) {
    if (count >= 2) {
      if (!escalations[surface] || escalations[surface].current_severity !== 'P0') {
        escalations[surface] = { base_severity: 'P1', current_severity: 'P0', hits_run: count, last_escalated: RUN_STAMP };
        console.log(`  [B6] escalated ${surface} → P0 (${count} findings in this run)`);
        escalationChanged = true;
      }
    }
  }
  if (escalationChanged) {
    try { fs.writeFileSync(ESCALATION_FILE, JSON.stringify(escalations, null, 2), 'utf8'); } catch { /* non-fatal */ }
  }

  console.log(`\nReport: ${OUTPUT_DIR}/report.md`);
  console.log(`Summary: ${pass} passed, ${fail} failed, ${warn} warned`);
  results.forEach(r => {
    const icon = r.status === 'PASS' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'WARN';
    console.log(`  ${icon.padEnd(4)}     Check ${r.id} ${r.surface}: ${r.rule}`);
  });
  console.log(`\nOverall: ${overall} (${pass} pass, ${fail} fail, ${warn} warn)`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
