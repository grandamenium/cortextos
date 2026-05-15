import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();

// Capture POST body
let postBody = null;
p.on('request', async (r) => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    postBody = r.postData();
  }
});

await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);  // give plenty time

// Verify CSRF cookie exists before submit
const cookies = await ctx.cookies();
const csrfCookie = cookies.find(c => c.name.includes('csrf'));
console.log('csrf_cookie_present:', !!csrfCookie, 'name:', csrfCookie?.name);

await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(4000);

console.log('post_body:', postBody);
const csrfFromBody = postBody?.match(/csrfToken=([^&]+)/)?.[1];
console.log('csrf_from_body_len:', csrfFromBody?.length);
console.log('csrf_from_body:', csrfFromBody?.slice(0, 30) + '...');

const cookies2 = await ctx.cookies();
console.log('session_cookie_after:', cookies2.some(c => c.name.includes('session-token')));
await b.close();
