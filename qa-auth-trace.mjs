import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();

const events = [];
p.on('request', r => events.push(`REQ ${r.method()} ${r.url()}`));
p.on('response', async (r) => {
  let loc = '';
  try { loc = r.headers()['location'] || ''; } catch {}
  events.push(`RES ${r.status()} ${r.url()}${loc ? ' → ' + loc : ''}`);
});

await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(3000);
events.push('--- form submit ---');
await p.fill('input[name="username"], input[type="text"]', 'clicktoacquire');
await p.fill('input[name="password"], input[type="password"]', 'clicktoacquire123!!');
await p.click('button:has-text("Sign In")');
await p.waitForTimeout(5000);
console.log(`final_url=${p.url()}`);
console.log('--- events (auth+post only) ---');
events.filter(e => e.includes('auth') || e.includes('---') || e.includes('login')).forEach(e => console.log(e));
await b.close();
