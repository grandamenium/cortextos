import { chromium } from 'playwright';
const HOST = 'further-successful-commit-ellen.trycloudflare.com';
const IP = '104.16.231.132';
const url = `https://${HOST}/`;
const b = await chromium.launch({
  headless: true,
  args: [`--host-resolver-rules=MAP ${HOST} ${IP}`],
});
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
const log = [];
p.on('response', r => log.push(`${r.status()} ${r.url()}`));
try {
  const resp = await p.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);
  console.log(`top_status=${resp ? resp.status() : 'null'} final_url=${p.url()}`);
  console.log(`title="${await p.title()}"`);
  await p.screenshot({ path: '/tmp/qa-tunnel.png', fullPage: false });
  console.log('screenshot=/tmp/qa-tunnel.png');
  const bodyText = (await p.locator('body').innerText().catch(()=>'')).slice(0, 400);
  console.log(`bodyText=${JSON.stringify(bodyText)}`);
} catch (e) {
  console.error(`ERR ${e.message}`);
}
console.log('--- net log (first 15) ---');
log.slice(0, 15).forEach(l => console.log(l));
await b.close();
