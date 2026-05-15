import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
const reqs = [];
p.on('request', r => { if (r.url().includes('/api/auth') || r.method() === 'POST') reqs.push(`REQ ${r.method()} ${r.url()}`); });
p.on('response', r => { if (r.url().includes('/api/auth') || r.request().method() === 'POST') reqs.push(`RES ${r.status()} ${r.url()}`); });
p.on('requestfailed', r => reqs.push(`FAIL ${r.method()} ${r.url()} -- ${r.failure()?.errorText}`));
try {
  await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
  await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
  await p.click('button:has-text("Sign In")');
  await p.waitForTimeout(5000);
  console.log(`final_url=${p.url()}`);
} catch (e) { console.error(`ERR ${e.message}`); }
console.log('--- auth requests ---');
reqs.forEach(r => console.log(r));
await b.close();
