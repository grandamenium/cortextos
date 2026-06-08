import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { OrgContext } from '../types';
import {
  copyTemplateFiles,
  createMinimalAgent,
  installCodexSkillSymlinks,
  findTemplateDir,
  substituteDeferredTokens,
} from './templates.js';

/**
 * Thrown when the target agent directory already exists. The add-agent CLI
 * catches THIS specifically to reproduce its historical "already exists" exit-1
 * message, while letting unexpected scaffold errors propagate as before. The
 * pack installer catches it to skip an existing agent (idempotent re-run).
 */
export class AgentAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAlreadyExistsError';
  }
}

export interface AddAgentOptions {
  name: string;
  template: string;
  org: string;
  /** Agent runtime. Default 'claude-code'. Caller is responsible for validating
   *  the runtime × template combo (the add-agent CLI does this upstream). */
  runtime?: string;
  /** Instance ID (state root under ~/.cortextos/<instance>). Default 'default'. */
  instance?: string;
  /** Repo/project root where orgs/<org>/ lives. Default env-resolved. */
  projectRoot?: string;
  /** enabled-agents.json registration flag. Default true (preserves add-agent
   *  behavior). The pack installer passes false for a --no-start / hand-off
   *  install. */
  enabled?: boolean;
}

/**
 * Scaffold a single agent under orgs/<org>/agents/<name>. Extracted verbatim
 * from the `add-agent` command's action (F3) so the add-org --pack installer
 * can provision a roster without going through Commander. Behavior-preserving.
 *
 * The caller is responsible for validating name/org/runtime/template first
 * (validateAgentName, validateOrgName, the VALID_RUNTIMES / NON_CODEX_TEMPLATES
 * checks the CLI performs). Throws (rather than process.exit) if the agent dir
 * already exists, so the caller decides whether to abort (CLI) or skip
 * (idempotent installer).
 */
