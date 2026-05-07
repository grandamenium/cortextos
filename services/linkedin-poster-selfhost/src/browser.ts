import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, chmodSync, existsSync } from 'fs';
import { execFile } from 'child_process';
import type { PosterConfig } from './types.js';

const LOGIN_PATTERN = /log.?in|sign.?in|authwall/i;

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: PosterConfig;

  constructor(config: PosterConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (!existsSync(this.config.profileDir)) {
      console.log(`[browser] Profile dir not found — creating: ${this.config.profileDir}`);
      mkdirSync(this.config.profileDir, { recursive: true });
      chmodSync(this.config.profileDir, 0o700);
      console.log('[browser] WARNING: Profile not seeded yet. Run: cortextos bus poster-selfhost login --user <name>');
    }

    console.log(`[browser] Launching persistent context: ${this.config.profileDir}`);
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: { width: 1280, height: 900 },
    });

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    console.log('[browser] Persistent context ready');
  }

  getPage(): Page {
    if (!this.page) throw new Error('BrowserManager not initialized — call init() first');
    return this.page;
  }

  async checkHealth(): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      const title = await this.page.title();
      const healthy = !LOGIN_PATTERN.test(title);
      if (!healthy) {
        console.error(`[browser] Session expired — page title: "${title}"`);
      }
      return healthy;
    } catch (err) {
      console.error('[browser] Health check failed:', (err as Error).message.split('\n')[0]);
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
        this.context = null;
        this.page = null;
      }
    } catch (err) {
      console.error('[browser] Error closing context:', (err as Error).message);
    }

    // Kill any lingering Chromium processes that had this profile open
    const profileDir = this.config.profileDir;
    execFile('pkill', ['-f', profileDir], () => {
      // Ignore errors — process may already be gone
    });
  }
}
