import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectMetrics,
  parseUsageOutput,
  storeUsageData,
  collectTelegramCommands,
} from '../src/bus/metrics.js';

describe('Sprint 5: Observability & Metrics', () => {
  const testDir = join(tmpdir(), `cortextos-sprint5-${Date.now()}`);
  const ctxRoot = join(testDir, 'ctx');

  beforeEach(() => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    mkdirSync(join(ctxRoot, 'tasks'), { recursive: true });
    mkdirSync(join(ctxRoot, 'approvals', 'pending'), { recursive: true });
    mkdirSync(join(ctxRoot, 'analytics', 'events'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('collectMetrics', () => {
    it('returns empty report with no agents', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      const report = collectMetrics(ctxRoot);
      expect(report.timestamp).toBeTruthy();
      expect(report.system.agents_total).toBe(0);
      expect(report.system.agents_healthy).toBe(0);
      expect(report.system.total_tasks_completed).toBe(0);
      expect(report.system.approvals_pending).toBe(0);
    });

    it('counts tasks per agent by status', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      // Create tasks
      writeFileSync(join(ctxRoot, 'tasks', 'task1.json'), JSON.stringify({ assigned_to: 'bot1', status: 'completed' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task2.json'), JSON.stringify({ assigned_to: 'bot1', status: 'pending' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task3.json'), JSON.stringify({ assigned_to: 'bot1', status: 'in_progress' }), 'utf-8');
      writeFileSync(join(ctxRoot, 'tasks', 'task4.json'), JSON.stringify({ assigned_to: 'other', status: 'completed' }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.tasks_completed).toBe(1);
      expect(report.agents.bot1.tasks_pending).toBe(1);
      expect(report.agents.bot1.tasks_in_progress).toBe(1);
      expect(report.system.total_tasks_completed).toBe(1);
    });

    it('detects healthy heartbeats', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      const stateDir = join(ctxRoot, 'state', 'bot1');
      mkdirSync(stateDir, { recursive: true });

      // Fresh heartbeat
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
        last_heartbeat: new Date().toISOString(),
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.heartbeat_stale).toBe(false);
      expect(report.system.agents_healthy).toBe(1);
    });

    it('detects stale heartbeats', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      const stateDir = join(ctxRoot, 'state', 'bot1');
      mkdirSync(stateDir, { recursive: true });

      // Old heartbeat (6 hours ago)
      const oldTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
        last_heartbeat: oldTime,
      }), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.heartbeat_stale).toBe(true);
      expect(report.system.agents_healthy).toBe(0);
    });

    it('counts pending approvals', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'approvals', 'pending', 'ap1.json'), '{}', 'utf-8');
      writeFileSync(join(ctxRoot, 'approvals', 'pending', 'ap2.json'), '{}', 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.system.approvals_pending).toBe(2);
    });

    it('writes report to analytics/reports/latest.json', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      collectMetrics(ctxRoot);
      const reportPath = join(ctxRoot, 'analytics', 'reports', 'latest.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.timestamp).toBeTruthy();
      expect(report.system).toBeDefined();
    });

    it('writes to org-scoped and system-wide reports when org specified', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
      mkdirSync(join(ctxRoot, 'orgs', 'testorg', 'analytics'), { recursive: true });
      collectMetrics(ctxRoot, 'testorg');

      expect(existsSync(join(ctxRoot, 'orgs', 'testorg', 'analytics', 'reports', 'latest.json'))).toBe(true);
      expect(existsSync(join(ctxRoot, 'analytics', 'reports', 'latest.json'))).toBe(true);
    });

    it('counts errors from event logs (severity-filtered)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"crash","severity":"error"}',
        '{"category":"info","event":"heartbeat","severity":"info"}',
        '{"category":"error","event":"timeout","severity":"error"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(2);
    });

    it('does NOT count info-severity events even when category=error (Frank false-positive case)', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      // The exact pattern that polluted Frank's metrics: 7 info-severity
      // gap_detector_false_positive events emitted under category=error.
      const lines: string[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(`{"category":"error","event":"gap_detector_false_positive","severity":"info","metadata":{"i":${i}}}`);
      }
      // Plus one real error
      lines.push('{"category":"error","event":"actual_failure","severity":"error"}');
      writeFileSync(join(eventDir, `${today}.jsonl`), lines.join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(1);
    });

    it('counts critical-severity events as errors', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"oom","severity":"critical"}',
        '{"category":"error","event":"crash","severity":"error"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(2);
    });

    it('does NOT count warning-severity category=error events', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"degraded","severity":"warning"}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(0);
    });

    it('ignores false positives where "category":"error" appears inside a metadata payload', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      // The substring `"category":"error"` is embedded in metadata, but the
      // actual top-level category is 'task'. The previous substring check
      // would have miscounted this; the parsed-JSON path correctly skips it.
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"task","event":"taxonomy","severity":"info","metadata":{"taxonomy":"\\"category\\":\\"error\\""}}',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(0);
    });

    it('skips malformed JSON lines without crashing', () => {
      writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ bot1: { enabled: true } }), 'utf-8');
      mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });

      const today = new Date().toISOString().split('T')[0];
      const eventDir = join(ctxRoot, 'analytics', 'events', 'bot1');
      mkdirSync(eventDir, { recursive: true });
      writeFileSync(join(eventDir, `${today}.jsonl`), [
        '{"category":"error","event":"real","severity":"error"}',
        'not-valid-json-at-all',
        '{broken json',
      ].join('\n'), 'utf-8');

      const report = collectMetrics(ctxRoot);
      expect(report.agents.bot1.errors_today).toBe(1);
    });
  });

  describe('parseUsageOutput', () => {
    it('parses session percentage', () => {
      const output = 'Current session\n  42%\n  Resets in 3h';
      const result = parseUsageOutput(output, 'testbot');
      expect(result.session.used_pct).toBe(42);
      expect(result.agent).toBe('testbot');
    });

    it('defaults to 0 when no match', () => {
      const result = parseUsageOutput('no usage data', 'testbot');
      expect(result.session.used_pct).toBe(0);
      expect(result.week_all_models.used_pct).toBe(0);
      expect(result.week_sonnet.used_pct).toBe(0);
    });

    it('includes timestamp', () => {
      const result = parseUsageOutput('', 'testbot');
      expect(result.timestamp).toBeTruthy();
      expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
    });
  });

  describe('storeUsageData', () => {
    it('writes latest.json', () => {
      const data = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        session: { used_pct: 50, resets: '3h' },
        week_all_models: { used_pct: 30, resets: '4d' },
        week_sonnet: { used_pct: 20 },
      };
      storeUsageData(ctxRoot, data);

      const latestPath = join(ctxRoot, 'state', 'usage', 'latest.json');
      expect(existsSync(latestPath)).toBe(true);
      const stored = JSON.parse(readFileSync(latestPath, 'utf-8'));
      expect(stored.agent).toBe('testbot');
      expect(stored.session.used_pct).toBe(50);
    });

    it('appends to daily JSONL', () => {
      const today = new Date().toISOString().split('T')[0];
      const data = {
        agent: 'testbot',
        timestamp: new Date().toISOString(),
        session: { used_pct: 50, resets: '' },
        week_all_models: { used_pct: 30, resets: '' },
        week_sonnet: { used_pct: 20 },
      };
      storeUsageData(ctxRoot, data);
      storeUsageData(ctxRoot, data); // second write

      const dailyPath = join(ctxRoot, 'state', 'usage', `${today}.jsonl`);
      expect(existsSync(dailyPath)).toBe(true);
      const lines = readFileSync(dailyPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });

  describe('collectTelegramCommands', () => {
    it('collects commands from skills directory', () => {
      const scanDir = join(testDir, 'agent');
      const skillDir = join(scanDir, 'skills', 'autoresearch');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), [
        '---',
        'name: autoresearch',
        'description: Automated web research',
        '---',
        'Content',
      ].join('\n'), 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('autoresearch');
      expect(commands[0].description).toBe('Automated web research');
    });

    it('sanitizes command names', () => {
      const scanDir = join(testDir, 'agent2');
      const skillDir = join(scanDir, 'skills', 'cron-management');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: cron-management\ndescription: Manage crons\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands[0].command).toBe('cron_management');
    });

    it('skips non-invocable skills', () => {
      const scanDir = join(testDir, 'agent3');
      const skillDir = join(scanDir, 'skills', 'internal');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: internal\ndescription: Internal only\nuser-invocable: false\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(0);
    });

    it('deduplicates commands across directories', () => {
      const dir1 = join(testDir, 'dir1');
      const dir2 = join(testDir, 'dir2');
      mkdirSync(join(dir1, 'skills', 'test-skill'), { recursive: true });
      mkdirSync(join(dir2, 'skills', 'test-skill'), { recursive: true });
      writeFileSync(join(dir1, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: First\n---\n', 'utf-8');
      writeFileSync(join(dir2, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: Second\n---\n', 'utf-8');

      const commands = collectTelegramCommands([dir1, dir2]);
      expect(commands.length).toBe(1);
      expect(commands[0].description).toBe('First'); // first wins
    });

    it('collects from .claude/commands/', () => {
      const scanDir = join(testDir, 'agent4');
      const cmdDir = join(scanDir, '.claude', 'commands');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, 'deploy.md'), '---\nname: deploy\ndescription: Deploy the app\n---\n', 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('deploy');
    });

    it('handles missing directories gracefully', () => {
      const commands = collectTelegramCommands(['/nonexistent']);
      expect(commands.length).toBe(0);
    });

    it('truncates description to 256 chars', () => {
      const scanDir = join(testDir, 'agent5');
      const skillDir = join(scanDir, 'skills', 'verbose');
      mkdirSync(skillDir, { recursive: true });
      const longDesc = 'A'.repeat(300);
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: verbose\ndescription: ${longDesc}\n---\n`, 'utf-8');

      const commands = collectTelegramCommands([scanDir]);
      expect(commands[0].description.length).toBe(256);
    });

    // Issue #329: codex-runtime agents store slash commands under .codex/, not
    // .claude/. Without these scan paths, registerTelegramCommands sees zero
    // commands for codex agents and the Telegram setMyCommands call no-ops,
    // leaving codex bots with an empty slash menu.
    it('collects from .codex/prompts/ (issue #329)', () => {
      const scanDir = join(testDir, 'codex-agent-prompts');
      const promptsDir = join(scanDir, '.codex', 'prompts');
      mkdirSync(promptsDir, { recursive: true });
      writeFileSync(
        join(promptsDir, 'review.md'),
        '---\nname: review\ndescription: Review the staged diff\n---\n',
        'utf-8',
      );

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('review');
      expect(commands[0].description).toBe('Review the staged diff');
    });

    it('collects from .codex/commands/ (issue #329)', () => {
      const scanDir = join(testDir, 'codex-agent-commands');
      const cmdDir = join(scanDir, '.codex', 'commands');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(
        join(cmdDir, 'plan.md'),
        '---\nname: plan\ndescription: Draft a plan\n---\n',
        'utf-8',
      );

      const commands = collectTelegramCommands([scanDir]);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('plan');
    });

    it('merges codex + claude commands across both layouts (issue #329)', () => {
      const scanDir = join(testDir, 'mixed-agent');
      const codexDir = join(scanDir, '.codex', 'prompts');
      const claudeDir = join(scanDir, '.claude', 'commands');
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(codexDir, 'codex-only.md'),
        '---\nname: codex_only\ndescription: Codex prompt\n---\n',
        'utf-8',
      );
      writeFileSync(
        join(claudeDir, 'claude-only.md'),
        '---\nname: claude_only\ndescription: Claude command\n---\n',
        'utf-8',
      );

      const cmds = collectTelegramCommands([scanDir]);
      const names = cmds.map((c) => c.command).sort();
      expect(names).toEqual(['claude_only', 'codex_only']);
    });
  });
});
