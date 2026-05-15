import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let formHeaders = null;
let evalHeaders = null;
let n = 0;
p.on('request', r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    n++;
    if (n === 1) formHeaders = r.headers();
    else if (n === 2) evalHeaders = r.headers();
  }
});
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

// Path 1: form click
await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(3000);

// Path 2: direct fetch (simulating the working path)
await p.evaluate(async () => {
  const csrf = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()).csrfToken;
  const body = new URLSearchParams({ csrfToken: csrf, username: 'clicktoacquire', password: 'clicktoacquire123!!' });
  await fetch('https://further-successful-commit-ellen.trycloudflare.com/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });
});

console.log('=== FORM CLICK headers ===');
console.log(JSON.stringify(formHeaders, null, 2));
console.log('=== DIRECT FETCH headers ===');
console.log(JSON.stringify(evalHeaders, null, 2));
await b.close();
