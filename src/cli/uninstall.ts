import { Command } from 'commander';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { uninstallSelfHealing } from './install-self-healing.js';

export const uninstallCommand = new Command('uninstall')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--force', 'Skip confirmation')
  .option('--keep-state', 'Remove agent config but preserve state directory (logs, tasks, heartbeats)')
  .description('Remove cortextOS state directories and PM2 processes')
  .action(async (options: { instance: string; force?: boolean; keepState?: boolean }) => {
    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    if (!existsSync(ctxRoot)) {
      console.log(`No cortextOS state found at ${ctxRoot}`);
      return;
    }

    console.log(`\nUninstalling cortextOS instance: ${instanceId}`);
    console.log(`  State directory: ${ctxRoot}`);
    if (options.keepState) {
      console.log('  Mode: --keep-state (preserving state directory, removing agent config only)\n');
    } else {
      console.log('');
    }

    // Stop PM2 processes if pm2 is available
    try {
      const pm2Result = spawnSync('pm2', ['jlist'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
      if (pm2Result.status === 0 && pm2Result.stdout) {
        const processes = JSON.parse(pm2Result.stdout);
        const cortextosProcesses = processes.filter((p: { name: string }) =>
          p.name.startsWith('cortextos-') || p.name.startsWith(`ctx-${instanceId}`),
        );
        for (const p of cortextosProcesses) {
          const del = spawnSync('pm2', ['delete', p.name], { timeout: 5000, stdio: 'pipe' });
          if (del.status === 0) {
            console.log(`  Stopped PM2 process: ${p.name}`);
          }
        }
      }
    } catch {
      // PM2 not available, skip
    }

    // Fleet-resilience #6: unload + remove self-healing launchd plists.
    // No-op on Linux. Runs before state-dir removal so its logs (which live
    // under ctxRoot) get cleaned up by the subsequent rmSync.
    const shResult = uninstallSelfHealing(ctxRoot, instanceId);
    if (shResult.unloaded.length > 0) {
      console.log(`  Unloaded self-healing: ${shResult.unloaded.join(', ')}`);
    }
    if (shResult.failed.length > 0) {
      console.log(`  ! Some self-healing unloads failed: ${shResult.failed.join('; ')}`);
      console.log('    Services may still be registered with launchd. Verify with:');
      console.log('      launchctl list | grep cortextos');
      console.log('    To clean up by hand:');
      console.log('      launchctl bootout gui/$(id -u)/<label>');
    }

    if (options.keepState) {
      // --keep-state: remove only enabled-agents config, preserve all state data
      const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledFile)) {
        try {
          rmSync(enabledFile);
          console.log('  Removed enabled-agents.json');
        } catch { /* ignore */ }
      }
      console.log('  Preserved state directory (logs, tasks, heartbeats, analytics)');
    } else {
      // Full uninstall: remove entire state directory
      try {
        rmSync(ctxRoot, { recursive: true, force: true });
        console.log(`  Removed state directory: ${ctxRoot}`);
      } catch (err) {
        console.error(`  Failed to remove ${ctxRoot}: ${err}`);
      }
    }

    // Remove ecosystem.config.js if exists in current directory
    const ecosystemPath = join(process.cwd(), 'ecosystem.config.js');
    if (existsSync(ecosystemPath)) {
      try {
        rmSync(ecosystemPath);
        console.log('  Removed ecosystem.config.js');
      } catch { /* ignore */ }
    }

    console.log('\n  cortextOS uninstalled.');
  });
