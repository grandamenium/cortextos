import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, platform, arch } from 'os';
import { execSync, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';

const IS_WINDOWS = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

// Defense in depth: only allow well-formed package and command names so that
// even if a future caller passes user-controlled input, no shell injection is
// possible. spawnSync with array args also prevents shell parsing.
const SAFE_NAME = /^[@a-z0-9._/-]+$/i;

function tryInstallGlobal(pkg: string): boolean {
  if (!SAFE_NAME.test(pkg)) return false;
  const result = spawnSync('npm', ['install', '-g', pkg], { stdio: 'inherit', timeout: 120000 });
  return result.status === 0;
}

function commandExists(cmd: string): boolean {
  if (!SAFE_NAME.test(cmd)) return false;
  const which = IS_WINDOWS ? 'where' : 'which';
  const result = spawnSync(which, [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

function tryInstallJq(): boolean {
  if (IS_MAC && commandExists('brew')) {
    try { execSync('brew install jq', { stdio: 'inherit' }); return true; } catch { return false; }
  }
  if (!IS_WINDOWS && !IS_MAC) {
    try { execSync('sudo apt-get install -y jq', { stdio: 'inherit' }); return true; } catch { return false; }
  }
  if (IS_WINDOWS) {
    if (commandExists('winget')) {
      try { execSync('winget install jqlang.jq --silent', { stdio: 'inherit' }); return true; } catch { /* try choco */ }
    }
    if (commandExists('choco')) {
      try { execSync('choco install jq -y', { stdio: 'inherit' }); return true; } catch { return false; }
    }
  }
  return false;
}

export const installCommand = new Command('install')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Install cortextOS — create state directories, check and install dependencies')
  .action(async (options: { instance: string }) => {
    const instanceId = options.instance;
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    console.log('\ncortextOS Installation\n');

    // ─── Dependency checks & auto-install ────────────────────────────────────

    console.log('Checking dependencies...\n');

    // Node.js
    try {
      const v = execSync('node --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const major = parseInt(v.replace('v', '').split('.')[0], 10);
      if (major < 20) {
        console.error(`  ✗ node: v${major} too old (need v20+). Install from https://nodejs.org`);
        process.exit(1);
      }
      console.log(`  ✓ node: ${v}`);
    } catch {
      console.error('  ✗ node: NOT FOUND — install from https://nodejs.org');
      process.exit(1);
    }

    // Claude Code
    let claudeOk = false;
    try {
      const v = execSync('claude --version', { encoding: 'utf-8', stdio: 'pipe' }).trim().split('\n')[0];
      console.log(`  ✓ claude: ${v}`);
      claudeOk = true;
    } catch {
      console.log('  ✗ claude: NOT FOUND');
      console.log('    Auto-installing Claude Code...');
      if (tryInstallGlobal('@anthropic-ai/claude-code')) {
        try {
          const v = execSync('claude --version', { encoding: 'utf-8', stdio: 'pipe' }).trim().split('\n')[0];
          console.log(`  ✓ claude: ${v} (just installed)`);
          claudeOk = true;
        } catch { /* PATH may need refresh */ }
      }
      if (!claudeOk) {
        console.error('  ✗ Could not install Claude Code. Install manually:');
        console.error('    npm install -g @anthropic-ai/claude-code');
        process.exit(1);
      }
    }

    // Claude Code auth check — use `claude auth status` which covers all auth methods
    {
      let authenticated = false;
      try {
        const authOutput = execSync('claude auth status', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        if (authOutput.includes('"loggedIn": true') || authOutput.includes('"loggedIn":true')) {
          authenticated = true;
        }
      } catch {
        // claude auth status failed — check env var as fallback
        if (process.env.ANTHROPIC_API_KEY) {
          authenticated = true;
        }
      }

      if (!authenticated) {
        console.log('');
        console.log('  ! Claude Code is not authenticated.');
        console.log('    Run: claude login');
        console.log('    Agents will not start until you authenticate.');
        console.log('    You can run this after installation completes.');
        console.log('');
      } else {
        console.log('  ✓ claude: authenticated');
      }
    }

    // node-pty native module
    try {
      require('node-pty');
      console.log('  ✓ node-pty: native module loaded');
    } catch (err) {
      console.error('  ✗ node-pty: native module failed to load');
      console.error(`    Error: ${(err as Error).message}`);
      if (IS_MAC) {
        console.error('    Install Xcode Command Line Tools: xcode-select --install');
      } else if (IS_WINDOWS) {
        console.error('    Install Visual C++ Build Tools: npm install -g windows-build-tools');
      } else {
        console.error('    Install build tools: sudo apt-get install -y build-essential python3');
      }
      console.error('    Then run: npm install (in the cortextOS directory)');
      process.exit(1);
    }

    // Fix node-pty spawn-helper permissions (npm doesn't reliably preserve executable bits on prebuilds)
    if (!IS_WINDOWS) {
      const fixed = fixSpawnHelper(process.cwd());
      if (fixed) {
        console.log('  ✓ node-pty: spawn-helper permissions fixed');
      }
    }

    // Smoke test: verify node-pty can actually spawn a process
    {
      try {
        const pty = require('node-pty');
        let output = '';
        const smokeCmd = IS_WINDOWS ? 'cmd.exe' : '/bin/echo';
        const smokeArgs = IS_WINDOWS ? ['/c', 'echo', 'pty-ok'] : ['pty-ok'];
        const p = pty.spawn(smokeCmd, smokeArgs, { name: 'xterm-256color', cols: 80, rows: 24 });
        await new Promise<void>((resolve, reject) => {
          p.onData((data: string) => { output += data; });
          p.onExit(({ exitCode }: { exitCode: number }) => {
            if (exitCode === 0 && output.includes('pty-ok')) resolve();
            else reject(new Error(`spawn test failed (exit ${exitCode})`));
          });
          setTimeout(() => reject(new Error('spawn test timed out')), 5000);
        });
        console.log('  ✓ node-pty: spawn test passed');
      } catch (err) {
        console.error('  ✗ node-pty: spawn test failed');
        console.error(`    Error: ${(err as Error).message}`);
        console.error('    The daemon will not be able to start agents.');
        console.error('    Try: npm rebuild node-pty');
        process.exit(1);
      }
    }

    // PM2 — required for daemon persistence
    if (!commandExists('pm2')) {
      console.log('  - pm2: not found. Installing...');
      if (tryInstallGlobal('pm2')) {
        try {
          const v = execSync('pm2 --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
          console.log(`  ✓ pm2: ${v} (just installed)`);
        } catch {
          console.log('  ✓ pm2: installed (restart terminal if pm2 not in PATH)');
        }
      } else {
        console.log('  ! pm2: could not auto-install. Run: npm install -g pm2');
      }
    } else {
      try {
        const v = execSync('pm2 --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        console.log(`  ✓ pm2: ${v}`);
      } catch {
        console.log('  ✓ pm2: installed');
      }
    }

    // jq — required for bus scripts
    if (!commandExists('jq')) {
      console.log('  - jq: not found. Installing...');
      const installed = tryInstallJq();
      if (installed && commandExists('jq')) {
        const v = execSync('jq --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        console.log(`  ✓ jq: ${v} (just installed)`);
      } else {
        console.log('  ! jq: could not auto-install.');
        if (IS_MAC) console.log('    Install with: brew install jq');
        else if (IS_WINDOWS) console.log('    Install with: winget install jqlang.jq');
        else console.log('    Install with: sudo apt-get install -y jq');
        console.log('    Agent bus scripts (messaging, tasks) will not work without jq.');
      }
    } else {
      try {
        const v = execSync('jq --version', { encoding: 'utf-8', stdio: 'pipe' }).trim();
        console.log(`  ✓ jq: ${v}`);
      } catch {
        console.log('  ✓ jq: installed');
      }
    }

    console.log('');

    // ─── State directories ────────────────────────────────────────────────────

    console.log('Creating state directories...');
    const dirs = [
      ctxRoot,
      join(ctxRoot, 'config'),
      join(ctxRoot, 'state'),
      join(ctxRoot, 'state', 'oauth'),
      join(ctxRoot, 'state', 'usage'),
      join(ctxRoot, 'inbox'),
      join(ctxRoot, 'inflight'),
      join(ctxRoot, 'processed'),
      join(ctxRoot, 'outbox'),
      join(ctxRoot, 'logs'),
      join(ctxRoot, 'orgs'),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* ignore on Windows */ }
    }
    console.log(`  Created ${dirs.length} directories at ${ctxRoot}`);

    // enabled-agents.json
    const enabledPath = join(ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledPath)) {
      writeFileSync(enabledPath, '{}', 'utf-8');
      console.log('  Created enabled-agents.json');
    }

    // Instance .env
    const envPath = join(ctxRoot, '.env');
    if (!existsSync(envPath)) {
      writeFileSync(envPath, [
        `CTX_INSTANCE_ID=${instanceId}`,
        `CTX_ROOT=${ctxRoot}`,
        '',
      ].join('\n'), 'utf-8');
      try { chmodSync(envPath, 0o600); } catch { /* ignore on Windows */ }
      console.log('  Created .env');
    }

    // Bus signing key
    const signingKeyPath = join(ctxRoot, 'config', 'bus-signing-key');
    if (!existsSync(signingKeyPath)) {
      const signingKey = randomBytes(32).toString('hex');
      writeFileSync(signingKeyPath, signingKey, 'utf-8');
      try { chmodSync(signingKeyPath, 0o600); } catch { /* ignore on Windows */ }
      console.log('  Generated bus-signing-key (HMAC-SHA256)');
    }

    // ─── Dashboard credentials ────────────────────────────────────────────────

    const dashEnvPath = join(ctxRoot, 'dashboard.env');
    let authSecret: string;
    let adminPassword: string;

    if (existsSync(dashEnvPath)) {
      // Read existing values so we don't overwrite them
      const existing = readFileSync(dashEnvPath, 'utf-8');
      const lines = Object.fromEntries(
        existing.split('\n')
          .filter(l => l.includes('='))
          .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
      );
      authSecret = lines['AUTH_SECRET'] || randomBytes(32).toString('hex');
      adminPassword = lines['ADMIN_PASSWORD'] || randomBytes(12).toString('hex');
    } else {
      authSecret = randomBytes(32).toString('hex');
      adminPassword = randomBytes(12).toString('hex');
    }

    writeFileSync(
      dashEnvPath,
      [
        `AUTH_SECRET=${authSecret}`,
        `ADMIN_USERNAME=admin`,
        `ADMIN_PASSWORD=${adminPassword}`,
        `CTX_ROOT=${ctxRoot}`,
        `CTX_FRAMEWORK_ROOT=${process.cwd()}`,
        '',
      ].join('\n'),
      'utf-8',
    );
    try { chmodSync(dashEnvPath, 0o600); } catch { /* ignore on Windows */ }
    console.log(`  Generated dashboard credentials at ${dashEnvPath}`);

    console.log('\n  Installation complete.');
    console.log(`  State directory: ${ctxRoot}`);
    console.log(`\n  Dashboard credentials saved to: ${dashEnvPath}`);
    console.log(`    Admin username: admin`);
    console.log(`    Admin credentials saved to: ${dashEnvPath}`);
    console.log(`    (View password with: cat ${dashEnvPath})`);
    console.log('\n  Next steps:');
    console.log('    1. cortextos init <org-name>');
    console.log('    2. cortextos add-agent <name> --template orchestrator');
    console.log('    3. cortextos ecosystem && pm2 start ecosystem.config.js');
    console.log('    4. cortextos dashboard\n');
  });

/**
 * Fix node-pty spawn-helper permissions on Unix.
 * npm doesn't reliably preserve executable bits on prebuild binaries,
 * which causes posix_spawnp to fail on macOS/Linux.
 * Scans all prebuild directories and ensures spawn-helper is executable.
 */
function fixSpawnHelper(projectRoot: string): boolean {
  const prebuildsDir = join(projectRoot, 'node_modules', 'node-pty', 'prebuilds');
  const buildRelease = join(projectRoot, 'node_modules', 'node-pty', 'build', 'Release');
  let fixed = false;

  // Check prebuilds (used when no local compilation)
  if (existsSync(prebuildsDir)) {
    try {
      for (const platformDir of readdirSync(prebuildsDir)) {
        const helperPath = join(prebuildsDir, platformDir, 'spawn-helper');
        if (existsSync(helperPath)) {
          try {
            const mode = statSync(helperPath).mode;
            if ((mode & 0o111) === 0) {
              chmodSync(helperPath, 0o755);
              fixed = true;
            }
          } catch { /* skip individual files that can't be stat'd */ }
        }
      }
    } catch { /* prebuilds dir unreadable */ }
  }

  // Check build/Release (used when compiled from source)
  const buildHelper = join(buildRelease, 'spawn-helper');
  if (existsSync(buildHelper)) {
    try {
      const mode = statSync(buildHelper).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(buildHelper, 0o755);
        fixed = true;
      }
    } catch { /* ignore */ }
  }

  return fixed;
}
