import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync, spawn, spawnSync } from 'child_process';
import { IPCClient } from '../daemon/ipc-server.js';

const IS_WINDOWS = platform() === 'win32';
const SAFE_CMD = /^[@a-z0-9._/-]+$/i;

function commandExists(cmd: string): boolean {
  if (!SAFE_CMD.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

export const startCommand = new Command('start')
  .argument('[agent]', 'Specific agent to start (starts all if omitted)')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--foreground', 'Run daemon in foreground (no PM2, for debugging)')
  .description('Start the cortextOS daemon and agents')
  .action(async (agent: string | undefined, options: { instance: string; foreground?: boolean }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      const projectRoot = process.cwd();
      const daemonScript = join(projectRoot, 'dist', 'daemon.js');

      if (!existsSync(daemonScript)) {
        console.error('Daemon not built. Run: npm run build');
        process.exit(1);
      }

      const ctxRoot = join(homedir(), '.cortextos', options.instance);

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
        CTX_INSTANCE_ID: options.instance,
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: projectRoot,
        CTX_PROJECT_ROOT: projectRoot,
        ...(org ? { CTX_ORG: org } : {}),
      };

      if (options.foreground) {
        // Run in foreground (blocking) — useful for debugging
        console.log('Starting cortextOS daemon in foreground...');
        console.log('(Press Ctrl+C to stop)\n');
        const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
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

        const child = spawn(process.execPath, [daemonScript, '--instance', options.instance], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: daemonEnv,
          cwd: projectRoot,
          windowsHide: true,
        });
        child.unref();

        // Give it a moment to start
        await new Promise(r => setTimeout(r, 1500));

        const ipc2 = new IPCClient(options.instance);
        const running = await ipc2.isDaemonRunning();
        if (running) {
          console.log('Daemon started successfully (background process).');
          console.log('Note: daemon will stop if you close this terminal session.');
          console.log('Install PM2 for persistence: npm install -g pm2');
        } else {
          console.log('Daemon spawned. Check logs if agents do not appear:');
          console.log(`  ${logFile}`);
        }
      }
      return;
    }

    // Daemon already running
    if (agent) {
      // Auto-register in enabled-agents.json if not already present
      const ctxRoot = join(homedir(), '.cortextos', options.instance);
      const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
      let enabledAgents: Record<string, any> = {};
      try {
        if (existsSync(enabledPath)) {
          enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8'));
        }
      } catch { /* ignore */ }

      if (!enabledAgents[agent]) {
        // Try to detect org from existing entries or project structure
        const existingOrg = Object.values(enabledAgents as Record<string, any>).find((e: any) => e.org)?.org;
        enabledAgents[agent] = {
          enabled: true,
          status: 'configured',
          ...(existingOrg ? { org: existingOrg } : {}),
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
