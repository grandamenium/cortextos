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
import { join, relative } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMUNITY_AGENTS = join(process.cwd(), 'community', 'agents');
const COMMUNITY_SKILLS = join(process.cwd(), 'community', 'skills');
const COMMUNITY_CATALOG = join(process.cwd(), 'community', 'catalog.json');

const REQUIRED_COMMON_SKILLS = [
  'agent-management',
  'approvals',
  'bus-reference',
  'comms',
  'cron-management',
  'event-logging',
  'guardrails-reference',
  'heartbeat',
  'human-tasks',
  'knowledge-base',
  'memory',
  'onboarding',
  'system-diagnostics',
  'tasks',
];

type CatalogItem = {
  name?: string;
  type?: string;
  review_status?: string;
  install_path?: string;
};

function getCatalogCommunityTemplateAgents(): string[] {
  const catalog = JSON.parse(readFileSync(COMMUNITY_CATALOG, 'utf-8')) as { items?: CatalogItem[] };
  expect(Array.isArray(catalog.items), 'community/catalog.json items must be an array').toBe(true);

  return (catalog.items ?? [])
    .filter((item) => (
      item.type === 'agent' &&
      item.review_status === 'community' &&
      typeof item.install_path === 'string' &&
      item.install_path.startsWith('community/agents/')
    ))
    .map((item) => item.install_path!.replace(/^community\/agents\//, ''))
    .sort();
}

const STRICT_COMMUNITY_TEMPLATE_AGENTS = new Set(getCatalogCommunityTemplateAgents());

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

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function getTextFiles(dir: string): string[] {
  return walkFiles(dir).filter((file) => {
    const name = file.toLowerCase();
    return (
      name.endsWith('.md') ||
      name.endsWith('.json') ||
      name.endsWith('.txt') ||
      name.endsWith('.yml') ||
      name.endsWith('.yaml')
    );
  });
}

function readConfig(agentDir: string): Record<string, any> {
  const configPath = join(agentDir, 'config.json');
  expect(existsSync(configPath), 'config.json must exist').toBe(true);
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function normalizeText(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
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
    if (/do not use.*\/loop|not.*\/loop|never.*\/loop|session-only|session-scoped|session-local/i.test(line)) continue;
    // Skip comment lines (markdown or code comment)
    if (/^\s*(<!--.*-->|\/\/|#)/.test(line)) continue;
    // Detect the creation pattern: `/loop <interval> <text>`
    if (/`?\/loop\s+\w+\s+.+`?/.test(line)) return true;
  }
  return false;
}

function hasStaleLoopPersistentCronTeaching(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.includes('/loop')) continue;
    if (/\/loop\s+vs\s+persistent/i.test(line)) continue;
    if (/do not use.*\/loop|never use.*\/loop|not.*\/loop|session-only|session-scoped|session-local/i.test(line)) continue;
    if (/persist|persistent|survive|restart|recurring cron|scheduled task/i.test(line)) return true;
  }
  return false;
}

function validateConfigCrons(config: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!Array.isArray(config.crons)) {
    return ['config.crons must be a non-empty array'];
  }
  if (config.crons.length === 0) {
    return ['config.crons must contain at least one cron'];
  }

  const seenNames = new Set<string>();
  config.crons.forEach((cron: any, index: number) => {
    const prefix = `crons[${index}]`;
    if (!cron || typeof cron !== 'object' || Array.isArray(cron)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    if (typeof cron.name !== 'string' || cron.name.trim() === '') {
      errors.push(`${prefix}.name must be a non-empty string`);
    } else if (!/^[a-z0-9][a-z0-9_-]*$/.test(cron.name)) {
      errors.push(`${prefix}.name "${cron.name}" must be lowercase slug text`);
    } else if (seenNames.has(cron.name)) {
      errors.push(`${prefix}.name "${cron.name}" is duplicated`);
    } else {
      seenNames.add(cron.name);
    }

    if (cron.type !== undefined && !['recurring', 'once', 'disabled'].includes(cron.type)) {
      errors.push(`${prefix}.type must be recurring, once, or disabled when present`);
    }

    if (typeof cron.prompt !== 'string' || cron.prompt.trim() === '') {
      errors.push(`${prefix}.prompt must be a non-empty string`);
    }

    const hasInterval = typeof cron.interval === 'string' && cron.interval.trim() !== '';
    const hasCronExpr = typeof cron.cron === 'string' && cron.cron.trim() !== '';
    const hasFireAt = typeof cron.fire_at === 'string' && cron.fire_at.trim() !== '';
    const type = cron.type ?? 'recurring';

    if (type === 'once') {
      if (!hasFireAt) errors.push(`${prefix}.fire_at is required for once crons`);
      if (hasFireAt && Number.isNaN(Date.parse(cron.fire_at))) {
        errors.push(`${prefix}.fire_at must be ISO-parseable`);
      }
      if (hasInterval || hasCronExpr) {
        errors.push(`${prefix} once crons must not also set interval/cron`);
      }
      return;
    }

    if (!hasInterval && !hasCronExpr) {
      errors.push(`${prefix} must set interval or cron`);
    }
    if (hasInterval && hasCronExpr) {
      errors.push(`${prefix} must set only one of interval or cron`);
    }
    if (hasInterval && !/^\d+[smhdw]$/.test(cron.interval)) {
      errors.push(`${prefix}.interval "${cron.interval}" must look like 30m, 4h, or 1d`);
    }
    if (hasCronExpr && !/^(\S+\s+){4}\S+$/.test(cron.cron)) {
      errors.push(`${prefix}.cron "${cron.cron}" must be a 5-field cron expression`);
    }
  });

  return errors;
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

  it('checks every cataloged community template agent', () => {
    expect([...STRICT_COMMUNITY_TEMPLATE_AGENTS]).toEqual([
      'automation-builder-agent',
      'coding-agent',
      'cortextos-concierge',
      'customer-support-agent',
      'fitness-agent',
      'knowledge-base-librarian',
      'research-agent',
      'social-media-agent',
    ]);
  });

  for (const agent of agents) {
    const agentDir = join(COMMUNITY_AGENTS, agent);

    describe(`community/agents/${agent}`, () => {
      it('AGENTS.md exists', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
      });

      it('does not reference AGENTS.md without shipping it', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        if (existsSync(join(agentDir, 'AGENTS.md'))) return;
        const references = getTextFiles(agentDir)
          .filter((file) => /AGENTS\.md/.test(readFileSync(file, 'utf-8')))
          .map((file) => relative(process.cwd(), file));

        expect(references).toEqual([]);
      });

      it('ships required common operating skills', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const missing = REQUIRED_COMMON_SKILLS.filter((skill) => (
          !existsSync(join(agentDir, '.claude', 'skills', skill, 'SKILL.md'))
        ));

        expect(missing).toEqual([]);
      });

      it('ships a universal setup wrapper plus domain setup skill', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const config = readConfig(agentDir);
        expect(config.setup_skill).toBe('setup');
        expect(typeof config.domain_setup_skill).toBe('string');
        expect(config.domain_setup_skill.trim()).not.toBe('');

        expect(existsSync(join(agentDir, '.claude', 'skills', 'setup', 'SKILL.md'))).toBe(true);
        expect(existsSync(join(agentDir, '.claude', 'skills', config.domain_setup_skill, 'SKILL.md'))).toBe(true);
      });

      it('keeps vendored common skills byte-identical to canonical community skills', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const drift = REQUIRED_COMMON_SKILLS.filter((skill) => {
          const canonical = join(COMMUNITY_SKILLS, skill, 'SKILL.md');
          const vendored = join(agentDir, '.claude', 'skills', skill, 'SKILL.md');
          return normalizeText(readFileSync(canonical, 'utf-8')) !== normalizeText(readFileSync(vendored, 'utf-8'));
        });

        expect(drift).toEqual([]);
      });

      it('common operating skill files do not leak private/internal agent names', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const leakPatterns = [
          /\bsentinel\b/i,
          /\baamcp\b/i,
          /\blifeos\b/i,
        ];
        const leaked = REQUIRED_COMMON_SKILLS.flatMap((skill) => {
          const file = join(agentDir, '.claude', 'skills', skill, 'SKILL.md');
          const content = readFileSync(file, 'utf-8');
          return leakPatterns.some((pattern) => pattern.test(content))
            ? [relative(process.cwd(), file)]
            : [];
        });

        expect(leaked).toEqual([]);
      });

      it('config.json contains valid non-empty cron definitions', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const config = readConfig(agentDir);
        expect(validateConfigCrons(config)).toEqual([]);
      });

      it('text files do not teach stale persistent /loop cron behavior', () => {
        if (!STRICT_COMMUNITY_TEMPLATE_AGENTS.has(agent)) return;
        const staleFiles = getTextFiles(agentDir)
          .filter((file) => !file.endsWith(join('.claude', 'skills', 'm2c1-worker', 'SKILL.md')))
          .filter((file) => {
            const content = readFileSync(file, 'utf-8');
            return hasStaleLoopCronCreation(content) || hasStaleLoopPersistentCronTeaching(content);
          })
          .map((file) => relative(process.cwd(), file));

        expect(staleFiles).toEqual([]);
      });

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
