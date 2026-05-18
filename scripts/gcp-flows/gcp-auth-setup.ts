#!/usr/bin/env node

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(SCRIPT_DIR, '.auth');
const STORAGE_STATE = path.join(AUTH_DIR, 'google-session.json');
const CONSOLE_URL = 'https://console.cloud.google.com/';

async function hasGoogleAuthCookies(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies(['https://accounts.google.com', CONSOLE_URL]);
  const authCookieNames = new Set(['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);
  return cookies.some((cookie) => authCookieNames.has(cookie.name));
}

async function waitForConsoleLogin(page: Page): Promise<void> {
  const timeoutAt = Date.now() + 15 * 60 * 1000;

  while (Date.now() < timeoutAt) {
    const currentUrl = page.url();

    if (currentUrl.startsWith(CONSOLE_URL) && await hasGoogleAuthCookies(page)) {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return;
    }

    await page.waitForTimeout(2_000);
  }

  throw new Error('Timed out waiting for Google Cloud Console login');
}

async function main(): Promise<void> {
  if (process.platform === 'darwin' && (
    process.env.ALLOW_MAC_BROWSER_AUTOMATION !== '1' || !process.env.ORGO_FAILURE_ARTIFACT
  )) {
    throw new Error('GCP auth browser setup is Orgo/Codex-CU by default and is blocked on macOS. Set ALLOW_MAC_BROWSER_AUTOMATION=1 and ORGO_FAILURE_ARTIFACT only for an approved Mac fallback.');
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('Opening Google Cloud Console. Complete Google login in the browser window.');
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForConsoleLogin(page);
    await page.context().storageState({ path: STORAGE_STATE });
    console.log(`Google session saved to ${STORAGE_STATE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
