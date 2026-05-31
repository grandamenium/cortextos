import { Command } from 'commander';
import { validateOrgName } from '../utils/validate.js';
import { initOrg } from '../scaffold/org.js';

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

    // All scaffolding logic lives in src/scaffold/org.ts (F3) so the
    // add-org --pack installer can reuse it. This command is a thin wrapper:
    // validate the CLI arg, then delegate. projectRoot is process.cwd() to
    // preserve the original behavior. Unexpected scaffold I/O errors are left to
    // propagate exactly as they did in the original action (no extra wrapping).
    initOrg({ orgName, instance: options.instance, projectRoot: process.cwd() });
  });
