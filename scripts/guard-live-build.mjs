#!/usr/bin/env node
/**
 * Refuse to overwrite a LIVE dist/ from a work-in-progress branch.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bin.cortextos` points at `dist/cli.js`. When cortextOS is installed from a
 * working checkout (`npm link`, `npm i -g .`), the global `cortextos` command
 * resolves *into that checkout's dist/*. Every agent, cron and hook on the box
 * executes it.
 *
 * So on a live fleet host, `npm run build` is not a compile step. It is a
 * DEPLOY. And nothing said so.
 *
 * CONTRIBUTING.md tells you to run `npm run build` to check your code compiles
 * before submitting — which, on such a host, ships the branch you are still
 * writing to every agent mid-run. A held merge protects nothing when the build
 * that "just checks it compiles" has already deployed. The gate was on `merge`;
 * the deploy happens at `build`.
 *
 * This guard puts the check where the decision actually happens.
 *
 * To VERIFY code without deploying:      npm run typecheck   (tsc --noEmit, writes nothing)
 * To DELIBERATELY deploy to a live host: CORTEXTOS_ALLOW_LIVE_BUILD=1 npm run build
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Non-fatal: any probe failing just means "cannot prove it's live" → allow. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Is THIS checkout's dist/ the binary the machine actually runs?
 *
 * Resolves the `cortextos` command on PATH through symlinks (npm's global bin is
 * a symlink into the linked package) and checks whether it lands inside our dist.
 */
function distIsLive() {
  const which = tryExec('sh', ['-c', 'command -v cortextos']);
  if (!which) return false;
  try {
    const real = realpathSync(which);
    return real === realpathSync(distDir) || real.startsWith(realpathSync(distDir) + sep);
  } catch {
    return false;
  }
}

function gitBranch() {
  return tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function gitDirty() {
  const out = tryExec('git', ['status', '--porcelain']);
  return out === null ? false : out.length > 0;
}

// --- escape hatches -------------------------------------------------------

if (process.env.CORTEXTOS_ALLOW_LIVE_BUILD === '1') {
  console.log(`${YELLOW}[build] CORTEXTOS_ALLOW_LIVE_BUILD=1 — deploying to dist/ deliberately.${RESET}`);
  process.exit(0);
}

// CI builds a throwaway checkout; nothing on the box runs it.
if (process.env.CI) process.exit(0);

// A dist that nothing executes is just a build artefact — the normal case for
// contributors who did not link the package.
if (!existsSync(distDir) || !distIsLive()) process.exit(0);

// --- dist/ is LIVE: is this a deliberate deploy, or someone verifying? -----

const branch = gitBranch();
const dirty = gitDirty();
const onMain = branch === 'main';

if (onMain && !dirty) {
  // Clean main == the released code. Building it is a legitimate deploy, but say so.
  console.log(`${YELLOW}[build] dist/ is LIVE on this host — this build DEPLOYS clean main to every agent.${RESET}`);
  process.exit(0);
}

const reason = !onMain
  ? `you are on branch "${branch}", not main`
  : 'your working tree has uncommitted changes';

console.error(`
${RED}${BOLD}✖ REFUSING TO BUILD — this would DEPLOY, not just compile.${RESET}

  ${BOLD}dist/ is the live binary on this host.${RESET}
  The global \`cortextos\` command resolves into ${distDir},
  so every agent, cron and hook on this box would immediately execute what
  this build writes — and ${reason}.

  ${BOLD}A build is a deploy here. That is almost certainly not what you meant.${RESET}

  To CHECK YOUR CODE COMPILES (writes nothing):
      ${BOLD}npm run typecheck${RESET}

  To DELIBERATELY DEPLOY this branch to the live fleet:
      ${BOLD}CORTEXTOS_ALLOW_LIVE_BUILD=1 npm run build${RESET}
`);
process.exit(1);
