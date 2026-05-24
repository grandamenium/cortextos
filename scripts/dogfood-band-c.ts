#!/usr/bin/env node
/**
 * Band C dogfood validation checks.
 *
 * Vignette visual-regression gate:
 *   - compare a live or supplied Estate vignette PNG against the canonical PNG
 *   - fail when perceptual dHash Hamming distance exceeds 30
 */

import { chromium, type Page } from 'playwright';
import { execFileSync } from 'child_process';
import { PNG } from 'pngjs';
import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-c', RUN_STAMP);
const CANONICAL_PNG = path.resolve(
  process.env.DOGFOOD_BAND_C_CANONICAL_PNG
    ?? path.join(REPO_ROOT, 'orgs/revops-global/agents/design-agent/output/ob1-vignette-check-2026-05-21.png')
);
const CANONICAL_DHASH = parseHash(process.env.DOGFOOD_BAND_C_CANONICAL_DHASH ?? '2d30018181838300');
const ACTUAL_PNG = process.env.DOGFOOD_BAND_C_ACTUAL_PNG
  ? path.resolve(process.env.DOGFOOD_BAND_C_ACTUAL_PNG)
  : path.join(OUTPUT_DIR, 'estate-vignette-live.png');
const VIGNETTE_URL = process.env.DOGFOOD_BAND_C_URL ?? 'https://ob1.revopsglobal.com';
const VIGNETTE_SELECTOR = process.env.DOGFOOD_BAND_C_SELECTOR ?? [
  '[data-testid="daily-vignette"]',
  '[data-testid="estate-vignette"]',
  '[data-vignette]',
  'section:has-text("Morning Watch")',
  'main',
].join(', ');
const HAMMING_THRESHOLD = Number.parseInt(process.env.DOGFOOD_BAND_C_HAMMING_THRESHOLD ?? '30', 10);
const results: CheckResult[] = [];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function parseHash(value: string): bigint {
  return BigInt(value.startsWith('0x') ? value : `0x${value}`);
}

function record(result: CheckResult): void {
  results.push(result);
  const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : result.status === 'WARN' ? '!' : '-';
  console.log(`${result.status.padEnd(4)} ${icon} ${fingerprint(result)}`);
  if (result.status !== 'PASS') console.log(`       ${result.evidence}`);
}

function loadEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#') && line.includes('='))
    .reduce((acc, line) => {
      const idx = line.indexOf('=');
      acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      return acc;
    }, {} as Record<string, string>);
}

function readPng(filePath: string): PNG {
  if (!fs.existsSync(filePath)) throw new Error(`PNG not found: ${filePath}`);
  return PNG.sync.read(fs.readFileSync(filePath));
}

