import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../utils/strip-bom.js';

export const getConfigCommand = new Command('get-config')
  .description('Show resolved operational config for an agent (org defaults + agent overrides)')
  .option('--agent <name>', 'Agent name')
  .option('--org <org>', 'Org name')
  .option('--format <format>', 'Output format: text or json', 'text')
  .action((options) => {
    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();
    const org = options.org || process.env.CTX_ORG || '';
    const agentName = options.agent || process.env.CTX_AGENT_NAME || '';

    // Require org
    if (!org) {
      process.stderr.write('Error: --org is required (or set CTX_ORG)\n');
      process.exit(1);
    }

    // Read org defaults. stripBom: PowerShell-saved context.json may have a
    // BOM that breaks JSON.parse silently (2026-05-16 incident — see
    // src/utils/strip-bom.ts). WARN on parse failure instead of silently
    // falling back to defaults so operators can see misconfiguration.
    let orgCtx: Record<string, any> = {};
    const orgCtxPath = join(frameworkRoot, 'orgs', org, 'context.json');
    if (existsSync(orgCtxPath)) {
      try {
        orgCtx = JSON.parse(stripBom(readFileSync(orgCtxPath, 'utf-8')));
      } catch (err) {
        process.stderr.write(`Warning: failed to parse ${orgCtxPath} (${(err as Error).message}); using hardcoded defaults\n`);
      }
    } else {
      process.stderr.write(`Warning: org context not found at ${orgCtxPath}, using hardcoded defaults\n`);
    }

    // Read agent overrides
    let agentCfg: Record<string, any> = {};
    if (agentName) {
      const agentCfgPath = join(frameworkRoot, 'orgs', org, 'agents', agentName, 'config.json');
      if (existsSync(agentCfgPath)) {
        try {
          agentCfg = JSON.parse(stripBom(readFileSync(agentCfgPath, 'utf-8')));
        } catch (err) {
          process.stderr.write(`Warning: failed to parse ${agentCfgPath} (${(err as Error).message}); showing org defaults only\n`);
        }
      } else if (options.agent) {
        // --agent was explicitly passed but no config found — warn, don't exit
        process.stderr.write(`Warning: agent config not found at ${agentCfgPath}, showing org defaults only\n`);
      }
    }

    // Validate default_approval_categories — fall back to hardcoded default if not an array
    const defaultApprovalCategories = Array.isArray(orgCtx.default_approval_categories)
      ? orgCtx.default_approval_categories
      : ['external-comms', 'financial', 'deployment', 'data-deletion'];

    // Merge: agent wins over org defaults
    const resolved = {
      timezone: agentCfg.timezone || orgCtx.timezone || 'UTC',
      day_mode_start: agentCfg.day_mode_start || orgCtx.day_mode_start || '08:00',
      day_mode_end: agentCfg.day_mode_end || orgCtx.day_mode_end || '00:00',
      communication_style: agentCfg.communication_style || orgCtx.communication_style || 'direct and casual',
      approval_rules: agentCfg.approval_rules || {
        always_ask: defaultApprovalCategories,
        never_ask: [],
      },
    };

    if (options.format === 'json') {
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }

    // Text format for agents to read
    const header = agentName ? `=== Config: ${agentName} (org: ${org}) ===` : `=== Org Config: ${org} ===`;
    console.log(header);
    console.log(`Timezone:            ${resolved.timezone}`);
    console.log(`Day Mode:            ${resolved.day_mode_start} – ${resolved.day_mode_end}`);
    console.log(`Night Mode:          ${resolved.day_mode_end} – ${resolved.day_mode_start}`);
    console.log(`Approval Required:   ${resolved.approval_rules.always_ask.join(', ') || '(none)'}`);
    console.log(`Never Need Approval: ${resolved.approval_rules.never_ask.join(', ') || '(none)'}`);
    console.log(`Communication:       ${resolved.communication_style}`);
  });
