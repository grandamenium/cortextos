#!/usr/bin/env node
/**
 * cortextOS cross-platform installer
 *
 * Mac/Linux:   curl -fsSL https://raw.githubusercontent.com/grandamenium/cortextos/main/install.mjs | node
 * Windows:     node -e "$(irm https://raw.githubusercontent.com/grandamenium/cortextos/main/install.mjs)"
 * Local test:  node install.mjs
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const REPO_URL = process.env.CORTEXTOS_REPO || 'https://github.com/grandamenium/cortextos.git';
const INSTALL_DIR = process.env.CORTEXTOS_DIR || join(homedir(), 'cortextos');

// CORTEXTOS_BRANCH lets you install a specific branch instead of `main`. Useful
// for testing fixes before they merge:
//   CORTEXTOS_BRANCH=fix/foo curl -fsSL .../fix/foo/install.mjs | node
// Branch name is restricted to standard git ref characters to avoid shell injection.
const REPO_BRANCH_RAW = process.env.CORTEXTOS_BRANCH || 'main';
if (!/^[a-zA-Z0-9._/-]+$/.test(REPO_BRANCH_RAW)) {
  console.error(`Invalid CORTEXTOS_BRANCH value: ${REPO_BRANCH_RAW}`);
  console.error('Branch names may only contain letters, digits, dot, underscore, slash, or dash.');
  process.exit(1);
}
const REPO_BRANCH = REPO_BRANCH_RAW;
const IS_WINDOWS = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

// ANSI colors (work on modern Windows Terminal, macOS Terminal, Linux)
const R = '\x1b[0m';
const B = '\x1b[34m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

const log  = (msg) => console.log(`${B}==>${R} ${msg}`);
const ok   = (msg) => console.log(`${G}  ✓${R} ${msg}`);
const warn = (msg) => console.log(`${Y}  !${R} ${msg}`);
const fail = (msg) => { console.error(`${RED}  ✗${R} ${msg}`); process.exit(1); };
const info = (msg) => console.log(`    ${msg}`);

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function runVisible(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function commandExists(cmd) {
  try {
    const which = IS_WINDOWS ? 'where' : 'which';
    run(`${which} ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

function tryInstall(label, installFn) {
  try {
    installFn();
    return true;
  } catch {
    warn(`Could not auto-install ${label} — see manual instructions above`);
    return false;
  }
}

console.log('');
console.log(`${BOLD}cortextOS installer${R}`);
console.log('Persistent 24/7 Claude Code agents with Telegram control');
console.log('');

// ─── 1. Node.js version ──────────────────────────────────────────────────────

log('Checking Node.js...');
const nodeVersion = run('node --version').replace('v', '');
const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
if (nodeMajor < 20) {
  fail(`Node.js v${nodeVersion} is too old. v20 or later required.\n    Install from https://nodejs.org`);
}
ok(`Node.js v${nodeVersion}`);

try {
  const npmVersion = run('npm --version');
  ok(`npm ${npmVersion}`);
} catch {
  fail('npm is not installed');
}

// ─── 2. git ───────────────────────────────────────────────────────────────────

log('Checking git...');
if (!commandExists('git')) {
  if (IS_MAC) {
    warn('git is not installed. It will be installed with Xcode Command Line Tools (next step).');
  } else if (IS_LINUX) {
    warn('git is not installed. Installing...');
    try { runVisible('sudo apt-get install -y git'); ok('git installed'); }
    catch { fail('Could not install git. Run: sudo apt-get install -y git'); }
  } else {
    fail('git is not installed.\n    Install from https://git-scm.com/download/win or via: winget install Git.Git');
  }
} else {
  ok(`git ${run('git --version')}`);
}

// ─── 2b. Homebrew (macOS — needed for jq auto-install) ───────────────────────

if (IS_MAC && !commandExists('brew')) {
  console.log('');
  console.log(`${Y}  ! Homebrew is not installed.${R}`);
  console.log('    Homebrew is used to auto-install jq and other tools on macOS.');
  console.log(`    Install it: ${Y}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${R}`);
  console.log('    You can skip this for now, but jq will need to be installed manually later.');
  console.log('');
}

// ─── 3. Build tools (required for node-pty native compilation) ───────────────

log('Checking build tools (required for native dependencies)...');

if (IS_MAC) {
  let hasXcode = false;
  try {
    run('xcode-select -p');
    hasXcode = true;
  } catch { /* not installed */ }

  if (!hasXcode) {
    console.log('');
    console.log(`${Y}  ! Xcode Command Line Tools are not installed.${R}`);
    console.log(`    These are required to compile native Node.js addons (node-pty).`);
    console.log('');
    console.log(`    ${BOLD}Installing now...${R}`);
    console.log(`    A dialog box will appear asking you to install the tools.`);
    console.log(`    Click "Install" and wait for it to complete, then press Enter here.`);
    console.log('');
    try {
      runVisible('xcode-select --install');
    } catch { /* dialog already open or installing */ }
    // Wait for user to confirm
    console.log('');
    await new Promise((resolve) => {
      process.stdout.write('    Press Enter once Xcode CLI tools installation is complete... ');
      process.stdin.once('data', resolve);
    });
    try {
      run('xcode-select -p');
      ok('Xcode Command Line Tools installed');
    } catch {
      fail('Xcode Command Line Tools still not found. Install them manually:\n    xcode-select --install');
    }
  } else {
    ok(`Xcode Command Line Tools: ${run('xcode-select -p')}`);
  }
} else if (IS_LINUX) {
  let hasBuildEssential = false;
  try {
    run('dpkg -l build-essential 2>/dev/null | grep -q "^ii"');
    hasBuildEssential = true;
  } catch { /* not installed */ }
  if (!hasBuildEssential) {
    warn('build-essential not detected. Installing...');
    tryInstall('build-essential', () => runVisible('sudo apt-get install -y build-essential python3'));
  } else {
    ok('build-essential');
  }
} else if (IS_WINDOWS) {
  // Check for Windows Build Tools
  let hasBuildTools = false;
  try {
    run('cl.exe /? 2>&1');
    hasBuildTools = true;
  } catch { /* not in PATH */ }
  try {
    run('where cl.exe');
    hasBuildTools = true;
  } catch { /* not found */ }

  if (!hasBuildTools) {
    console.log('');
    console.log(`${Y}  ! Visual C++ Build Tools are required for native Node.js addons.${R}`);
    console.log('');
    console.log(`    ${BOLD}Option A (recommended): Install via npm${R}`);
    console.log('    Run this command in an Administrator PowerShell, then re-run this installer:');
    console.log(`    ${Y}  npm install -g windows-build-tools${R}`);
    console.log('');
    console.log(`    ${BOLD}Option B: Install Visual Studio Build Tools manually${R}`);
    console.log('    https://visualstudio.microsoft.com/visual-cpp-build-tools/');
    console.log('');
    const tryAuto = process.env.AUTO_BUILD_TOOLS === '1';
    if (tryAuto) {
      warn('Attempting auto-install of windows-build-tools...');
      try {
        runVisible('npm install -g windows-build-tools');
        ok('windows-build-tools installed');
      } catch {
        fail('Could not auto-install build tools. See instructions above.');
      }
    } else {
      fail('Visual C++ Build Tools required. See instructions above.\nSet AUTO_BUILD_TOOLS=1 to attempt auto-install (requires admin).');
    }
  } else {
    ok('Visual C++ Build Tools found');
  }
}

