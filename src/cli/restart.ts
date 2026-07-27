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

    // BUG-011 fix: use a single restart-agent IPC instead of separate stop-agent
    // + start-agent. The two-shot approach raced: stop-agent IPC returned
    // immediately ("Stopping") while stopAgent() was still async, so the
    // subsequent start-agent hit inspectAgentOp's DEDUPED guard (agent still
    // in registry) and the CLI reported failure — even though pendingRestarts
    // would have recovered silently. restart-agent dispatches restartAgent()
    // which does await stopAgent() → await startAgent() in proper sequence.
    //
    // Write the .user-stop marker before the IPC call so the SessionEnd
    // crash-alert hook does not fire a false 🚨 CRASH alarm. (BUG-036 pattern.)
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');
    const restartResponse = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
    if (!restartResponse.success) {
      console.error(`  Restart failed: ${restartResponse.error}`);
      console.error(`  Agent may be in an unknown state. Check: cortextos status`);
      process.exit(1);
    }
    console.log(`  ${restartResponse.data}`);
  });
