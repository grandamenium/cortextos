/**
 * tests/integration/migration-guide-references-upgrade-cmd.test.ts
 *
 * Regression guard for Part B of the upgrade-cron-teaching follow-up.
 *
 * Asserts that CRONS_MIGRATION_GUIDE.md documents the
 * `cortextos bus upgrade-cron-teaching` workflow so the command is
 * discoverable by anyone reading the migration story end-to-end.
 *
 * Required content:
 *   - The "Upgrading Existing Agent Skill/Bootstrap Files" section heading
 *   - The literal command string `cortextos bus upgrade-cron-teaching`
 *   - Both `--apply` and `--json` flags are mentioned
 *   - The whitelist mechanics (sentinel marker + negation tokens) are noted
 *   - The new section appears after "Manual Migration" so the reader hits it
 *     in the right order
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const GUIDE_PATH = join(REPO_ROOT, 'CRONS_MIGRATION_GUIDE.md');

describe('CRONS_MIGRATION_GUIDE.md upgrade-cron-teaching references', () => {
  it('migration guide exists', () => {
    expect(existsSync(GUIDE_PATH)).toBe(true);
  });

  it('documents the upgrade-cron-teaching command', () => {
    const body = readFileSync(GUIDE_PATH, 'utf-8');
    expect(body).toContain('cortextos bus upgrade-cron-teaching');
  });

  it('has the upgrade section heading', () => {
    const body = readFileSync(GUIDE_PATH, 'utf-8');
    expect(body).toMatch(
      /## Upgrading Existing Agent Skill\/Bootstrap Files/,
    );
  });

  it('mentions both --apply and --json flags', () => {
    const body = readFileSync(GUIDE_PATH, 'utf-8');
    expect(body).toContain('--apply');
    expect(body).toContain('--json');
  });

  it('describes the whitelist mechanics', () => {
    const body = readFileSync(GUIDE_PATH, 'utf-8');
    expect(body).toContain('/loop is intentionally used');
    expect(body.toLowerCase()).toContain('negation');
  });

  it('places the upgrade section after Manual Migration', () => {
    const body = readFileSync(GUIDE_PATH, 'utf-8');
    const manualIdx = body.indexOf('## Manual Migration');
    const upgradeIdx = body.indexOf(
      '## Upgrading Existing Agent Skill/Bootstrap Files',
    );
    const troubleshootIdx = body.indexOf('## Troubleshooting');
    expect(manualIdx).toBeGreaterThan(-1);
    expect(upgradeIdx).toBeGreaterThan(manualIdx);
    expect(troubleshootIdx).toBeGreaterThan(upgradeIdx);
  });
});
