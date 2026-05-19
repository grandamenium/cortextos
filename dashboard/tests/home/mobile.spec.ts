import { test, expect } from '@playwright/test';

const JWT = process.env.JWT!;

test('AC-H19 no horizontal scroll', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ Authorization: `Bearer ${JWT}` });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('http://localhost:3100/');
  const metrics = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollW).toBe(metrics.clientW);
});
