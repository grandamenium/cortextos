import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const b = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${HOST} ${IP}`] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto(`https://${HOST}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
const action = await p.evaluate(() => {
  const form = document.querySelector('form');
  return { action: form?.action, hrefBase: document.location.origin };
});
console.log(JSON.stringify(action));
await b.close();
