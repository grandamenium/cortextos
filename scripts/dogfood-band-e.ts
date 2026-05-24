#!/usr/bin/env node
/**
 * Band E dogfood validation checks.
 *
 * Cross-screen card consistency gate:
 *   - visit Estate app section routes with primary repeated card components
 *   - extract a normalized DOM structure signature for the dominant card
 *   - compare each card against the cluster centroid
 *   - fail when one card diverges beyond the configured structural threshold
 */

import { chromium, type Page } from 'playwright';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SECRETS_ENV = path.resolve(REPO_ROOT, 'orgs/revops-global/secrets.env');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-e', RUN_STAMP);
const ESTATE_URL = process.env.DOGFOOD_BAND_E_URL ?? 'https://ob1.revopsglobal.com';
const SIMILARITY_THRESHOLD = Number.parseFloat(process.env.DOGFOOD_BAND_E_THRESHOLD ?? '0.62');

interface CardTarget {
  surface: string;
  route: string;
  expectedName: string;
  selectors: string[];
}

interface CardSignature {
  target: CardTarget;
  url: string;
  selector: string;
  hash: string;
  tokens: string[];
  tagOutline: string[];
  evidence: string;
  screenshot?: string;
}

const TARGETS: CardTarget[] = [
  {
    surface: 'FarmAnimalCard',
    route: '/farm',
    expectedName: 'FarmAnimalCard',
    selectors: ['[data-testid="animal-card"]', '[data-testid^="animal-card-"]', '.animal-card', '.animal-row', 'article[data-card-kind="animal"]', 'article'],
  },
  {
    surface: 'GardenPlantCard',
    route: '/garden',
    expectedName: 'GardenPlantCard',
    selectors: ['[data-testid="plant-card"]', '[data-testid^="plant-card-"]', '[data-testid="seed-card"]', '[data-testid^="seed-card-"]', '.plant-card', '.seed-card', 'article[data-card-kind="plant"]', '.glass.overflow-hidden', 'article'],
  },
  {
    surface: 'OrchardTreeCard',
    route: '/orchard',
    expectedName: 'OrchardTreeCard',
    selectors: ['[data-testid="tree-card"]', '[data-testid^="tree-card-"]', '.tree-card', '.tree-row', 'article[data-card-kind="tree"]', 'article'],
  },
  {
    surface: 'BeerBottleCard',
    route: '/meals?subtab=beer',
    expectedName: 'BeerBottleCard',
    selectors: ['[data-testid="beer-card"]', '[data-testid^="beer-card-"]', '[data-testid="bottle-card"]', '[data-testid^="bottle-card-"]', '.beer-card', '.bottle-card', 'button.glass.press-scale', 'article[data-card-kind="beer"]', 'article'],
  },
  {
    surface: 'MushroomCard',
    route: '/mushrooms',
    expectedName: 'MushroomCard',
    selectors: ['[data-testid="mushroom-card"]', '[data-testid^="mushroom-card-"]', '.mushroom-card', '.glass.px-5.py-10.fade-up', 'article[data-card-kind="mushroom"]', 'article'],
  },
  {
    surface: 'FamilyCard',
    route: '/family',
    expectedName: 'FamilyCard',
    selectors: ['[data-testid="family-card"]', '[data-testid^="family-card-"]', '[data-testid="person-card"]', '[data-testid^="person-card-"]', '.family-card', '.person-card', '.swipe-row-wrapper', 'article[data-card-kind="family"]', 'article'],
  },
];

const results: CheckResult[] = [];
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

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

