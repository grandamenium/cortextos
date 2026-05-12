// Phase 3 CLI verbs: recommend.
//
// Side-effect: importing this file registers Phase 3 commands.

import type { Command } from 'commander';
import { resolveEnv } from '../utils/env.js';
import { parseDurationMs } from '../bus/cron-state.js';
import { readWindow, getStorePaths } from '../analysis/token-audit.js';
import { setPhase3Registrar } from './token-audit-registrars.js';
import { generateRecommendations, persistRecommendations, readRecommendations, updateRecommendationState } from '../analysis/recommendations.js';
import type { RecommendationState } from '../analysis/recommendations.js';

function parseSince(s: string | undefined, fallback: string): Date {
  const value = s ?? fallback;
  const ms = parseDurationMs(value);
  if (Number.isFinite(ms)) return new Date(Date.now() - ms);
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return new Date(Date.now() - parseDurationMs(fallback));
}

setPhase3Registrar((ta: Command) => {
  ta
    .command('recommend')
    .description('Generate recommendation proposals from current fact-store state')
    .option('--since <window>', 'Evidence window (default 7d)', '7d')
    .option('--dry-run', 'Report proposals without persisting')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { since: string; dryRun?: boolean; format: string }) => {
      const env = resolveEnv();
      const since = parseSince(opts.since, '7d');
      const until = new Date();
      const turns = readWindow({ ctxRoot: env.ctxRoot, org: env.org || '', since, until });
      const store = getStorePaths(env.ctxRoot, env.org || '');
      const proposals = generateRecommendations({ turns, since, until });

      if (!opts.dryRun) persistRecommendations(store, proposals);

      if ((opts.format ?? 'text').toLowerCase() === 'json') {
        console.log(JSON.stringify({ proposals }, null, 2));
        return;
      }
      console.log(`Generated ${proposals.length} proposal(s)${opts.dryRun ? ' (dry-run, not persisted)' : ''}.`);
      for (const p of proposals) {
        console.log(`\n[${p.kind}] target=${p.target}  expected savings: $${p.expected_savings_usd_per_week.toFixed(2)}/wk  blast=${p.blast_radius}`);
        console.log(`  ${p.hypothesis}`);
        console.log(`  evidence: ${p.evidence_ids.length} turn(s) — id=${p.id}`);
      }
    });

  ta
    .command('recommendation-state')
    .description('Update a recommendation\'s lifecycle state')
    .argument('<id>', 'Recommendation UUID')
    .argument('<state>', 'draft|proposed|approved|rejected|applied|measured|kept|reverted')
    .option('--notes <text>', 'Free-form notes for the transition')
    .action((id: string, state: string, opts: { notes?: string }) => {
      const env = resolveEnv();
      const store = getStorePaths(env.ctxRoot, env.org || '');
      const updated = updateRecommendationState(store, id, state as RecommendationState, opts.notes);
      if (!updated) {
        console.error(`Recommendation ${id} not found`);
        process.exit(2);
      }
      console.log(JSON.stringify(updated, null, 2));
    });

  ta
    .command('list-recommendations')
    .description('List all recommendations and their lifecycle state')
    .option('--state <state>', 'Filter by state')
    .option('--format <fmt>', 'text | json', 'text')
    .action((opts: { state?: string; format: string }) => {
      const env = resolveEnv();
      const store = getStorePaths(env.ctxRoot, env.org || '');
      let recs = readRecommendations(store);
      if (opts.state) recs = recs.filter((r) => r.state === opts.state);
      if ((opts.format ?? 'text').toLowerCase() === 'json') {
        console.log(JSON.stringify({ recommendations: recs }, null, 2));
        return;
      }
      console.log(`${recs.length} recommendation(s)${opts.state ? ` in state=${opts.state}` : ''}`);
      for (const r of recs) {
        console.log(`\n[${r.state}] ${r.kind} — target=${r.target} — exp savings $${r.expected_savings_usd_per_week.toFixed(2)}/wk — id=${r.id}`);
        console.log(`  ${r.hypothesis}`);
      }
    });
});
