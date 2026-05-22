/**
 * tests/integration/community-templates-no-stale-cron-refs.test.ts
 *
 * Regression guard for Subtask 2.3.
 *
 * Asserts that community agent template files (AGENTS.md, CLAUDE.md,
 * ONBOARDING.md) and cron-management skill files do NOT contain stale
 * session-only cron instructions that were valid before the external
 * persistent-crons migration.
 *
 * Specifically guards against:
 *   - "Restore crons from config.json" (old step 6 / session-start language)
 *   - "CronList first" (paired with session restore pattern)
 *   - "/loop {interval} {prompt}" pattern in cron-restoration contexts
 *
 * Also asserts:
 *   - Each AGENTS.md step 6 contains "daemon-managed" or "auto-load"
 *   - cron-management SKILL.md files contain "bus add-cron" (new API)
 *
 * Exclusions (legitimate session-only /loop uses):
 *   - m2c1-worker SKILL.md files (short-lived worker session polling)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMUNITY_AGENTS = join(process.cwd(), 'community', 'agents');
const COMMUNITY_SKILLS = join(process.cwd(), 'community', 'skills');

/** Return list of top-level agent directories under community/agents/ */
function getAgentDirs(): string[] {
  if (!existsSync(COMMUNITY_AGENTS)) return [];
  return readdirSync(COMMUNITY_AGENTS).filter((name) => {
    const p = join(COMMUNITY_AGENTS, name);
    return statSync(p).isDirectory() && !name.startsWith('.');
  });
}

