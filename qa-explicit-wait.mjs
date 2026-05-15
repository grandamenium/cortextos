import { chromium } from 'playwright';
const HOST = 'dashboard.clicktoacquire.com';
const IP = '172.67.141.29';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
let postResp = null;
p.on('response', r => { if (r.url().includes('/api/auth/callback/credentials')) postResp = { status: r.status(), location: r.headers()['location'] }; });

p.on('console', msg => console.log('[console]', msg.type(), msg.text()));
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });

// Wait until submit button is ENABLED (csrfReady=true)
await p.waitForFunction(() => {
  const btn = document.querySelector('button[type="submit"]');
  return btn && !btn.disabled;
}, null, { timeout: 15000 });
console.log('submit button enabled — csrfReady=true');

await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');

await p.click('button[type="submit"]');
await p.waitForTimeout(5000);
console.log('postResp:', JSON.stringify(postResp));
console.log('final_url:', p.url());
const cookies = await ctx.cookies();
console.log('session_cookie_after:', cookies.some(c => c.name.includes('session-token')));
const bodyText = await p.locator('body').innerText().catch(()=>'');
console.log('body_error:', /Sign-in failed|MissingCSRF|Network error/.test(bodyText) ? bodyText.match(/Sign-in failed[^\n]*|Network error[^\n]*/)?.[0] : 'no_error');
await b.close();
