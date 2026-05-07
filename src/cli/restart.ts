import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import { writeStopMarker } from './stop.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent (stop + start). Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Stop phase mirrors `cortextos stop <agent>` — write the .user-stop marker
    // before the IPC stop so the SessionEnd crash-alert hook does not fire a
    // false 🚨 CRASH alarm during the brief stop window. (BUG-036 pattern.)
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');
    const stopResponse = await ipc.send({ type: 'stop-agent', agent, source: 'cortextos restart' });
    if (!stopResponse.success) {
      console.error(`  Stop failed: ${stopResponse.error}`);
      process.exit(1);
    }
    console.log(`  ${stopResponse.data}`);

    // Start phase — daemon's start-agent handler re-reads config.json + .env
    // and spawns a fresh PTY. Same code path as `cortextos start <agent>`
    // when the daemon is already running, so env reload / config re-read /
    // PTY respawn semantics match exactly.
    const startResponse = await ipc.send({ type: 'start-agent', agent, source: 'cortextos restart' });
    if (!startResponse.success) {
      console.error(`  Start failed: ${startResponse.error}`);
      console.error(`  Agent is now stopped. Recover with: cortextos start ${agent}`);
      process.exit(1);
    }
    console.log(`  ${startResponse.data}`);
  });
