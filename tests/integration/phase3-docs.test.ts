/**
 * tests/integration/phase3-docs.test.ts — Subtask 3.1-3.4 Documentation Guard
 *
 * Asserts that the Phase 3 documentation pass is complete and consistent:
 *
 *   - Each templates/{agent,orchestrator,analyst}/AGENTS.md contains the
 *     "## External Persistent Crons" section with all required examples
 *   - CRONS_MIGRATION_GUIDE.md exists with all required sections
 *   - No doc contains the stale "Crons die on restart" claim
 *   - No doc references the deprecated CronList-first cron-restoration pattern
 *     (m2c1-worker excluded — legitimate session-only /loop use)
 *
 * Lightweight: file presence + key string checks only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

function read(filePath: string): string {
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf-8');
}

function readRequired(filePath: string): string {
  expect(existsSync(filePath), `Expected file to exist: ${filePath}`).toBe(true);
  return readFileSync(filePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// PR-A2 (2026-05-11): templates/*/AGENTS.md were removed — content moved into
// CLAUDE.md (top-level shape) and the cron-management skill (deep how-to).
// The "External Persistent Crons" guidance now lives in the skill and is
// asserted against there.

const TEMPLATE_NAMES = ['agent', 'orchestrator', 'analyst'];

// The persistent-cron teaching now lives in the cron-management skill that
// ships with each agent template. One skill SKILL.md per template role.
const TEMPLATE_CRON_SKILLS = TEMPLATE_NAMES.map((name) =>
  join(ROOT, 'templates', name, '.claude', 'skills', 'cron-management', 'SKILL.md'),
);

const MIGRATION_GUIDE = join(ROOT, 'CRONS_MIGRATION_GUIDE.md');

// Stale patterns that must not appear in docs
const STALE_CRONLIST_FIRST = /run CronList first/i;
const STALE_CRONS_DIE_RESTART = /crons die on restart/i;

// ---------------------------------------------------------------------------
// 3.1 — AGENTS.md Comprehensive Rewrite
// ---------------------------------------------------------------------------

