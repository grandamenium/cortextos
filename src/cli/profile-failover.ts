/**
 * `cortextos profile-failover` — BL-003 phase 3 CLI primitive.
 *
 * Thin commander wrapper over `runFailover` in
 * `src/services/profile-failover.ts`. Boss-LLM invokes this command
 * after detecting a `profile_quota_exhausted` event in the bus
 * log; the SKILL.md runbook documents the LLM-side decision tree.
 *
 * Usage:
 *   cortextos profile-failover \
 *     --agent <name> \
 *     --trigger <event-id> \
 *     [--org <org>]
 *
 * The CLI handles user-facing exit codes:
 *   0 = swap completed; soft-restart dispatched
 *   2 = no fallback configured / agent missing — Saurav decision needed
 *   3 = registry / fallback unknown — config error
 *   4 = cascade window active — Saurav triage required
 *   1 = unexpected internal error
 */

import { Command } from 'commander';

import { runFailover, FailoverError } from '../services/profile-failover.js';

export const profileFailoverCommand = new Command('profile-failover')
  .description('Atomically swap an agent to its fallback Claude profile + dispatch a soft-restart (BL-003 phase 3)')
  .requiredOption('--agent <name>', 'Target agent (whose claude_profile gets swapped)')
  .requiredOption('--trigger <event-id>', 'Bus-event id of the triggering profile_quota_exhausted event (audit provenance)')
  .option('--org <org>', 'Organization (defaults to CTX_ORG)')
  .action((options: { agent: string; trigger: string; org?: string }) => {
    const projectRoot = process.env.CTX_FRAMEWORK_ROOT
      || process.env.CTX_PROJECT_ROOT
      || process.cwd();
    const org = options.org || process.env.CTX_ORG;
    if (!org) {
      console.error('Error: --org not given and CTX_ORG not set');
      process.exit(1);
    }

    try {
      const result = runFailover({
        projectRoot,
        org,
        agentName: options.agent,
        triggerEventId: options.trigger,
      });
      console.log(`profile-failover: ${result.from_profile ?? '(default)'} → ${result.to_profile} for agent=${result.agent}`);
      console.log(`  trigger: ${result.trigger_event_id}`);
      console.log(`  restarted_at: ${result.restarted_at}`);
      console.log(`  soft-restart message dispatched on the bus`);
    } catch (err) {
      if (err instanceof FailoverError) {
        console.error(`Error (${err.reason}): ${err.message}`);
        // Map reason → distinct exit code so boss runbook can branch
        // on the failure mode without parsing the message string.
        switch (err.reason) {
          case 'agent_dir_missing':
          case 'no_fallback_configured':
            process.exit(2);
          case 'registry_missing':
          case 'fallback_profile_unknown':
          case 'config_unreadable':
            process.exit(3);
          case 'cascade_window_active':
            process.exit(4);
          case 'config_write_failed':
          default:
            process.exit(1);
        }
      }
      console.error(`Unexpected error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
