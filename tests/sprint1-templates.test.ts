import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const TEMPLATE_ROOT = join(__dirname, '..', 'templates');

describe('Sprint 1: Template Completeness', () => {
  describe('Agent template', () => {
    const agentDir = join(TEMPLATE_ROOT, 'agent');

    it('has all required markdown files', () => {
      const requiredFiles = [
        'CLAUDE.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md',
        'GUARDRAILS.md', 'ONBOARDING.md', 'IDENTITY.md',
        'SYSTEM.md', 'USER.md', 'GOALS.md', 'MEMORY.md',
      ];
      for (const file of requiredFiles) {
        expect(existsSync(join(agentDir, file)), `Missing ${file}`).toBe(true);
      }
    });

    it('has config.json with heartbeat cron', () => {
      const config = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8'));
      expect(config.crons).toBeDefined();
      expect(config.crons.length).toBeGreaterThanOrEqual(1);
      expect(config.crons[0].name).toBe('heartbeat');
      expect(config.crons[0].interval).toBe('4h');
    });

    it('goals.json exists with all expected fields', () => {
      const goalsPath = join(agentDir, 'goals.json');
      expect(existsSync(goalsPath), 'Missing goals.json').toBe(true);
      const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
      expect(goals).toHaveProperty('focus');
      expect(goals).toHaveProperty('goals');
      expect(goals).toHaveProperty('bottleneck');
      expect(goals).toHaveProperty('updated_at');
      expect(goals).toHaveProperty('updated_by');
    });

    it('has .claude/settings.json with hooks', () => {
      const settingsPath = join(agentDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PermissionRequest).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.SessionEnd).toBeDefined();
    });

    it('has all 5 skills', () => {
      const expectedSkills = ['autoresearch', 'comms', 'cron-management', 'tasks', 'onboarding'];
      for (const skill of expectedSkills) {
        const skillPath = join(agentDir, '.claude', 'skills', skill, 'SKILL.md');
        expect(existsSync(skillPath), `Missing skill: ${skill}`).toBe(true);
      }
    });

    it('CLAUDE.md has first boot check', () => {
      const content = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('First Boot Check');
      expect(content).toContain('ONBOARDING');
    });

    it('CLAUDE.md references cortextos bus commands', () => {
      const content = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('cortextos bus');
      expect(content).not.toContain('bash $CTX_FRAMEWORK_ROOT/bus/');
    });

    it('SOUL.md has system-first mindset', () => {
      const content = readFileSync(join(agentDir, 'SOUL.md'), 'utf-8');
      expect(content).toContain('System-First Mindset');
      expect(content).toContain('Idle Is Failure');
      expect(content).toContain('Day/Night Mode');
    });

    it('HEARTBEAT.md has 9 steps', () => {
      const content = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
      expect(content).toContain('Step 1');
      expect(content).toContain('Step 9');
      expect(content).toContain('SKIP NOTHING');
    });

    it('TOOLS.md has complete script inventory', () => {
      const content = readFileSync(join(agentDir, 'TOOLS.md'), 'utf-8');
      expect(content).toContain('create-task');
      expect(content).toContain('send-message');
      expect(content).toContain('log-event');
      expect(content).toContain('update-heartbeat');
      expect(content).toContain('create-approval');
      expect(content).toContain('send-telegram');
      expect(content).toContain('list-agents');
      expect(content).toContain('list-skills');
      expect(content).toContain('check-stale-tasks');
      expect(content).toContain('create-experiment');
      expect(content).toContain('browse-catalog');
      expect(content).toContain('Quick Reference');
    });

    it('GUARDRAILS.md has red flag table', () => {
      const content = readFileSync(join(agentDir, 'GUARDRAILS.md'), 'utf-8');
      expect(content).toContain('Red Flag Table');
      expect(content).toContain('Heartbeat cycle fires');
      expect(content).toContain('Required Action');
    });

    it('ONBOARDING.md has 5 parts', () => {
      const content = readFileSync(join(agentDir, 'ONBOARDING.md'), 'utf-8');
      expect(content).toContain('Part 1: Identity');
      expect(content).toContain('Part 2: Workflows');
      expect(content).toContain('Part 3: Context');
      expect(content).toContain('Part 4: Finalize');
      expect(content).toContain('Part 5: Autoresearch');
    });

    it('skill files have YAML frontmatter', () => {
      const skillPath = join(agentDir, '.claude', 'skills', 'autoresearch', 'SKILL.md');
      const content = readFileSync(skillPath, 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('name: autoresearch');
      expect(content).toContain('description:');
    });
  });

  describe('Orchestrator template', () => {
    const orchDir = join(TEMPLATE_ROOT, 'orchestrator');

    it('has all required markdown files', () => {
      const requiredFiles = [
        'CLAUDE.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md',
        'GUARDRAILS.md', 'ONBOARDING.md', 'IDENTITY.md',
        'SYSTEM.md', 'USER.md', 'GOALS.md', 'MEMORY.md',
      ];
      for (const file of requiredFiles) {
        expect(existsSync(join(orchDir, file)), `Missing ${file}`).toBe(true);
      }
    });

    it('has config.json with 5 orchestrator crons', () => {
      const config = JSON.parse(readFileSync(join(orchDir, 'config.json'), 'utf-8'));
      expect(config.crons.length).toBe(5);
      const cronNames = config.crons.map((c: any) => c.name);
      expect(cronNames).toContain('heartbeat');
      expect(cronNames).toContain('check-approvals');
      expect(cronNames).toContain('morning-review');
      expect(cronNames).toContain('evening-review');
      expect(cronNames).toContain('weekly-review');
    });

    it('goals.json exists with all expected fields', () => {
      const goalsPath = join(orchDir, 'goals.json');
      expect(existsSync(goalsPath), 'Missing goals.json').toBe(true);
      const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
      expect(goals).toHaveProperty('focus');
      expect(goals).toHaveProperty('goals');
      expect(goals).toHaveProperty('bottleneck');
      expect(goals).toHaveProperty('updated_at');
      expect(goals).toHaveProperty('updated_by');
    });

    it('has 11 skills including orchestrator-specific ones', () => {
      const expectedSkills = [
        'autoresearch', 'comms', 'cron-management', 'tasks',
        'evening-review', 'goal-management', 'morning-review',
        'nighttime-mode', 'theta-wave', 'weekly-review', 'onboarding',
      ];
      for (const skill of expectedSkills) {
        const skillPath = join(orchDir, '.claude', 'skills', skill, 'SKILL.md');
        expect(existsSync(skillPath), `Missing skill: ${skill}`).toBe(true);
      }
    });

    it('CLAUDE.md has orchestrator-specific content', () => {
      const content = readFileSync(join(orchDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Orchestrator');
      expect(content).toContain('coordination');
      expect(content).toContain('Decompose');
    });

    it('GUARDRAILS.md has orchestrator-specific section', () => {
      const content = readFileSync(join(orchDir, 'GUARDRAILS.md'), 'utf-8');
      expect(content).toContain('Orchestrator-Specific');
      expect(content).toContain('Delegate');
    });

    it('ONBOARDING.md has orchestrator role description', () => {
      const content = readFileSync(join(orchDir, 'ONBOARDING.md'), 'utf-8');
      expect(content).toContain('Orchestrator');
      expect(content).toContain('coordination');
    });

    it('IDENTITY.md has orchestrator work style', () => {
      const content = readFileSync(join(orchDir, 'IDENTITY.md'), 'utf-8');
      expect(content).toContain('Decompose');
    });

    it('.claude/settings.json exists with hooks', () => {
      const settings = JSON.parse(readFileSync(join(orchDir, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks.PermissionRequest).toBeDefined();
    });
  });

  describe('Analyst template', () => {
    const analystDir = join(TEMPLATE_ROOT, 'analyst');

    it('has all required markdown files', () => {
      const requiredFiles = [
        'CLAUDE.md', 'SOUL.md', 'HEARTBEAT.md', 'TOOLS.md',
        'GUARDRAILS.md', 'ONBOARDING.md', 'IDENTITY.md',
        'SYSTEM.md', 'USER.md', 'GOALS.md', 'MEMORY.md',
      ];
      for (const file of requiredFiles) {
        expect(existsSync(join(analystDir, file)), `Missing ${file}`).toBe(true);
      }
    });

    it('has config.json with 6 analyst crons + ecosystem config', () => {
      const config = JSON.parse(readFileSync(join(analystDir, 'config.json'), 'utf-8'));
      expect(config.crons.length).toBe(6);
      const cronNames = config.crons.map((c: any) => c.name);
      expect(cronNames).toContain('heartbeat');
      expect(cronNames).toContain('usage-monitor');
      expect(cronNames).toContain('nightly-metrics');
      expect(cronNames).toContain('auto-commit');
      expect(cronNames).toContain('check-upstream');
      expect(cronNames).toContain('catalog-browse');
      expect(config.ecosystem).toBeDefined();
      expect(config.ecosystem.local_version_control).toBeDefined();
    });

    it('goals.json exists with all expected fields', () => {
      const goalsPath = join(analystDir, 'goals.json');
      expect(existsSync(goalsPath), 'Missing goals.json').toBe(true);
      const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
      expect(goals).toHaveProperty('focus');
      expect(goals).toHaveProperty('goals');
      expect(goals).toHaveProperty('bottleneck');
      expect(goals).toHaveProperty('updated_at');
      expect(goals).toHaveProperty('updated_by');
    });

    it('has 10 skills including analyst-specific ones', () => {
      const expectedSkills = [
        'autoresearch', 'comms', 'cron-management', 'tasks',
        'catalog-browse', 'community-publish', 'local-version-control',
        'theta-wave', 'upstream-sync', 'onboarding',
      ];
      for (const skill of expectedSkills) {
        const skillPath = join(analystDir, '.claude', 'skills', skill, 'SKILL.md');
        expect(existsSync(skillPath), `Missing skill: ${skill}`).toBe(true);
      }
    });

    it('CLAUDE.md has analyst-specific content', () => {
      const content = readFileSync(join(analystDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Analyst');
      expect(content).toContain('metrics');
    });

    it('GUARDRAILS.md has analyst-specific section', () => {
      const content = readFileSync(join(analystDir, 'GUARDRAILS.md'), 'utf-8');
      expect(content).toContain('Analyst-Specific');
      expect(content).toContain('Anomaly');
    });

    it('analyst theta-wave skill is different from orchestrator', () => {
      const analystTW = readFileSync(join(analystDir, '.claude', 'skills', 'theta-wave', 'SKILL.md'), 'utf-8');
      const orchTW = readFileSync(join(TEMPLATE_ROOT, 'orchestrator', '.claude', 'skills', 'theta-wave', 'SKILL.md'), 'utf-8');
      // Analyst version has "Deep System Scan" and "system_effectiveness"
      expect(analystTW).toContain('Deep System Scan');
      expect(analystTW).toContain('system_effectiveness');
      // Orchestrator version has "Challenge Assumptions"
      expect(orchTW).toContain('Challenge Assumptions');
      expect(orchTW).not.toContain('Deep System Scan');
    });
  });

  describe('Org template', () => {
    const orgDir = join(TEMPLATE_ROOT, 'org');

    it('has all required org template files', () => {
      const requiredFiles = [
        'context.json', 'goals.json', 'brand-voice.md',
        'knowledge.md', 'activity-channel.env.example',
      ];
      for (const file of requiredFiles) {
        expect(existsSync(join(orgDir, file)), `Missing ${file}`).toBe(true);
      }
    });

    it('context.json has all dashboard-expected fields', () => {
      const ctx = JSON.parse(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      expect(ctx).toHaveProperty('name');
      expect(ctx).toHaveProperty('timezone');
      expect(ctx).toHaveProperty('orchestrator');
    });

    it('goals.json has all expected fields', () => {
      const goals = JSON.parse(readFileSync(join(orgDir, 'goals.json'), 'utf-8'));
      expect(goals).toHaveProperty('north_star');
      expect(goals).toHaveProperty('daily_focus');
      expect(goals).toHaveProperty('goals');
      expect(goals).toHaveProperty('bottleneck');
      expect(goals).toHaveProperty('updated_at');
    });

    it('knowledge.md has org brain sections', () => {
      const content = readFileSync(join(orgDir, 'knowledge.md'), 'utf-8');
      expect(content).toContain('Business');
      expect(content).toContain('Team');
      expect(content).toContain('Technical');
      expect(content).toContain('Key Links');
      expect(content).toContain('Decisions Log');
    });
  });

  describe('No bash script references remain', () => {
    it('no templates contain bash $CTX_FRAMEWORK_ROOT/bus/', () => {
      const roles = ['agent', 'orchestrator', 'analyst'];
      for (const role of roles) {
        const dir = join(TEMPLATE_ROOT, role);
        checkDirForBashRefs(dir);
      }
    });
  });
});

function checkDirForBashRefs(dir: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      checkDirForBashRefs(fullPath);
    } else if ((entry.name.endsWith('.md') || entry.name.endsWith('.json')) && entry.name !== 'settings.json') {
      const content = readFileSync(fullPath, 'utf-8');
      // Check for old bash script references but allow bash in code examples
      // that aren't bus/scripts paths
      if (content.includes('bash $CTX_FRAMEWORK_ROOT/bus/') ||
          content.includes('bash $CTX_FRAMEWORK_ROOT/scripts/') ||
          content.includes('bash $CTX_FRAMEWORK_ROOT/enable-agent') ||
          content.includes('bash $CTX_FRAMEWORK_ROOT/disable-agent')) {
        throw new Error(`File ${fullPath} still contains bash $CTX_FRAMEWORK_ROOT references`);
      }
    }
  }
}
