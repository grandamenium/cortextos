#!/usr/bin/env node
/**
 * Band B dogfood validation checks.
 *
 * Static PR gates run by default:
 *   - Add Beer design-token compliance guard
 *   - Orca visual identity hash contract
 *   - deterministic vignette/alert prose critic
 *   - design image request ledger schema
 *
 * Live gate runs when DOGFOOD_BAND_B_BASE_URL is provided:
 *   - bottom padding vs fixed bottom nav height
 */

import { chromium, type Page } from 'playwright';
import { createHash } from 'crypto';
import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fingerprint, type CheckResult } from './dogfood-check-result';

interface TokenSurface { id: string; label: string; path_patterns: string[]; allowed_tokens: string[]; }
interface TokenContract { canonical_doc?: string; surfaces?: TokenSurface[]; }
interface IdentitySurface { surface: string; path: string; expectedMd5: string; sourceId?: string; }
interface IdentityContract { surfaces?: IdentitySurface[]; }
interface LedgerEntry { id: string; source_path: string; received_at: string; owner: string; status: string; tracking_id?: string; notes?: string; }
interface VoicePersonaContract {
  required_personas?: string[];
  personas?: VoicePersona[];
}
interface VoicePersona {
  id: string;
  display_name: string;
  app_surface: string;
  voice_id: string;
  speaking_rate: number;
  confirmation_behavior: 'brief-operational' | 'explicit-action-summary' | 'silent-unless-action';
  barge_in_latency_target_ms: number;
  delta_test: {
    fixture: string;
    assertions: string[];
  };
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_DIR = process.env.DOGFOOD_OUTPUT_DIR
  ? path.resolve(process.env.DOGFOOD_OUTPUT_DIR)
  : path.resolve(REPO_ROOT, 'orgs/revops-global/agents/hub-dogfood/output/band-b', RUN_STAMP);
const args = new Set(process.argv.slice(2));
const staticOnly = args.has('--static');
const results: CheckResult[] = [];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function record(result: CheckResult): void {
  results.push(result);
  const icon = result.status === 'PASS' ? '✓' : result.status === 'FAIL' ? '✗' : result.status === 'WARN' ? '!' : '-';
  console.log(`${result.status.padEnd(4)} ${icon} ${fingerprint(result)}`);
  if (result.status !== 'PASS') console.log(`       ${result.evidence}`);
}

function readJson<T>(filePath: string, fallback: T): T {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) as T : fallback;
}

