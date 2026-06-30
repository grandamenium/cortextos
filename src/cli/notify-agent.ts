import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../utils/paths.js';
import { notifyAgent } from '../bus/agents.js';
import { validateAgentName, validateInstanceId } from '../utils/validate.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID', 'default')
  .action((name: string, message: string, options: { from: string; instance: string }) => {
    validateAgentName(name);
    validateAgentName(options.from);
    validateInstanceId(options.instance); // feeds ~/.cortextos/<instance> below
    const paths = resolvePaths(options.from, options.instance);
    const ctxRoot = join(homedir(), '.cortextos', options.instance);

    notifyAgent(paths, options.from, name, message, ctxRoot);
    console.log(`Signal sent to ${name}`);
  });
