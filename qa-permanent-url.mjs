import { chromium } from 'playwright';
const URL = 'https://dashboard.clicktoacquire.com';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  ignoreHTTPSErrors: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});
const p = await ctx.newPage();

let postResp = null;
p.on('response', r => {
  if (r.url().includes('/api/auth/callback/credentials')) {
    postResp = { status: r.status(), location: r.headers()['location'] };
  }
});
p.on('console', msg => console.log('[console]', msg.type(), msg.text().slice(0, 200)));

await p.goto(`${URL}/login`, { waitUntil: 'networkidle' });
await p.waitForFunction(() => {
  const btn = document.querySelector('button[type="submit"]');
  return btn && !btn.disabled;
}, null, { timeout: 15000 });
console.log('button enabled — csrfReady=true');

// Dump cookies BEFORE submit
const beforeCookies = await ctx.cookies();
console.log('cookies_before_submit:', beforeCookies.map(c => `${c.name}=${c.value.slice(0,20)}...(domain=${c.domain},secure=${c.secure},httpOnly=${c.httpOnly})`).join('\n  '));

await p.fill('input[name="username"]', 'clicktoacquire');
await p.fill('input[name="password"]', 'clicktoacquire123!!');
await p.click('button[type="submit"]');
await p.waitForTimeout(5000);

console.log('postResp:', JSON.stringify(postResp));
console.log('final_url:', p.url());
const after = await ctx.cookies();
console.log('cookies_after_submit:', after.map(c => `${c.name}=${c.value.slice(0,20)}...(secure=${c.secure})`).join('\n  '));
console.log('session_token_set:', after.some(c => c.name.includes('session-token')));
const body = await p.locator('body').innerText().catch(()=>'');
console.log('body_error:', /Sign-in failed|MissingCSRF|Network error/.test(body) ? (body.match(/Sign-in failed[^\n]*|Network error[^\n]*/)?.[0] || 'unknown') : 'no_error');
await b.close();
