import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, lstatSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { OrgContext } from '../types';
import { validateAgentName } from '../utils/validate';

const VALID_RUNTIMES = ['claude-code', 'hermes', 'codex-app-server'] as const;
type RuntimeKind = typeof VALID_RUNTIMES[number];

// Templates that don't have a codex variant yet. Pairing any of these with
// --runtime codex-app-server used to silently scaffold claude-only bootstrap
// (`.claude/skills/`, `CLAUDE_CODE_OAUTH_TOKEN`, `/loop` references) into a
// codex agent — degrading on first boot. Reject the combo until codex
// variants exist (PR 11+).
const NON_CODEX_TEMPLATES = ['orchestrator', 'analyst', 'm2c1-worker', 'hermes'] as const;

export const addAgentCommand = new Command('add-agent')
  .argument('<name>', 'Agent name')
  .option('--template <type>', 'Agent template (orchestrator, analyst, agent, agent-codex)', 'agent')
  .option('--org <org>', 'Organization name')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--runtime <runtime>', `Agent runtime (${VALID_RUNTIMES.join(', ')})`, 'claude-code')
  .description('Add a new agent to the organization')
  .action(async (name: string, options: { template: string; org?: string; instance: string; runtime: string }) => {
    if (!VALID_RUNTIMES.includes(options.runtime as RuntimeKind)) {
      console.error(`Error: --runtime must be one of: ${VALID_RUNTIMES.join(', ')} (got "${options.runtime}")`);
      process.exit(1);
    }

    if (options.runtime === 'codex-app-server' && (NON_CODEX_TEMPLATES as readonly string[]).includes(options.template)) {
      console.error(`Error: no codex variant of "${options.template}" yet. Use --template agent for a codex agent (or file an issue to track adding a codex-${options.template} variant).`);
      process.exit(1);
    }
    // BUG-041 fix: validate the agent name BEFORE creating anything on disk.
    // Without this, mixed-case names like 'CortextDesigner' pass through
    // add-agent, get written to disk, and THEN fail every `cortextos bus *`
    // command at runtime because `src/utils/env.ts:resolveEnv()` strictly
    // validates CTX_AGENT_NAME via the same `validateAgentName()` function.
    // The mismatch made affected agents half-functional — daemon-managed
    // fine but unable to use any bus command (including send-telegram).
    // Canonical rule lives in `src/utils/validate.ts`:
    //   AGENT_NAME_REGEX = /^[a-z0-9_-]+$/
    try {
      validateAgentName(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error(`Agent names must match /^[a-z0-9_-]+$/ (lowercase letters, numbers, underscores, hyphens).`);
      console.error(`Examples of valid names: paul, sentinel, cortext-designer, m2c1-worker, agent_1`);
      process.exit(1);
    }

    const projectRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || process.cwd();

    // Auto-detect org if not specified
    let org = options.org;
    if (!org) {
      const orgsDir = join(projectRoot, 'orgs');
      if (existsSync(orgsDir)) {
        const orgs = readdirSync(orgsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        if (orgs.length === 1) {
          org = orgs[0];
        } else if (orgs.length > 1) {
          console.error('Multiple organizations found. Specify one with --org <name>');
          process.exit(1);
        }
      }
    }

    if (!org) {
      console.error('No organization found. Run "cortextos init <org>" first.');
      process.exit(1);
    }

    const agentDir = join(projectRoot, 'orgs', org, 'agents', name);
    if (existsSync(agentDir)) {
      console.error(`Agent "${name}" already exists at ${agentDir}`);
      process.exit(1);
    }

    console.log(`\nAdding agent: ${name}`);
    console.log(`  Template: ${options.template}`);
    console.log(`  Organization: ${org}`);
    console.log(`  Directory: ${agentDir}\n`);

    // Create agent directory
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, 'memory'), { recursive: true });

    // For codex-app-server, skills live under plugins/cortextos-agent-skills/skills
    // and are copied in by the template; .claude/skills is Claude-Code-only.
    const isCodexAppServer = options.runtime === 'codex-app-server';
    if (!isCodexAppServer) {
      mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    }

    // Resolve template name. Codex agents created with the default --template agent
    // get the codex-specific bootstrap in templates/agent-codex/. Any explicit
    // --template choice is honored as-is so orchestrator/analyst/etc still work.
    const effectiveTemplate = (isCodexAppServer && options.template === 'agent')
      ? 'agent-codex'
      : options.template;

    // Copy template files
    const templateDir = findTemplateDir(projectRoot, effectiveTemplate);
    if (templateDir) {
      copyTemplateFiles(templateDir, agentDir, name, org);
      console.log(`  Copied template files from ${effectiveTemplate}`);
    } else {
      // Create minimal files
      createMinimalAgent(agentDir, name, org, options.template);
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
    if (options.runtime !== 'claude-code' && existsSync(configPath)) {
      try {
        const existingCfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        existingCfg.runtime = options.runtime;
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

    // Update org context.json if this is the orchestrator
    if (options.template === 'orchestrator') {
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
    const instanceId = options.instance;
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
        enabled: true,
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
  });

/**
 * Walk an agent's plugins/cortextos-agent-skills/skills tree and create one
 * symlink per skill in ~/.codex/skills/<agent_name>__<skill_name>.
 *
 * The agent-name prefix prevents collisions when multiple codex agents share
 * the host's ~/.codex/skills directory (codex's default skill discovery
 * location). Existing symlinks pointing at the same target are replaced;
 * non-symlink entries with the same name are left alone (we don't clobber
 * unknown files the user may have placed there).
 *
 * Returns the number of symlinks successfully created or refreshed.
 */
function installCodexSkillSymlinks(agentDir: string, agentName: string): number {
  const skillsRoot = join(agentDir, 'plugins', 'cortextos-agent-skills', 'skills');
  if (!existsSync(skillsRoot)) return 0;

  const codexSkillsDir = join(homedir(), '.codex', 'skills');
  mkdirSync(codexSkillsDir, { recursive: true });

  let linked = 0;
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = join(skillsRoot, entry.name);
    const linkPath = join(codexSkillsDir, `${agentName}__${entry.name}`);
    try {
      // Replace an existing symlink — but never an actual file/dir owned by the user.
      if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false } as any)) {
        try {
          const st = lstatSync(linkPath);
          if (st.isSymbolicLink()) {
            unlinkSync(linkPath);
          } else {
            // Skip — something else is here, leave it.
            continue;
          }
        } catch { /* path likely doesn't exist; continue to symlink */ }
      }
      symlinkSync(skillSrc, linkPath, 'dir');
      linked++;
    } catch (err) {
      // Don't abort the whole scaffold for one bad symlink.
      console.error(`    Warning: failed to symlink ${linkPath}: ${(err as Error).message}`);
    }
  }
  return linked;
}

