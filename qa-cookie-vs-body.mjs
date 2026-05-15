import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let postBody = null;
p.on('request', r => { if (r.url().includes('/api/auth/callback/credentials')) postBody = r.postData(); });
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);

// Snapshot just before click
const cookiesBefore = await ctx.cookies();
const csrfCookie = cookiesBefore.find(c => c.name.includes('csrf'));
const cookieTokenPart = csrfCookie.value.split('%7C')[0];

await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(2000);

const bodyToken = postBody?.match(/csrfToken=([^&]+)/)?.[1];
console.log('cookie_token_part:', cookieTokenPart);
console.log('body_token       :', bodyToken);
console.log('match:', cookieTokenPart === bodyToken);

// Also check the cookie at the moment of POST request
const cookiesAtPost = await ctx.cookies();
const csrfAtPost = cookiesAtPost.find(c => c.name.includes('csrf'));
const cookieAtPostTokenPart = csrfAtPost.value.split('%7C')[0];
console.log('cookie_at_post   :', cookieAtPostTokenPart);
console.log('match_at_post:', cookieAtPostTokenPart === bodyToken);

await b.close();
