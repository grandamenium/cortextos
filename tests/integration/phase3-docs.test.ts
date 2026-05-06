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

const TEMPLATE_AGENTS_MD = [
  join(ROOT, 'templates', 'agent', 'AGENTS.md'),
  join(ROOT, 'templates', 'orchestrator', 'AGENTS.md'),
  join(ROOT, 'templates', 'analyst', 'AGENTS.md'),
];

const TEMPLATE_NAMES = ['agent', 'orchestrator', 'analyst'];

const MIGRATION_GUIDE = join(ROOT, 'CRONS_MIGRATION_GUIDE.md');

// Stale patterns that must not appear in docs
const STALE_CRONLIST_FIRST = /run CronList first/i;
const STALE_CRONS_DIE_RESTART = /crons die on restart/i;

// ---------------------------------------------------------------------------
// 3.1 — AGENTS.md Comprehensive Rewrite
// ---------------------------------------------------------------------------

describe('3.1 — templates/*/AGENTS.md External Persistent Crons section', () => {
  for (let i = 0; i < TEMPLATE_AGENTS_MD.length; i++) {
    const filePath = TEMPLATE_AGENTS_MD[i];
    const name = TEMPLATE_NAMES[i];

    describe(`templates/${name}/AGENTS.md`, () => {
      let content: string;
      it('file exists', () => {
        expect(existsSync(filePath)).toBe(true);
        content = readRequired(filePath);
      });

      it('contains "## External Persistent Crons" section header', () => {
        content = readRequired(filePath);
        expect(content).toContain('## External Persistent Crons');
      });

      it('explains crons.json as the source of truth', () => {
        content = readRequired(filePath);
        expect(content).toContain('crons.json');
      });

      it('explains daemon-managed model with retry logic', () => {
        content = readRequired(filePath);
        expect(content).toMatch(/daemon.*manages|daemon owns|daemon reads|daemon-managed/i);
      });

      it('distinguishes /loop (ephemeral) from persistent crons', () => {
        content = readRequired(filePath);
        expect(content).toContain('/loop');
        expect(content).toMatch(/session.only|ephemeral|dies when|dies on restart/i);
      });

      it('mentions automatic migration from config.json', () => {
        content = readRequired(filePath);
        expect(content).toMatch(/auto.migrat|migrat.*automatic|migrat.*config\.json/i);
      });

      it('mentions .crons-migrated marker file', () => {
        content = readRequired(filePath);
        expect(content).toContain('.crons-migrated');
      });

      it('contains example 1: heartbeat interval cron with bus add-cron', () => {
        content = readRequired(filePath);
        expect(content).toMatch(/cortextos bus add-cron.*heartbeat.*[0-9]+h/);
      });

      it('contains example 2: cron expression schedule', () => {
        content = readRequired(filePath);
        // Should have a cron expression (5-field) example
        expect(content).toMatch(/add-cron.*"[0-9*]+ [0-9*]+ \* \* /);
      });

      it('contains example 3: offset cron to avoid stampede', () => {
        content = readRequired(filePath);
        // Offset minute (non-zero) to avoid :00 stampede
        expect(content).toMatch(/add-cron.*"[0-9]+ \*\//);
      });

      it('contains example 4: test-cron-fire command', () => {
        content = readRequired(filePath);
        expect(content).toContain('cortextos bus test-cron-fire');
      });

      it('contains "How to Verify" subsection with list-crons', () => {
        content = readRequired(filePath);
        expect(content).toContain('cortextos bus list-crons');
      });

      it('contains get-cron-log command for execution history', () => {
        content = readRequired(filePath);
        expect(content).toContain('cortextos bus get-cron-log');
      });

      it('cross-references cron-management skill', () => {
        content = readRequired(filePath);
        expect(content).toContain('cron-management');
      });

      it('does not contain stale "CronList first" pattern', () => {
        content = readRequired(filePath);
        expect(STALE_CRONLIST_FIRST.test(content)).toBe(false);
      });

      it('does not claim crons die on restart', () => {
        content = readRequired(filePath);
        expect(STALE_CRONS_DIE_RESTART.test(content)).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3.2 — Onboarding docs updated
// ---------------------------------------------------------------------------

describe('3.2 — Onboarding docs contain persistent cron guidance', () => {
  const onboardingDocs = [
    { label: 'templates/agent/ONBOARDING.md',       path: join(ROOT, 'templates', 'agent', 'ONBOARDING.md') },
    { label: 'templates/orchestrator/ONBOARDING.md', path: join(ROOT, 'templates', 'orchestrator', 'ONBOARDING.md') },
    { label: 'templates/analyst/ONBOARDING.md',      path: join(ROOT, 'templates', 'analyst', 'ONBOARDING.md') },
    { label: 'community/skills/onboarding/SKILL.md', path: join(ROOT, 'community', 'skills', 'onboarding', 'SKILL.md') },
  ];

  for (const { label, path } of onboardingDocs) {
    describe(label, () => {
      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('references cortextos bus add-cron for persistent scheduling', () => {
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
  it('no template AGENTS.md contains "Crons die on restart"', () => {
    for (const filePath of TEMPLATE_AGENTS_MD) {
      const content = read(filePath);
      expect(STALE_CRONS_DIE_RESTART.test(content)).toBe(false);
    }
  });

  it('no template AGENTS.md contains "run CronList first"', () => {
    for (const filePath of TEMPLATE_AGENTS_MD) {
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
