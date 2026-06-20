#!/usr/bin/env node
// Architecture-Pattern-Discovery — semantic-level scan via Claude API
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PHYTO = '/Users/arndt/phytomedic-saas';
const AUDIT_DIR = join(PHYTO, 'tests/quality/audits');
const TODAY = new Date().toISOString().slice(0, 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const ANTI_PATTERNS = `
A1: Scan-based KPI aggregation (query.take(N).reduce -> rollup table)
A2: N+1 query pattern (await get/query in for-loop -> Promise.all or join)
A3: Mutation doing aggregation (reduce/length in mutation -> write delta only)
A4: Read-then-patch race (read X, patch x.n+1 -> atomic counter)
A5: Cross-table N+1 (Promise.all + get -> denormalize critical fields)
A6: Missing denormalization (3-table-join hot read -> denormalize)
A7: Unbounded list/getAll (collect without pagination -> cursor)
A8: Implicit string-key lookup (filter by raw name/email -> normalized key)
`;

function rg(pattern, dir, ext) {
  try {
    // grep -l with extended-regex, recursive, only matching pattern files
    const cmd = `find ${dir} -name "*.${ext}" -type f | xargs grep -lE "${pattern.replace(/"/g, '\\"')}" 2>/dev/null`;
    return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: PHYTO }).split('\n').filter(Boolean);
  } catch { return []; }
}

function findCandidates() {
  const candidates = {};
  const checks = [
    { pattern: 'for.*const.*of.*\\{', dir: 'convex', ext: 'ts', kind: 'A2-for-loop' },
    { pattern: '\\.collect\\(\\)', dir: 'convex/functions', ext: 'ts', kind: 'A1-collect' },
    { pattern: 'ctx\\.db\\.patch', dir: 'convex/functions', ext: 'ts', kind: 'A4-patch' },
    { pattern: '\\.take\\([0-9]{4,}\\)', dir: 'convex', ext: 'ts', kind: 'A1A7-take' },
    { pattern: 'Promise\\.all', dir: 'convex', ext: 'ts', kind: 'A5A6-promise-all' },
    { pattern: 'export const (list|getAll|fetchAll)', dir: 'convex/functions', ext: 'ts', kind: 'A7-list' },
    { pattern: 'filter\\([^)]*q\\.eq', dir: 'convex', ext: 'ts', kind: 'A8-filter-eq' },
  ];
  for (const c of checks) {
    for (const f of rg(c.pattern, c.dir, c.ext)) {
      if (!candidates[f]) candidates[f] = { kinds: new Set(), score: 0 };
      candidates[f].kinds.add(c.kind);
      candidates[f].score++;
    }
  }
  const ranked = Object.entries(candidates)
    .map(([f, v]) => ({ file: f, score: v.score, kinds: [...v.kinds] }))
    .sort((a, b) => b.score - a.score);
  console.log('\n=== Top architecture-candidate files ===\n');
  for (const c of ranked.slice(0, 15)) {
    console.log(`  ${c.file}  (score=${c.score}, suspects=${c.kinds.join(',')})`);
  }
  mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(join(AUDIT_DIR, `arch-candidates-${TODAY}.json`), JSON.stringify(ranked, null, 2));
  console.log(`\nSaved arch-candidates-${TODAY}.json (top-15 priority for semantic analysis)`);
  return ranked;
}

async function analyzeFile(filepath) {
  if (!ANTHROPIC_KEY) {
    console.error('No ANTHROPIC_API_KEY env');
    process.exit(1);
  }
  const content = readFileSync(join(PHYTO, filepath), 'utf8').slice(0, 60000);
  const prompt = `Review this Convex/TypeScript code against architecture anti-patterns. Be sparse. Max 8 findings.

ANTI-PATTERNS:${ANTI_PATTERNS}

FILE: ${filepath}
CODE:
${content}

RETURN STRICT JSON ARRAY (no prose):
[{"pattern":"A1","line":42,"severity":"critical","current_code":"snippet","problem":"one-sentence","proposed_fix":"one-paragraph","estimated_hours":2}]`;

  console.log(`Analyzing ${filepath} via Claude...`);
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
  }).then(r => r.text());

  let parsed = [];
  try {
    const r = JSON.parse(apiResp);
    const text = r.content?.[0]?.text || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (m) parsed = JSON.parse(m[0]);
    else console.log('No JSON in response:', text.slice(0, 500));
  } catch (e) { console.error('Parse:', e.message); }

  console.log(`\n=== ${filepath}: ${parsed.length} findings ===`);
  for (const f of parsed) {
    console.log(`  [${f.severity}] ${f.pattern} line ${f.line}: ${(f.problem || '').slice(0, 150)}`);
  }
  writeFileSync(join(AUDIT_DIR, `arch-${filepath.replace(/[/\\]/g, '_')}-${TODAY}.json`), JSON.stringify({ file: filepath, findings: parsed }, null, 2));
  return parsed;
}

const mode = process.argv[2];
if (mode === '--candidates') findCandidates();
else if (mode === '--analyze' && process.argv[3]) await analyzeFile(process.argv[3]);
else if (mode === '--full') {
  const c = findCandidates();
  for (const x of c.slice(0, 5)) await analyzeFile(x.file);
} else console.log('Usage: --candidates | --analyze <file> | --full');
