import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForFunction(() => {
  const btn = document.querySelector('button[type="submit"]');
  return btn && !btn.disabled;
}, null, { timeout: 15000 });
await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button[type="submit"]');
await p.waitForTimeout(8000);
console.log('after_submit_url:', p.url());
// Force navigate to root if still on login
if (p.url().includes('/login')) {
  await p.goto(`https://${HOST}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
}
console.log('final_url:', p.url());
console.log('title:', await p.title());
await p.screenshot({ path: '/tmp/qa-dashboard-auth.png', fullPage: false });
const bodyText = (await p.locator('body').innerText().catch(()=>'')).slice(0, 800);
console.log('body sample:', JSON.stringify(bodyText));
await b.close();
