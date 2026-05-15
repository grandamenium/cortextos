import { chromium } from 'playwright';
const URL = 'https://dashboard.clicktoacquire.com';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();

p.on('request', req => {
  if (req.url().includes('/api/auth/callback/credentials')) {
    console.log('REQ URL:', req.url());
    console.log('REQ METHOD:', req.method());
    console.log('REQ HEADERS:', JSON.stringify(req.headers(), null, 2));
    console.log('REQ POSTDATA:', req.postData());
  }
});
p.on('response', async r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    console.log('RESP STATUS:', r.status());
    console.log('RESP HEADERS:', JSON.stringify(r.headers(), null, 2));
  }
});

await p.goto(`${URL}/login`, { waitUntil: 'networkidle' });
await p.waitForFunction(() => {
  const btn = document.querySelector('button[type="submit"]');
  return btn && !btn.disabled;
}, null, { timeout: 15000 });

await p.fill('input[name="username"]', 'clicktoacquire');
await p.fill('input[name="password"]', 'clicktoacquire123!!');
await p.click('button[type="submit"]');
await p.waitForTimeout(5000);
await b.close();