function grayAt(png: PNG, x: number, y: number): number {
  const clampedX = Math.max(0, Math.min(png.width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(png.height - 1, Math.round(y)));
  const idx = (clampedY * png.width + clampedX) * 4;
  const r = png.data[idx] ?? 0;
  const g = png.data[idx + 1] ?? 0;
  const b = png.data[idx + 2] ?? 0;
  return (r * 0.299) + (g * 0.587) + (b * 0.114);
}

function dHash(filePath: string): bigint {
  const png = readPng(filePath);
  const cols = 9;
  const rows = 8;
  const values: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = cols === 1 ? 0 : (col / (cols - 1)) * (png.width - 1);
      const y = rows === 1 ? 0 : (row / (rows - 1)) * (png.height - 1);
      values.push(grayAt(png, x, y));
    }
  }

  let hash = 0n;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const left = values[row * cols + col] ?? 0;
      const right = values[row * cols + col + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

function hamming(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value > 0n) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

async function unlockIfNeeded(page: Page, env: Record<string, string>): Promise<void> {
  const pin = env.OB1_PIN ?? env.OB1_APP_PIN ?? env.OB1_UNLOCK_PIN ?? env.NEXT_PUBLIC_OB1_PIN;
  if (!pin) return;
  const input = page.locator('input[type="password"], input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
  if (!(await input.isVisible().catch(() => false))) return;
  await input.fill(pin);
  await page.keyboard.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function captureLivePng(): Promise<string> {
  const env = { ...loadEnv(SECRETS_ENV), ...process.env };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();
    await page.goto(VIGNETTE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await unlockIfNeeded(page, env);
    await page.waitForTimeout(1500);

    const target = page.locator(VIGNETTE_SELECTOR).first();
    if (await target.isVisible().catch(() => false)) {
      await target.screenshot({ path: ACTUAL_PNG });
    } else {
      await page.screenshot({ path: ACTUAL_PNG, fullPage: false });
    }
    await context.close();
    return ACTUAL_PNG;
  } finally {
    await browser.close();
  }
}

function writeReport(): string {
  const pass = results.filter(result => result.status === 'PASS').length;
  const fail = results.filter(result => result.status === 'FAIL').length;
  const warn = results.filter(result => result.status === 'WARN').length;
  const rows = results.map(result =>
    `| ${result.id} | ${result.surface} | ${result.route} | ${result.check_label} | ${result.status} | ${result.evidence.replace(/\|/g, '/')} |`
  ).join('\n');
  const report = [
    '# Dogfood Band C Vignette Visual Regression Report',
    '',
    `Run: ${RUN_STAMP}`,
    `Canonical PNG: ${fs.existsSync(CANONICAL_PNG) ? CANONICAL_PNG : `not present; using dHash ${CANONICAL_DHASH.toString(16)}`}`,
    `Actual PNG: ${ACTUAL_PNG}`,
    `Threshold: dHash Hamming <= ${HAMMING_THRESHOLD}`,
    `Summary: ${pass} passed, ${fail} failed, ${warn} warned`,
    '',
    '| ID | Surface | Route | Check | Status | Evidence |',
    '|---|---|---|---|---|---|',
    rows,
    '',
  ].join('\n');
  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  return reportPath;
}

function fileOrBumpTask(result: CheckResult): void {
  if (process.env.DOGFOOD_SKIP_TASKS === '1') return;
  const title = `[dogfood-band-c] ${result.surface}: ${result.check_label} - ${result.status}`;
  const desc = [
    `Fingerprint: ${fingerprint(result)}`,
    `Status: ${result.status}`,
    `Evidence: ${result.evidence}`,
    `Canonical PNG: ${CANONICAL_PNG}`,
    `Actual PNG: ${ACTUAL_PNG}`,
    `Report: ${path.join(OUTPUT_DIR, 'report.md')}`,
  ].join('\n');
  try {
    execFileSync('cortextos', [
      'bus', 'create-task', title,
      '--desc', desc,
      '--assignee', 'family-agent',
      '--priority', result.severity === 'P0' ? 'urgent' : 'high',
      '--project', 'dogfood-findings',
      '--success-criteria', 'Estate vignette rendered PNG compares within Band C visual-regression threshold against canonical PNG.',
      '--out-of-scope', 'Do not change Band C threshold while fixing the visual regression.',
      '--escalation-triggers', 'Canonical screenshot is outdated, production route is unavailable, or regression persists after deploy.',
      '--source-hierarchy', 'hub-dogfood Band C vignette visual-regression gate',
      '--required-capabilities', 'ob1-app UI fix and production screenshot verification',
      '--fallback-proof', 'Re-run npm run dogfood:band-c with DOGFOOD_BAND_C_ACTUAL_PNG set to the fixed production screenshot.',
      '--artifact-expectations', 'Merged UI fix PR plus passing Band C report.',
      '--goal-ancestry', 'Estate vignette visual regression dogfood coverage',
      '--skip-dedup',
    ], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    // Non-fatal: CI should report the failed check even if task filing is unavailable.
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(CANONICAL_PNG) && !process.env.DOGFOOD_BAND_C_CANONICAL_DHASH) {
    record({
      id: 'band-c-vignette-visual-regression',
      surface: 'estate-vignette',
      route: '/',
      status: 'WARN',
      severity: 'P2',
      check_label: 'Vignette visual regression canonical PNG present',
      evidence: `Canonical PNG missing at ${CANONICAL_PNG}; using baked-in canonical dHash ${CANONICAL_DHASH.toString(16)} from design-agent ob1-vignette-check-2026-05-21.png.`,
    });
  }

  if (!process.env.DOGFOOD_BAND_C_ACTUAL_PNG) {
    await captureLivePng();
  }

  if (fs.existsSync(ACTUAL_PNG)) {
    const canonicalHash = fs.existsSync(CANONICAL_PNG) ? dHash(CANONICAL_PNG) : CANONICAL_DHASH;
    const actualHash = dHash(ACTUAL_PNG);
    const distance = hamming(canonicalHash, actualHash);
    record({
      id: 'band-c-vignette-visual-regression',
      surface: 'estate-vignette',
      route: '/',
      status: distance <= HAMMING_THRESHOLD ? 'PASS' : 'FAIL',
      severity: 'P1',
      check_label: 'Vignette visual regression dHash distance',
      evidence: `hamming=${distance}, threshold=${HAMMING_THRESHOLD}, canonical=${canonicalHash.toString(16)}, actual=${actualHash.toString(16)}`,
      screenshot: ACTUAL_PNG,
    });
  } else {
    record({
      id: 'band-c-vignette-visual-regression',
      surface: 'estate-vignette',
      route: '/',
      status: 'FAIL',
      severity: 'P1',
      check_label: 'Vignette visual regression actual PNG present',
      evidence: `Actual PNG missing: ${ACTUAL_PNG}`,
    });
  }

  const reportPath = writeReport();
  console.log(`Report: ${reportPath}`);

  for (const result of results.filter(result => result.status === 'FAIL')) fileOrBumpTask(result);
  process.exit(results.some(result => result.status === 'FAIL') ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
