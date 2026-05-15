import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

// Test 1: credentials 'same-origin' (form's actual code)
const t1 = await p.evaluate(async () => {
  const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const csrf = (await csrfRes.json()).csrfToken;
  const body = new URLSearchParams();
  body.set('csrfToken', csrf);
  body.set('username', 'clicktoacquire');
  body.set('password', 'clicktoacquire123!!');
  const res = await fetch('https://further-successful-commit-ellen.trycloudflare.com/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'same-origin',
    redirect: 'follow',
  });
  return { final: res.url, status: res.status, redirected: res.redirected };
});
console.log('same-origin:', JSON.stringify(t1));
await b.close();