// ─── 3b. Python 3 (needed as fallback for native module compilation) ─────────

log('Checking Python 3...');
const hasPython = commandExists('python3') || commandExists('python');
if (!hasPython) {
  if (IS_LINUX) {
    warn('python3 not found. Installing...');
    tryInstall('python3', () => runVisible('sudo apt-get install -y python3'));
  } else if (IS_WINDOWS) {
    warn('python3 not found. node-pty compilation may fail.');
    console.log('    Install Python 3 from https://www.python.org/downloads/');
    console.log('    Or via Microsoft Store: search "Python 3"');
    console.log('');
  } else if (IS_MAC) {
    // Xcode CLI tools include Python 3 — should already be present
    warn('python3 not found (should be included with Xcode CLI Tools).');
  }
} else {
  try {
    const pyver = run(commandExists('python3') ? 'python3 --version' : 'python --version');
    ok(pyver);
  } catch { ok('python3: installed'); }
}

// ─── 4. Claude Code ───────────────────────────────────────────────────────────

log('Checking Claude Code...');
if (commandExists('claude')) {
  try {
    const claudeVersion = run('claude --version').split('\n')[0];
    ok(`Claude Code ${claudeVersion}`);
  } catch {
    ok('Claude Code (installed)');
  }
} else {
  warn('Claude Code is not installed. Installing now...');
  try {
    runVisible('npm install -g @anthropic-ai/claude-code');
    ok('Claude Code installed');
  } catch {
    console.log('');
    console.log(`${Y}  Could not auto-install Claude Code. Install manually:${R}`);
    console.log(`    npm install -g @anthropic-ai/claude-code`);
    console.log('');
  }
}

// Check claude authentication — use `claude auth status` which covers all auth methods (OAuth, API key, etc.)
{
  let authenticated = false;
  try {
    const authOutput = run('claude auth status');
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
    console.log(`${Y}  ! Claude Code authentication required before agents can start.${R}`);
    console.log('');
    console.log(`    ${BOLD}Run this now to authenticate:${R}`);
    console.log(`    ${Y}  claude login${R}`);
    console.log('');
    console.log('    You can complete authentication after this installer finishes.');
    console.log('    Agents will not start until you run: claude login');
    console.log('');
  } else {
    ok('Claude Code authenticated');
  }
}

