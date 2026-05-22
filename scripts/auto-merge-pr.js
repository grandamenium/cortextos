#!/usr/bin/env node
/**
 * auto-merge-pr.js
 *
 * Cron: every 15min. Lists open PRs across RevOps-Global-GIT repos, merges
 * those that pass all checks. Logs each merge via cortextos bus log-event.
 * Sends Telegram summary via orchestrator if >5 merges or any error occurs.
 *
 * Carve-outs (never touched): charlie-holstine, grandamenium repos.
 * Skip signals in PR body (case-insensitive): 'do not merge', 'feature branch only',
 *   'do_not_merge', 'greg merges'.
 * Skip if: mergeable != MERGEABLE, any check FAILURE, any CHANGES_REQUESTED review.
 */

'use strict';

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const { checkPR, formatComment, postComment } = require('./memo-conflict-check');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPOS = [
  'RevOps-Global-GIT/cortextos',
  'RevOps-Global-GIT/rgos',
  'RevOps-Global-GIT/ob1-app',
  'RevOps-Global-GIT/ob1-parents',
  'RevOps-Global-GIT/team-brain',
];

const CARVE_OUTS = ['charlie-holstine', 'grandamenium'];

const SKIP_BODY_PATTERNS = [
  /do\s*not\s*merge/i,
  /feature\s*branch\s*only/i,
  /do_not_merge/i,
  /greg\s*merges/i,
];

const CTX_ROOT = process.env.CTX_ROOT || `${process.env.HOME}/.cortextos/default`;
const CTX_AGENT_NAME = process.env.CTX_AGENT_NAME || 'dev';
const CTX_ORG = process.env.CTX_ORG || 'revops-global';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', timeout: 30000 });
  } catch (err) {
    throw new Error(`gh ${args.join(' ')}: ${err.message}`);
  }
}

function bus(args) {
  try {
    execFileSync('cortextos', ['bus', ...args], { encoding: 'utf-8', timeout: 15000 });
  } catch {
    // Non-fatal: bus errors must not abort the merge loop
  }
}

/**
 * Infer the owning agent from the PR branch name.
 * Branch conventions: "codex/...", "codex-2/...", "dev/...", "analyst/..."
 * Falls back to the current agent (dev) for non-prefixed branches.
 */
const KNOWN_AGENTS = ['codex', 'codex-2', 'codex-3', 'dev', 'analyst', 'orchestrator'];
function inferOwnerAgent(headRefName) {
  if (!headRefName) return CTX_AGENT_NAME;
  for (const agent of KNOWN_AGENTS) {
    if (headRefName.startsWith(agent + '/') || headRefName.startsWith(agent + '-')) {
      return agent;
    }
  }
  return CTX_AGENT_NAME;
}

function shouldSkipBody(body) {
  if (!body) return false;
  return SKIP_BODY_PATTERNS.some(p => p.test(body));
}

function isCarvedOut(repo) {
  return CARVE_OUTS.some(co => repo.includes(co));
}

/**
 * Fetch open PRs for a repo with merge + CI state via GitHub CLI GraphQL.
 * Returns array of { number, title, body, mergeable, mergeStateStatus, ciPassed, hasChangesRequested }
 */
