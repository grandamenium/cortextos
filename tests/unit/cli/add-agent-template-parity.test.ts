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
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CLAUDE_SKILLS = join(__dirname, '..', '..', '..', 'templates', 'agent', '.claude', 'skills');
const TEMPLATE_ROOT = join(__dirname, '..', '..', '..', 'templates');
const REPO_ROOT = join(__dirname, '..', '..', '..');
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
  it('ships the public codex opt-in guide in the npm package', () => {
    const guide = 'CODEX_APP_SERVER_OPT_IN.md';
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));

    expect(existsSync(join(REPO_ROOT, guide))).toBe(true);
    expect(packageJson.files).toContain(guide);
  });

  it('codex template carries the explicit daemon opt-in', () => {
    const config = JSON.parse(readFileSync(join(TEMPLATE_ROOT, 'agent-codex', 'config.json'), 'utf-8'));

    expect(config.runtime).toBe('codex-app-server');
    expect(config.allow_codex_app_server).toBe(true);
  });

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

  it.each([
    ['claude', 'agent'],
    ['codex', 'agent-codex'],
    ['opencode', 'agent-opencode'],
  ])('%s AGENTS.md documents the context handoff lifecycle contract', (_runtime, templateDir) => {
    const agentsMd = readFileSync(join(TEMPLATE_ROOT, templateDir, 'AGENTS.md'), 'utf-8');

    expect(agentsMd).toContain('## Context Handoff Lifecycle');
    expect(agentsMd).toContain('[CONTEXT HANDOFF REQUIRED]');
    expect(agentsMd).toContain('memory/handoffs/handoff-<ts>.md');
    expect(agentsMd).toContain('--handoff-doc <absolute path>');
    expect(agentsMd).toContain('## Current Tasks');
    expect(agentsMd).toContain('## Files Modified This Session');
  });
});
