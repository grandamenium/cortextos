/**
 * skill-autopr.ts — `cortextos bus create-skill-pr <skill-name>`
 *
 * Called by hook-skill-autopr.ts (as a background process) after a community
 * skill is written or modified. Handles the git operations and draft PR creation
 * so the hook can return immediately without blocking the agent.
 *
 * Steps:
 *  1. Locate the skill file and validate it exists
 *  2. Check whether a PR for this skill is already open (avoid duplicates)
 *  3. Create a branch community/skill/<name>-<timestamp>
 *  4. Stage and commit the skill directory
 *  5. Push the branch
 *  6. Open a draft PR with a mandatory security checklist in the body
 *  7. Log the result
 *
 * Requires: git, gh CLI (GitHub CLI) in PATH.
 * Safe to re-run: duplicate detection prevents multiple open PRs for the same skill.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { scanForSecurityIssues, validateFrontmatter } from '../hooks/hook-skill-autopr.js';

const UPSTREAM_REPO = 'grandamenium/cortextos';

/**
 * Skill names must be lowercase alphanumeric slugs.
 * This prevents shell injection when the name is interpolated into run() commands.
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Run a shell command and return its stdout, or throw on non-zero exit.
 */
function run(cmd: string, cwd: string): string {
  const result = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
    throw new Error(`Command failed (${result.status}): ${cmd}\n${err}`);
  }
  return result.stdout?.trim() || '';
}

/**
 * Check if a draft PR is already open for this skill branch prefix.
 * Returns the PR URL if found, null otherwise.
 * Logs auth/network failures to stderr rather than silently masking them.
 */
function findExistingPR(skillName: string, cwd: string): string | null {
  try {
    const out = run(
      `gh pr list --repo ${UPSTREAM_REPO} --state open --json headRefName,url ` +
      `--jq '.[] | select(.headRefName | startswith("community/skill/${skillName}-")) | .url'`,
      cwd,
    );
    return out.trim() || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log authentication or network errors so they surface in daemon logs
    if (/auth|token|credential|network|timeout|permission/i.test(msg)) {
      process.stderr.write(`skill-autopr: gh pr list failed (possible auth issue): ${msg}\n`);
    }
    return null;
  }
}

/**
 * Build the draft PR body with security checklist and scan results.
 */
function buildPrBody(
  skillName: string,
  description: string,
  securityFlags: string[],
  warnings: string[],
): string {
  const securityStatus = securityFlags.length === 0
    ? '✅ Automated scan passed — no obvious injection or exfiltration patterns detected.'
    : `⚠️ **Automated scan flagged ${securityFlags.length} issue(s) — human review required:**\n${securityFlags.map(f => `  - ${f}`).join('\n')}`;

  const warningBlock = warnings.length > 0
    ? `\n**Frontmatter warnings:**\n${warnings.map(w => `- ${w}`).join('\n')}\n`
    : '';

  return `## New Community Skill: \`${skillName}\`

**Description:** ${description}
${warningBlock}
---

## Security Scan

${securityStatus}

> This scan is heuristic-only. Human review is mandatory before merging.
> See Snyk ToxicSkills report: 13.4% of published community skills contain critical vulnerabilities.

---

## Reviewer Checklist (required before merge)

- [ ] Description accurately explains what the skill does and when to use it
- [ ] No hardcoded credentials, API keys, or tokens in skill content
- [ ] No exfiltration code (curl to external URLs, webhook calls, data uploads)
- [ ] No prompt injection (hidden instructions, "ignore previous instructions", conditional exfiltration)
- [ ] Scripts (if any) are minimal, documented, and do not execute arbitrary code
- [ ] \`external_calls\` field accurately reflects all network calls the skill makes
- [ ] \`triggers\` field contains appropriate activation phrases
- [ ] \`license\` field present if skill includes third-party content

---

🤖 Auto-staged by cortextos hook-skill-autopr | Draft PR — do not merge without checklist sign-off`;
}

