const {listMessages, getMessage} = require('./orgs/atlasos/agents/forge/scripts/gmail-lib.js');

const TOKENS = [
  'gmail_tokens.json',
  'gmail_jordanreyes_tokens.json',
  'gmail_jb1979_tokens.json',
  'gmail_tis_tokens.json',
  'gmail_ahr_tokens.json',
  'gmail_wti_tokens.json',
  'gmail_tis4u_tokens.json',
  'gmail_tt23_tokens.json',
];

const ACCOUNT_NAMES = {
  'gmail_tokens.json': 'JLB',
  'gmail_jordanreyes_tokens.json': 'JORDANREYES',
  'gmail_jb1979_tokens.json': 'JB1979',
  'gmail_tis_tokens.json': 'TIS',
  'gmail_ahr_tokens.json': 'AHR',
  'gmail_wti_tokens.json': 'WTI',
  'gmail_tis4u_tokens.json': 'TIS4U',
  'gmail_tt23_tokens.json': 'TT23',
};

// Jun 20 2026 unix timestamp
const AFTER_JUN20 = 1750377600;

async function searchOne(token, query, label) {
  try {
    const msgs = await listMessages(token, query);
    if (!msgs || msgs.length === 0) return [];
    const results = [];
    for (const m of msgs.slice(0, 5)) {
      const detail = await getMessage(token, m.id);
      const hdrs = detail.payload.headers;
      const from = (hdrs.find(h => h.name === 'From') || {}).value || '';
      const subj = (hdrs.find(h => h.name === 'Subject') || {}).value || '';
      const date = (hdrs.find(h => h.name === 'Date') || {}).value || '';
      const snippet = (detail.snippet || '').substring(0, 300);
      results.push({ account: label, msgId: m.id, from, subj, date, snippet });
    }
    return results;
  } catch (e) {
    return [];
  }
}

function dedup(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = r.account + ':' + r.msgId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  // === DENNY ===
  console.log('=== DENNY ELECTRIC (after Jun 20 2026) ===');
  const dennyQueries = [
    `from:d.dennyelectric@gmail.com after:${AFTER_JUN20}`,
    `"Denny Electric" after:${AFTER_JUN20}`,
    `"David Denny" invoice after:${AFTER_JUN20}`,
    `from:intuit.com "Denny" after:${AFTER_JUN20}`,
  ];
  const dennyHits = [];
  for (const token of TOKENS) {
    const acct = ACCOUNT_NAMES[token];
    for (const q of dennyQueries) {
      const hits = await searchOne(token, q, acct);
      for (const h of hits) dennyHits.push(h);
    }
  }
  const uniqueDenny = dedup(dennyHits);
  if (uniqueDenny.length === 0) {
    console.log('NO RESULTS');
  } else {
    for (const r of uniqueDenny) {
      console.log(`\n[${r.account} / ${r.msgId}]`);
      console.log(`FROM: ${r.from}`);
      console.log(`SUBJECT: ${r.subj}`);
      console.log(`DATE: ${r.date}`);
      console.log(`SNIPPET: ${r.snippet}`);
    }
  }

  // === PPF LOAN ===
  console.log('\n=== PARK PLACE FINANCE / ZARELDA LOAN ===');
  const ppfQueries = [
    '"Park Place Finance"',
    '"Byron Farrior"',
    '"parkplaceus" "Zarelda"',
    '"1502052"',
    'from:parkplaceus.com',
    '"promissory note" "Zarelda"',
    '"loan agreement" "Zarelda"',
  ];
  const ppfHits = [];
  for (const token of TOKENS) {
    const acct = ACCOUNT_NAMES[token];
    for (const q of ppfQueries) {
      const hits = await searchOne(token, q, acct);
      for (const h of hits) ppfHits.push(h);
    }
  }
  const uniquePPF = dedup(ppfHits);
  if (uniquePPF.length === 0) {
    console.log('NO RESULTS');
  } else {
    for (const r of uniquePPF) {
      console.log(`\n[${r.account} / ${r.msgId}]`);
      console.log(`FROM: ${r.from}`);
      console.log(`SUBJECT: ${r.subj}`);
      console.log(`DATE: ${r.date}`);
      console.log(`SNIPPET: ${r.snippet}`);
    }
  }

  // === LAUREL $130K WIRE ===
  console.log('\n=== LAUREL $130K WIRE CONFIRMATION ===');
  const laurelQueries = [
    '"Laurel" "wire"',
    '"123 Laurel"',
    '"W Laurel" "San Antonio"',
    '"Laurel" "San Antonio" "transfer"',
    '"80,000" "Laurel"',
    '"50,000" "Laurel"',
    '"80000" "Laurel"',
    '"50000" "Laurel"',
    '"JB Investment Trust" "wire"',
    '"JB Investment Trust" "Laurel"',
    '"Impact Living" "wire" "Laurel"',
    '"Impact Living" "Laurel"',
  ];
  const laurelHits = [];
  for (const token of TOKENS) {
    const acct = ACCOUNT_NAMES[token];
    for (const q of laurelQueries) {
      const hits = await searchOne(token, q, acct);
      for (const h of hits) laurelHits.push(h);
    }
  }
  const uniqueLaurel = dedup(laurelHits);
  if (uniqueLaurel.length === 0) {
    console.log('NO RESULTS');
  } else {
    for (const r of uniqueLaurel) {
      console.log(`\n[${r.account} / ${r.msgId}]`);
      console.log(`FROM: ${r.from}`);
      console.log(`SUBJECT: ${r.subj}`);
      console.log(`DATE: ${r.date}`);
      console.log(`SNIPPET: ${r.snippet}`);
    }
  }

  console.log('\nSweep UTC:', new Date().toISOString());
  console.log('Mailboxes swept: JLB, JORDANREYES, JB1979, TIS, AHR, WTI, TIS4U, TT23');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
