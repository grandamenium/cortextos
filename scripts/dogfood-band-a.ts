#!/usr/bin/env node
/**
 * Band A dogfood validation checks.
 *
 * Static PR gates run by default in CI:
 *   - CSS blast-radius evidence gate
 *   - asset existence / hash contract
 *
 * Live gates run when URLs/session state are provided:
 *   - nav pixel-drift across sibling routes
 *   - authenticated voice smoke
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

interface AssetEntry {
  surface: string;
  path: string;
  expectedMd5?: string;
  sourceId?: string;
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-a', RUN_STAMP);

const args = new Set(process.argv.slice(2));
const staticOnly = args.has('--static');
const updateAssetContract = args.has('--update-asset-contract');
const results: CheckResult[] = [];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function record(result: CheckResult): void {
  results.push(result);
  const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : result.status === 'WARN' ? '!' : '-';
  console.log(`${result.status.padEnd(4)} ${icon} ${fingerprint(result)}`);
  if (result.status !== 'PASS') console.log(`       ${result.evidence}`);
}

function md5File(filePath: string): string {
  return createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function isInsideRepo(filePath: string): boolean {
  const rel = path.relative(REPO_ROOT, path.resolve(filePath));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function gitChangedFiles(): string[] {
  if (process.env.DOGFOOD_CHANGED_FILES) {
    return process.env.DOGFOOD_CHANGED_FILES.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  }

  const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  for (const args of [['diff', '--name-only', `${baseRef}...HEAD`], ['diff', '--name-only', 'HEAD~1...HEAD']]) {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
    } catch {
      // Try the next strategy.
    }
  }
  return [];
}

function hasSiblingEvidence(): boolean {
  const evidenceDir = process.env.DOGFOOD_SIBLING_DIFF_DIR
    ? path.resolve(process.env.DOGFOOD_SIBLING_DIFF_DIR)
    : path.resolve(REPO_ROOT, 'dogfood-evidence');
  if (!fs.existsSync(evidenceDir)) return false;
  const files = fs.readdirSync(evidenceDir, { recursive: true }).map(String);
  return files.some(file => /\.(png|jpg|jpeg|webp|json|md)$/i.test(file));
}

function runCssBlastRadiusCheck(): void {
  const changed = gitChangedFiles();
  const styleCandidates = changed.filter(file => {
    if (!/\.(css|scss|sass|less|tsx|jsx|ts|js)$/.test(file)) return false;
    if (/\.(test|spec)\.[tj]sx?$/.test(file)) return false;
    const lower = file.toLowerCase();
    if (/(nav|menu|hero|layout|sidebar|sheet|drawer|shell|app\/\(dashboard\))/.test(lower)) return true;
    if (!fs.existsSync(path.resolve(REPO_ROOT, file))) return false;
    const body = fs.readFileSync(path.resolve(REPO_ROOT, file), 'utf8');
    return /\b(className|style)=/.test(body) && /(nav|menu|hero|sidebar|fixed|sticky|bottom-|top-|z-)/i.test(body);
  });

  if (styleCandidates.length === 0) {
    record({
      id: 'css-blast-radius',
      surface: 'dogfood',
      route: 'pull-request',
      status: 'PASS',
      severity: 'P0',
      check_label: 'CSS blast-radius evidence gate',
      evidence: 'No nav/menu/hero/sidebar style files changed.',
    });
    return;
  }

  const evidenceFound = hasSiblingEvidence();
  record({
    id: 'css-blast-radius',
    surface: 'dogfood',
    route: 'pull-request',
    status: evidenceFound ? 'PASS' : 'FAIL',
    severity: 'P0',
    check_label: 'CSS blast-radius evidence gate',
    evidence: evidenceFound
      ? `Style-risk files changed and sibling diff evidence is present: ${styleCandidates.join(', ')}`
      : `Style-risk files changed without sibling-page diff evidence: ${styleCandidates.join(', ')}. Add screenshots/report under dogfood-evidence/ or set DOGFOOD_SIBLING_DIFF_DIR.`,
  });
}

function readAssetContract(): AssetEntry[] {
  const contractPath = process.env.DOGFOOD_ASSET_CONTRACT
    ? path.resolve(process.env.DOGFOOD_ASSET_CONTRACT)
    : path.resolve(REPO_ROOT, 'scripts/dogfood-band-a-assets.json');
  if (!fs.existsSync(contractPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as { assets?: AssetEntry[] } | AssetEntry[];
  return Array.isArray(parsed) ? parsed : parsed.assets ?? [];
}

function discoverDashboardAssets(): AssetEntry[] {
  const candidates = [
    'dashboard/src/app/icon.svg',
    'dashboard/src/app/favicon.ico',
    'dashboard/public/next.svg',
    'dashboard/public/vercel.svg',
  ];
  return candidates
    .filter(file => fs.existsSync(path.resolve(REPO_ROOT, file)))
    .map(file => ({ surface: 'agentops', path: file, sourceId: file.includes('icon') ? 'dashboard-app-icon' : undefined }));
}

function runAssetChecks(): void {
  const configured = readAssetContract();
  const assets = configured.length > 0 ? configured : discoverDashboardAssets();
  const hashLines: string[] = [];
  let failures = 0;

  for (const asset of assets) {
    const filePath = path.resolve(REPO_ROOT, asset.path);
    if (!isInsideRepo(filePath) || !fs.existsSync(filePath)) {
      failures += 1;
      hashLines.push(`${asset.surface}:${asset.path}=MISSING`);
      continue;
    }
    const size = fs.statSync(filePath).size;
    const md5 = size > 0 ? md5File(filePath) : 'EMPTY';
    hashLines.push(`${asset.surface}:${asset.path} md5=${md5} source=${asset.sourceId ?? 'n/a'}`);
    if (size === 0 || (asset.expectedMd5 && asset.expectedMd5 !== md5)) failures += 1;
    if (updateAssetContract) asset.expectedMd5 = md5;
  }

  if (updateAssetContract && configured.length > 0) {
    const contractPath = path.resolve(process.env.DOGFOOD_ASSET_CONTRACT ?? path.join(REPO_ROOT, 'scripts/dogfood-band-a-assets.json'));
    fs.writeFileSync(contractPath, `${JSON.stringify({ assets: configured }, null, 2)}\n`);
  }

  record({
    id: 'asset-integrity',
    surface: 'dogfood',
    route: 'asset-contract',
    status: failures > 0 ? 'FAIL' : assets.length > 0 ? 'PASS' : 'SKIP',
    severity: 'P0',
    check_label: 'Asset existence and cross-surface hash contract',
    evidence: assets.length === 0
      ? 'No asset contract or dashboard assets found.'
      : `${assets.length} assets checked; ${failures} failures. ${hashLines.join(' | ')}`,
  });
}

async function visibleNavClip(page: Page): Promise<Buffer | null> {
  const nav = page.locator('nav, [data-testid*="nav"], [class*="nav"], [class*="menu"]').last();
  if ((await nav.count()) === 0) return null;
  const box = await nav.boundingBox().catch(() => null);
  if (!box || box.width < 20 || box.height < 10) return null;
  return nav.screenshot({ animations: 'disabled' });
}

function byteDrift(a: Buffer, b: Buffer): number {
  const len = Math.max(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) diff += 1;
  }
  return diff / len;
}

async function runNavPixelDrift(): Promise<void> {
  const baseUrl = process.env.DOGFOOD_NAV_BASE_URL ?? process.env.DOGFOOD_BASE_URL;
  if (!baseUrl) {
    record({
      id: 'nav-pixel-drift',
      surface: 'agentops',
      route: 'sibling-routes',
      status: 'SKIP',
      severity: 'P0',
      check_label: 'Nav pixel drift sibling diff',
      evidence: 'DOGFOOD_NAV_BASE_URL not set; live nav pixel check skipped.',
    });
    return;
  }

  const routes = (process.env.DOGFOOD_NAV_ROUTES ?? '/app,/app/fleet/tasks,/app/orchestrator,/app/workflows,/app/analytics')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const threshold = Number(process.env.DOGFOOD_NAV_DRIFT_THRESHOLD ?? '0.05');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      const baseline = await captureRouteNav(page, baseUrl, routes[0], viewport);
      if (!baseline) continue;
      for (const route of routes.slice(1)) {
        const current = await captureRouteNav(page, baseUrl, route, viewport);
        if (!current) continue;
        const drift = byteDrift(baseline, current);
        const shotPath = path.join(OUTPUT_DIR, `nav-${viewport.width}x${viewport.height}-${route.replace(/\W+/g, '_')}.png`);
        fs.writeFileSync(shotPath, current);
        record({
          id: `nav-pixel-${viewport.width}x${viewport.height}-${route}`,
          surface: 'agentops',
          route,
          status: drift > threshold ? 'FAIL' : 'PASS',
          severity: 'P0',
          check_label: 'Nav pixel drift sibling diff',
          evidence: `byte-level nav-region drift=${(drift * 100).toFixed(2)}%, threshold=${(threshold * 100).toFixed(2)}%, baseline=${routes[0]}`,
          screenshot: shotPath,
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function captureRouteNav(page: Page, baseUrl: string, route: string, viewport: { width: number; height: number }): Promise<Buffer | null> {
  await page.goto(new URL(route, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const clip = await visibleNavClip(page);
  if (!clip) {
    record({
      id: `nav-pixel-${viewport.width}x${viewport.height}-${route}`,
      surface: 'agentops',
      route,
      status: 'FAIL',
      severity: 'P0',
      check_label: 'Nav pixel drift sibling diff',
      evidence: `No nav/menu element could be captured at ${viewport.width}x${viewport.height}.`,
    });
  }
  return clip;
}

async function runVoiceSmoke(): Promise<void> {
  const voiceUrl = process.env.DOGFOOD_VOICE_URL;
  if (!voiceUrl) {
    record({
      id: 'voice-smoke',
      surface: 'voice agents',
      route: 'authenticated-flow',
      status: 'SKIP',
      severity: 'P0',
      check_label: 'Voice and attachment smoke',
      evidence: 'DOGFOOD_VOICE_URL not set; authenticated voice smoke skipped.',
    });
    return;
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(voiceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const selectors = [
      'audio, [data-testid*="voice"], button[aria-label*="voice" i], button:has-text("Voice")',
      'input[type="file"], [data-testid*="attach"], button[aria-label*="attach" i], button:has-text("Attach")',
    ];
    const counts = await Promise.all(selectors.map(sel => page.locator(sel).count().catch(() => 0)));
    record({
      id: 'voice-smoke',
      surface: 'voice agents',
      route: new URL(voiceUrl).pathname,
      status: counts.every(count => count > 0) ? 'PASS' : 'FAIL',
      severity: 'P0',
      check_label: 'Voice and attachment smoke',
      evidence: `voice controls=${counts[0]}, attachment controls=${counts[1]}`,
      screenshot: await page.screenshot({ path: path.join(OUTPUT_DIR, 'voice-smoke.png'), fullPage: false }).then(() => path.join(OUTPUT_DIR, 'voice-smoke.png')),
    });
  } finally {
    await browser.close();
  }
}

function writeReport(): void {
  const jsonPath = path.join(OUTPUT_DIR, 'check-results.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  const lines = [
    '# Dogfood Band A Check Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Results: ${results.filter(r => r.status === 'PASS').length} pass, ${results.filter(r => r.status === 'FAIL').length} fail, ${results.filter(r => r.status === 'WARN').length} warn, ${results.filter(r => r.status === 'SKIP').length} skip`,
    '',
    '| Status | Severity | Surface | Route | Check | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.status} | ${r.severity} | ${r.surface} | ${r.route} | ${r.check_label} | ${r.evidence.replace(/\|/g, '\\|')} |`),
    '',
    `Structured results: ${jsonPath}`,
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  runCssBlastRadiusCheck();
  runAssetChecks();
  if (!staticOnly) {
    await runNavPixelDrift();
    await runVoiceSmoke();
  }
  writeReport();
  const failed = results.filter(r => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error(`Dogfood Band A failed: ${failed.length} failing checks. Report: ${OUTPUT_DIR}/report.md`);
    process.exit(1);
  }
  console.log(`Dogfood Band A passed without failures. Report: ${OUTPUT_DIR}/report.md`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
