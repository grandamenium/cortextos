/**
 * Guarded LinkedIn login CLI
 *
 * Run on an approved Orgo/Codex-CU browser lane to seed a fresh Chrome profile
 * with a LinkedIn session, validate it, then rsync to the Linux poster server.
 * macOS execution is blocked unless an explicit approved Mac fallback sets
 * ALLOW_MAC_BROWSER_AUTOMATION=1 and ORGO_FAILURE_ARTIFACT.
 *
 * Usage:
 *   npx tsx src/login-cli.ts --user greg --server <poster-server-ssh>
 *
 * Requirements:
 *   - Node >= 20
 *   - playwright (already in devDependencies)
 *   - rsync (pre-installed on macOS)
 *   - SSH access to the server via the alias/IP
 */

import { chromium } from 'playwright';
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function arg(flag: string, required = true): string {
  const idx = process.argv.indexOf(flag);
  const val = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (required && !val) {
    console.error(`Missing required flag: ${flag}`);
    process.exit(1);
  }
  return val ?? '';
}

const userId = arg('--user');
const server = arg('--server');
const remoteBase = arg('--remote-base', false) || '/var/lib/linkedin-poster/profiles';

const localTempDir = join(tmpdir(), `poster-login-${userId}`);
const remoteDir = `${remoteBase}/${userId}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;
const AUTHED_SELECTOR = '[data-control-name="identity_profile_photo"], .global-nav__me-photo, .feed-identity-module';
const TIMEOUT_MS = 5 * 60_000; // 5 min for user to complete login + 2FA

function log(msg: string) {
  console.log(`[login-cli] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.platform === 'darwin' && (
    process.env.ALLOW_MAC_BROWSER_AUTOMATION !== '1' || !process.env.ORGO_FAILURE_ARTIFACT
  )) {
    throw new Error('LinkedIn login CLI is Orgo/Codex-CU by default and is blocked on macOS. Set ALLOW_MAC_BROWSER_AUTOMATION=1 and ORGO_FAILURE_ARTIFACT only for an approved Mac fallback.');
  }

  // Clean up any previous temp run
  if (existsSync(localTempDir)) {
    log(`Cleaning previous temp profile: ${localTempDir}`);
    rmSync(localTempDir, { recursive: true, force: true });
  }
  mkdirSync(localTempDir, { recursive: true, mode: 0o700 });
  log(`Temp profile dir: ${localTempDir}`);

  log('Launching headed browser — log in to LinkedIn in the window that opens.');
  const context = await chromium.launchPersistentContext(localTempDir, {
    headless: false, // must be headed so Greg can interact
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 900 },
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  log('Navigating to LinkedIn login page...');
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });

  // ------------------------------------------------------------------
  // Wait for successful login (poll every 3 s, up to TIMEOUT_MS)
  // ------------------------------------------------------------------
  log(`Waiting up to ${TIMEOUT_MS / 1000}s for login + 2FA to complete...`);
  const deadline = Date.now() + TIMEOUT_MS;
  let authenticated = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);

    const url = page.url();
    const title = await page.title().catch(() => '');

    // Still on auth flow? Keep waiting.
    if (LOGIN_PATTERN.test(url) || LOGIN_PATTERN.test(title)) {
      process.stdout.write('.');
      continue;
    }

    // Navigated away — check for authed element
    try {
      await page.waitForSelector(AUTHED_SELECTOR, { timeout: 5_000 });
      authenticated = true;
      break;
    } catch {
      // Page changed but authed element not found yet (e.g. 2FA page)
      process.stdout.write('?');
    }
  }

  console.log(''); // newline after dots

  if (!authenticated) {
    console.error('[login-cli] Timed out waiting for authentication. Aborting.');
    await context.close();
    cleanupTemp();
    process.exit(1);
  }

  log('Login detected. Validating session by visiting feed...');

  // ------------------------------------------------------------------
  // Feed validation — confirm authed state with a real page load
  // ------------------------------------------------------------------
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
  } catch (err) {
    console.error('[login-cli] Feed load timed out:', (err as Error).message.split('\n')[0]);
  }

  const feedTitle = await page.title().catch(() => '');
  if (LOGIN_PATTERN.test(feedTitle)) {
    console.error(`[login-cli] Feed title suggests not logged in: "${feedTitle}". Aborting.`);
    await context.close();
    cleanupTemp();
    process.exit(1);
  }

  // Check for at least one authed DOM element
  const authedEl = await page.$(AUTHED_SELECTOR).catch(() => null);
  if (!authedEl) {
    // Soft warn — LinkedIn structure may vary; don't abort if feed title is clean
    log('WARNING: Could not find authed element selector — proceeding with title-only validation.');
  }

  log(`Feed title: "${feedTitle}" — session looks valid.`);

  // ------------------------------------------------------------------
  // Close browser cleanly (flush profile to disk)
  // ------------------------------------------------------------------
  log('Closing browser to flush profile state to disk...');
  await context.close();
  await new Promise((r) => setTimeout(r, 1_000)); // let OS finish writes

  // ------------------------------------------------------------------
  // Ensure remote directory exists (first-run sudo note)
  // ------------------------------------------------------------------
  log(`Ensuring remote directory exists: ${server}:${remoteDir}`);
  const mkdirResult = spawnSync(
    'ssh',
    [server, `mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`],
    { stdio: 'inherit' }
  );
  if (mkdirResult.status !== 0) {
    console.error('[login-cli] Could not create remote directory. If first run, you may need:');
    console.error(`  ssh ${server} "sudo mkdir -p ${remoteDir} && sudo chown $USER:$USER ${remoteBase}"`);
    console.error('Then re-run this command.');
    cleanupTemp();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // rsync profile to server
  // ------------------------------------------------------------------
  log(`Rsyncing profile to ${server}:${remoteDir} ...`);
  const rsyncResult = spawnSync(
    'rsync',
    [
      '-av',
      '--delete',
      `${localTempDir}/`,
      `${server}:${remoteDir}/`,
    ],
    { stdio: 'inherit' }
  );

  if (rsyncResult.status !== 0) {
    console.error('[login-cli] rsync failed. Profile NOT uploaded.');
    cleanupTemp();
    process.exit(1);
  }

  log('Profile uploaded successfully.');
  log(`Server path: ${remoteDir}`);
  log('You can now start the poster service with:');
  log(`  PROFILE_DIR=${remoteDir} USER_ID=${userId} npm start`);

  cleanupTemp();
}

function cleanupTemp() {
  try {
    rmSync(localTempDir, { recursive: true, force: true });
    log(`Cleaned up temp dir: ${localTempDir}`);
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error('[login-cli] Fatal:', err);
  process.exit(1);
});