// PR-A2: AGENTS.md was removed from per-role templates. The persistent-cron
// teaching it carried was already covered by .claude/skills/cron-management/
// SKILL.md; we now assert against that skill directly. Migration-specific
// assertions (`.crons-migrated` marker, automatic-migration-from-config.json,
// test-cron-fire wiring) are covered by section 3.4 against the
// CRONS_MIGRATION_GUIDE.md, which is the actual source of truth for those
// claims — keeping them duplicated in every template was the smell that
// motivated the restructure.
describe('3.1 — templates/*/cron-management skill teaches persistent crons', () => {
  for (let i = 0; i < TEMPLATE_CRON_SKILLS.length; i++) {
    const filePath = TEMPLATE_CRON_SKILLS[i];
    const name = TEMPLATE_NAMES[i];

    describe(`templates/${name}/.claude/skills/cron-management/SKILL.md`, () => {
      it('file exists', () => {
        expect(existsSync(filePath)).toBe(true);
      });

      it('explains crons.json as the source of truth', () => {
        const content = readRequired(filePath);
        expect(content).toContain('crons.json');
      });

      it('explains daemon-managed model', () => {
        const content = readRequired(filePath);
        expect(content).toMatch(/daemon.*manag|daemon owns|daemon reads|daemon-managed/i);
      });

      it('distinguishes /loop (ephemeral) from persistent crons', () => {
        const content = readRequired(filePath);
        expect(content).toContain('/loop');
        expect(content).toMatch(/session.only|session.local|ephemeral|dies when|dies on restart|won.?t survive/i);
      });

      it('shows the bus add-cron heartbeat interval form', () => {
        const content = readRequired(filePath);
        expect(content).toMatch(/cortextos bus add-cron.*heartbeat.*[0-9]+[smhd]/);
      });

      it('shows a 5-field cron expression example', () => {
        const content = readRequired(filePath);
        expect(content).toMatch(/add-cron[\s\S]*?"[0-9*\-]+\s+[0-9*\-]+\s+\*\s+\*/);
      });

      it('teaches list-crons for verification', () => {
        const content = readRequired(filePath);
        expect(content).toContain('cortextos bus list-crons');
      });

      it('teaches get-cron-log for execution history', () => {
        const content = readRequired(filePath);
        expect(content).toContain('cortextos bus get-cron-log');
      });

      it('does not contain stale "CronList first" pattern', () => {
        const content = readRequired(filePath);
        expect(STALE_CRONLIST_FIRST.test(content)).toBe(false);
      });

      it('does not claim crons die on restart', () => {
        const content = readRequired(filePath);
        expect(STALE_CRONS_DIE_RESTART.test(content)).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3.2 — Onboarding docs updated
// ---------------------------------------------------------------------------

describe('3.2 — Onboarding docs contain persistent cron guidance', () => {
  // PR-A2: per-template ONBOARDING.md replaced by .claude/skills/onboarding/SKILL.md
  // under each template, and the canonical community/skills/onboarding/SKILL.md.
  const onboardingDocs = [
    { label: 'templates/agent/.claude/skills/onboarding/SKILL.md',
      path: join(ROOT, 'templates', 'agent', '.claude', 'skills', 'onboarding', 'SKILL.md') },
    { label: 'templates/orchestrator/.claude/skills/onboarding/SKILL.md',
      path: join(ROOT, 'templates', 'orchestrator', '.claude', 'skills', 'onboarding', 'SKILL.md') },
    { label: 'templates/analyst/.claude/skills/onboarding/SKILL.md',
      path: join(ROOT, 'templates', 'analyst', '.claude', 'skills', 'onboarding', 'SKILL.md') },
    { label: 'community/skills/onboarding/SKILL.md',
      path: join(ROOT, 'community', 'skills', 'onboarding', 'SKILL.md') },
  ];

  for (const { label, path } of onboardingDocs) {
    describe(label, () => {
      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('references cortextos bus add-cron for persistent scheduling', () => {
        // PR-A2: per-template onboarding skills don't duplicate the cron
        // teaching — that lives in the cron-management skill which ships
        // alongside them. The canonical community onboarding skill still
        // carries the full instruction. Skip the per-template variants here
        // since the persistent-cron teaching is asserted directly on the
        // cron-management skill in section 3.1.
        if (/templates\/[^/]+\/\.claude\/skills\/onboarding/.test(path)) {
          return;
        }
        const content = read(path);
        expect(content).toContain('cortextos bus add-cron');
      });

      it('does not use /loop for persistent cron creation (creation form only)', () => {
        const content = read(path);
        const lines = content.split('\n');
        for (const line of lines) {
          // Skip warning lines that correctly advise against /loop
          if (/do not use.*\/loop|not.*\/loop|never.*\/loop/i.test(line)) continue;
          // Skip comment lines
          if (/^\s*(<!--.*-->|\/\/|#)/.test(line)) continue;
          // Detect the stale creation pattern: `/loop <interval> <text>`
          const hasStaleLoop = /`?\/loop\s+\w+\s+.+`?/.test(line);
          if (hasStaleLoop) {
            throw new Error(`${label}: stale /loop cron creation found: "${line.trim()}"`);
          }
        }
      });

      it('does not reference CronCreate for scheduling', () => {
        const content = read(path);
        // Allow the word in warnings ("do NOT use CronCreate"), but not as an instruction
        const lines = content.split('\n');
        for (const line of lines) {
          if (/do not use.*CronCreate|not.*CronCreate|never.*CronCreate/i.test(line)) continue;
          if (/^\s*(<!--.*-->|\/\/|#)/.test(line)) continue;
          // Any bare CronCreate instruction (tool call format) is stale
          if (/\bCronCreate\b/.test(line) && !/warning|warn|avoid|never|not recommended/i.test(line)) {
            throw new Error(`${label}: stale CronCreate instruction found: "${line.trim()}"`);
          }
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3.3 — Skill docs: heartbeat + autoresearch
// ---------------------------------------------------------------------------

describe('3.3 — Skill documentation updates', () => {
  describe('community/skills/heartbeat/SKILL.md', () => {
    const heartbeatPath = join(ROOT, 'community', 'skills', 'heartbeat', 'SKILL.md');

    it('file exists', () => {
      expect(existsSync(heartbeatPath)).toBe(true);
    });

    it('references crons.json or daemon-managed (not just config.json)', () => {
      const content = read(heartbeatPath);
      const hasDaemonRef = content.includes('crons.json') || content.includes('daemon-managed');
      expect(hasDaemonRef).toBe(true);
    });

    it('does not say to check CronList to verify crons', () => {
      const content = read(heartbeatPath);
      expect(STALE_CRONLIST_FIRST.test(content)).toBe(false);
    });

    it('guides to list-crons for verification', () => {
      const content = read(heartbeatPath);
      expect(content).toContain('list-crons');
    });
  });

  describe('community/skills/autoresearch/SKILL.md', () => {
    const autoresearchPath = join(ROOT, 'community', 'skills', 'autoresearch', 'SKILL.md');

    it('file exists', () => {
      expect(existsSync(autoresearchPath)).toBe(true);
    });

    it('uses bus add-cron for experiment cron setup', () => {
      const content = read(autoresearchPath);
      expect(content).toContain('cortextos bus add-cron');
    });
  });
});

// ---------------------------------------------------------------------------
// 3.4 — CRONS_MIGRATION_GUIDE.md
// ---------------------------------------------------------------------------

describe('3.4 — CRONS_MIGRATION_GUIDE.md', () => {
  it('file exists at repo root', () => {
    expect(existsSync(MIGRATION_GUIDE)).toBe(true);
  });

  const REQUIRED_SECTIONS = [
    'What Changed',
    'What You Need to Do',
    'Verification',
    'Troubleshooting',
    'Backward Compatibility',
  ];

  for (const section of REQUIRED_SECTIONS) {
    it(`contains section: "${section}"`, () => {
      const content = readRequired(MIGRATION_GUIDE);
      expect(content).toContain(section);
    });
  }

  it('explains the migration is automatic', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toMatch(/automatic|Nothing.*Migration runs/i);
  });

  it('references .crons-migrated marker file', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toContain('.crons-migrated');
  });

  it('references crons.json as the target store', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toContain('crons.json');
  });

  it('explains config.json is left untouched (non-destructive)', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toMatch(/untouched|non.destructive|left unchanged/i);
  });

  it('provides manual migration command', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toContain('cortextos bus migrate-crons');
  });

  it('provides --force flag for bypassing marker', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toContain('--force');
  });

  it('references Architecture section with source file paths', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(content).toContain('src/');
    expect(content).toContain('Architecture');
  });

  it('does not claim crons die on restart', () => {
    const content = readRequired(MIGRATION_GUIDE);
    expect(STALE_CRONS_DIE_RESTART.test(content)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: no stale patterns in any template AGENTS.md
// ---------------------------------------------------------------------------

describe('cross-cutting: no deprecated patterns in template docs', () => {
  it('no template cron-management SKILL.md contains "Crons die on restart"', () => {
    for (const filePath of TEMPLATE_CRON_SKILLS) {
      const content = read(filePath);
      expect(STALE_CRONS_DIE_RESTART.test(content)).toBe(false);
    }
  });

  it('no template cron-management SKILL.md contains "run CronList first"', () => {
    for (const filePath of TEMPLATE_CRON_SKILLS) {
      const content = read(filePath);
      expect(STALE_CRONLIST_FIRST.test(content)).toBe(false);
    }
  });

  it('m2c1-worker skill is excluded from /loop restrictions (legitimate session use)', () => {
    // m2c1-worker may use /loop for session-local polling — this is intentional
    const m2c1Path = join(ROOT, 'community', 'skills', 'm2c1-worker', 'SKILL.md');
    // We just confirm the file exists and we are NOT asserting /loop absence for it
    // (the test suite intentionally skips it)
    if (existsSync(m2c1Path)) {
      const content = readFileSync(m2c1Path, 'utf-8');
      // m2c1-worker is allowed to have /loop references — no assertion here
      expect(typeof content).toBe('string');
    }
  });
});
