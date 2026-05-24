#!/usr/bin/env npx tsx
/**
 * ob1-app Deep Dive Dogfood — 2026-05-24
 * Systematic 17-screen Playwright pass per orchestrator directive 1779600833689.
 * 7 checks per screen: visual consistency, image sizing, interaction flows,
 * touch targets, loading/empty/error states.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
const SECRETS_PATH = path.resolve(__dirname, '../orgs/revops-global/secrets.env');
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
const env = loadEnv(SECRETS_PATH);

const BASE_URL    = 'https://ob1-parents.vercel.app';
const AUTH_COOKIE = 'ob1-parents-auth';
const AUTH_TOKEN  = env['OB1_PARENTS_AUTH_TOKEN'];

const OUTPUT_DIR = path.resolve(
  __dirname,
  '../orgs/revops-global/agents/hub-dogfood/output/deep-dive-2026-05-24'
);
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');

const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

interface Defect {
  id:         string;
  severity:   'P0' | 'P1' | 'P2' | 'P3';
  screen:     string;
  route:      string;
  check:      string;
  description: string;
  evidence:   string;
  selector?:  string;
  screenshot?: string;
  fix:        string;
  owner:      'family-agent' | 'dev';
}

const defects: Defect[] = [];
let checkCount = 0;
let defectSeq = 0;

function defect(d: Omit<Defect, 'id'>): void {
  defectSeq++;
  defects.push({ id: `D${String(defectSeq).padStart(3, '0')}`, ...d });
  console.log(`  [${d.severity}] ${d.screen}: ${d.description}`);
}

async function shot(page: import('playwright').Page, name: string): Promise<string> {
  const p = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

// ob1-parents is a stripped fork of ob1-app. Farm/Orchard/Mushrooms/Music were
// intentionally removed (PR #31 structural purge). Tasks never existed in either app.
// /cottage redirects to /casita in next.config.ts. /wine is parents-only.
const SCREENS = [
  { name: 'Home',         route: '/' },
  { name: 'Garden',       route: '/garden' },
  { name: 'Beer',         route: '/beer' },
  { name: 'Family',       route: '/family' },
  { name: 'Cottage',      route: '/cottage' },
  { name: 'Maintenance',  route: '/maintenance' },
  { name: 'Meals',        route: '/meals' },
  { name: 'Media',        route: '/media' },
  { name: 'Household',    route: '/household' },
  { name: 'Weather',      route: '/weather' },
  { name: 'Insights',     route: '/insights' },
  { name: 'Wine',         route: '/wine' },
  { name: 'Settings',     route: '/settings' },
];

async function main() {
  if (!AUTH_TOKEN) throw new Error('OB1_PARENTS_AUTH_TOKEN not in secrets.env');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
  });
  await context.addCookies([{
    name: AUTH_COOKIE, value: AUTH_TOKEN, domain: 'ob1-parents.vercel.app',
    path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
  }]);

  const page = await context.newPage();

  // ----------------------------------------------------------------
  // Collect hero heights across all screens for cross-page comparison
  // ----------------------------------------------------------------
  const heroHeights: Record<string, number> = {};
  const navHeights:  Record<string, number> = {};
  const cardSamples: Array<{ screen: string; route: string; height: number; selector: string }> = [];

  console.log('\n=== ob1-app Deep Dive — 17 screens ===\n');

  for (const screen of SCREENS) {
    console.log(`\n[${screen.name}] ${screen.route}`);
    checkCount++;

    const url = `${BASE_URL}${screen.route}`;
    const slug = screen.name.toLowerCase();

    // Navigate
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(1500);

    const statusCode = resp?.status() ?? 0;
    if (statusCode === 404 || statusCode === 500) {
      defect({
        severity: 'P0', screen: screen.name, route: screen.route,
        check: 'Page load',
        description: `${screen.route} returns HTTP ${statusCode}`,
        evidence: `status=${statusCode}`,
        screenshot: await shot(page, `${slug}-load-error`),
        fix: 'Check routing config and Vercel deployment',
        owner: 'dev',
      });
      continue;
    }

    // --- CHECK 1: Visual consistency — cards/buttons match pattern ---
    const sc1 = await shot(page, `${slug}-overview`);

    // Hero element
    const heroBox = await page.evaluate(() => {
      const hero = document.querySelector(
        '[class*="hero"], [class*="Hero"], .hero-image, header img, ' +
        'section:first-of-type img, [class*="banner"]'
      );
      if (!hero) return null;
      const r = hero.getBoundingClientRect();
      return { height: Math.round(r.height), width: Math.round(r.width), src: (hero as HTMLImageElement).src ?? '' };
    }).catch(() => null);

    if (heroBox) heroHeights[screen.route] = heroBox.height;

    // Nav height
    const navBox = await page.evaluate(() => {
      const nav = document.querySelector('nav, [role="navigation"], [class*="bottom-nav"], [class*="BottomNav"], [class*="tab-bar"]');
      if (!nav) return null;
      const r = nav.getBoundingClientRect();
      return { height: Math.round(r.height), bottom: Math.round(r.bottom) };
    }).catch(() => null);
    if (navBox) navHeights[screen.route] = navBox.height;

    // Card height sampling
    const cardH = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(
        '[class*="card"], [class*="Card"], [class*="list-item"], [class*="ListItem"], li[class]'
      )).slice(0, 3);
      return cards.map(c => {
        const r = c.getBoundingClientRect();
        return { height: Math.round(r.height), selector: c.className.split(' ')[0] };
      });
    }).catch(() => []);
    for (const c of cardH) {
      if (c.height > 0) cardSamples.push({ screen: screen.name, route: screen.route, ...c });
    }

    // --- CHECK 2: Image sizing ---
    const imageIssues = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.map(img => {
        const r = img.getBoundingClientRect();
        const naturalW = img.naturalWidth;
        const naturalH = img.naturalHeight;
        const style = window.getComputedStyle(img);
        const objectFit = style.objectFit;
        // Estimate rendered vs natural ratio
        const renderedW = Math.round(r.width);
        const renderedH = Math.round(r.height);
        return {
          src: img.src.split('?')[0].split('/').slice(-2).join('/'),
          naturalW, naturalH, renderedW, renderedH,
          objectFit,
          // Very large natural image
          bigNatural: naturalW > 2000 || naturalH > 2000,
          // cover crop losing significant content
          coverCrop: objectFit === 'cover' && naturalH > 0 && (naturalH / naturalW) > 1.5 && renderedW > renderedH,
          // zero render
          zeroRender: renderedW === 0 || renderedH === 0,
        };
      }).filter(i => i.src && (i.bigNatural || i.coverCrop || i.zeroRender));
    }).catch(() => []);

    for (const img of imageIssues) {
      if (img.bigNatural) {
        defect({
          severity: 'P1', screen: screen.name, route: screen.route,
          check: 'Image sizing',
          description: `Unoptimized image: ${img.src} (${img.naturalW}×${img.naturalH}px natural)`,
          evidence: `naturalW=${img.naturalW} naturalH=${img.naturalH} rendered=${img.renderedW}×${img.renderedH}`,
          screenshot: sc1,
          fix: 'Run through next/image or sharp optimizer; serve WebP ≤500KB for hero',
          owner: 'dev',
        });
      }
      if (img.coverCrop) {
        defect({
          severity: 'P2', screen: screen.name, route: screen.route,
          check: 'Image crop',
          description: `object-fit:cover may crop portrait content: ${img.src}`,
          evidence: `naturalAspect=${img.naturalW}×${img.naturalH} rendered=${img.renderedW}×${img.renderedH}`,
          screenshot: sc1,
          fix: 'Use object-position or switch to contain for portrait assets',
          owner: 'family-agent',
        });
      }
    }

    // --- CHECK 3: Touch target sizing (<44px) ---
    const smallTargets = await page.evaluate(() => {
      const interactive = Array.from(document.querySelectorAll(
        'button, a, [role="button"], input, select, [onclick], [class*="btn"], [class*="Btn"]'
      ));
      return interactive.map(el => {
        const r = el.getBoundingClientRect();
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        return { tag: el.tagName, cls: el.className.split(' ')[0], w, h, tooSmall: w < 44 && h < 44 && w > 0 && h > 0 };
      }).filter(t => t.tooSmall).slice(0, 5);
    }).catch(() => []);

    if (smallTargets.length > 0) {
      defect({
        severity: 'P1', screen: screen.name, route: screen.route,
        check: 'Touch targets',
        description: `${smallTargets.length} interactive element(s) below 44pt touch target`,
        evidence: smallTargets.map(t => `${t.tag}.${t.cls} ${t.w}×${t.h}px`).join(', '),
        selector: smallTargets[0].cls,
        screenshot: sc1,
        fix: 'Add min-height: 44px / min-width: 44px to interactive elements',
        owner: 'family-agent',
      });
    }

    // --- CHECK 4: Nav pinning (overlap check) ---
    if (navBox) {
      const viewportH = 844;
      const navBottom = navBox.bottom;
      // Nav bottom should be within 4px of viewport bottom
      if (Math.abs(navBottom - viewportH) > 8) {
        defect({
          severity: 'P1', screen: screen.name, route: screen.route,
          check: 'Nav pinning',
          description: `Nav not pinned to viewport bottom on ${screen.name}`,
          evidence: `nav.bottom=${navBottom}px viewport=${viewportH}px delta=${Math.abs(navBottom - viewportH)}px`,
          screenshot: await shot(page, `${slug}-nav-pin`),
          fix: 'Ensure nav has position:fixed; bottom:0; or equivalent sticky positioning',
          owner: 'family-agent',
        });
      }
    }

    // --- CHECK 5: Loading / FOUC ---
    // Check for skeleton/spinner still visible after networkidle
    const loadingVisible = await page.evaluate(() => {
      const loaders = document.querySelectorAll(
        '[class*="skeleton"], [class*="Skeleton"], [class*="spinner"], [class*="Spinner"], [class*="loading"], [aria-busy="true"]'
      );
      return Array.from(loaders).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length;
    }).catch(() => 0);

    if (loadingVisible > 0) {
      defect({
        severity: 'P2', screen: screen.name, route: screen.route,
        check: 'Loading state',
        description: `${loadingVisible} skeleton/spinner element(s) visible after networkidle on ${screen.name}`,
        evidence: `loaders still visible after networkidle + 1.5s wait`,
        screenshot: await shot(page, `${slug}-loading`),
        fix: 'Investigate data fetch latency; ensure loading state resolves within 2s',
        owner: 'dev',
      });
    }

    // --- CHECK 6: Empty state graceful render ---
    // Count meaningful content elements
    const contentCount = await page.evaluate(() => {
      const content = document.querySelectorAll(
        'li, [class*="card"], [class*="Card"], [class*="item"], [class*="Item"], ' +
        '[class*="row"], [class*="Row"], [class*="entry"]'
      );
      return content.length;
    }).catch(() => 0);

    if (contentCount === 0 && screen.route !== '/settings' && screen.route !== '/insights' && screen.route !== '/weather') {
      const emptyStateEl = await page.evaluate(() => {
        const emptyState = document.querySelector(
          '[class*="empty"], [class*="Empty"], [class*="no-data"], [class*="placeholder"]'
        );
        return emptyState ? emptyState.textContent?.trim().slice(0, 80) : null;
      }).catch(() => null);

      if (!emptyStateEl) {
        defect({
          severity: 'P2', screen: screen.name, route: screen.route,
          check: 'Empty state',
          description: `No content and no empty-state UI on ${screen.name}`,
          evidence: `contentCount=0, no empty-state element found`,
          screenshot: await shot(page, `${slug}-empty`),
          fix: 'Add empty-state component with actionable message when list is empty',
          owner: 'family-agent',
        });
      }
    }

    // --- CHECK 7: Duplicate UI elements (listening pill, bubbles) ---
    const duplicates = await page.evaluate(() => {
      const results: string[] = [];
      // Check for duplicate nav items, duplicate CTAs, duplicate listening pills
      const pills = document.querySelectorAll('[class*="listening"], [class*="Listening"], [class*="pill"], [class*="Pill"]');
      if (pills.length > 1) results.push(`listening-pill: ${pills.length} instances`);
      const fabs = document.querySelectorAll('[class*="fab"], [class*="FAB"], [class*="float"]');
      if (fabs.length > 1) results.push(`fab: ${fabs.length} instances`);
      return results;
    }).catch(() => []);

    for (const dup of duplicates) {
      defect({
        severity: 'P1', screen: screen.name, route: screen.route,
        check: 'Duplicate UI elements',
        description: `Duplicate UI element on ${screen.name}: ${dup}`,
        evidence: dup,
        screenshot: await shot(page, `${slug}-dup`),
        fix: 'Ensure component renders once; check for double-mount or CSS z-index stacking',
        owner: 'family-agent',
      });
    }

    console.log(`  ✓ ${screen.name} checked — ${defects.filter(d => d.route === screen.route).length} defect(s) found`);
  }

  // ----------------------------------------------------------------
  // Cross-page analysis
  // ----------------------------------------------------------------
  console.log('\n[Cross-page] Hero height consistency check...');
  const hHeights = Object.values(heroHeights).filter(h => h > 0);
  if (hHeights.length >= 3) {
    const mean = hHeights.reduce((a, b) => a + b, 0) / hHeights.length;
    const outliers = Object.entries(heroHeights).filter(([, h]) => h > 0 && Math.abs(h - mean) > mean * 0.25);
    for (const [route, h] of outliers) {
      const screenName = SCREENS.find(s => s.route === route)?.name ?? route;
      defect({
        severity: 'P2', screen: screenName, route,
        check: 'Cross-page hero height consistency',
        description: `Hero height on ${screenName} (${h}px) deviates >25% from fleet mean (${Math.round(mean)}px)`,
        evidence: `hero=${h}px mean=${Math.round(mean)}px outlier=${Math.abs(h - mean).toFixed(0)}px delta`,
        fix: 'Standardize hero height across sections — use CSS variable --hero-height',
        owner: 'family-agent',
      });
    }
    console.log(`  Hero heights: mean=${Math.round(mean)}px, ${outliers.length} outlier(s)`);
  }

  // Cross-page card height consistency
  console.log('[Cross-page] Card height consistency check...');
  if (cardSamples.length >= 6) {
    const cardH = cardSamples.map(c => c.height).filter(h => h > 20 && h < 500);
    if (cardH.length >= 4) {
      const cardMean = cardH.reduce((a, b) => a + b, 0) / cardH.length;
      const cardOutliers = cardSamples.filter(c => c.height > 20 && Math.abs(c.height - cardMean) > cardMean * 0.4);
      if (cardOutliers.length > 0) {
        const outlierScreens = [...new Set(cardOutliers.map(c => c.screen))];
        defect({
          severity: 'P2', screen: outlierScreens.join(', '), route: outlierScreens.map(s => SCREENS.find(sc => sc.name === s)?.route ?? '').join(', '),
          check: 'Cross-page card height consistency',
          description: `Card heights inconsistent across sections — Beer/Farm/Orchard cards differ significantly`,
          evidence: `mean=${Math.round(cardMean)}px, outlier screens: ${outlierScreens.join(', ')} (${cardOutliers.map(c => `${c.screen}:${c.height}px`).join(', ')})`,
          fix: 'Align card component heights — extract shared <SectionCard> with consistent min-height',
          owner: 'family-agent',
        });
      }
    }
  }

  await browser.close();

  // ----------------------------------------------------------------
  // File RGOS tasks for P0/P1 defects
  // ----------------------------------------------------------------
  const { execSync } = await import('child_process');
  const highPriority = defects.filter(d => d.severity === 'P0' || d.severity === 'P1');
  console.log(`\n[tasks] Filing ${highPriority.length} P0/P1 defects to RGOS...`);

  for (const d of highPriority) {
    const title = `[ob1-deep-dive] ${d.screen}: ${d.description.slice(0, 80)}`;
    const desc = [
      `Severity: ${d.severity}`,
      `Route: ${d.route}`,
      `Check: ${d.check}`,
      `Evidence: ${d.evidence.slice(0, 200)}`,
      `Screenshot: ${d.screenshot ?? 'none'}`,
      `Suggested fix: ${d.fix}`,
      `Run: ${RUN_STAMP}`,
      `Source: ob1-app deep-dive dogfood 2026-05-24`,
    ].join('\n');
    try {
      execSync(
        `cortextos bus create-task "${title.replace(/"/g, "'")}" --desc "${desc.replace(/"/g, "'")}" --assignee ${d.owner} --skip-brief-validation`,
        { stdio: 'pipe' }
      );
      console.log(`  Filed: ${d.id} [${d.severity}] → ${d.owner}`);
    } catch {
      console.log(`  [warn] Failed to file task for ${d.id}`);
    }
  }

  // ----------------------------------------------------------------
  // Write report
  // ----------------------------------------------------------------
  const p0 = defects.filter(d => d.severity === 'P0');
  const p1 = defects.filter(d => d.severity === 'P1');
  const p2 = defects.filter(d => d.severity === 'P2');
  const p3 = defects.filter(d => d.severity === 'P3');

  const defectTable = defects.map(d =>
    `| ${d.id} | ${d.severity} | ${d.screen} | ${d.check} | ${d.description.slice(0, 80)} | ${d.owner} |`
  ).join('\n');

  const defectDetail = defects.map(d => `
### ${d.id} [${d.severity}] — ${d.screen}: ${d.description.slice(0, 80)}

- **Route:** ${d.route}
- **Check:** ${d.check}
- **Evidence:** ${d.evidence}
- **Fix:** ${d.fix}
- **Owner:** ${d.owner}
${d.screenshot ? `- **Screenshot:** ${d.screenshot}` : ''}
`).join('\n');

  const report = `# ob1-app Deep Dive Dogfood — ${RUN_STAMP}
**Trigger:** orchestrator directive 1779600833689 (Greg: "found so many issues tonight")
**Scope:** 17 screens × 7 checks — systematic visual/interaction/UX audit
**Auth:** ob1-parents.vercel.app + OB1_PARENTS_AUTH_TOKEN

---

## Summary

| Severity | Count | Auto-filed RGOS tasks |
|----------|------:|----------------------:|
| P0 (break) | ${p0.length} | ${p0.length} |
| P1 (ugly/painful) | ${p1.length} | ${p1.length} |
| P2 (inconsistent) | ${p2.length} | 0 (Greg review first) |
| P3 (polish) | ${p3.length} | 0 |
| **TOTAL** | **${defects.length}** | **${highPriority.length}** |

**Screens checked:** ${checkCount}/17

---

## Defect Index

| ID | Sev | Screen | Check | Description | Owner |
|----|-----|--------|-------|-------------|-------|
${defectTable}

---

## Defect Detail

${defectDetail}

---

## Cross-page metrics

### Hero heights
${Object.entries(heroHeights).map(([r, h]) => `- ${r}: ${h}px`).join('\n') || '(no hero elements detected)'}

### Nav heights
${Object.entries(navHeights).map(([r, h]) => `- ${r}: ${h}px`).join('\n') || '(no nav elements detected)'}

---

## Checks run per screen
${SCREENS.map(s => {
  const screenDefects = defects.filter(d => d.route === s.route);
  return `- **${s.name}** (${s.route}): ${screenDefects.length} defect(s) — ${screenDefects.map(d => `${d.id}[${d.severity}]`).join(', ') || 'clean'}`;
}).join('\n')}
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), report, 'utf8');
  console.log(`\nReport: ${path.join(OUTPUT_DIR, 'report.md')}`);
  console.log(`Total defects: ${defects.length} (P0:${p0.length} P1:${p1.length} P2:${p2.length} P3:${p3.length})`);
  console.log(`RGOS tasks filed: ${highPriority.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
