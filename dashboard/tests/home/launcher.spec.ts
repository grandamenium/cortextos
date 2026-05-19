import { test, expect } from '@playwright/test';

const JWT = process.env.JWT!;

test('AC-H10 skill prefill', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ Authorization: `Bearer ${JWT}` });
  await page.goto('http://localhost:3100/');
  await page.click('[data-testid="launcher-skill-graphify"]');
  await expect(page.locator('[data-testid="launcher-input"]')).toHaveValue(/^\/graphify/);
});
