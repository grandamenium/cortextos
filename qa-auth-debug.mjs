import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();

let csrfBody = null;
p.on('request', async (req) => {
  if (req.url().includes('/api/auth/callback/credentials')) {
    csrfBody = req.postData();
  }
});

await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(3000);

const cookiesBeforeSubmit = await ctx.cookies();
console.log('--- cookies before submit ---');
cookiesBeforeSubmit.forEach(c => console.log(`${c.name}=${c.value.slice(0,40)}... domain=${c.domain} secure=${c.secure} sameSite=${c.sameSite}`));

const csrfFromJs = await p.evaluate(async () => {
  const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const d = await r.json();
  return { token: d.csrfToken?.slice(0, 30), setCookie: r.headers.get('set-cookie') };
});
console.log('--- /api/auth/csrf result ---');
console.log(JSON.stringify(csrfFromJs));

await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(4000);
console.log('--- POST body ---');
console.log(csrfBody);
console.log('--- cookies after submit ---');
const cookiesAfter = await ctx.cookies();
cookiesAfter.forEach(c => console.log(`${c.name}=${c.value.slice(0,40)}... domain=${c.domain}`));

await b.close();