function findTemplateDir(projectRoot: string, template: string): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || projectRoot;
  const candidates = [
    join(projectRoot, 'templates', template),
    join(frameworkRoot, 'templates', template),
    join(projectRoot, 'node_modules', 'cortextos', 'templates', template),
    // Relative to this file for development
    join(__dirname, '..', '..', 'templates', template),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function copyTemplateFiles(templateDir: string, agentDir: string, name: string, org: string): void {
  const files = readdirSync(templateDir);
  for (const file of files) {
    const srcPath = join(templateDir, file);
    const destPath = join(agentDir, file);
    try {
      const stat = require('fs').statSync(srcPath);
      if (stat.isFile()) {
        let content = readFileSync(srcPath, 'utf-8');
        // Replace template placeholders
        content = content.replace(/\{\{agent_name\}\}/g, name);
        content = content.replace(/\{\{org\}\}/g, org);
        content = content.replace(/\{\{current_timestamp\}\}/g, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        writeFileSync(destPath, content, 'utf-8');
      } else if (stat.isDirectory() && file !== 'node_modules') {
        mkdirSync(destPath, { recursive: true });
        copyTemplateFiles(srcPath, destPath, name, org);
      }
    } catch { /* skip files that can't be read */ }
  }
}

function createMinimalAgent(agentDir: string, name: string, org: string, template: string): void {
  const role = template === 'orchestrator' ? 'Orchestrator'
    : template === 'analyst' ? 'Analyst'
    : 'Agent';

  writeFileSync(join(agentDir, 'IDENTITY.md'), `# ${name}\n\nYou are ${name}, a ${role} for ${org}.\n`);
  writeFileSync(join(agentDir, 'SOUL.md'), `# Soul\n\nYou are helpful, precise, and proactive.\n`);
  writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n- Awaiting goal configuration\n`);
  writeFileSync(join(agentDir, 'HEARTBEAT.md'), `# Heartbeat Checklist\n\n- [ ] Check inbox\n- [ ] Update heartbeat\n`);
  writeFileSync(join(agentDir, 'MEMORY.md'), `# Long-Term Memory\n\nNothing recorded yet.\n`);
  writeFileSync(join(agentDir, 'USER.md'), `# User Profile\n\nNot configured yet.\n`);
  writeFileSync(join(agentDir, 'SYSTEM.md'), `# System Context\n\nOrganization: ${org}\n`);
  writeFileSync(join(agentDir, 'TOOLS.md'), `# Available Tools\n\nUse \`cortextos bus <command>\` for bus operations.\n`);
  // CLAUDE.md is a thin wrapper that imports AGENTS.md (works with Claude Code's @ import syntax)
  writeFileSync(join(agentDir, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(agentDir, 'AGENTS.md'), createAgentsMd(name, org, template));
}

function createAgentsMd(name: string, org: string, template: string): string {
  return `# cortextOS ${template.charAt(0).toUpperCase() + template.slice(1)}

## BOOTSTRAP PROTOCOL - READ EVERY FILE BEFORE DOING ANYTHING

Read these files at the start of EVERY session:
1. IDENTITY.md
2. SOUL.md
3. GOALS.md
4. HEARTBEAT.md
5. MEMORY.md
6. memory/$(date -u +%Y-%m-%d).md (today's session state)
7. TOOLS.md
8. SYSTEM.md
9. config.json
10. USER.md

## Bus Commands

Send messages: \`cortextos bus send-message <agent> <priority> "<text>"\`
Check inbox: \`cortextos bus check-inbox\`
ACK messages: \`cortextos bus ack-inbox <id>\`
Create tasks: \`cortextos bus create-task "<title>" --assignee <agent> --priority <p>\`
Update tasks: \`cortextos bus update-task <id> <status>\`
Complete tasks: \`cortextos bus complete-task <id> --result "<text>"\`
Log events: \`cortextos bus log-event <category> <event> <severity>\`
Update heartbeat: \`cortextos bus update-heartbeat "<status>"\`
Send Telegram: \`cortextos bus send-telegram <chat_id> "<text>"\`
`;
}
