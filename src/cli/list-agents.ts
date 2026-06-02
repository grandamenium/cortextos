import { Command } from 'commander';
import { listAgents } from '../bus/agents.js';
import { getCtxRoot } from '../utils/paths.js';

export const listAgentsCommand = new Command('list-agents')
  .description('List all agents in the system')
  .option('--org <org>', 'Filter by organization')
  .option('--format <format>', 'Output format: json or text', 'text')
  .option('--instance <id>', 'Instance ID')
  .action((options: { org?: string; format: string; instance?: string }) => {
    const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';
    const ctxRoot = getCtxRoot(instanceId);
    const agents = listAgents(ctxRoot, options.org);

    if (options.format === 'json') {
      console.log(JSON.stringify(agents, null, 2));
    } else {
      if (agents.length === 0) {
        console.log('No agents found.');
        return;
      }

      // Table header
      const header = '  Name              Display Name      Org              Role                          Status          Last Heartbeat';
      const separator = '  ' + '-'.repeat(header.length - 2);
      console.log('\n  Agents\n');
      console.log(header);
      console.log(separator);

      for (const a of agents) {
        const name = a.name.padEnd(18);
        const displayName = (a.display_name || '-').padEnd(18);
        const org = (a.org || '-').padEnd(17);
        const role = (a.role || '-').substring(0, 29).padEnd(30);
        // Show health indicator emoji
        const healthIcon = a.running ? '● ' : '○ ';
        const statusText = a.running ? 'running' : 'stopped';
        const status = (healthIcon + statusText).padEnd(16);
        const hb = a.last_heartbeat || '-';
        console.log(`  ${name}${displayName}${org}${role}${status}${hb}`);
      }

      console.log(`\n  Total: ${agents.length} agents\n`);
    }
  });
