import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export const ecosystemCommand = new Command('ecosystem')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <name>', 'Organization name (auto-detected if not specified)')
  .option('--output <path>', 'Output file', 'ecosystem.config.js')
  .description('Generate PM2 ecosystem.config.js from agent configs')
  .action(async (options: { instance: string; org?: string; output: string }) => {
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    // BUG-035 (companion fix): same project-root discovery as enable-agent.ts
    // so `cortextos ecosystem` works from outside ~/cortextos.
    let projectRoot: string;
    if (process.env.CTX_FRAMEWORK_ROOT) {
      projectRoot = process.env.CTX_FRAMEWORK_ROOT;
    } else if (process.env.CTX_PROJECT_ROOT) {
      projectRoot = process.env.CTX_PROJECT_ROOT;
    } else {
      const canonical = join(homedir(), 'cortextos');
      projectRoot = existsSync(join(canonical, 'orgs')) ? canonical : process.cwd();
    }

    // Find all agents
    const agents: Array<{ name: string; dir: string; org?: string }> = [];

    // Scan orgs/*/agents/*
    const orgsDir = join(projectRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agent.isDirectory()) continue;
          agents.push({ name: agent.name, dir: join(agentsDir, agent.name), org: org.name });
        }
      }
    }

    if (agents.length === 0) {
      console.log('No agents found. Add agents first: cortextos add-agent <name>');
      return;
    }

    // Determine org: use --org flag, or auto-detect from first agent found
    const detectedOrg = options.org || agents.find(a => a.org)?.org || '';
    if (!detectedOrg) {
      console.error('Could not determine org. Use --org <name>.');
      return;
    }

    // Use dist/ in project root for all scripts
    const distDir = join(projectRoot, 'dist');
    const daemonScript = join(distDir, 'daemon.js');
    const dashboardDir = join(projectRoot, 'dashboard');
    // BUG-019 + cycle-2 finding: require BOTH package.json AND node_modules/.bin/next.
    // Without the second check, running `cortextos ecosystem` before
    // `npm install` in dashboard/ produces a crash-looped PM2 entry that the
    // user sees as "dashboard keeps restarting". Better to silently skip the
    // dashboard entry if its deps aren't installed yet — the user can re-run
    // `cortextos ecosystem` after `npm install` to add it.
    const hasDashboard = existsSync(join(dashboardDir, 'package.json')) &&
      existsSync(join(dashboardDir, 'node_modules', '.bin', 'next'));

    // BUG-002 fix: emit ecosystem.config.js as raw JS that resolves
    // process.env.CTX_INSTANCE_ID at PM2-startup time, not at generation time.
    // The previous JSON.stringify approach baked the instance id into the
    // generated file, so instance switching required regenerating the file.
    // Now: `CTX_INSTANCE_ID=other pm2 restart cortextos-daemon` just works.
    //
    // BUG-016 fix: bumped max_restarts from 10 to 50. PM2's max_restarts
    // controls how many times PM2 itself restarts cortextos-daemon if it
    // crashes — independent of in-daemon agent crash counting. 10 was too
    // low: a transient infrastructure wobble could exhaust retries before
    // the daemon stabilized. 50 leaves real headroom.
    //
    // BUG-019 fix: emit a cortextos-dashboard PM2 entry alongside the daemon
    // so the dashboard runs under PM2 supervision instead of as an orphan
    // `npm run dev &` background shell job started by /onboarding. Now it
    // gets restart-on-crash, log files in ~/.pm2/logs/, and reboot survival
    // via `pm2 startup`/`pm2 save`. The dashboard PM2 entry is only added
    // if dashboard/package.json exists (to keep the generator working in
    // minimal/test installs).
    // PM2 on Windows can't execute `npm` directly — `npm.cmd` is a Windows
    // .cmd shim that PM2's node-based loader tries to interpret as JS, which
    // fails immediately ("Unexpected token ':'"). Bypass the shim by pointing
    // PM2 at the local Next.js binary that `npm run dev` would run anyway.
    // The `next` entry resolves under dashboard/node_modules/next/dist/bin/next
    // and is just a Node script, so PM2 spawns it cleanly on every platform.
    //
    // Task #74 (2026-05-17): emit paths as template literals over
    // `process.env.HOME` (with `os.homedir()` fallback) so the same file
    // works across hosts that share orgs/ via git. Previously every host
    // had to sed-patch /Users/<user>/cortextos back in after pulling.
    const isWindows = process.platform === 'win32';
    const nextBin = join(dashboardDir, 'node_modules', 'next', 'dist', 'bin', 'next');

    // Decide whether the install lives under HOME. If so we emit
    // `path.join(HOME, ...relativeParts)` so PM2 resolves it per-host. If
    // not (e.g. /opt/cortextos), we fall back to an absolute literal.
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    const dotCortextosPrefix = join(home, '.cortextos') + '/';

    function asHomeRel(absolutePath: string): string {
      if (absolutePath === home) return 'HOME';
      if (absolutePath.startsWith(homePrefix)) {
        const rel = absolutePath.slice(homePrefix.length);
        // Emit as path.join(HOME, 'a', 'b', 'c') so it works on Windows too.
        const parts = rel.split('/').filter(Boolean).map(p => JSON.stringify(p));
        return `path.join(HOME, ${parts.join(', ')})`;
      }
      // Outside HOME — emit literal absolute path.
      return JSON.stringify(absolutePath);
    }

    function asCtxRootRel(absolutePath: string): string {
      // Special-case ctxRoot so it resolves CTX_ROOT env var first, then
      // falls back to path.join(HOME, '.cortextos', INSTANCE_ID). The
      // instance id is already a runtime expression so we can compose them.
      if (absolutePath.startsWith(dotCortextosPrefix)) {
        const tail = absolutePath.slice(dotCortextosPrefix.length).split('/').filter(Boolean);
        // tail typically equals [instanceId]. If it does, prefer the runtime
        // INSTANCE_ID expression so a `CTX_INSTANCE_ID=foo` override flows
        // through correctly without regen.
        if (tail.length === 1 && tail[0] === options.instance) {
          return `path.join(HOME, '.cortextos', INSTANCE_ID)`;
        }
        const parts = ["'.cortextos'", ...tail.map(p => JSON.stringify(p))].join(', ');
        return `path.join(HOME, ${parts})`;
      }
      return JSON.stringify(absolutePath);
    }

    const daemonScriptExpr = asHomeRel(daemonScript);
    const projectRootExpr = asHomeRel(projectRoot);
    const ctxRootExpr = asCtxRootRel(ctxRoot);
    const dashboardDirExpr = asHomeRel(dashboardDir);
    const nextBinExpr = asHomeRel(nextBin);

    // For the dashboard script: emit the runtime decision so Windows hosts
    // running the same file pick up nextBin if present. existsSync needs
    // a runtime import.
    const dashboardScriptExpr = isWindows && existsSync(nextBin)
      ? nextBinExpr
      : "'npm'";
    const dashboardArgsExpr = isWindows && existsSync(nextBin)
      ? "'dev'"
      : "'run dev'";

    // windowsHide: stops PM2 from attaching a visible "next-server" console
    // window to the dashboard process at boot on Windows. PM2's default
    // CreateProcess flags include the parent console; on Linux/macOS the
    // process is already daemonized so this is invisible. Harmless if true
    // on non-Windows (PM2 ignores the flag). Surfaces as a stray terminal
    // titled "next-server (vX.Y.Z)" after `pm2 resurrect` post-reboot.
    const dashboardAppBlock = hasDashboard
      ? `,
    {
      name: 'cortextos-dashboard',
      script: ${dashboardScriptExpr},
      args: ${dashboardArgsExpr},
      cwd: ${dashboardDirExpr},
      env: {
        PORT: process.env.PORT || '3000',
      },
      // Dashboard reads its real config from dashboard/.env.local — populated
      // by /onboarding Phase 7. PM2 just supervises the dashboard process.
      windowsHide: true,
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }`
      : '';

    const content = `// AUTO-GENERATED by \`cortextos ecosystem\`. Do NOT edit by hand.
// Re-run \`cortextos ecosystem\` to regenerate.
//
// Task #74 (2026-05-17): paths are resolved at PM2-startup time via
// process.env.HOME so the same file works across hosts that sync orgs/ via
// git. The os.homedir() fallback covers headless PM2 starts where HOME
// isn't exported (rare; PM2 normally inherits it from the launching shell).
// Daemon-internal env overrides go into ~/.cortextos/<instance>/config/daemon.env
// (loaded by daemon at startup — Task #76), not into this file.
const path = require('path');
const HOME = process.env.HOME || require('os').homedir();
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)};

module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: ${daemonScriptExpr},
      args: '--instance ' + INSTANCE_ID,
      cwd: ${projectRootExpr},
      env: {
        CTX_INSTANCE_ID: INSTANCE_ID,
        CTX_ROOT: process.env.CTX_ROOT || ${ctxRootExpr},
        CTX_FRAMEWORK_ROOT: ${projectRootExpr},
        CTX_PROJECT_ROOT: ${projectRootExpr},
        CTX_ORG: process.env.CTX_ORG || ${JSON.stringify(detectedOrg)},
      },
      max_restarts: 50,
      restart_delay: 5000,
      autorestart: true,
    }${dashboardAppBlock},
  ],
};
`;

    writeFileSync(options.output, content, 'utf-8');
    console.log(`Generated ${options.output} with daemon (manages ${agents.length} agents)${hasDashboard ? ' + dashboard' : ''}`);
    console.log('\nStart with:');
    console.log(`  pm2 start ${options.output}`);
    console.log('  pm2 save');
  });
