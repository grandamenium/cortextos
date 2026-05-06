import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..') as string;

const CANONICAL_PATH = join(ROOT, 'community', 'skills', 'cron-management', 'SKILL.md');
const SECURITY_PATH = join(ROOT, 'community', 'agents', 'security', '.claude', 'skills', 'cron-management', 'SKILL.md');

function readSkill(p: string): string {
  return readFileSync(p, 'utf8');
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const block = match[1];
  const result: Record<string, unknown> = {};

  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    // Parse JSON arrays inline
    if (rawVal.startsWith('[')) {
      try {
        result[key] = JSON.parse(rawVal);
      } catch {
        result[key] = rawVal;
      }
    } else {
      // Strip surrounding quotes for string values
      result[key] = rawVal.replace(/^"(.*)"$/, '$1');
    }
  }
  return result;
}

describe('cron-management skill', () => {
  describe('canonical sync', () => {
    it('community/skills and security agent copies are byte-identical', () => {
      const canonical = readSkill(CANONICAL_PATH);
      const security = readSkill(SECURITY_PATH);
      expect(canonical).toBe(security);
    });
  });

  describe('frontmatter structure', () => {
    const canonical = readSkill(CANONICAL_PATH);

    it('has valid frontmatter delimiters', () => {
      expect(canonical).toMatch(/^---\n[\s\S]*?\n---/);
    });

    it('has name field', () => {
      const fm = parseFrontmatter(canonical);
      expect(fm).not.toBeNull();
      expect(fm!['name']).toBeTruthy();
    });

    it('has description field', () => {
      const fm = parseFrontmatter(canonical);
      expect(fm!['description']).toBeTruthy();
    });

    it('has triggers as an array', () => {
      const fm = parseFrontmatter(canonical);
      expect(Array.isArray(fm!['triggers'])).toBe(true);
      const triggers = fm!['triggers'] as string[];
      expect(triggers.length).toBeGreaterThan(0);
    });

    it('has external_calls as an array', () => {
      const fm = parseFrontmatter(canonical);
      expect(Array.isArray(fm!['external_calls'])).toBe(true);
    });
  });

  describe('body references all 6 bus commands', () => {
    const canonical = readSkill(CANONICAL_PATH);
    const body = canonical.replace(/^---\n[\s\S]*?\n---\n/, '');

    it('references add-cron', () => {
      expect(body).toContain('add-cron');
    });

    it('references remove-cron', () => {
      expect(body).toContain('remove-cron');
    });

    it('references list-crons', () => {
      expect(body).toContain('list-crons');
    });

    it('references update-cron', () => {
      expect(body).toContain('update-cron');
    });

    it('references test-cron-fire', () => {
      expect(body).toContain('test-cron-fire');
    });

    it('references get-cron-log', () => {
      expect(body).toContain('get-cron-log');
    });
  });

  describe('stale patterns removed from body', () => {
    const canonical = readSkill(CANONICAL_PATH);
    const body = canonical.replace(/^---\n[\s\S]*?\n---\n/, '');

    it('does not contain "Crons die on restart"', () => {
      expect(body).not.toContain('Crons die on restart');
    });

    it('does not contain /loop creation pattern "/loop {interval}"', () => {
      // The old pattern was instructing agents to use /loop for persistence
      expect(body).not.toMatch(/\/loop\s+\{interval\}/);
    });

    it('does not contain "Restore crons from config.json"', () => {
      expect(body).not.toContain('Restore crons from config.json');
    });

    it('does not contain "CronList first"', () => {
      expect(body).not.toContain('CronList first');
    });
  });

  describe('gap documentation', () => {
    const canonical = readSkill(CANONICAL_PATH);

    it('documents the one-shot reminder gap', () => {
      expect(canonical).toContain('not yet supported');
      expect(canonical).toContain('fire_at');
    });

    it('documents enable/disable via --enabled flag', () => {
      expect(canonical).toContain('--enabled');
    });
  });
});