function gitChangedFiles(): string[] {
  if (process.env.DOGFOOD_CHANGED_FILES) {
    return process.env.DOGFOOD_CHANGED_FILES.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  }
  const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  for (const cmd of [['diff', '--name-only', `${baseRef}...HEAD`], ['diff', '--name-only', 'HEAD~1...HEAD']]) {
    try {
      return execFileSync('git', cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
    } catch {}
  }
  return [];
}

function globToRegExp(pattern: string): RegExp {
  const globstar = '\0GLOBSTAR\0';
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, '[^/]*')
    .replaceAll(globstar, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function md5File(filePath: string): string {
  return createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function runDesignTokenCompliance(): void {
  const contractPath = path.resolve(process.env.DOGFOOD_BAND_B_TOKEN_CONTRACT ?? path.join(REPO_ROOT, 'scripts/dogfood-band-b-token-contract.json'));
  const contract = readJson<TokenContract>(contractPath, { surfaces: [] });
  const changed = new Set(gitChangedFiles());
  const allFiles = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const violations: string[] = [];
  let checked = 0;

  for (const surface of contract.surfaces ?? []) {
    const matchers = surface.path_patterns.map(globToRegExp);
    const candidates = allFiles.filter(file => matchers.some(re => re.test(file)) && (changed.size === 0 || changed.has(file)));
    for (const file of candidates) {
      checked += 1;
      const body = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const hexes = body.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
      const arbitraryColors = body.match(/\b(?:bg|text|border|ring)-\[[^\]]+\]/g) ?? [];
      const inlineColors = body.match(/\b(?:color|backgroundColor|borderColor)\s*:/g) ?? [];
      for (const hit of [...hexes, ...arbitraryColors, ...inlineColors]) violations.push(`${file}: ${hit}`);
    }
  }

  record({
    id: 'band-b-token-compliance',
    surface: 'estate-app',
    route: 'add-beer',
    status: violations.length ? 'FAIL' : 'PASS',
    severity: 'P1',
    check_label: 'Add Beer design token compliance',
    evidence: violations.length
      ? `Raw color/style tokens found: ${violations.slice(0, 12).join(' | ')}`
      : `${checked} changed Add Beer files checked; no raw hex, arbitrary color, or inline color props found.`,
  });
}

function runOrcaIdentityContract(): void {
  const contractPath = path.resolve(process.env.DOGFOOD_BAND_B_ORCA_IDENTITY_CONTRACT ?? path.join(REPO_ROOT, 'scripts/dogfood-band-b-orca-identity.json'));
  const contract = readJson<IdentityContract>(contractPath, { surfaces: [] });
  const failures: string[] = [];
  const checked: string[] = [];

  for (const surface of contract.surfaces ?? []) {
    const filePath = path.resolve(REPO_ROOT, surface.path);
    if (!filePath.startsWith(REPO_ROOT) || !fs.existsSync(filePath)) {
      failures.push(`${surface.surface}:${surface.path}=MISSING`);
      continue;
    }
    const md5 = md5File(filePath);
    checked.push(`${surface.surface}:${surface.path} md5=${md5}`);
    if (md5 !== surface.expectedMd5) failures.push(`${surface.surface}:${surface.path} expected=${surface.expectedMd5} actual=${md5}`);
  }

  record({
    id: 'band-b-orca-identity',
    surface: 'orca',
    route: 'character-pwa-icon',
    status: failures.length ? 'FAIL' : checked.length ? 'PASS' : 'SKIP',
    severity: 'P1',
    check_label: 'Orca character and PWA icon cross-surface identity',
    evidence: failures.length
      ? failures.join(' | ')
      : checked.length ? checked.join(' | ') : 'No Orca identity contract entries configured for this checkout.',
  });
}

function critiqueCopy(title: string, body: string): number[] {
  const violations = new Set<number>();
  const titleWords = title.match(/[A-Za-z][A-Za-z'0-9-]*/g) ?? [];
  if (titleWords.length >= 4 && titleWords.filter(w => /^[A-Z][a-z0-9'’-]+$/.test(w)).length / titleWords.length >= 0.75) violations.add(1);
  if (/\sand\s/i.test(title) && !/\b(is|are|needs?|knows?|has|gets|faces|starts|comes|keeps|holds|runs)\b/i.test(title)) violations.add(2);
  if (/\bat\s+(?:\d|\d+f|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(title)) violations.add(3);
  if (/^(he|she|it)\s+has\s+/i.test(body)) violations.add(4);
  if (normalize(body).startsWith(normalize(title))) violations.add(5);
  if (!/\b(add|bring|check|clip|cover|delay|inspect|move|plan|protect|pull|save|shift|start|watch|worth)\b/i.test(lastSentence(body))) violations.add(6);
  if (/[!🎉✅⚠️🚨]|\[[^\]]+\]/u.test(`${title} ${body}`)) violations.add(7);
  if (/\b(might|possibly|could be|maybe|perhaps)\b/i.test(`${title} ${body}`)) violations.add(8);
  return [...violations].sort((a, b) => a - b);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lastSentence(value: string): string {
  return value.split(/[.!?]/).map(s => s.trim()).filter(Boolean).at(-1) ?? value;
}

function runVignetteCopyCritic(): void {
  const bad = critiqueCopy('Chunk and Lettuce Bolt Risk At 80f Thursday', 'he has positioned himself near lettuce bolt risk at 80f thursday');
  const good = critiqueCopy('Chunk knows lettuce weather', 'Eighty degrees Thursday, and Chunk is already near the lettuce row. Pull the early heads tomorrow morning before the heat sets in.');
  const externalPath = process.env.DOGFOOD_BAND_B_COPY_FIXTURES;
  const externalFailures: string[] = [];
  if (externalPath && fs.existsSync(externalPath)) {
    const fixtures = readJson<Array<{ title: string; body: string; expect?: 'approve' | 'reject' }>>(path.resolve(externalPath), []);
    fixtures.forEach((draft, index) => {
      const violations = critiqueCopy(draft.title, draft.body);
      if (draft.expect === 'approve' && violations.length) externalFailures.push(`fixture ${index} unexpectedly rejected: ${violations.join(',')}`);
      if (draft.expect === 'reject' && violations.length === 0) externalFailures.push(`fixture ${index} unexpectedly approved`);
    });
  }
  record({
    id: 'band-b-vignette-copy-critic',
    surface: 'estate-app',
    route: 'estate-insights',
    status: bad.length >= 5 && bad.includes(4) && good.length === 0 && externalFailures.length === 0 ? 'PASS' : 'FAIL',
    severity: 'P1',
    check_label: 'Vignette and alert prose quality critic',
    evidence: `broken fixture violations=${bad.join(',') || 'none'}; warm fixture violations=${good.join(',') || 'none'}${externalFailures.length ? `; external failures=${externalFailures.join(' | ')}` : ''}`,
  });
}

function runDesignImageLedger(): void {
  const ledgerPath = path.resolve(process.env.DOGFOOD_DESIGN_IMAGE_LEDGER ?? path.join(REPO_ROOT, 'scripts/design-image-request-ledger.json'));
  const ledger = readJson<{ entries?: LedgerEntry[] }>(ledgerPath, { entries: [] });
  const allowed = new Set(['received', 'assigned', 'processed', 'archived']);
  const malformed: string[] = [];
  const stale: string[] = [];
  const now = Date.now();
  for (const entry of ledger.entries ?? []) {
    if (!entry.id || !entry.source_path || !entry.received_at || !entry.owner || !allowed.has(entry.status)) malformed.push(entry.id || '<missing-id>');
    const ageDays = (now - Date.parse(entry.received_at)) / 86400000;
    if (entry.status === 'received' && Number.isFinite(ageDays) && ageDays > 7) stale.push(entry.id);
  }
  record({
    id: 'band-b-design-image-ledger',
    surface: 'design-system',
    route: 'greg-image-requests',
    status: malformed.length ? 'FAIL' : stale.length ? 'WARN' : 'PASS',
    severity: 'P2',
    check_label: 'Design system image request tracking ledger',
    evidence: `${ledger.entries?.length ?? 0} entries checked; malformed=${malformed.length}; stale-unassigned=${stale.length}${malformed.length ? ` (${malformed.join(', ')})` : ''}${stale.length ? ` (${stale.join(', ')})` : ''}`,
  });
}

function runVoicePersonaContract(): void {
  const contractPath = path.resolve(process.env.DOGFOOD_VOICE_PERSONA_CONTRACT ?? path.join(REPO_ROOT, 'scripts/dogfood-voice-personas.json'));
  const contract = readJson<VoicePersonaContract>(contractPath, { required_personas: [], personas: [] });
  const personas = contract.personas ?? [];
  const personaIds = new Set(personas.map(persona => persona.id));
  const missingRequired = (contract.required_personas ?? []).filter(id => !personaIds.has(id));
  const duplicateIds = personas
    .map(persona => persona.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);

  for (const persona of personas) {
    const failures: string[] = [];
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(persona.id)) failures.push(`id is not slug-safe: ${persona.id}`);
    if (duplicateIds.includes(persona.id)) failures.push(`duplicate persona id: ${persona.id}`);
    if (!persona.display_name) failures.push('missing display_name');
    if (!persona.app_surface) failures.push('missing app_surface');
    if (!persona.voice_id || /^(default|pending|tbd)$/i.test(persona.voice_id)) failures.push(`voice_id must be explicit, got ${persona.voice_id || '<empty>'}`);
    if (!Number.isFinite(persona.speaking_rate) || persona.speaking_rate < 0.7 || persona.speaking_rate > 2) failures.push(`speaking_rate out of 0.7-2.0 range: ${persona.speaking_rate}`);
    if (!['brief-operational', 'explicit-action-summary', 'silent-unless-action'].includes(persona.confirmation_behavior)) failures.push(`invalid confirmation_behavior: ${persona.confirmation_behavior}`);
    if (!Number.isFinite(persona.barge_in_latency_target_ms) || persona.barge_in_latency_target_ms < 150 || persona.barge_in_latency_target_ms > 750) failures.push(`barge_in_latency_target_ms out of 150-750 range: ${persona.barge_in_latency_target_ms}`);
    if (!persona.delta_test?.fixture) failures.push('missing delta_test.fixture');
    for (const required of ['voice_id', 'speaking_rate', 'confirmation_behavior', 'barge_in_latency_target_ms']) {
      if (!persona.delta_test?.assertions?.some(assertion => assertion.includes(required))) failures.push(`delta_test missing ${required} assertion`);
    }

    record({
      id: `o-framework-1-${persona.id}`,
      surface: persona.app_surface,
      route: `voice-persona/${persona.id}`,
      status: failures.length ? 'FAIL' : 'PASS',
      severity: 'P0',
      check_label: 'O-Framework 1 voice persona contract',
      evidence: failures.length
        ? failures.join('; ')
        : `${persona.display_name} pinned to ${persona.voice_id} at ${persona.speaking_rate}x; ${persona.confirmation_behavior}; barge-in<=${persona.barge_in_latency_target_ms}ms`,
    });
  }

  if (missingRequired.length || personas.length === 0) {
    record({
      id: 'o-framework-1-required-personas',
      surface: 'voice',
      route: 'voice-persona/required',
      status: 'FAIL',
      severity: 'P0',
      check_label: 'O-Framework 1 required voice personas',
      evidence: personas.length === 0 ? `No personas configured in ${contractPath}` : `Missing required personas: ${missingRequired.join(', ')}`,
    });
  }
}

async function runBottomPaddingVsNav(): Promise<void> {
  const baseUrl = process.env.DOGFOOD_BAND_B_BASE_URL;
  if (!baseUrl || staticOnly) {
    record({
      id: 'band-b-nav-padding',
      surface: 'ob1-app',
      route: 'top-routes',
      status: 'SKIP',
      severity: 'P1',
      check_label: 'Bottom padding vs fixed nav height',
      evidence: staticOnly ? 'Static mode; live nav occlusion check skipped.' : 'DOGFOOD_BAND_B_BASE_URL not set; live nav occlusion check skipped.',
    });
    return;
  }
  const routes = (process.env.DOGFOOD_BAND_B_ROUTES ?? '/,/app,/app/more,/app/beer,/app/hive')
    .split(',').map(s => s.trim()).filter(Boolean);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(new URL(route, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      const metrics = await navMetrics(page);
      const ok = metrics.paddingBottom > metrics.navHeight && metrics.overlapCount === 0;
      const shotPath = path.join(OUTPUT_DIR, `nav-padding-${route.replace(/\W+/g, '_') || 'root'}.png`);
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
      record({
        id: `band-b-nav-padding-${route}`,
        surface: 'ob1-app',
        route,
        status: ok ? 'PASS' : 'FAIL',
        severity: 'P1',
        check_label: 'Bottom padding vs fixed nav height',
        evidence: `paddingBottom=${metrics.paddingBottom}px navHeight=${metrics.navHeight}px overlapCount=${metrics.overlapCount}`,
        screenshot: shotPath,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function navMetrics(page: Page): Promise<{ paddingBottom: number; navHeight: number; overlapCount: number }> {
  return page.evaluate(() => {
    const nav = Array.from(document.querySelectorAll('nav, [data-testid*="nav"], [class*="bottom-nav"], [class*="tab-bar"]'))
      .map(el => ({ el, rect: el.getBoundingClientRect(), style: getComputedStyle(el) }))
      .filter(item => item.rect.height > 10)
      .sort((a, b) => b.rect.bottom - a.rect.bottom)[0];
    const navHeight = nav?.rect.height ?? 0;
    const paddingBottom = parseFloat(getComputedStyle(document.body).paddingBottom || '0') ||
      parseFloat(getComputedStyle(document.documentElement).paddingBottom || '0') ||
      Math.max(...Array.from(document.querySelectorAll('main, [role="main"], body')).map(el => parseFloat(getComputedStyle(el).paddingBottom || '0')));
    const navTop = nav?.rect.top ?? window.innerHeight;
    const overlapCount = Array.from(document.querySelectorAll('main a, main button, main input, main textarea, main [role="button"]'))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > navTop && rect.top < window.innerHeight;
      }).length;
    return { paddingBottom, navHeight, overlapCount };
  });
}

function writeReport(): void {
  fs.writeFileSync(path.join(OUTPUT_DIR, 'check-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const lines = [
    '# Dogfood Band B Check Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Results: ${results.filter(r => r.status === 'PASS').length} pass, ${results.filter(r => r.status === 'FAIL').length} fail, ${results.filter(r => r.status === 'WARN').length} warn, ${results.filter(r => r.status === 'SKIP').length} skip`,
    '',
    '| Status | Severity | Surface | Route | Check | Evidence |',
    '|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.status} | ${r.severity} | ${r.surface} | ${r.route} | ${r.check_label} | ${r.evidence.replace(/\|/g, '\\|')} |`),
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
}

function fileOrBumpTask(result: CheckResult): void {
  if (process.env.DOGFOOD_FILE_TASKS !== '1') return;
  const fp = fingerprint(result);
  const title = `[dogfood-band-b] ${result.surface}: ${result.check_label} - ${result.status}`;
  const desc = [
    `Fingerprint: ${fp}`,
    `Status: ${result.status}`,
    `Severity: ${result.severity}`,
    `Route: ${result.route}`,
    `Evidence: ${result.evidence.slice(0, 300)}`,
    `Screenshot: ${result.screenshot ?? 'none'}`,
    `Run: ${RUN_STAMP}`,
    `Script: scripts/dogfood-band-b.ts`,
  ].join('\n');

  try {
    const existing = execSync('cortextos bus list-tasks --status open --format json 2>/dev/null || echo "[]"', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let tasks: Array<{ id: string; title: string; description?: string }> = [];
    try { tasks = JSON.parse(existing); } catch { tasks = []; }
    const duplicate = tasks.find(task => (task.description ?? '').includes(fp) || task.title.includes(result.check_label.slice(0, 40)));
    if (duplicate) {
      execSync(`cortextos bus update-task ${duplicate.id} open --desc ${JSON.stringify(`occurrence at ${RUN_STAMP}: ${result.evidence.slice(0, 160)}`)}`, { cwd: REPO_ROOT, stdio: 'pipe' });
      console.log(`[task] bumped ${duplicate.id} for ${fp}`);
      return;
    }
    execSync(`cortextos bus create-task ${JSON.stringify(title)} --desc ${JSON.stringify(desc)}`, { cwd: REPO_ROOT, stdio: 'pipe' });
    console.log(`[task] filed finding for ${fp}`);
  } catch {
    console.log(`[task] skipped filing for ${fp}; cortextos bus unavailable or rejected request.`);
  }
}

async function main(): Promise<void> {
  runDesignTokenCompliance();
  runOrcaIdentityContract();
  runVignetteCopyCritic();
  runDesignImageLedger();
  runVoicePersonaContract();
  await runBottomPaddingVsNav();
  writeReport();
  const failed = results.filter(r => r.status === 'FAIL');
  const findings = results.filter(r => r.status === 'FAIL' || r.status === 'WARN');
  for (const finding of findings) fileOrBumpTask(finding);
  if (failed.length > 0) {
    console.error(`Dogfood Band B failed: ${failed.length} failing checks. Report: ${OUTPUT_DIR}/report.md`);
    process.exit(1);
  }
  console.log(`Dogfood Band B passed without failures. Report: ${OUTPUT_DIR}/report.md`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