// ─── 5. jq ────────────────────────────────────────────────────────────────────

log('Checking jq (required for agent bus scripts)...');
if (!commandExists('jq')) {
  warn('jq is not installed. Installing...');
  let installed = false;

  if (IS_MAC) {
    if (commandExists('brew')) {
      installed = tryInstall('jq', () => runVisible('brew install jq'));
    } else {
      console.log('');
      console.log(`    ${BOLD}Homebrew is required to auto-install jq on macOS.${R}`);
      console.log('    Install Homebrew first: https://brew.sh');
      console.log('    Then run: brew install jq');
      console.log('');
    }
  } else if (IS_LINUX) {
    installed = tryInstall('jq', () => runVisible('sudo apt-get install -y jq'));
  } else if (IS_WINDOWS) {
    if (commandExists('winget')) {
      installed = tryInstall('jq', () => runVisible('winget install jqlang.jq --silent'));
    } else if (commandExists('choco')) {
      installed = tryInstall('jq', () => runVisible('choco install jq -y'));
    } else {
      console.log('');
      console.log(`    ${BOLD}Install jq on Windows:${R}`);
      console.log('    winget:  winget install jqlang.jq');
      console.log('    choco:   choco install jq');
      console.log('    manual:  https://jqlang.github.io/jq/download/');
      console.log('');
    }
  }

  if (installed && commandExists('jq')) {
    ok(`jq ${run('jq --version')}`);
  } else if (!installed) {
    warn('jq not installed — agent bus scripts will not work without it');
  }
} else {
  ok(`jq ${run('jq --version')}`);
}

// ─── 6. Windows: WSL check ────────────────────────────────────────────────────

if (IS_WINDOWS) {
  log('Checking WSL (required for agent shell scripts on Windows)...');
  if (commandExists('wsl')) {
    try {
      const wslVersion = run('wsl --version 2>&1 || wsl -l -v');
      ok(`WSL installed`);
    } catch {
      ok('WSL installed');
    }
  } else {
    console.log('');
    console.log(`${Y}  ! WSL (Windows Subsystem for Linux) is required.${R}`);
    console.log('    Agent shell scripts run inside a bash environment.');
    console.log('');
    console.log(`    ${BOLD}Install WSL (requires restart):${R}`);
    console.log(`    ${Y}  wsl --install${R}`);
    console.log('    Run this in an Administrator PowerShell, then restart your machine.');
    console.log('    After restart, run this installer again.');
    console.log('');
    warn('WSL not installed — agents will not work without it on Windows');
  }
}

console.log('');

// ─── 7. Clone or update ───────────────────────────────────────────────────────

if (existsSync(INSTALL_DIR)) {
  warn(`Directory ${INSTALL_DIR} already exists`);
  if (existsSync(join(INSTALL_DIR, '.git'))) {
    // Check and migrate remote setup if needed
    let hasUpstream = false;
    try {
      run('git remote get-url upstream', { cwd: INSTALL_DIR });
      hasUpstream = true;
    } catch { /* no upstream remote yet */ }

    if (!hasUpstream) {
      // Check if origin points to canonical — if so, rename it to upstream
      let originUrl = '';
      try { originUrl = run('git remote get-url origin', { cwd: INSTALL_DIR }); } catch { /* no origin */ }
      if (originUrl && (originUrl.includes('grandamenium/cortextos') || originUrl === REPO_URL)) {
        log('Migrating git remotes: renaming origin → upstream...');
        try {
          run('git remote rename origin upstream', { cwd: INSTALL_DIR });
          ok('Remote migrated: canonical repo is now "upstream"');
          hasUpstream = true;
        } catch {
          warn('Could not rename remote — run manually: git remote rename origin upstream');
        }
      }
    }

    log('Pulling latest changes...');
    try {
      if (hasUpstream) {
        runVisible('git pull upstream main --ff-only', { cwd: INSTALL_DIR });
      } else {
        runVisible('git pull --ff-only', { cwd: INSTALL_DIR });
      }
    } catch {
      warn('Could not pull — continuing with existing version');
    }
  } else {
    fail(`${INSTALL_DIR} exists but is not a git repo. Remove it or set CORTEXTOS_DIR to a different path.`);
  }
} else {
  log(`Cloning cortextOS (branch: ${REPO_BRANCH}) to ${INSTALL_DIR}...`);
  runVisible(`git clone --branch ${REPO_BRANCH} ${REPO_URL} ${JSON.stringify(INSTALL_DIR)}`);
  ok('Cloned');

  // Rename origin → upstream so check-upstream and upstream-sync work out of the box
  log('Configuring git remotes...');
  try {
    run('git remote rename origin upstream', { cwd: INSTALL_DIR });
    ok('"upstream" remote configured (tracks canonical cortextOS)');
  } catch {
    warn('Could not configure upstream remote — run manually: git remote rename origin upstream');
  }
}