function hashTokens(tokens: string[]): string {
  let hash = 2166136261;
  for (const token of tokens.join('|')) {
    hash ^= token.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

function clusterSimilarity(card: CardSignature, cards: CardSignature[]): number {
  const others = cards.filter(other => other !== card);
  if (others.length === 0) return 1;
  const cardTokens = new Set(card.tokens);
  const scores = others.map(other => jaccard(cardTokens, new Set(other.tokens)));
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

async function captureCard(page: Page, target: CardTarget): Promise<CardSignature | null> {
  await page.goto(`${ESTATE_URL}${target.route}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await unlockIfNeeded(page, { ...loadEnv(SECRETS_ENV), ...process.env });
  await page.waitForTimeout(1000);

  const payloadJson = await page.evaluate(`
    (() => {
      const selectors = ${JSON.stringify(target.selectors)};
      const usefulClassTokens = (value) => value
        .split(/\\s+/)
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => /card|tile|item|grid|media|image|title|meta|tag|status|actions|content|footer|header|body|portrait|thumb/i.test(part))
        .slice(0, 8);

      const signatureFor = (el) => {
        const tokens = [];
        const outline = [];
        const walk = (node, depth) => {
          if (depth > 4 || tokens.length > 140) return;
          const tag = node.tagName.toLowerCase();
          const role = node.getAttribute('role');
          const testid = node.getAttribute('data-testid');
          const classTokens = usefulClassTokens(node.className?.toString?.() ?? '');
          const children = Array.from(node.children).filter(child => !['SCRIPT', 'STYLE'].includes(child.tagName));
          const token = [
            'd' + depth,
            tag,
            role ? 'role:' + role : '',
            testid ? 'test:' + testid.replace(/\\d+/g, '#') : '',
            classTokens.map(cls => 'class:' + cls.replace(/\\d+/g, '#')).join(','),
            'kids:' + Math.min(children.length, 8),
          ].filter(Boolean).join('/');
          tokens.push(token);
          outline.push('  '.repeat(depth) + tag + (classTokens.length ? '.' + classTokens.join('.') : ''));
          children.slice(0, 8).forEach(child => walk(child, depth + 1));
        };
        walk(el, 0);
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          tokens,
          outline,
          evidence: el.tagName.toLowerCase() + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' display=' + style.display + ' grid=' + (style.gridTemplateColumns !== 'none') + ' gap=' + style.gap,
        };
      };

      for (const selector of selectors) {
        const candidates = Array.from(document.querySelectorAll(selector))
          .filter(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width >= 120 && rect.height >= 80 && style.display !== 'none' && style.visibility !== 'hidden';
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (br.width * br.height) - (ar.width * ar.height);
          });
        const card = candidates[0];
        if (card) return JSON.stringify({ selector, ...signatureFor(card) });
      }
      return 'null';
    })()
  `);
  const payload = JSON.parse(payloadJson) as { selector: string; tokens: string[]; outline: string[]; evidence: string } | null;

  if (!payload) return null;
  const screenshot = path.join(OUTPUT_DIR, `${target.surface}.png`);
  await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
  return {
    target,
    url: page.url(),
    selector: payload.selector,
    hash: hashTokens(payload.tokens),
    tokens: payload.tokens,
    tagOutline: payload.outline,
    evidence: payload.evidence,
    screenshot: path.basename(screenshot),
  };
}

function writeReport(cards: CardSignature[], scores: Array<{ card: CardSignature; score: number }>): string {
  const rows = scores.map(({ card, score }) =>
    `| ${card.target.surface} | ${card.target.route} | ${card.selector.replace(/\|/g, '/')} | ${card.hash} | ${score.toFixed(3)} | ${card.evidence.replace(/\|/g, '/')} |`
  ).join('\n');
  const outlines = cards.map(card => [
    `## ${card.target.surface}`,
    '',
    `Route: ${card.target.route}`,
    `URL: ${card.url}`,
    `Screenshot: ${card.screenshot ?? 'none'}`,
    '',
    '```',
    card.tagOutline.join('\n'),
    '```',
    '',
  ].join('\n')).join('\n');
  const report = [
    '# Dogfood Band E Card Consistency Report',
    '',
    `Run: ${RUN_STAMP}`,
    `Base URL: ${ESTATE_URL}`,
    `Threshold: cluster average Jaccard >= ${SIMILARITY_THRESHOLD}`,
    '',
    '| Surface | Route | Selector | Structure Hash | Cluster Similarity | Evidence |',
    '|---|---|---|---|---|---|',
    rows,
    '',
    outlines,
  ].join('\n');
  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  return reportPath;
}