export async function createSkillPr(skillName: string): Promise<void> {
  // Validate skill name is a safe slug — prevents shell injection and path traversal
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(
      `Invalid skill name "${skillName}" — must match [a-z0-9][a-z0-9_-]{0,63} (alphanumeric slug only)`,
    );
  }

  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();

  // Path traversal check: resolved skill dir must stay inside community/skills/
  const communitySkillsDir = join(frameworkRoot, 'community', 'skills');
  const skillDir = join(communitySkillsDir, skillName);
  if (!skillDir.startsWith(communitySkillsDir + '/') && skillDir !== communitySkillsDir) {
    throw new Error(`Skill path "${skillDir}" escapes the community/skills directory`);
  }

  const skillFile = join(skillDir, 'SKILL.md');

  if (!existsSync(skillFile)) {
    throw new Error(`Skill file not found: ${skillFile}`);
  }

  const content = readFileSync(skillFile, 'utf-8');

  // Re-validate frontmatter (hook already checked, but be defensive)
  const validation = validateFrontmatter(content, skillName);
  if (!validation.valid) {
    throw new Error(`Invalid frontmatter for skill "${skillName}": ${validation.error}`);
  }

  // Security scan
  const security = scanForSecurityIssues(content);

  // Check for existing open PR (duplicate prevention)
  const existing = findExistingPR(skillName, frameworkRoot);
  if (existing) {
    console.log(`Skill PR already open for "${skillName}": ${existing}`);
    return;
  }

  // Create a new branch
  const ts = Math.floor(Date.now() / 1000);
  const branch = `community/skill/${skillName}-${ts}`;

  // Save the skill file content now, before any branch switching.
  // `git checkout -` at the end returns to the original branch, which resets
  // tracked files to their committed state — losing uncommitted changes written
  // by the hook that triggered us. We restore the file after switching back.
  const skillFileContentBeforeBranch = readFileSync(skillFile, 'utf-8');

  let bodyFile: string | null = null;

  try {
    // Fetch latest upstream, then branch from origin/main
    // Failing to fetch is non-fatal — we'll still branch from whatever origin/main is cached
    run('git fetch origin main 2>/dev/null || git fetch upstream main 2>/dev/null || true', frameworkRoot);
    run(`git checkout -b ${branch} origin/main`, frameworkRoot);

    // Restore the skill file on the new branch — git checkout from origin/main
    // would have reset it to the committed version, losing our uncommitted write.
    writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');

    // Stage only the skill directory
    run(`git add community/skills/${skillName}/`, frameworkRoot);

    // Check if there's anything to commit
    const status = run('git diff --cached --name-only', frameworkRoot);
    if (!status) {
      throw new Error(`Nothing staged for skill "${skillName}" — file may not have changed`);
    }

    // Commit
    run(
      `git commit -m "community: add skill ${skillName}\n\nAuto-staged by hook-skill-autopr.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`,
      frameworkRoot,
    );

    // Push
    run(`git push origin ${branch}`, frameworkRoot);

    // Write PR body to a temp file so multi-line content is passed correctly
    // (bash -c with inline JSON.stringify flattens \n — body-file preserves formatting)
    const description = (validation.frontmatter.description as string) || '';
    const body = buildPrBody(skillName, description, security.flags, validation.warnings);
    const title = `community: add skill ${skillName}`;

    bodyFile = join(tmpdir(), `skill-pr-body-${ts}.txt`);
    writeFileSync(bodyFile, body, 'utf-8');

    const prUrl = run(
      `gh pr create --repo ${UPSTREAM_REPO} --draft ` +
      `--title ${JSON.stringify(title)} ` +
      `--body-file ${JSON.stringify(bodyFile)} ` +
      `--head ${branch}`,
      frameworkRoot,
    );

    console.log(`Draft PR created for skill "${skillName}": ${prUrl}`);

    // Return to original branch, then restore the skill file so the working
    // tree reflects the content that was written before we branched.
    run('git checkout -', frameworkRoot);
    writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');
  } catch (err) {
    // Attempt cleanup: return to original branch and restore file
    try {
      run('git checkout -', frameworkRoot);
      writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');
    } catch { /* ignore */ }
    throw err;
  } finally {
    // Clean up temp body file
    if (bodyFile) {
      try { unlinkSync(bodyFile); } catch { /* ignore */ }
    }
  }
}

// No require.main === module guard here — skill-autopr.ts is bundled into cli.js
// by tsup (splitting: false) so that check would always be true and fire on every
// CLI invocation. The CLI entry point is bus.ts, which registers create-skill-pr
// as a Commander subcommand and calls createSkillPr() from there.
