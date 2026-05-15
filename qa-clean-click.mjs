import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let postResp = null;
let postReqHeaders = null;
let postReqBody = null;
p.on('request', r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    postReqHeaders = r.headers();
    postReqBody = r.postData();
  }
});
p.on('response', r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    postResp = { status: r.status(), location: r.headers()['location'] };
  }
});
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);
await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(4500);
console.log('postResp:', JSON.stringify(postResp));
console.log('postReqHeaders.referer:', postReqHeaders?.referer);
console.log('postReqHeaders["content-type"]:', postReqHeaders?.['content-type']);
console.log('postReqHeaders.cookie present:', !!postReqHeaders?.cookie);
console.log('cookie keys:', postReqHeaders?.cookie?.split(';').map(c=>c.trim().split('=')[0]).join(','));
console.log('body:', postReqBody);
await b.close();