// ─── 8. npm install ───────────────────────────────────────────────────────────

log('Installing dependencies (this may take a minute)...');
try {
  runVisible('npm install', { cwd: INSTALL_DIR });
  ok('Dependencies installed');
} catch (err) {
  console.error('');
  console.error(`${RED}  npm install failed.${R}`);
  if (IS_MAC) {
    console.error('  If you see C++ compilation errors, install Xcode CLI tools:');
    console.error('    xcode-select --install');
  } else if (IS_LINUX) {
    console.error('  If you see C++ compilation errors, install build tools:');
    console.error('    sudo apt-get install -y build-essential');
  } else if (IS_WINDOWS) {
    console.error('  If you see C++ compilation errors, install Visual C++ Build Tools:');
    console.error('    npm install -g windows-build-tools  (run as Administrator)');
  }
  process.exit(1);
}

// ─── 8b. Fix node-pty spawn-helper permissions ───────────────────────────────
// npm doesn't reliably preserve executable bits on prebuild binaries.
// This causes posix_spawnp to fail on macOS/Linux when the daemon tries to spawn agents.

if (!IS_WINDOWS) {
  const prebuilds = join(INSTALL_DIR, 'node_modules', 'node-pty', 'prebuilds');
  const buildRel = join(INSTALL_DIR, 'node_modules', 'node-pty', 'build', 'Release');
  let fixed = false;

  if (existsSync(prebuilds)) {
    try {
      for (const d of readdirSync(prebuilds)) {
        const h = join(prebuilds, d, 'spawn-helper');
        if (existsSync(h) && (statSync(h).mode & 0o111) === 0) { chmodSync(h, 0o755); fixed = true; }
      }
    } catch { /* skip */ }
  }
  const bh = join(buildRel, 'spawn-helper');
  if (existsSync(bh)) {
    try { if ((statSync(bh).mode & 0o111) === 0) { chmodSync(bh, 0o755); fixed = true; } } catch { /* skip */ }
  }

  if (fixed) ok('Fixed node-pty spawn-helper permissions');
}

// ─── 9. Build ─────────────────────────────────────────────────────────────────

log('Building...');
runVisible('npm run build', { cwd: INSTALL_DIR });
ok('Build complete');

// ─── 10. Link CLI globally ────────────────────────────────────────────────────

log('Linking cortextos CLI...');
try {
  runVisible('npm link', { cwd: INSTALL_DIR });
} catch {
  try {
    runVisible('npm install -g .', { cwd: INSTALL_DIR });
  } catch {
    warn('Could not install globally. Run manually: cd ' + INSTALL_DIR + ' && npm install -g .');
  }
}

if (commandExists('cortextos')) {
  ok('cortextos CLI available');
} else {
  warn('cortextos not in PATH yet. You may need to restart your terminal.');
}

// ─── 11. PM2 ─────────────────────────────────────────────────────────────────

log('Checking PM2 (process manager)...');
if (!commandExists('pm2')) {
  log('Installing PM2...');
  try {
    runVisible('npm install -g pm2');
    ok(`PM2 ${run('pm2 --version')}`);
  } catch {
    warn('Could not install PM2. Install manually: npm install -g pm2');
  }
} else {
  ok(`PM2 ${run('pm2 --version')}`);
}

// ─── 12. Run cortextos install ────────────────────────────────────────────────

log('Running cortextos install...');
try {
  runVisible('node dist/cli.js install', { cwd: INSTALL_DIR });
} catch {
  warn('cortextos install had warnings — see above');
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log('');
console.log(`${G}${BOLD}cortextOS installed successfully!${R}`);
console.log('');

if (!commandExists('claude')) {
  console.log(`${Y}  IMPORTANT: Install and authenticate Claude Code before continuing:${R}`);
  console.log(`    npm install -g @anthropic-ai/claude-code`);
  console.log(`    claude login`);
  console.log('');
}

console.log(`${BOLD}Next steps:${R}`);
console.log('');
console.log(`  1. Open ${BOLD}${INSTALL_DIR}${R} in Claude Code:`);
if (IS_WINDOWS) {
  console.log(`     ${Y}claude "${INSTALL_DIR}"${R}`);
} else {
  console.log(`     ${Y}claude ${INSTALL_DIR}${R}`);
}
console.log('');
console.log(`  2. In Claude Code, run:`);
console.log(`     ${Y}/onboarding${R}`);
console.log('');
console.log('  That\'s it. The /onboarding command walks you through everything:');
console.log('  org setup, agent creation, Telegram bots, dashboard, and more.');
console.log('');