function fetchPRs(repo) {
  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
          nodes {
            number
            title
            body
            isDraft
            headRefName
            mergeable
            mergeStateStatus
            autoMergeRequest { mergeMethod }
            reviews(last: 10, states: [CHANGES_REQUESTED]) { totalCount }
            commits(last: 1) {
              nodes {
                commit {
                  statusCheckRollup {
                    state
                    contexts(first: 20) {
                      nodes {
                        ... on CheckRun { conclusion name }
                        ... on StatusContext { state context }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const [owner, name] = repo.split('/');
  let raw;
  try {
    raw = gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
  } catch (err) {
    console.warn(`[auto-merge] Could not fetch PRs for ${repo}: ${err.message}`);
    return [];
  }
  const data = JSON.parse(raw);
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];

  return nodes.map(pr => {
    const commit = pr.commits?.nodes?.[0]?.commit;
    const rollup = commit?.statusCheckRollup;
    const contexts = rollup?.contexts?.nodes ?? [];

    const hasFailure = contexts.some(c =>
      (c.conclusion && c.conclusion === 'FAILURE') ||
      (c.state && c.state === 'FAILURE')
    );
    const allPassed = rollup ? rollup.state === 'SUCCESS' : true; // no checks = pass
    const hasChangesRequested = (pr.reviews?.totalCount ?? 0) > 0;

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      isDraft: pr.isDraft ?? false,
      headRefName: pr.headRefName ?? '',
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      ciPassed: !hasFailure && allPassed,
      hasChangesRequested,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const merged = [];
  const errors = [];

  for (const repo of REPOS) {
    if (isCarvedOut(repo)) continue;

    let prs;
    try {
      prs = fetchPRs(repo);
    } catch (err) {
      errors.push({ repo, error: err.message });
      continue;
    }

    for (const pr of prs) {
      const { number, title, body, isDraft, mergeable, mergeStateStatus, ciPassed, hasChangesRequested } = pr;

      // Skip conditions
      if (isDraft) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — draft PR`);
        continue;
      }
      if (shouldSkipBody(body)) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — body contains skip signal`);
        continue;
      }
      if (mergeable !== 'MERGEABLE') {
        console.log(`[auto-merge] SKIP #${number} ${repo} — mergeable=${mergeable}`);
        continue;
      }
      if (mergeStateStatus !== 'CLEAN') {
        console.log(`[auto-merge] SKIP #${number} ${repo} — mergeState=${mergeStateStatus}`);
        continue;
      }
      if (!ciPassed) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — CI not clean`);
        continue;
      }
      if (hasChangesRequested) {
        console.log(`[auto-merge] SKIP #${number} ${repo} — CHANGES_REQUESTED review`);
        continue;
      }

      // Memo-conflict check (skip if body contains 'memo-conflict-ok')
      if (!/memo-conflict-ok/i.test(body)) {
        let conflictResult;
        try {
          conflictResult = checkPR(repo, number);
        } catch {
          conflictResult = { hasConflict: false, conflicts: [] };
        }
        if (conflictResult.hasConflict) {
          const criticalCount = conflictResult.conflicts.filter(c => c.critical).length;
          console.log(`[auto-merge] SKIP #${number} ${repo} — memo-conflict (${criticalCount} critical, ${conflictResult.conflicts.length - criticalCount} warnings)`);
          const comment = formatComment(repo, number, conflictResult.conflicts);
          postComment(repo, number, comment);
          continue;
        }
      }

      // Merge
      try {
        console.log(`[auto-merge] MERGING #${number} ${repo} — "${title}"`);
        gh(['pr', 'merge', String(number), '-R', repo, '--squash', '--delete-branch']);
        merged.push({ repo, number, title, headRefName });
        bus(['log-event', 'action', 'pr_auto_merged', 'info',
          '--meta', JSON.stringify({ pr: number, repo, title, agent: CTX_AGENT_NAME })]);

        // Post-merge verification gate: notify the owning agent that they must
        // verify the merged change is working before marking the related task complete.
        const ownerAgent = inferOwnerAgent(headRefName);
        const verifyMsg = `[verify-required] PR #${number} ${repo.split('/')[1]} merged ("${title}"). ` +
          `Before marking any related task complete: confirm the change works in prod ` +
          `(CI green + smoke test or screenshot). Reply with verification evidence.`;
        bus(['send-message', ownerAgent, 'normal', verifyMsg]);
        console.log(`[auto-merge] Sent verify-required message to ${ownerAgent} for #${number}`);
      } catch (err) {
        console.error(`[auto-merge] ERROR merging #${number} ${repo}: ${err.message}`);
        errors.push({ repo, pr: number, error: err.message });
      }
    }
  }

  // Summary
  const mergedCount = merged.length;
  const errorCount = errors.length;
  console.log(`[auto-merge] Done: ${mergedCount} merged, ${errorCount} errors`);

  if (mergedCount > 5 || errorCount > 0) {
    const lines = [];
    if (mergedCount > 0) {
      lines.push(`Merged ${mergedCount} PRs:`);
      merged.slice(0, 10).forEach(m => lines.push(`  #${m.number} ${m.repo.split('/')[1]}: ${m.title}`));
    }
    if (errorCount > 0) {
      lines.push(`Errors (${errorCount}):`);
      errors.slice(0, 5).forEach(e => lines.push(`  ${e.repo} #${e.pr ?? ''}: ${e.error}`));
    }
    const summary = lines.join('\n');
    bus(['send-message', 'orchestrator', 'normal', `auto-merge-pr summary:\n${summary}`]);
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[auto-merge] Fatal:', err);
    process.exit(1);
  });
}

// Export helpers for unit testing
if (typeof module !== 'undefined') {
  module.exports = { shouldSkipBody, isCarvedOut, REPOS, CARVE_OUTS };
}

