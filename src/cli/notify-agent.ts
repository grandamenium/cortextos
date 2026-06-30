import { Command } from 'commander';
import { resolvePaths } from '../utils/paths.js';
import { resolveCtxRoot } from '../utils/env.js';
import { notifyAgent } from '../bus/agents.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID', 'default')
  .action((name: string, message: string, options: { from: string; instance: string }) => {
    const paths = resolvePaths(options.from, options.instance, undefined, resolveCtxRoot(options.instance));
    notifyAgent(paths, options.from, name, message, paths.ctxRoot);
    console.log(`Signal sent to ${name}`);
  });