function fileTask(result: CheckResult, reportPath: string): void {
  if (process.env.DOGFOOD_SKIP_TASKS === '1') return;
  try {
    execFileSync('cortextos', [
      'bus', 'create-task', `[dogfood-band-e] ${result.surface}: ${result.check_label}`,
      '--desc', [
        `Fingerprint: ${fingerprint(result)}`,
        `Status: ${result.status}`,
        `Evidence: ${result.evidence}`,
        `Report: ${reportPath}`,
      ].join('\n'),
      '--assignee', 'family-agent',
      '--priority', 'high',
      '--project', 'dogfood-findings',
      '--success-criteria', 'Primary card DOM structure matches the estate card cluster within Band E threshold.',
      '--out-of-scope', 'Do not lower Band E threshold to make a divergent card pass.',
      '--escalation-triggers', 'If the route is intentionally redesigned, update the card contract with design-agent approval.',
      '--source-hierarchy', 'hub-dogfood Band E cross-screen card consistency gate',
      '--required-capabilities', 'ob1-app UI/component fix and production dogfood verification',
      '--fallback-proof', 'Re-run npm run dogfood:band-e against production and attach the passing report.',
      '--artifact-expectations', 'Merged UI fix PR plus passing Band E report.',
      '--goal-ancestry', 'Estate app dogfood prevention for cross-screen component drift',
      '--skip-dedup',
    ], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch {
    // Non-fatal in CI and local runs.
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const cards: CardSignature[] = [];

  try {
    for (const target of TARGETS) {
      const card = await captureCard(page, target);
      if (!card) {
        record({
          id: `band-e-${target.surface}`,
          surface: target.surface,
          route: target.route,
          status: 'WARN',
          severity: 'P2',
          check_label: `${target.expectedName} primary card discovered`,
          evidence: `No visible primary card found using selectors: ${target.selectors.join(', ')}`,
        });
      } else {
        cards.push(card);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (cards.length < 3) {
    record({
      id: 'band-e-card-cluster-minimum',
      surface: 'estate-cards',
      route: '/',
      status: 'WARN',
      severity: 'P2',
      check_label: 'At least three primary cards available for structure clustering',
      evidence: `Only ${cards.length} card signatures captured; cannot compute useful cluster. This usually means the run is unauthenticated, routes are unavailable, or card selectors need a contract refresh.`,
    });
    writeReport(cards, cards.map(card => ({ card, score: 0 })));
    process.exit(0);
  }

  const scores = cards.map(card => ({ card, score: clusterSimilarity(card, cards) }));
  const reportPath = writeReport(cards, scores);
  for (const { card, score } of scores) {
    const status = score >= SIMILARITY_THRESHOLD ? 'PASS' : 'FAIL';
    const result: CheckResult = {
      id: `band-e-${card.target.surface}-cluster-similarity`,
      surface: card.target.surface,
      route: card.target.route,
      status,
      severity: 'P1',
      check_label: 'Primary card DOM structure matches estate card cluster',
      evidence: `score=${score.toFixed(3)} threshold=${SIMILARITY_THRESHOLD}; hash=${card.hash}; selector=${card.selector}; ${card.evidence}`,
      screenshot: card.screenshot,
    };
    record(result);
    if (status === 'FAIL') fileTask(result, reportPath);
  }

  const failed = results.filter(result => result.status === 'FAIL');
  console.log(`Dogfood Band E ${failed.length ? 'failed' : 'passed'}: ${reportPath}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
