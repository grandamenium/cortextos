import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IPCClient } from '../daemon/ipc-server.js';

/**
 * BUG-036 fix: write a `.user-stop` marker before the agent's PTY is killed,
 * so the SessionEnd crash-alert hook (src/hooks/hook-crash-alert.ts) knows
 * the stop was intentional and does not fire a false 🚨 CRASH alarm.
 * Pattern matches src/cli/bus.ts:1285-1289.
 */
export function writeStopMarker(instanceId: string, agent: string, reason: string): void {
  try {
    const ctxRoot = join(homedir(), '.cortextos', instanceId);
    const stateDir = join(ctxRoot, 'state', agent);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.user-stop'), reason);
  } catch { /* don't block stop on marker-write failure */ }
}

export const stopCommand = new Command('stop')
  .argument('[agent]', 'Agent name to stop. Omit and pass --all to stop every running agent.')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--all', 'Stop every running agent (required when no agent name is given)')
  .description('Stop a running agent. Use --all to stop every agent. Does NOT stop the daemon process itself — use `pm2 stop cortextos-daemon` for that.')
  .action(async (agent: string | undefined, options: { instance: string; all?: boolean }) => {
    // Safety: refuse to stop the entire fleet unless the user explicitly opted in.
    if (!agent && !options.all) {
      console.error('Refusing to stop all agents without an explicit target.');
      console.error('');
      console.error('  To stop one agent:    cortextos stop <agent>');
      console.error('  To stop every agent:  cortextos stop --all');
      console.error('  To stop the daemon:   pm2 stop cortextos-daemon');
      console.error('');
      console.error('(Previously `cortextos stop` with no argument silently stopped every running agent. That behavior was a foot-gun and now requires --all.)');
      process.exit(2);
    }

    if (agent && options.all) {
      console.error('Error: pass either an agent name or --all, not both.');
      process.exit(2);
    }

    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.log('Daemon is not running.');
      return;
    }

    if (agent) {
      console.log(`Stopping agent: ${agent}`);
      writeStopMarker(options.instance, agent, 'stopped via cortextos stop');
      const response = await ipc.send({ type: 'stop-agent', agent });
      if (response.success) {
        console.log(`  ${response.data}`);
      } else {
        console.error(`  Error: ${response.error}`);
        process.exit(1);
      }
      return;
    }

    // options.all === true
    console.log('Stopping all agents...');
    const listResponse = await ipc.send({ type: 'list-agents' });
    if (!listResponse.success) {
      console.error(`  Error listing agents: ${listResponse.error}`);
      process.exit(1);
    }
    const agents = listResponse.data as string[];
    if (agents.length === 0) {
      console.log('  No agents are running.');
      return;
    }
    for (const a of agents) {
      writeStopMarker(options.instance, a, 'stopped via cortextos stop --all');
      const response = await ipc.send({ type: 'stop-agent', agent: a });
      console.log(`  ${a}: ${response.success ? 'stopped' : response.error}`);
    }
    console.log('\nAll agents stopped. The daemon is still running. To stop it: pm2 stop cortextos-daemon');
  });
