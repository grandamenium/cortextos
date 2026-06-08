/**
 * Skill-tree parity between the claude and codex agent templates.
 *
 * Bug context: PR 02 added the codex-agent template under
 * templates/agent-codex/plugins/cortextos-agent-skills/skills/, but the
 * template's .gitignore matched a bare `memory/` rule, which silently dropped
 * the memory skill from the committed tree. Fresh codex agents booted without
 * a memory skill — invisible breakage with no failing test.
 *
 * The fix anchored the .gitignore to agent-instance memory dirs only and
 * restored the template's memory/ skill. This test pins the invariant: every
 * skill that ships in the claude template must also ship in the codex
 * template, by directory name.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';

const CLAUDE_SKILLS = join(__dirname, '..', '..', '..', 'templates', 'agent', '.claude', 'skills');
const CODEX_SKILLS = join(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'agent-codex',
  'plugins',
  'cortextos-agent-skills',
  'skills',
);

function listSkillDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('agent template skill-tree parity', () => {
  it('codex template ships every skill that the claude template ships', () => {
    const claudeSkills = listSkillDirs(CLAUDE_SKILLS);
    const codexSkills = listSkillDirs(CODEX_SKILLS);

    const missingInCodex = claudeSkills.filter((skill) => !codexSkills.includes(skill));
    expect(missingInCodex).toEqual([]);
  });

  it('codex template does not ship skills that the claude template lacks', () => {
    const claudeSkills = listSkillDirs(CLAUDE_SKILLS);
    const codexSkills = listSkillDirs(CODEX_SKILLS);

    const extraInCodex = codexSkills.filter((skill) => !claudeSkills.includes(skill));
    expect(extraInCodex).toEqual([]);
  });

  it('skill counts match exactly', () => {
    expect(listSkillDirs(CODEX_SKILLS).length).toBe(listSkillDirs(CLAUDE_SKILLS).length);
  });
});