/** Read file content if it exists, else return null. */
function readIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/** Collect all cron-management SKILL.md files under community/ */
function getCronManagementSkillFiles(): string[] {
  const paths: string[] = [];

  // community/skills/cron-management/SKILL.md
  const communitySkillPath = join(COMMUNITY_SKILLS, 'cron-management', 'SKILL.md');
  if (existsSync(communitySkillPath)) paths.push(communitySkillPath);

  // community/agents/{agent}/.claude/skills/cron-management/SKILL.md
  for (const agent of getAgentDirs()) {
    const agentSkillPath = join(
      COMMUNITY_AGENTS,
      agent,
      '.claude',
      'skills',
      'cron-management',
      'SKILL.md',
    );
    if (existsSync(agentSkillPath)) paths.push(agentSkillPath);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Patterns considered stale
// ---------------------------------------------------------------------------

const STALE_RESTORE_PATTERN = /Restore crons from `?config\.json`?/i;
const STALE_CRONLIST_FIRST_PATTERN = /run CronList first/i;

/**
 * Matches "/loop {interval} {prompt}" in a cron-restoration context.
 * Specifically: `/loop` followed by an interval token (e.g. 4h, 2h, 1d)
 * then a space and some text — the creation form, not a "do NOT use /loop" warning.
 *
 * We exclude lines that are part of "do NOT use /loop" or "not /loop" phrases,
 * since those are the correct migration-era warnings we intentionally added.
 */
function hasStaleLoopCronCreation(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    // Skip lines that are clearly warning against /loop usage
    if (/do not use.*\/loop|not.*\/loop|never.*\/loop/i.test(line)) continue;
    // Skip comment lines (markdown or code comment)
    if (/^\s*(<!--.*-->|\/\/|#)/.test(line)) continue;
    // Detect the creation pattern: `/loop <interval> <text>`
    if (/`?\/loop\s+\w+\s+.+`?/.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('community templates: no stale cron restoration references', () => {
  const agents = getAgentDirs();

  // Make sure we actually found some agents to check
  it('finds at least one community agent directory', () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  for (const agent of agents) {
    const agentDir = join(COMMUNITY_AGENTS, agent);

    describe(`community/agents/${agent}`, () => {
      // ---- AGENTS.md -------------------------------------------------------

      const agentsMdPath = join(agentDir, 'AGENTS.md');
      const agentsMdContent = readIfExists(agentsMdPath);

      if (agentsMdContent !== null) {
        it('AGENTS.md: step 6 does not contain "Restore crons from config.json"', () => {
          expect(STALE_RESTORE_PATTERN.test(agentsMdContent)).toBe(false);
        });

        it('AGENTS.md: step 6 does not contain "run CronList first" in restore context', () => {
          // Allow "list-crons" but not the old CronList-first-restore pattern
          expect(STALE_CRONLIST_FIRST_PATTERN.test(agentsMdContent)).toBe(false);
        });

        it('AGENTS.md: step 6 contains "daemon-managed" or "auto-load"', () => {
          // The step 6 line should describe daemon management
          const hasDaemonRef =
            agentsMdContent.includes('daemon-managed') ||
            agentsMdContent.includes('auto-load');
          expect(hasDaemonRef).toBe(true);
        });

        it('AGENTS.md: does not contain stale /loop cron-creation pattern', () => {
          expect(hasStaleLoopCronCreation(agentsMdContent)).toBe(false);
        });
      }

      // ---- CLAUDE.md -------------------------------------------------------

      const claudeMdPath = join(agentDir, 'CLAUDE.md');
      const claudeMdContent = readIfExists(claudeMdPath);

      if (claudeMdContent !== null) {
        it('CLAUDE.md: does not contain "Restore crons from config.json"', () => {
          expect(STALE_RESTORE_PATTERN.test(claudeMdContent)).toBe(false);
        });

        it('CLAUDE.md: does not contain "run CronList first"', () => {
          expect(STALE_CRONLIST_FIRST_PATTERN.test(claudeMdContent)).toBe(false);
        });

        it('CLAUDE.md: does not contain stale /loop cron-creation pattern', () => {
          expect(hasStaleLoopCronCreation(claudeMdContent)).toBe(false);
        });
      }

      // ---- ONBOARDING.md ---------------------------------------------------

      const onboardingMdPath = join(agentDir, 'ONBOARDING.md');
      const onboardingMdContent = readIfExists(onboardingMdPath);

      if (onboardingMdContent !== null) {
        it('ONBOARDING.md: does not contain "Restore crons from config.json"', () => {
          expect(STALE_RESTORE_PATTERN.test(onboardingMdContent)).toBe(false);
        });

        it('ONBOARDING.md: does not contain "run CronList first"', () => {
          expect(STALE_CRONLIST_FIRST_PATTERN.test(onboardingMdContent)).toBe(false);
        });

        it('ONBOARDING.md: does not contain stale /loop cron-creation pattern', () => {
          expect(hasStaleLoopCronCreation(onboardingMdContent)).toBe(false);
        });
      }

      // ---- .claude/skills/cron-management/SKILL.md -------------------------

      const cronSkillPath = join(
        agentDir,
        '.claude',
        'skills',
        'cron-management',
        'SKILL.md',
      );
      const cronSkillContent = readIfExists(cronSkillPath);

      if (cronSkillContent !== null) {
        it('.claude/skills/cron-management/SKILL.md: does not contain stale /loop cron-creation pattern', () => {
          expect(hasStaleLoopCronCreation(cronSkillContent)).toBe(false);
        });

        it('.claude/skills/cron-management/SKILL.md: references bus add-cron', () => {
          expect(cronSkillContent.includes('bus add-cron')).toBe(true);
        });
      }
    });
  }

  // ---- community/skills/cron-management/SKILL.md ---------------------------

  describe('community/skills/cron-management/SKILL.md', () => {
    const skillContent = readIfExists(
      join(COMMUNITY_SKILLS, 'cron-management', 'SKILL.md'),
    );

    it('file exists', () => {
      expect(skillContent).not.toBeNull();
    });

    if (skillContent !== null) {
      it('does not contain stale /loop cron-creation pattern', () => {
        expect(hasStaleLoopCronCreation(skillContent)).toBe(false);
      });

      it('references bus add-cron', () => {
        expect(skillContent.includes('bus add-cron')).toBe(true);
      });

      it('does not contain "Restore crons from config.json"', () => {
        expect(STALE_RESTORE_PATTERN.test(skillContent)).toBe(false);
      });

      it('does not contain "run CronList first"', () => {
        expect(STALE_CRONLIST_FIRST_PATTERN.test(skillContent)).toBe(false);
      });
    }
  });

  // ---- m2c1-worker exclusion sanity check ----------------------------------

  describe('m2c1-worker exclusion: legitimate /loop use is preserved', () => {
    const workerSkillPath = join(
      COMMUNITY_SKILLS,
      'm2c1-worker',
      'SKILL.md',
    );
    const workerContent = readIfExists(workerSkillPath);

    it('file exists', () => {
      expect(workerContent).not.toBeNull();
    });

    if (workerContent !== null) {
      it('still contains /loop reference for session-scoped worker polling', () => {
        expect(workerContent.includes('/loop')).toBe(true);
      });
    }
  });
});
