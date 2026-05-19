import { test, expect } from '@playwright/test';

const JWT = process.env.JWT!;

test('AC-H17 keyboard CTA', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ Authorization: `Bearer ${JWT}` });
  await page.goto('http://localhost:3100/');
  const cta = page.locator('[data-testid="decision-row-0"] [data-testid="decision-cta"]').first();
  await cta.focus();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  expect(focused).toBe('decision-cta');
  const [response] = await Promise.all([
    page.waitForResponse((response) => /\/(approve|review|triage|pr|tasks|github)/i.test(response.url()), { timeout: 3_000 }),
    page.keyboard.press('Enter'),
  ]);
  expect(response.status()).toBeLessThan(500);
});
