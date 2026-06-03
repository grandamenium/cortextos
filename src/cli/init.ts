import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';
import { validateOrgName } from '../utils/validate.js';
import { stripBom } from '../utils/strip-bom.js';
import type { OrgContext } from '../types/index.js';

export const initCommand = new Command('init')
  .argument('<org-name>', 'Organization name')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Create a new cortextOS organization')
  .action(async (orgName: string, options: { instance: string }) => {
    // Validate the org name BEFORE creating anything on disk.
    // Without this, mixed-case names like 'teamStupid' pass through `init`,
    // get written to disk, and then fail every dashboard add-agent and every
    // `cortextos bus *` invocation at runtime because `src/utils/env.ts` and
    // the dashboard API both call `validateOrgName()` strictly. Mirrors the
    // BUG-041 fix for `validateAgentName()` in src/cli/add-agent.ts.
    try {
      validateOrgName(orgName);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error(`Org names must match /^[a-z0-9_-]+$/ (lowercase letters, numbers, underscores, hyphens).`);
      console.error(`Examples of valid names: acme, myco, demo, team-1, team_alpha`);
      process.exit(1);
    }

    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const projectRoot = process.cwd();

    // Check if org already exists
    const orgDir = join(projectRoot, 'orgs', orgName);
    if (existsSync(orgDir)) {
      console.log(`\n  Warning: Organization "${orgName}" already exists at ${orgDir}`);
      console.log('  Existing files will NOT be overwritten. Only missing files will be created.\n');
    }

    console.log(`\nInitializing cortextOS organization: ${orgName}`);
    console.log(`  Instance: ${instanceId}`);
    console.log(`  State: ${ctxRoot}`);
    console.log(`  Project: ${projectRoot}\n`);

    // Create state directories
    // Rule: init creates org-level dirs only. Instance-level dirs are created by install.
    const stateDirs = [
      join(ctxRoot, 'orgs', orgName, 'tasks'),
      join(ctxRoot, 'orgs', orgName, 'approvals'),
      join(ctxRoot, 'orgs', orgName, 'approvals', 'pending'),
      join(ctxRoot, 'orgs', orgName, 'analytics'),
      join(ctxRoot, 'orgs', orgName, 'analytics', 'events'),
    ];

    for (const dir of stateDirs) {
      ensureDir(dir);
    }
    console.log('  Created state directories');

    // Create project structure
    const agentsDir = join(orgDir, 'agents');
    ensureDir(agentsDir);

    // Copy org template files if available
    const orgTemplateDir = findOrgTemplateDir(projectRoot);
    if (orgTemplateDir) {
      copyOrgTemplateFiles(orgTemplateDir, orgDir, orgName);
      console.log('  Copied org template files');
    }

    // Create org context.json (if not already from template)
    const contextPath = join(orgDir, 'context.json');
    if (!existsSync(contextPath)) {
      writeFileSync(contextPath, JSON.stringify({
        name: orgName,
        description: '',
        industry: '',
        icp: '',
        value_prop: '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        orchestrator: '',
        day_mode_start: '08:00',
        day_mode_end: '00:00',
        default_approval_categories: ['external-comms', 'financial', 'deployment', 'data-deletion'],
        communication_style: 'direct and casual',
      }, null, 2) + '\n', 'utf-8');
      console.log('  Created org context.json');
    } else {
      // Fill in any missing fields (handles upgrades from older context.json without new fields)
      try {
        // stripBom: see src/utils/strip-bom.ts. Skipping this would make
        // every re-run of `cortextos init` silently fall through to the
        // catch block, leaving context.json un-upgraded.
        const ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8')));
        if (!ctx.timezone) ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!ctx.name) ctx.name = orgName;
        if (!ctx.day_mode_start) ctx.day_mode_start = '08:00';
        if (!ctx.day_mode_end) ctx.day_mode_end = '00:00';
        if (!ctx.default_approval_categories) ctx.default_approval_categories = ['external-comms', 'financial', 'deployment', 'data-deletion'];
        if (!ctx.communication_style) ctx.communication_style = 'direct and casual';
        writeFileSync(contextPath, JSON.stringify(ctx, null, 2) + '\n', 'utf-8');
      } catch { /* ignore */ }
    }

    // Create goals.json if not from template
    const goalsPath = join(orgDir, 'goals.json');
    if (!existsSync(goalsPath)) {
      writeFileSync(goalsPath, JSON.stringify({
        north_star: '',
        daily_focus: '',
        daily_focus_set_at: '',
        goals: [],
        bottleneck: '',
        updated_at: '',
      }, null, 2) + '\n', 'utf-8');
    }

    // Create secrets.env placeholder
    const secretsPath = join(orgDir, 'secrets.env');
    if (!existsSync(secretsPath)) {
      writeFileSync(secretsPath, [
        '# cortextOS secrets for ' + orgName,
        '# Add your Telegram bot token and other secrets here',
        'BOT_TOKEN=',
        'CHAT_ID=',
        'ACTIVITY_CHAT_ID=',
        '',
        '# Knowledge Base (RAG) — enables semantic search across agent memory and documents',
        '# Get your API key from https://aistudio.google.com/app/apikey (free tier available)',
        'GEMINI_API_KEY=',
        '',
      ].join('\n'), 'utf-8');
      chmodSync(secretsPath, 0o600); // credentials — owner read/write only
      console.log('  Created secrets.env');
    }

    // Create .env with instance ID
    const envPath = join(projectRoot, '.env');
    if (!existsSync(envPath)) {
      writeFileSync(envPath, `CTX_INSTANCE_ID=${instanceId}\n`, 'utf-8');
      console.log('  Created .env');
    }

    // Create knowledge.md if not from template
    const knowledgePath = join(orgDir, 'knowledge.md');
    if (!existsSync(knowledgePath)) {
      writeFileSync(knowledgePath, `# ${orgName} - Shared Knowledge\n\nShared facts, metrics, and corrections for all agents.\n`, 'utf-8');
    }

    // Regenerate SYSTEM.md for all existing agents (handles cortextos init upgrades).
    // Reads the now-current context.json and rewrites each agent's SYSTEM.md so that
    // dashboard_url, orchestrator, timezone, etc. stay in sync after context changes.
    if (existsSync(agentsDir)) {
      let ctx: OrgContext | null = null;
      try {
        const contextPath = join(orgDir, 'context.json');
        // stripBom: same incident as line ~75 above
        ctx = JSON.parse(stripBom(readFileSync(contextPath, 'utf-8'))) as OrgContext;
      } catch { /* skip if unreadable */ }

      if (ctx) {
        let regenerated = 0;
        for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const agentDir = join(agentsDir, entry.name);
          const systemMdPath = join(agentDir, 'SYSTEM.md');
          if (!existsSync(systemMdPath)) continue; // only update existing agents

          try {
            const systemMd = [
              '# System Context',
              '',
              `**Organization:** ${ctx.name || orgName}`,
              `**Description:** ${ctx.description || '(not set)'}`,
              `**Timezone:** ${ctx.timezone || 'UTC'}`,
              `**Orchestrator:** ${ctx.orchestrator || '(not set)'}`,
              `**Dashboard:** ${ctx.dashboard_url || '(not configured)'}`,
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
            writeFileSync(systemMdPath, systemMd, 'utf-8');
            regenerated++;
          } catch { /* skip agents we can't write to */ }
        }
        if (regenerated > 0) {
          console.log(`  Regenerated SYSTEM.md for ${regenerated} agent(s)`);
        }
      }
    }

    console.log(`\n  Organization "${orgName}" initialized.`);
    console.log(`\n  Next steps:`);
    console.log(`    1. Add your Telegram bot token to orgs/${orgName}/secrets.env`);
    console.log(`    2. Add an agent: cortextos add-agent <name> --template orchestrator`);
    console.log(`    3. Start: cortextos start\n`);
  });

function findOrgTemplateDir(projectRoot: string): string | null {
  const candidates = [
    join(projectRoot, 'templates', 'org'),
    join(projectRoot, 'node_modules', 'cortextos', 'templates', 'org'),
    join(__dirname, '..', '..', 'templates', 'org'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

function copyOrgTemplateFiles(templateDir: string, orgDir: string, orgName: string): void {
  try {
    const files = readdirSync(templateDir);
    for (const file of files) {
      const srcPath = join(templateDir, file);
      const destPath = join(orgDir, file);
      if (existsSync(destPath)) continue; // Don't overwrite existing
      try {
        const stat = require('fs').statSync(srcPath);
        if (stat.isFile()) {
          let content = readFileSync(srcPath, 'utf-8');
          content = content.replace(/\{\{org_name\}\}/g, orgName);
          writeFileSync(destPath, content, 'utf-8');
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
