import { Command } from 'commander';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { validateAgentName, validateOrgName } from '../utils/validate';
import { addAgent, AgentAlreadyExistsError } from '../scaffold/agent.js';

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

    // Mirror the BUG-041 fix above for the resolved org name.
    // Mixed-case orgs pass through add-agent today (whether supplied via --org or
    // auto-detected from the orgs/ directory), get committed to disk, and then
    // break every `cortextos bus *` invocation at runtime because env.ts strictly
    // validates CTX_ORG. The dashboard API also rejects them with HTTP 400.
    // Canonical rule: src/utils/validate.ts:validateOrgName (/^[a-z0-9_-]+$/).
    try {
      validateOrgName(org);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      console.error(`Org names must match /^[a-z0-9_-]+$/ (lowercase letters, numbers, underscores, hyphens).`);
      process.exit(1);
    }

    // All scaffolding lives in src/scaffold/agent.ts (F3) so the add-org --pack
    // installer can provision a roster directly. This command validates the CLI
    // args (above), then delegates. Catch ONLY the "already exists" case to
    // reproduce the command's historical exit-1 message; let any unexpected
    // scaffold error propagate exactly as it did before the extraction.
    try {
      addAgent({
        name,
        template: options.template,
        org,
        runtime: options.runtime,
        instance: options.instance,
        projectRoot,
      });
    } catch (err) {
      if (err instanceof AgentAlreadyExistsError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });
