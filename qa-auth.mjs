import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({
  headless: true,
  args: [`--host-resolver-rules=MAP ${HOST} ${IP}`],
});
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
try {
  await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500); // let csrf useEffect complete
  await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
  await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
  await Promise.all([
    p.waitForURL(u => !u.toString().includes('/login') || u.toString().includes('error='), { timeout: 25000 }).catch(()=>{}),
    p.click('button:has-text("Sign In")'),
  ]);
  await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
  await p.waitForTimeout(3000);
  console.log(`final_url=${p.url()}`);
  console.log(`title="${await p.title()}"`);
  await p.screenshot({ path: '/tmp/qa-dashboard.png', fullPage: false });
  console.log('screenshot=/tmp/qa-dashboard.png');
  const bodyText = (await p.locator('body').innerText().catch(()=>'')).slice(0, 800);
  console.log(`bodyText=${JSON.stringify(bodyText)}`);
} catch (e) {
  console.error(`ERR ${e.message}`);
}
await b.close();
