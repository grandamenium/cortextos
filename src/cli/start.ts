import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync, spawn, spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';
import { discoverProjectRoot, readEnabledAgents } from './enable-agent.js';
import { findAgentDirAndOrg, readAgentConfigSafe, validateClaudeWorkingDirectoryPolicy } from '../utils/agent-session-isolation.js';
import { resolveInstanceId } from './resolve-instance-id.js';

const IS_WINDOWS = platform() === 'win32';
const SAFE_CMD = /^[@a-z0-9._/-]+$/i;

function commandExists(cmd: string): boolean {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

export async function requireDaemonOfflineForBootstrap(ipc: IPCClient): Promise<boolean> {
  const availability = await ipc.probeAvailability('cortextos start probe');
  if (availability === 'running') return false;
  if (availability === 'offline') return true;

  console.error('Daemon appears to be running but is not responding to IPC health checks.');
  console.error('Refusing to auto-restart it from `cortextos start`, because that would bounce the entire fleet.');
  console.error('Use `cortextos status` or inspect `~/.pm2/logs/cortextos-daemon-*.log`, then restart explicitly if needed.');
  process.exit(1);
}

export const startCommand = new Command('start')
  .argument('[agent]', 'Specific agent to start (starts all if omitted)')
  .option('--instance <id>', 'Instance ID')
  .option('--foreground', 'Run daemon in foreground (no PM2, for debugging)')
  .option('--allow-external-cwd', 'Allow a non-agent-dir working_directory for Claude agents')
  .description('Start the cortextOS daemon and agents')
  .action(async (agent: string | undefined, options: { instance?: string; foreground?: boolean; allowExternalCwd?: boolean }) => {
    const instanceId = resolveInstanceId(options.instance);
    const ipc = new IPCClient(instanceId);
    const shouldBootstrapDaemon = await requireDaemonOfflineForBootstrap(ipc);

    if (shouldBootstrapDaemon) {
      const projectRoot = process.cwd();
      const daemonScript = join(projectRoot, 'dist', 'daemon.js');

      if (!existsSync(daemonScript)) {
        console.error('Daemon not built. Run: npm run build');
        process.exit(1);
      }

      const ctxRoot = join(homedir(), '.cortextos', instanceId);

      // Try reading org from enabled-agents.json
      let org = '';
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      if (existsSync(enabledPath)) {
        try {
          const agents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
          const first = Object.values(agents as Record<string, any>)[0] as any;
          if (first?.org) org = first.org;
        } catch { /* ignore */ }
      }

      const daemonEnv = {
        ...process.env,
        CTX_INSTANCE_ID: instanceId,
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: projectRoot,
        CTX_PROJECT_ROOT: projectRoot,
        ...(org ? { CTX_ORG: org } : {}),
      };

      if (options.foreground) {
        // Run in foreground (blocking) — useful for debugging
        console.log('Starting cortextOS daemon in foreground...');
        console.log('(Press Ctrl+C to stop)\n');
        const child = spawn(process.execPath, [daemonScript, '--instance', instanceId], {
          stdio: 'inherit',
          env: daemonEnv,
        });
        child.on('exit', (code) => process.exit(code || 0));
        process.on('SIGINT', () => child.kill('SIGTERM'));
        process.on('SIGTERM', () => child.kill('SIGTERM'));
        process.on('exit', () => { try { child.kill(); } catch { /* already dead */ } });
        return;
      }

      if (commandExists('pm2')) {
        // PM2 available — use ecosystem or direct pm2 start
        const ecosystemPath = join(projectRoot, 'ecosystem.config.js');
        if (existsSync(ecosystemPath)) {
          console.log('Starting cortextOS daemon via PM2...');
          try {
            execSync('pm2 start ecosystem.config.js', { stdio: 'inherit', cwd: projectRoot });
            execSync('pm2 save', { stdio: 'inherit', cwd: projectRoot });
            console.log('\nDaemon started. Use `cortextos status` to check agents.');
            if (IS_WINDOWS) {
              console.log('\nFor auto-start on Windows boot:');
              console.log('  npm install -g pm2-windows-startup');
              console.log('  pm2-windows-startup install');
            }
          } catch {
            console.error('PM2 start failed. Try: pm2 start ecosystem.config.js');
          }
        } else {
          console.log('Generating ecosystem.config.js and starting...');
          try {
            execSync(`node ${JSON.stringify(join(projectRoot, 'dist', 'cli.js'))} ecosystem`, {
              stdio: 'inherit',
              cwd: projectRoot,
              env: daemonEnv,
            });
            execSync('pm2 start ecosystem.config.js', { stdio: 'inherit', cwd: projectRoot });
            execSync('pm2 save', { stdio: 'inherit', cwd: projectRoot });
            console.log('\nDaemon started. Use `cortextos status` to check agents.');
            if (IS_WINDOWS) {
              console.log('\nFor auto-start on Windows boot:');
              console.log('  npm install -g pm2-windows-startup');
              console.log('  pm2-windows-startup install');
            }
          } catch {
            console.error('Failed to generate ecosystem and start. Try manually:');
            console.error('  cortextos ecosystem && pm2 start ecosystem.config.js');
          }
        }
      } else {
        // No PM2 — spawn daemon detached in background
        console.log('PM2 not found. Starting daemon directly (background)...');
        console.log('(Install PM2 for persistence across reboots: npm install -g pm2)\n');

        const logDir = join(ctxRoot, 'logs');
        const logFile = join(logDir, 'daemon.log');

        // Spawn-with-retry: a detached spawn() succeeds from Node's POV even if
        // the child dies milliseconds later (bad state dir, permission denied
        // on logs, missing dist/daemon.js). Without retries, the user sees
        // "Daemon spawned" and assumes everything is fine while the daemon is
        // actually dead. Retry up to 2x with 2s backoff; if still not running,
        // exit non-zero so the operator gets an actionable error.
        const MAX_SPAWN_ATTEMPTS = 3;
        const SPAWN_RETRY_BACKOFF_MS = 2000;
        const ipc2 = new IPCClient(instanceId);
        let running = false;

        for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS && !running; attempt++) {
          const child = spawn(process.execPath, [daemonScript, '--instance', instanceId], {
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: daemonEnv,
            cwd: projectRoot,
            windowsHide: true,
          });
          child.unref();

          // Give it a moment to bootstrap, then check.
          await new Promise(r => setTimeout(r, 1500));
          running = await ipc2.isDaemonRunning();
          if (!running && attempt < MAX_SPAWN_ATTEMPTS) {
            console.log(`Daemon spawn attempt ${attempt}/${MAX_SPAWN_ATTEMPTS} did not produce a running daemon. Retrying in ${SPAWN_RETRY_BACKOFF_MS / 1000}s...`);
            await new Promise(r => setTimeout(r, SPAWN_RETRY_BACKOFF_MS));
          }
        }

        if (running) {
          console.log('Daemon started successfully (background process).');
          console.log('Note: daemon will stop if you close this terminal session.');
          console.log('Install PM2 for persistence: npm install -g pm2');
        } else {
          console.error(`Daemon failed to start after ${MAX_SPAWN_ATTEMPTS} attempts.`);
          console.error('Check the daemon log for the root cause:');
          console.error(`  ${logFile}`);
          console.error('Common causes: missing dist/daemon.js (run `npm run build`), permission denied on logs dir, bad CTX_ROOT.');
          process.exit(1);
        }
      }
      return;
    }

    // Daemon already running
    if (agent) {
      const projectRoot = discoverProjectRoot();
      // Auto-register in enabled-agents.json if not already present
      const ctxRoot = join(homedir(), '.cortextos', instanceId);
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      const enabledAgents = readEnabledAgents(instanceId);
      const preferredOrg = enabledAgents[agent]?.org
        ?? Object.values(enabledAgents).find((entry: { org?: string }) => entry.org)?.org;
      const agentLocation = findAgentDirAndOrg(projectRoot, agent, preferredOrg);

      if (!agentLocation) {
        console.error(`Agent "${agent}" was not found under ${projectRoot}.`);
        process.exit(1);
      }

      const config = readAgentConfigSafe(agentLocation.agentDir);
      const validation = validateClaudeWorkingDirectoryPolicy({
        agentName: agent,
        agentDir: agentLocation.agentDir,
        config,
        projectRoot,
        enabledAgents,
        allowExternalCwd: options.allowExternalCwd,
      });
      if (!validation.ok) {
        console.error(`Error: ${validation.error}`);
        process.exit(1);
      }

      if (!enabledAgents[agent]) {
        enabledAgents[agent] = {
          enabled: true,
          status: 'configured',
          ...(agentLocation.org ? { org: agentLocation.org } : {}),
        };
        mkdirSync(join(ctxRoot, 'config'), { recursive: true });
        writeFileSync(enabledPath, JSON.stringify(enabledAgents, null, 2) + '\n', 'utf-8');
        console.log(`  Registered ${agent} in enabled-agents.json`);
      }

      console.log(`Starting agent: ${agent}`);
      const response = await ipc.send({ type: 'start-agent', agent, source: 'cortextos start' });
      if (response.success) {
        console.log(`  ${response.data}`);
      } else {
        console.error(`  Error: ${response.error}`);
      }
    } else {
      const response = await ipc.send({ type: 'status', source: 'cortextos start' });
      if (response.success) {
        const statuses = response.data as any[];
        if (statuses.length === 0) {
          console.log('No agents configured. Add one with: cortextos add-agent <name>');
        } else {
          console.log('Agent statuses:');
          for (const s of statuses) {
            console.log(`  ${s.name}: ${s.status} (pid: ${s.pid || '-'})`);
          }
        }
      }
    }
  });
