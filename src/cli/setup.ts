/**
 * cortextos setup — interactive first-run wizard.
 *
 * Guides a new user through:
 *   1. Dependency check + state directory creation (install)
 *   2. Org creation (init)
 *   3. Orchestrator agent setup (add-agent --template orchestrator + .env + enable)
 *   4. Optional additional agents (analyst/agent)
 *   5. Ecosystem config generation + daemon start
 */
import { Command } from 'commander';
import { createInterface, type Interface } from 'readline';
import { existsSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { TelegramAPI, formatValidateError } from '../telegram/api.js';

function rl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: Interface, question: string): Promise<string> {
  return new Promise(resolve => iface.question(question, answer => resolve(answer.trim())));
}

function askRequired(iface: Interface, question: string, errorMsg: string): Promise<string> {
  return new Promise(async resolve => {
    while (true) {
      const answer = await ask(iface, question);
      if (answer) {
        resolve(answer);
        return;
      }
      console.log(`  ${errorMsg}`);
    }
  });
}

function askDefault(iface: Interface, question: string, defaultVal: string): Promise<string> {
  return new Promise(resolve =>
    iface.question(`${question} [${defaultVal}]: `, answer => {
      const trimmed = answer.trim();
      resolve(trimmed || defaultVal);
    })
  );
}

function askYN(iface: Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise(resolve =>
    iface.question(`${question} [${hint}]: `, answer => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    })
  );
}

