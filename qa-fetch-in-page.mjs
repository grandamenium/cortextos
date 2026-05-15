import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let postResp = null;
p.on('response', r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    postResp = { status: r.status(), url: r.url(), location: r.headers()['location'] || null };
  }
});
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const result = await p.evaluate(async () => {
  const csrfRes = await fetch('/api/auth/csrf', { credentials: 'include' });
  const csrf = (await csrfRes.json()).csrfToken;
  const body = new URLSearchParams();
  body.set('csrfToken', csrf);
  body.set('username', 'clicktoacquire');
  body.set('password', 'clicktoacquire123!!');
  const res = await fetch('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    credentials: 'include',
  });
  return { final_url: res.url, status: res.status, redirected: res.redirected };
});
console.log(JSON.stringify(result));
console.log('post_response:', JSON.stringify(postResp));
const cookiesAfter = await ctx.cookies();
console.log('session_cookie_present:', cookiesAfter.some(c => c.name.includes('session-token')));
await b.close();