export function addAgent(opts: AddAgentOptions): void {
  const { name, template, org } = opts;
  const runtime = opts.runtime ?? 'claude-code';
  const instance = opts.instance ?? 'default';
  const projectRoot = opts.projectRoot
    ?? (process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd());
  const enabled = opts.enabled ?? true;

  const agentDir = join(projectRoot, 'orgs', org, 'agents', name);
  if (existsSync(agentDir)) {
    throw new AgentAlreadyExistsError(`Agent "${name}" already exists at ${agentDir}`);
  }

  console.log(`\nAdding agent: ${name}`);
  console.log(`  Template: ${template}`);
  console.log(`  Organization: ${org}`);
  console.log(`  Directory: ${agentDir}\n`);

  // Create agent directory
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, 'memory'), { recursive: true });

  // For codex-app-server, skills live under plugins/cortextos-agent-skills/skills
  // and are copied in by the template; .claude/skills is Claude-Code-only.
  const isCodexAppServer = runtime === 'codex-app-server';
  if (!isCodexAppServer) {
    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
  }

  // Resolve template name. Codex agents created with the default --template agent
  // get the codex-specific bootstrap in templates/agent-codex/. Any explicit
  // --template choice is honored as-is so orchestrator/analyst/etc still work.
  const effectiveTemplate = (isCodexAppServer && template === 'agent')
    ? 'agent-codex'
    : template;

  // Copy template files
  const templateDir = findTemplateDir(projectRoot, effectiveTemplate);
  if (templateDir) {
    copyTemplateFiles(templateDir, agentDir, name, org);
    console.log(`  Copied template files from ${effectiveTemplate}`);
  } else {
    // Create minimal files
    createMinimalAgent(agentDir, name, org, template);
    console.log('  Created minimal agent files');
  }

  // Codex agents: link each local skill into ~/.codex/skills/<agent>__<skill>
  // so codex-app-server's host-wide skill discovery sees the per-agent set.
  if (isCodexAppServer) {
    try {
      const linksCreated = installCodexSkillSymlinks(agentDir, name);
      if (linksCreated > 0) {
        console.log(`  Linked ${linksCreated} skill(s) into ~/.codex/skills/`);
      }
    } catch (err) {
      console.error(`Warning: failed to install codex skill symlinks: ${(err as Error).message}`);
    }
  }

  // Create goals.json (empty — orchestrator will populate on morning cascade)
  const goalsJsonPath = join(agentDir, 'goals.json');
  if (!existsSync(goalsJsonPath)) {
    writeFileSync(goalsJsonPath, JSON.stringify({
      focus: '',
      goals: [],
      bottleneck: '',
      updated_at: '',
      updated_by: '',
    }, null, 2) + '\n', 'utf-8');
  }

  // Create config.json
  const configPath = join(agentDir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      agent_name: name,
      startup_delay: 0,
      max_session_seconds: 255600,
      enabled: true,
      crons: [],
    }, null, 2) + '\n', 'utf-8');
  }

  // Persist non-default runtime into config.json regardless of whether the
  // file came from a template or was created above. The template-supplied
  // config.json wins file existence, so we read-merge-write to inject the
  // runtime field that agent-process.ts branches on.
  if (runtime !== 'claude-code' && existsSync(configPath)) {
    try {
      const existingCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      existingCfg.runtime = runtime;
      writeFileSync(configPath, JSON.stringify(existingCfg, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error(`Warning: failed to set runtime field in config.json: ${(err as Error).message}`);
    }
  }

  // Create .env placeholder with helpful comments
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, [
      `# Agent environment for ${name}`,
      '#',
      '# BOT_TOKEN: Create a Telegram bot with @BotFather and paste the token here',
      '# CHAT_ID: Send a message to your bot, then run:',
      '#   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | jq \'.result[-1].message.chat.id\'',
      '#',
      'BOT_TOKEN=',
      'CHAT_ID=',
      '',
      '# Modal-trap hardening (do not remove): suppress the Claude Code feedback',
      '# survey + non-essential interactive traffic. A survey/other TUI modal can',
      '# seize the headless PTY and swallow injected messages, leaving the agent',
      '# alive-but-unreachable. Also injected at spawn by the daemon as a backstop.',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
      '',
      '# Claude Code v2.1.111+ gives Sonnet 4.6 a 1M context window by default.',
      '# On plans WITHOUT "extra usage" billing, compaction fails at 100% ctx with:',
      '#   "Extra usage is required for 1M context"',
      '# If you see that error on a Sonnet or Haiku agent, uncomment the line below',
      '# to revert to the standard 200K window.',
      '# (Opus on Max / Team / Enterprise includes 1M natively — leave this commented.)',
      '# CLAUDE_CODE_DISABLE_1M_CONTEXT=true',
      '',
    ].join('\n'), 'utf-8');
    chmodSync(envPath, 0o600); // credentials — owner read/write only
  }

  // F4: org-derived day-mode values for the deferred-placeholder substitution
  // below. Default to the same fallbacks the config seeding uses, so the
  // tokens resolve even when context.json is absent or incomplete.
  let dayModeStart = '08:00';
  let dayModeEnd = '00:00';

  // Generate SYSTEM.md from context.json (static org context only).
  // This overwrites whatever the template wrote — context.json is the source of truth.
  // Dynamic data (agent roster, health) is discovered live via list-agents + read-all-heartbeats.
  const contextPath = join(projectRoot, 'orgs', org, 'context.json');
  if (existsSync(contextPath)) {
    // Read context.json once and reuse for both SYSTEM.md generation and config seeding.
    let ctx: OrgContext | null = null;
    try {
      ctx = JSON.parse(readFileSync(contextPath, 'utf-8')) as OrgContext;
    } catch { /* leave template SYSTEM.md in place if context.json is unreadable */ }

    if (ctx) {
      // Generate SYSTEM.md
      try {
        const orgName = ctx.name || org;
        const timezone = ctx.timezone || 'UTC';
        const orchestrator = ctx.orchestrator || '(not set)';
        const dashboardUrl = ctx.dashboard_url || '(not configured)';
        const systemMd = [
          '# System Context',
          '',
          `**Organization:** ${orgName}`,
          `**Description:** ${ctx.description || '(not set)'}`,
          `**Timezone:** ${timezone}`,
          `**Orchestrator:** ${orchestrator}`,
          `**Dashboard:** ${dashboardUrl}`,
          `**Communication Style:** ${ctx.communication_style || 'casual'}`,
          `**Day Mode:** ${ctx.day_mode_start || '08:00'} - ${ctx.day_mode_end || '00:00'}`,
          '**Framework:** cortextOS Node.js',
          '',
          '---',
          '',
          '## Team Roster',
          '',
          '> This section is populated during onboarding. For the live roster:',
          '```bash',
          'cortextos list-agents',
          '```',
          '',
          '## Agent Health',
          '',
          '```bash',
          'cortextos bus read-all-heartbeats',
          '```',
          '',
          '## Communication',
          '',
          '- Agent-to-agent: `cortextos bus send-message <agent> <priority> "<text>"`',
          '- Telegram to user: `cortextos bus send-telegram <chat_id> "<text>"`',
          '- React to a Telegram message (single emoji ack, no verbal noise): `cortextos bus react-telegram <chat_id> <message_id> 👍`',
          '- Check inbox: `cortextos bus check-inbox`',
          '',
        ].join('\n');
        writeFileSync(join(agentDir, 'SYSTEM.md'), systemMd, 'utf-8');
      } catch { /* leave template SYSTEM.md in place on write error */ }

      // Seed org-level tuning knobs into agent config.json
      try {
        const agentConfigPath = join(agentDir, 'config.json');
        if (existsSync(agentConfigPath)) {
          const agentCfg = JSON.parse(readFileSync(agentConfigPath, 'utf-8'));
          agentCfg.timezone = ctx.timezone || 'UTC';
          // Only seed day_mode_start/end if they look like valid HH:MM strings
          const timeRegex = /^\d{2}:\d{2}$/;
          agentCfg.day_mode_start = (typeof ctx.day_mode_start === 'string' && timeRegex.test(ctx.day_mode_start))
            ? ctx.day_mode_start : '08:00';
          agentCfg.day_mode_end = (typeof ctx.day_mode_end === 'string' && timeRegex.test(ctx.day_mode_end))
            ? ctx.day_mode_end : '00:00';
          // F4: reuse the exact resolved values for markdown token substitution.
          dayModeStart = agentCfg.day_mode_start;
          dayModeEnd = agentCfg.day_mode_end;
          agentCfg.communication_style = ctx.communication_style || 'direct and casual';
          agentCfg.approval_rules = {
            always_ask: Array.isArray(ctx.default_approval_categories)
              ? ctx.default_approval_categories
              : ['external-comms', 'financial', 'deployment', 'data-deletion'],
            never_ask: [],
          };
          writeFileSync(agentConfigPath, JSON.stringify(agentCfg, null, 2) + '\n', 'utf-8');
        }
      } catch { /* org context may be incomplete — agent keeps template defaults */ }
    }
  }

  // F4: substitute org-level placeholders the copy step leaves unresolved in
  // template markdown. {{day_mode_start}}/{{day_mode_end}} come from org
  // context.json (read above), so copyTemplateFiles can't fill them at copy
  // time — without this they leak verbatim into the agent's SOUL.md/etc.
  substituteDeferredTokens(agentDir, {
    day_mode_start: dayModeStart,
    day_mode_end: dayModeEnd,
  });

  // Update org context.json if this is the orchestrator
  if (template === 'orchestrator') {
    const contextPath = join(projectRoot, 'orgs', org, 'context.json');
    if (existsSync(contextPath)) {
      try {
        const context = JSON.parse(readFileSync(contextPath, 'utf-8'));
        if (!context.orchestrator) {
          context.orchestrator = name;
          writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n', 'utf-8');
        }
      } catch { /* ignore */ }
    }
  }

  // Register in enabled-agents.json
  const instanceId = instance;
  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
  const configDir = join(ctxRoot, 'config');
  mkdirSync(configDir, { recursive: true });

  let enabledAgents: Record<string, any> = {};
  try {
    if (existsSync(enabledPath)) {
      enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
    }
  } catch { /* start fresh */ }

  if (!enabledAgents[name]) {
    enabledAgents[name] = {
      enabled,
      status: 'configured',
      ...(org ? { org } : {}),
    };
    writeFileSync(enabledPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
    console.log(`  Registered in enabled-agents.json`);
  }

  console.log(`\n  Agent "${name}" created.`);
  console.log(`\n  Next steps:`);
  console.log(`    1. Edit ${join('orgs', org, 'agents', name, '.env')} with your Telegram settings`);
  console.log(`    2. Customize identity files (IDENTITY.md, SOUL.md, GOALS.md)`);
  console.log(`    3. Start: cortextos start ${name}\n`);
}