function runCli(cwd: string, args: string[], label: string): boolean {
  const cliPath = join(cwd, 'dist', 'cli.js');
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\n  Error during: ${label}`);
    return false;
  }
  return true;
}

function writeAgentEnv(agentDir: string, botToken: string, chatId: string): void {
  const envPath = join(agentDir, '.env');
  const content = `BOT_TOKEN=${botToken}\nCHAT_ID=${chatId}\n`;
  writeFileSync(envPath, content, 'utf-8');
  try { chmodSync(envPath, 0o600); } catch { /* ignore on Windows */ }
}

/**
 * Fetch the most recent chat ID for a bot token via getUpdates.
 * Uses spawnSync with array args — no shell, no injection risk.
 * Returns empty string if the fetch fails or no updates exist.
 */
function fetchChatId(botToken: string): string {
  const script = [
    `fetch('https://api.telegram.org/bot' + process.argv[1] + '/getUpdates')`,
    `.then(r => r.json())`,
    `.then(d => { const m = d.result?.slice(-1)[0]?.message; console.log(m?.chat?.id || ''); })`,
    `.catch(() => console.log(''))`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script, botToken], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 10000,
  });
  const id = result.stdout?.trim() ?? '';
  if (id && /^\d+$/.test(id)) {
    console.log(`  Chat ID: ${id}`);
    return id;
  }
  console.log('  Could not auto-detect chat ID.');
  return '';
}

/**
 * Probe a BOT_TOKEN + CHAT_ID pair against the live Telegram API before
 * writing the .env to disk. Interactively prompts the user to re-enter the
 * chat id on a hard failure (bad_token is not recoverable here — they need
 * to fix the token outside the wizard and re-run setup).
 *
 * Returns the validated chat id (possibly re-entered) on success, or null
 * if the user gave up. Network errors and rate limits print a WARNING and
 * continue with the original chat id — the enable preflight will re-probe
 * once connectivity is restored.
 */
async function validateTelegramCredsInteractive(
  iface: Interface,
  botToken: string,
  initialChatId: string,
  label: string,
): Promise<string | null> {
  let chatId = initialChatId;
  // Allow up to 3 re-entry attempts before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    const api = new TelegramAPI(botToken);
    let result;
    try {
      result = await api.validateCredentials(chatId);
    } catch (err) {
      console.log(`  Warning: Telegram validator crashed: ${err instanceof Error ? err.message : String(err)}. Writing .env anyway.`);
      return chatId;
    }

    if (result.ok) {
      const titleHint = result.chatTitle ? ` (${result.chatTitle})` : '';
      console.log(`  Validated ${label}: bot=@${result.botUsername} chat=${chatId} type=${result.chatType}${titleHint}`);
      return chatId;
    }

    if (result.reason === 'network_error' || result.reason === 'rate_limited') {
      console.log(`  Warning: ${formatValidateError(result)}`);
      console.log('  Writing .env with unvalidated values. Re-run cortextos enable later to confirm.');
      return chatId;
    }

    console.log(`  Validation failed: ${formatValidateError(result)}`);

    if (result.reason === 'bad_token') {
      // Can't recover from a bad token inside the wizard loop — the user
      // needs to fix the token at @BotFather and re-run setup. Bail.
      console.log('  Re-run cortextos setup after fixing the bot token.');
      return null;
    }

    const answer = await ask(iface, `  Enter a different chat_id for ${label} (or blank to give up): `);
    if (!answer) {
      console.log('  Giving up on validation. No .env will be written for this agent.');
      return null;
    }
    chatId = answer;
  }
  console.log(`  Too many failed attempts — giving up on ${label}.`);
  return null;
}

function validateAgentName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

function validateOrgName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

function findProjectRoot(): string {
  // Prefer CTX_FRAMEWORK_ROOT if set (running inside cortextOS session)
  if (process.env.CTX_FRAMEWORK_ROOT && existsSync(join(process.env.CTX_FRAMEWORK_ROOT, 'dist', 'cli.js'))) {
    return process.env.CTX_FRAMEWORK_ROOT;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'dist', 'cli.js'))) return cwd;
  // Walk up to find package.json with cortextos name
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const { name } = JSON.parse(require('fs').readFileSync(pkg, 'utf-8'));
        if (name === 'cortextos' && existsSync(join(dir, 'dist', 'cli.js'))) return dir;
      } catch { /* ignore */ }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export const setupCommand = new Command('setup')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Interactive first-run setup wizard — install, create org, configure agents, start daemon')
  .action(async (options: { instance: string }) => {
    const instanceId = options.instance;
    const projectRoot = findProjectRoot();
    const ctxRoot = join(homedir(), '.cortextos', instanceId);

    const iface = rl();

    console.log('\n  Welcome to cortextOS setup\n');
    console.log('  This wizard will:');
    console.log('    1. Check and install dependencies');
    console.log('    2. Create your organization');
    console.log('    3. Configure your orchestrator agent');
    console.log('    4. Optionally add more agents');
    console.log('    5. Start the system\n');
    console.log('  Press Ctrl+C at any time to exit.\n');
    console.log('  ─────────────────────────────────────\n');

    // ─── Step 1: Install ─────────────────────────────────────────────────────

    console.log('  Step 1: Checking dependencies and creating state directories...\n');
    const installOk = runCli(projectRoot, ['install', '--instance', instanceId], 'cortextos install');
    if (!installOk) {
      console.error('\n  Install step failed. Fix the errors above and re-run cortextos setup.');
      iface.close();
      process.exit(1);
    }

    // ─── Step 2: Org name ────────────────────────────────────────────────────

    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Step 2: Create your organization\n');
    console.log('  This is the name for your team or project (e.g. "acme", "myco", "demo").');
    console.log('  Lowercase letters, numbers, hyphens, and underscores only.\n');

    let orgName = '';
    while (true) {
      orgName = await askRequired(iface, '  Organization name: ', 'Organization name cannot be empty.');
      if (!validateOrgName(orgName)) {
        console.log('  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.');
        continue;
      }
      break;
    }

    const initOk = runCli(projectRoot, ['init', orgName, '--instance', instanceId], 'cortextos init');
    if (!initOk) {
      console.error('\n  Org creation failed. Fix the errors above and re-run cortextos setup.');
      iface.close();
      process.exit(1);
    }

    // ─── Step 3: Orchestrator agent ──────────────────────────────────────────

    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Step 3: Create your orchestrator agent\n');
    console.log('  The orchestrator coordinates all other agents, routes messages,');
    console.log('  and sends you morning/evening briefings via Telegram.\n');
    console.log('  You need a Telegram bot token. Create one via @BotFather on Telegram:');
    console.log('    1. Open Telegram, search @BotFather');
    console.log('    2. Send /newbot, follow the prompts');
    console.log('    3. Copy the token it gives you (looks like 123456789:AAA...)\n');

    let orchName = '';
    while (true) {
      orchName = await askDefault(iface, '  Orchestrator agent name', 'boss');
      if (!validateAgentName(orchName)) {
        console.log('  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.');
        continue;
      }
      break;
    }

    const orchToken = await askRequired(
      iface,
      '  Orchestrator bot token (from @BotFather): ',
      'Bot token is required.'
    );

    console.log('\n  Now send a message to your new bot in Telegram (any message).');
    console.log('  This lets us fetch your chat ID.\n');
    await ask(iface, '  Press Enter when done...');

    let orchChatId = '';
    console.log('\n  Fetching your chat ID...');
    orchChatId = fetchChatId(orchToken);

    if (!orchChatId) {
      orchChatId = await askRequired(iface, '  Enter your Telegram chat ID manually: ', 'Chat ID is required.');
    }

    // self-chat trap preflight: validate credentials against the live Telegram API
    // BEFORE writing .env. Catches bad tokens, unreachable chats, bot
    // recipients, and the self_chat trap (CHAT_ID == bot's own user id).
    const validatedOrchChatId = await validateTelegramCredsInteractive(
      iface,
      orchToken,
      orchChatId,
      `orchestrator ${orchName}`,
    );
    if (!validatedOrchChatId) {
      console.error('\n  Cannot continue without validated orchestrator credentials.');
      iface.close();
      process.exit(1);
    }
    orchChatId = validatedOrchChatId;

    // Create orchestrator agent
    const addOrchOk = runCli(
      projectRoot,
      ['add-agent', orchName, '--template', 'orchestrator', '--org', orgName, '--instance', instanceId],
      'cortextos add-agent orchestrator'
    );
    if (!addOrchOk) {
      console.error('\n  Failed to create orchestrator agent.');
      iface.close();
      process.exit(1);
    }

    // Write .env
    const orchDir = join(projectRoot, 'orgs', orgName, 'agents', orchName);
    writeAgentEnv(orchDir, orchToken, orchChatId);
    console.log(`  Wrote .env for ${orchName}`);

    // Enable orchestrator
    const enableOrchOk = runCli(
      projectRoot,
      ['enable', orchName, '--org', orgName, '--instance', instanceId],
      'cortextos enable orchestrator'
    );
    if (!enableOrchOk) {
      console.error(`\n  Failed to enable ${orchName}. Check .env and try: cortextos enable ${orchName}`);
    }

    // ─── Step 4: Additional agents ───────────────────────────────────────────

    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Step 4: Add more agents (optional)\n');
    console.log('  Common additions:');
    console.log('    - analyst: reviews data, generates reports');
    console.log('    - agent: general-purpose specialist\n');

    const addedAgents: string[] = [orchName];

    while (true) {
      const addMore = await askYN(iface, '  Add another agent?', false);
      if (!addMore) break;

      let agentName = '';
      while (true) {
        agentName = await askRequired(iface, '  Agent name: ', 'Agent name is required.');
        if (!validateAgentName(agentName)) {
          console.log('  Invalid name. Use lowercase letters, numbers, hyphens, and underscores only.');
          continue;
        }
        if (addedAgents.includes(agentName)) {
          console.log(`  Agent "${agentName}" already added.`);
          continue;
        }
        break;
      }

      const templateChoices = ['orchestrator', 'analyst', 'agent'];
      let template = await askDefault(iface, `  Template for ${agentName} (orchestrator/analyst/agent)`, 'agent');
      if (!templateChoices.includes(template)) template = 'agent';

      console.log(`\n  Create a Telegram bot for ${agentName} via @BotFather, then enter its token.\n`);
      const agentToken = await askRequired(iface, `  Bot token for ${agentName}: `, 'Bot token is required.');

      console.log(`\n  Send a message to the ${agentName} bot in Telegram, then press Enter.`);
      await ask(iface, '  Press Enter when done...');

      let agentChatId = '';
      agentChatId = fetchChatId(agentToken);

      if (!agentChatId) {
        agentChatId = await askRequired(iface, `  Enter chat ID for ${agentName} manually: `, 'Chat ID is required.');
      }

      // self-chat trap preflight (see validateTelegramCredsInteractive above).
      const validatedAgentChatId = await validateTelegramCredsInteractive(
        iface,
        agentToken,
        agentChatId,
        `agent ${agentName}`,
      );
      if (!validatedAgentChatId) {
        console.log(`  Skipping ${agentName} — fix the credentials and re-run cortextos setup or cortextos enable ${agentName}.`);
        continue;
      }
      agentChatId = validatedAgentChatId;

      const addOk = runCli(
        projectRoot,
        ['add-agent', agentName, '--template', template, '--org', orgName, '--instance', instanceId],
        `cortextos add-agent ${agentName}`
      );

      if (addOk) {
        const agentDir = join(projectRoot, 'orgs', orgName, 'agents', agentName);
        writeAgentEnv(agentDir, agentToken, agentChatId);
        console.log(`  Wrote .env for ${agentName}`);

        runCli(projectRoot, ['enable', agentName, '--org', orgName, '--instance', instanceId], `enable ${agentName}`);
        addedAgents.push(agentName);
      }
    }

    // ─── Step 5: Ecosystem + start ───────────────────────────────────────────

    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Step 5: Generating ecosystem config and starting daemon...\n');

    const ecoEnv = { ...process.env, CTX_INSTANCE_ID: instanceId, CTX_ORG: orgName };
    const ecoResult = spawnSync(process.execPath, [join(projectRoot, 'dist', 'cli.js'), 'ecosystem', '--instance', instanceId], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: ecoEnv,
    });

    if (ecoResult.status !== 0) {
      console.error('  Failed to generate ecosystem config. Run manually: cortextos ecosystem');
    } else {
      // Try PM2 start
      const pm2Result = spawnSync('pm2', ['start', 'ecosystem.config.js'], {
        cwd: projectRoot,
        stdio: 'inherit',
      });
      if (pm2Result.status === 0) {
        spawnSync('pm2', ['save'], { cwd: projectRoot, stdio: 'inherit' });
        console.log('\n  Daemon started via PM2.');
      } else {
        // Fallback: cortextos start
        runCli(projectRoot, ['start', '--instance', instanceId], 'cortextos start');
      }
    }

    // ─── Done ─────────────────────────────────────────────────────────────────

    iface.close();

    console.log('\n  ─────────────────────────────────────\n');
    console.log('  Setup complete!\n');
    console.log(`  Organization: ${orgName}`);
    console.log(`  Agents: ${addedAgents.join(', ')}`);
    console.log(`  State: ${ctxRoot}\n`);
    console.log('  Next steps:');
    console.log('    - Check agent status: cortextos status');
    console.log('    - Start dashboard:    cortextos dashboard');
    console.log('    - View PM2 logs:      pm2 logs');
    console.log('    - Talk to your agent via Telegram!\n');
  });
