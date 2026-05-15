import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let postResp = null;
p.on('response', r => { if (r.url().includes('/api/auth/callback/credentials')) postResp = { status: r.status(), location: r.headers()['location'] }; });
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const result = await p.evaluate(async () => {
  // Get full cookie value
  const cookies = document.cookie;
  // __Host- cookies are httpOnly so not in document.cookie; fetch from /api/auth/csrf
  const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const csrfTokenShort = (await csrfRes.json()).csrfToken;
  // Try sending csrfToken with |hash too (we can't know hash from client side easily)
  // Just try the regular token but with credentials: 'include' explicitly
  const body = new URLSearchParams({ csrfToken: csrfTokenShort, username: 'clicktoacquire', password: 'clicktoacquire123!!' });
  const res = await fetch('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'include',  // explicit include
    redirect: 'follow',
  });
  return { final: res.url, status: res.status, redirected: res.redirected };
});
console.log('result:', JSON.stringify(result));
const cookies = await ctx.cookies();
console.log('session_cookie_after:', cookies.some(c => c.name.includes('session-token')));
await b.close();
