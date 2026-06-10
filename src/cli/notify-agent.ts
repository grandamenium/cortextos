import { Command } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePaths } from '../utils/paths.js';
import { notifyAgent } from '../bus/agents.js';
import { resolveInstanceId } from './resolve-instance-id.js';

export const notifyAgentCommand = new Command('notify-agent')
  .description('Send an urgent notification to an agent')
  .argument('<name>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <agent>', 'Sender agent name', 'cli')
  .option('--instance <id>', 'Instance ID')
  .action((name: string, message: string, options: { from: string; instance?: string }) => {
    const instanceId = resolveInstanceId(options.instance);
    const paths = resolvePaths(options.from, instanceId);
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    notifyAgent(paths, options.from, name, message, ctxRoot);
    console.log(`Signal sent to ${name}`);
  });
