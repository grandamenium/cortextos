#!/usr/bin/env node
// Monitor multiple Gmail accounts for new unread business emails (30 min cron)
// atlas@ TIS inbox is handled separately by check-atlas-inbox.js
// Argus runs a 4h priority scan on all accounts; forge is the 30-min tripwire for time-sensitive items
// Silent exit if nothing new; Telegram alert per account with new messages
'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');
const CORTEXTOS_CLI = path.resolve(__dirname, '../../../../../dist/cli.js');
const gmail = require('./gmail-lib');
const { classifyEmail } = require('./classify-email');

// Label config: token file → label name → label ID (created by setup-gmail-labels.js)
const LABEL_CONFIG_PATH = path.join(__dirname, '../label-config.json');
let labelConfig = {};
try { labelConfig = JSON.parse(fs.readFileSync(LABEL_CONFIG_PATH, 'utf8')); } catch { /* labels not set up yet */ }

function getLabelId(tokenFile, labelName) {
  return (labelConfig[tokenFile] || {})[labelName] || null;
}

const CHAT_ID = process.env.CTX_TELEGRAM_CHAT_ID || '8993058901';

// Inbox digest file — read by the dashboard for priority inbox widget
const CTX_ROOT = process.env.CTX_ROOT || path.join(require('os').homedir(), '.cortextos', 'default');
const DIGEST_FILE = path.join(CTX_ROOT, 'state', 'data', 'inbox-digest.json');
const DIGEST_MAX = 50; // keep last 50 flagged emails

// Sent-alerts dedup — tracks message IDs already routed to agents (24h TTL)
const SENT_ALERTS_FILE = path.join(CTX_ROOT, 'state', 'data', 'inbox-sent-alerts.json');
function loadSentAlerts() {
  try {
    const data = JSON.parse(fs.readFileSync(SENT_ALERTS_FILE, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return Object.fromEntries(Object.entries(data).filter(([, ts]) => ts > cutoff));
  } catch { return {}; }
}
function markAlertSent(messageId) {
  const data = loadSentAlerts();
  data[messageId] = Date.now();
  try {
    fs.mkdirSync(path.dirname(SENT_ALERTS_FILE), { recursive: true });
    fs.writeFileSync(SENT_ALERTS_FILE, JSON.stringify(data));
  } catch { /* non-fatal */ }
}
function wasAlertSent(messageId) {
  if (!messageId) return false;
  return !!loadSentAlerts()[messageId];
}
const _sentAlertsCache = loadSentAlerts(); // load once per process

function loadDigest() {
  try { return JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8')); }
  catch { return []; }
}

function saveDigest(items) {
  try {
    fs.mkdirSync(path.dirname(DIGEST_FILE), { recursive: true });
    fs.writeFileSync(DIGEST_FILE, JSON.stringify(items.slice(0, DIGEST_MAX), null, 2));
  } catch { /* non-fatal */ }
}

function appendToDigest(account, flaggedItems) {
  if (!flaggedItems.length) return;
  const existing = loadDigest();
  const now = new Date().toISOString();
  const newEntries = flaggedItems.map(it => ({
    account,
    from: it.from,
    subject: it.subject,
    snippet: it.snippet || '',
    body: it.body || it.snippet || '',
    category: it.category || null,
    isDeal: !!it.isDeal,
    flaggedAt: now,
    messageId: it.messageId || null,
    threadId: it.threadId || null,
    tokenFile: it.tokenFile || null,
  }));
  // Dedup by subject+account — remove any older entries for same email
  const deduped = existing.filter(e =>
    !newEntries.some(n => n.account === e.account && n.subject === e.subject)
  );
  saveDigest([...newEntries, ...deduped]);
}

// Account mapping (from argus coordination 2026-06-04):
// gmail_tokens     → jennifer.l.breitbach@gmail.com (personal)
// gmail_tis        → jennifer.breitbach@total-investment-solutions.com (TIS workspace — atlas@ alias, handled separately)
// gmail_tis4u      → tisolutions4you@gmail.com (TIS business Gmail)
// gmail_jb1979     → jbreitbach1979@gmail.com
// gmail_jordanreyes→ jennifer@jordanreyes.me
// gmail_ahr        → jennifer@americahomerestoration.com
// gmail_tt23       → texastimber23@gmail.com
// gmail_wti        → watchthis.illinois@gmail.com

const BUSINESS_QUERY = 'is:unread -in:sent -category:promotions -category:social -category:updates -category:forums newer_than:2d';

const ACCOUNTS = [
  { file: 'gmail_tokens.json',         label: 'Personal',         query: BUSINESS_QUERY, max: 5 },
  // gmail_tis_tokens.json = atlas@TIS alias — handled exclusively by check-atlas-inbox.js to prevent duplicate relays
  { file: 'gmail_tis4u_tokens.json',   label: 'TIS Business',     query: 'is:unread -in:sent newer_than:2d', max: 5 },
  { file: 'gmail_ilp_tokens.json',     label: 'ILP',              query: 'is:unread -label:ForgeAlerted newer_than:2d', max: 5, alertLabel: 'ForgeAlerted' },
  { file: 'gmail_jb1979_tokens.json',  label: 'JB1979',           query: 'is:unread -label:ForgeAlerted newer_than:2d', max: 5, alertLabel: 'ForgeAlerted' },
  { file: 'gmail_jordanreyes_tokens.json', label: 'Jordan Reyes', query: 'is:unread -label:ForgeAlerted newer_than:2d', max: 5, alertLabel: 'ForgeAlerted' },
  { file: 'gmail_ahr_tokens.json',     label: 'AHR',              query: 'is:unread -in:sent newer_than:7d', max: 5 },
  { file: 'gmail_tt23_tokens.json',    label: 'Texas Timber',     query: 'is:unread -in:sent newer_than:2d', max: 5 },
  { file: 'gmail_wti_tokens.json',     label: 'WATCH THIS LLC',   query: 'is:unread -in:sent newer_than:7d', max: 5 },
];

// High-priority senders/subjects to always flag to Argus
const DEAL_KEYWORDS = /crawford|greg cole|keith mendosa|loi|letter of intent|offer|contract|closing|purchase agreement|earnest|junietha|shambee|rei chicago|oscar|polk|ted sanders|ted@americahomerestoration/i;

// Senders/patterns to suppress silently (mark read, no Telegram alert)
const SUPPRESS_SENDERS = /aa\.com|@aa\.com|americanairlines\.com|@americanairlines\.|@delta\.com|@united\.com|@southwest\.com|@jetblue\.com|@spirit\.com|@alaskaair\.com|@alerts\.aa\.com|@email\.aa\.com|@news\.aa\.com|resnexus\.com|communications@resnexus|shutterstock\.com|emktng\.shutterstock|frommilitarytomillionaire\.com|iheart\.com|sofi\.com|gobrightline\.com|tymobeauty\.com|rodanandfields\.com|nuuly\.com|depop\.com|expedia\.com|tripadvisor\.com|turo\.com|benchmade\.com|jostens\.com|salliemae\.com|lendingclub\.com|shakeshack\.com|@e\.upgrade\.com|ebay\.com|alltrails\.com|aausports\.org|purefrequencies\.com|moneylion\.com|gainrepmail\.com|aurahealth\.io|youversion\.com|notarize\.com|@(email|close)\.close\.com|tasks\.clickup\.com|attio\.com|@attio\.|bluehorizon-realestate\.com|arturo@bluehorizon|newwestern\.com|@newwestern\.|@fyxer\.com|hostcamp\.com|@hostcamp\.|askforfunding\.com|@askforfunding\.|rocketlawyer\.com|@rocketlawyer\.|uber\.com|@uber\.|@h5\.hilton\.com|hilton\.com|zenbusiness\.com|@zenbusiness\.|capstoneconnectors\.com|@capstoneconnectors\.|remitly\.com|@remitly\.|info\.remitly|ablink\.info\.rem|invoice\+statements@make\.com|celonis\.com|taxact\.com|@taxact\.|360onlineprint\.com|@360onlineprint\.|constantcontact\.com|mailchimp\.com|klaviyo\.com|substack\.com|beehiiv\.com|convertkit\.com|mnatsakanian|toptiertc\.com|@toptiertc\.|top\.tier\.tc|airdna\.co|@airdna\.|kajabimail\.net|kajabi\.com|rentperfect\.com|@rentperfect\.|rehablend\.com|@rehablend\.|cara\.lee@|caralee@|homecare.*coach|homecarecoach|chatarv\.com|@chatarv\.|jenn.*billat|jennbillat|billat.*legacy|owners.*club.*legacy|certaintyinc\.com|@certaintyinc\.|marshall.*sylver|sylver.*marshall|skool\.com|@skool\.|greatwithmoney@m\.relayfi\.com|greatwithmoney@/i;

// Subject patterns that are always marketing/noise regardless of sender — suppress
const SUPPRESS_SUBJECTS = /trending posts|trending near|trending in your area|trending around|best.*around butte|best.*around.*billings|\bchallenge\b.*register|you.re not registered|don.t miss.*challenge|join.*challenge|all abilities challenge|on track for (next|your) (tax|season)|product (has )?shipped|your order (has )?shipped|your (package|shipment) (is |has )?shipped|built for solo.*agency.*scale|which one.s you|webinar.*register|register.*webinar|free training|free masterclass|free workshop|join us (live|online|virtually)|replay.*available|watch the replay|limited.*seats|seats.*limited|early.bird|special (offer|discount|price)|% off (today|now|this week)|flash sale|last chance|ends (tonight|tomorrow|soon)|deal of the day|promo code|coupon inside|LIVE NOW:|live now:|bonus.*underwriting|underwriting.*bonus|market.*(shifted|favor)|shifted.*favor|collect rent without|close in \d+ (business )?(days?|weeks?)|dscr (from|as low as|at) \d|hard money (lender|loan|available|fast)|private (money|lender|lending) (available|offer|solution)|we('re)? (fund|lending)|can fund your (deal|flip|project|rehab)|asset.based lend|no income.*verif|quick (close|fund)|fast close|close fast|fix.?and.?flip loan|rental (loan|financing) offer|bridge (loan|lender|funding) (offer|available|fast)|daily deal|deals o.clock|o.clock deal|super promo|300\+ resources|reintroduc.*myself|build your legacy|build.*legacy.*coaching|owners club|big goals.*event|events? happening tomorrow|events? this week.*community|skool.*event|community.*event.*tomorrow/i;

// Jennifer's own email addresses — used to detect self-sent calendar invites
const JENNIFER_EMAILS = /jennifer\.l\.breitbach@gmail|jennifer\.breitbach@total-investment|jennifer@jordanreyes|jennifer@americahome|jbreitbach1979@gmail/i;
// Senders that are suppressed UNLESS subject indicates a real transaction
const SUPPRESS_UNLESS_TRANSACTIONAL = /hiltongrandvacations\.com|hgv@|make\.com|info@make\.com|godaddy\.com|@godaddy/i;
const TRANSACTIONAL_KEYWORDS = /reservation|confirmation|booking|check.in|check.out|receipt|invoice|itinerary|your stay|your trip|cancell|affiliate.*commission|affiliate.*payment|affiliate.*earning|affiliate.*program.*welcome|affiliate.*approved|domain.*expir|expir.*domain|renew.*domain|domain.*renew|expire/i;

// Senders that always pass through regardless of other rules (operational platforms)
const ALWAYS_ALERT_SENDERS = /turbotenant\.com|ashley\.deloney|@doorloop\.|@docusign\.|@hellosign\.|jess\.pacheco|jesspacheco/i;

// Subject patterns that always surface regardless of sender — legal/transactional/money signals
const ALWAYS_ALERT_SUBJECTS = /signature requested|new lease agreement|please sign|docusign|e-sign|esign|sign and return|action required.*sign|lease.*sign|sign.*lease|countersign|invoice|payment received|payment due|payment failed|past due|balance due|amount due|wire transfer|ach transfer|rent paid|rent due|deposit received|earnest money|closing cost|funds received|commission|check enclosed|check attached|you.*paid|your.*payment|bill.*due|overdue|refund|reimburs/i;

// Known real counterparties — always pass regardless of subject match.
// A subject match from a whitelisted sender is NEVER suppressed (a real lender/attorney
// can legitimately use phrases like "DSCR", "fund your deal", "close in 2 weeks").
const SENDER_WHITELIST = /dahae|rok\.financial|rokfinancial|billingsrealtybrokers\.com|kathy@billings|initialrentals\.com|@sitewire\.|sitewire\.com|beartooth|tamara\.jensen|tammy\.jensen|gilbertresilientrealty|carlinresilientrealty|marchlarkin|marlo@serenity|marlo@tonyandmarlo|nancy.*hanson@|@doorloop\.|@turbotenant\.|rufus.*peace|integrity.*first|juneitha|shambee|@kultivate|@culturalrealty|mnatsakanian|ashley\.deloney|ashautoaz|jesspacheco|cathi@elitetax|sivartak|noreply@mail\.hellosign/i;

// Senders to auto-forward to a specific address (pattern -> email)
const FORWARD_RULES = [
  { pattern: /businessprofile-noreply@google\.com|google.*business.*profile/i, to: 'jordan@jordanreyes.me', label: 'Google Business Profile' },
];

// Senders/subjects to route to Ledger agent via cortextos bus send-message.
// Split into specific (domain-anchored) and generic (keyword) patterns.
// Generic patterns require LEDGER_FINANCIAL_SENDER to also match the from-field
// so that e.g. Grace Fellowship "account statement" emails don't trigger Ledger routing.
const LEDGER_SPECIFIC_PATTERNS = [
  /relay\.co|relayfi\.com|relay financial/i,        // Relay bank statements
  /statement.*meadowlark|meadowlark.*statement/i,   // Meadowlark statements
  /homedepot\.com|home.*depot/i,                    // Home Depot billing statements
  /madisontrust\.com/i,                              // Madison Trust IRA custodian
  /donotreply@.*trust|donotreply@.*custodian|donotreply@.*ira|noreply@.*trust|noreply@.*custodian/i, // IRA/custodian notices
];
// Generic keyword patterns — fail closed: only route when sender looks like a financial institution
const LEDGER_GENERIC_PATTERNS = [
  /bank.*statement|account.*statement/i,             // General bank statements
];
// Sender must match one of these to clear the fail-closed gate on generic patterns
const LEDGER_FINANCIAL_SENDER = /\bbank\b|bancorp|credit.?union|firstinterstate|wellsfargo|us.?bank|stockman|threadbank|relayfi|@relay\.|homedepot|madisontrust|@trust\.|custodian/i;
// Relay/Ledger subjects that are marketing/feature emails — skip Ledger routing for these
const LEDGER_RELAY_SKIP = /new feature|now available|introducing|we.ve added|product update|feature announcement|surcharging|invoices feature|premium.*feature|feature.*premium|marketing|newsletter|announcement|update.*plan|plan.*update|requesting your payment details|payment details|growth.loop|register.*payment|payment.*register|daily deal|deals o.clock|o.clock deal|special offer|% off|promo|coupon|flash sale|pro xtra|perks.*savings|savings.*perks|view your perks/i;

// Newsletter/automated senders — only alert if content is relevant
const NEWSLETTER_SENDERS = /neighborhoodalerts\.com|zillow\.com|realtor\.com|loopnet|crexi|newsletter|noreply|no-reply|digest|weekly.*update|monthly.*update|nextdoor\.com|padsplit\.com|padsplit|alignable\.com|engage\.canva\.com/i;

// Topics relevant to Jennifer's current work (for newsletter relevance check)
const RELEVANT_TOPICS = /coliving|co-living|rv park|mobile home|mhp|sober living|community housing|billings|montana|idaho|twin falls|butte|columbus|1031|subject.to|subto|creative finance|deal flow|buy box|acquisition|wholesale|dispo|real estate|housing|for rent|for sale|landlord|tenant|property|rental|foreclosure|eviction|rehab|investor|investment property/i;

function shouldAlert(from, subject, body, headers) {
  // Always alert for operational property management platforms + VIP senders
  if (ALWAYS_ALERT_SENDERS.test(from)) return 'alert';

  // Always alert for legal/transactional subject patterns (e-sign, lease, signature requests)
  if (ALWAYS_ALERT_SUBJECTS.test(subject)) return 'alert';

  // Suppress bulk mailers detected via email headers (lender broadcasts, social digests, newsletters)
  // List-Unsubscribe presence = bulk ESP. Precedence: bulk|list = mailing list.
  // Exception: whitelisted senders (real counterparties) pass through regardless.
  if (headers && !SENDER_WHITELIST.test(from) && !ALWAYS_ALERT_SENDERS.test(from)) {
    const listUnsub = getHeader(headers, 'list-unsubscribe');
    const precedence = getHeader(headers, 'precedence');
    if (listUnsub || /\b(bulk|list)\b/i.test(precedence)) return 'suppress';
  }

  // Suppress self-sent calendar invites for Jennifer's own recurring events
  if (/co-living office hours|coliving office hours/i.test(subject) && JENNIFER_EMAILS.test(from)) return 'suppress';

  // Always suppress known marketing/noise senders
  if (SUPPRESS_SENDERS.test(from)) return 'suppress';

  // Suppress marketing noise by subject pattern — but NEVER suppress a whitelisted sender.
  // Real counterparties (lenders, attorneys, partners) can legitimately use phrases that
  // match cold-blast patterns ("DSCR", "fund your deal", "close in 2 weeks").
  if (!SENDER_WHITELIST.test(from) && SUPPRESS_SUBJECTS.test(subject)) return 'suppress';

  // Suppress promotional emails from these senders, but pass through real reservations/receipts
  if (SUPPRESS_UNLESS_TRANSACTIONAL.test(from)) {
    return TRANSACTIONAL_KEYWORDS.test(subject) ? 'alert' : 'suppress';
  }

  // Neighborhood alerts → route to argus for buy box scoring
  if (/neighborhoodalerts\.com/i.test(from)) return 'argus';

  // Suppress Zillow/Realtor algo recommendation emails — these are never deal leads
  // "A Butte home for you", "Homes you may like", "Based on your search" etc.
  if (/zillow\.com|realtor\.com/i.test(from) &&
      /home[s]? for you|homes? you may like|based on your search|recommended for you|homes? we think you|rentals? we think you|you might like|similar home|homes? like this|\d+ rentals? (we|you|near|in)/i.test(subject)) {
    return 'suppress';
  }

  // Newsletter check — only alert if relevant content
  if (NEWSLETTER_SENDERS.test(from)) {
    const content = subject + ' ' + body;
    if (RELEVANT_TOPICS.test(content)) return 'alert';
    return 'suppress';
  }

  return 'alert';
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractAttachments(payload) {
  const results = [];
  function walk(p) {
    if (p.filename && p.filename.length > 0 && p.body?.attachmentId) {
      results.push({ filename: p.filename, mimeType: p.mimeType || 'application/octet-stream', sizeKb: Math.round((p.body.size || 0) / 1024) });
    }
    (p.parts || []).forEach(walk);
  }
  if (payload) walk(payload);
  return results;
}

function decodeBody(payload) {
  function findPart(parts, mime) {
    if (!parts) return null;
    for (const p of parts) {
      if (p.mimeType === mime && p.body?.data) return p.body.data;
      const found = findPart(p.parts, mime);
      if (found) return found;
    }
    return null;
  }
  let data = null;
  if (payload?.mimeType === 'text/plain' && payload.body?.data) data = payload.body.data;
  else data = findPart(payload?.parts, 'text/plain');
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf8').slice(0, 300);
}

// Load bot token once
function getBotToken() {
  try {
    const env = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
    const match = env.match(/^BOT_TOKEN=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch { return null; }
}
const BOT_TOKEN = getBotToken();

function sendTelegram(message) {
  // Route to Atlas, not directly to Jennifer (No Direct Jennifer Telegram guardrail)
  spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-message', 'atlas', 'normal', `[check-business-inboxes] ${message}`.slice(0, 1200)],
    { encoding: 'utf8', timeout: 15000 });
}

function notifyAgent(agent, priority, subject, from, account, category) {
  const msg = `[${category}] email in ${account}: From: ${from} | Subject: ${subject}`;
  spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-message', agent, priority, msg.slice(0, 1200)],
    { encoding: 'utf8', timeout: 10000 });
}

function busAtlas(message) {
  spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-message', 'atlas', 'normal', message.slice(0, 1200)],
    { encoding: 'utf8', timeout: 10000 });
}

function notifyArgus(subject, from, account) {
  notifyAgent('argus', 'high', subject, from, account, 'Deal');
}

// Route category-based agent notifications
function routeByCategory(category, subject, from, account) {
  switch (category) {
    case 'Deals':
      notifyAgent('argus', 'high', subject, from, account, 'Deals');
      break;
    case 'Property-Alerts':
      notifyAgent('argus', 'normal', subject, from, account, 'Property-Alert');
      break;
    case 'Lenders':
    case 'Legal-Filing':
    case 'Meetings':
    case 'Tenants':
      notifyAgent('atlas', 'normal', subject, from, account, category);
      break;
    case 'Contractors':
    case 'Quotes':
      notifyAgent('atlas', 'normal', subject, from, account, category);
      break;
    case 'Bills':
    case 'Invoices':
    case 'Banking':
      notifyAgent('atlas', 'normal', subject, from, account, category);
      break;
  }
}

const BLINQ_INVITE_BODY = [
  'Hi {FIRST_NAME},',
  '',
  'So great connecting with you! I would love to find a time to chat.',
  '',
  'Feel free to grab a 15-minute spot on my calendar:',
  'https://api.leadconnectorhq.com/widget/bookings/jenniferbreitbach/meet',
  '',
  'Looking forward to it!',
  '',
  'Jennifer Breitbach',
  'Total Investment Solutions',
].join('\n');

function extractFyxerText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n').replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}

async function handleFyxerNote(file, messageId, full, accountLabel) {
  const headers = full.payload?.headers || [];
  const subject = getHeader(headers, 'subject');
  // Skip meeting prep emails — only process completed note emails
  if (/\bprep\b/i.test(subject)) return false;

  function getHtml(p) {
    if (p.mimeType === 'text/html' && p.body?.data)
      return Buffer.from(p.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (p.parts) for (const x of p.parts) { const r = getHtml(x); if (r) return r; }
    return '';
  }
  const html = getHtml(full.payload);
  const text = html ? extractFyxerText(html) : '';
  if (!text || text.length < 100) return false;

  const summary = text.slice(0, 2000);
  const msg = `[Fyxer meeting note] ${subject} | ${summary.replace(/\n/g, ' | ')}`;
  spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-message', 'atlas', 'normal', msg.slice(0, 800)],
    { encoding: 'utf8', timeout: 10000 });

  await gmail.markRead(file, messageId).catch(() => {});
  const category = classifyEmail('', subject, 'meeting notes action items');
  console.log(`Fyxer note relayed to Atlas (${accountLabel}): ${subject}`);
  return true;
}

async function handleBlinqNotification(file, messageId, full) {
  const headers = full.payload?.headers || [];
  const from = getHeader(headers, 'from');
  const subject = getHeader(headers, 'subject');
  const msgId = getHeader(headers, 'message-id');

  // Extract first name from subject: "🎉 Person Name received your Blinq card"
  const nameMatch = subject.match(/🎉 (.+?) received/i);
  if (!nameMatch) return false;
  const firstName = nameMatch[1].split(' ')[0];

  // Extract relay email from From header: "Person via Blinq <connect+...@mail-relay.blinq.me>"
  const relayMatch = from.match(/<([^>]+@mail-relay\.blinq\.me)>/);
  if (!relayMatch) return false;
  const relayEmail = relayMatch[1];

  const body = BLINQ_INVITE_BODY.replace('{FIRST_NAME}', firstName);
  const res = await gmail.sendReply(file, relayEmail, 'Great connecting!', body, full.threadId, msgId);

  if (res.id) {
    console.log(`Blinq auto-invite sent to ${nameMatch[1]} (${res.id})`);
  } else {
    console.error(`Blinq invite failed for ${nameMatch[1]}:`, JSON.stringify(res).slice(0, 200));
  }

  await gmail.markRead(file, messageId).catch(() => {});
  await gmail.archiveMessage(file, messageId).catch(() => {});
  return true;
}

async function checkAccount(account) {
  const { file, label, query, max, alertLabel } = account;
  try {
    const messages = await gmail.listMessages(file, query, max);
    if (!messages.messages || messages.messages.length === 0) return;

    const items = [];
    for (const m of messages.messages.slice(0, 3)) {
      const full = await gmail.getMessage(file, m.id);
      const headers = full.payload?.headers || [];
      const from = getHeader(headers, 'from');
      const subject = getHeader(headers, 'subject');
      const fullBody = decodeBody(full.payload);
      const snippet = fullBody.slice(0, 150);
      const body = fullBody.slice(0, 8000);
      const attachments = extractAttachments(full.payload);
      const isDeal = DEAL_KEYWORDS.test(from + ' ' + subject);
      const action = shouldAlert(from, subject, snippet, headers);

      // Route bank/Relay statements to Ledger (skip marketing/feature announcement emails).
      // Specific patterns (domain-anchored) match freely on from or subject.
      // Generic patterns (keyword-only) require the sender to look like a financial institution
      // so that e.g. Grace Fellowship "account statement" emails fail closed.
      const specificLedgerMatch = LEDGER_SPECIFIC_PATTERNS.some(p => p.test(from) || p.test(subject));
      const genericLedgerMatch = LEDGER_GENERIC_PATTERNS.some(p => p.test(from) || p.test(subject))
        && LEDGER_FINANCIAL_SENDER.test(from);
      const isLedgerEmail = (specificLedgerMatch || genericLedgerMatch)
        && !LEDGER_RELAY_SKIP.test(subject);
      if (isLedgerEmail) {
        const attInfo = attachments.length > 0
          ? ` | Attachments: ${attachments.length} — ${attachments.map(a => `${a.filename} (${a.mimeType}, ${a.sizeKb}kb)`).join(', ')}`
          : ' | Attachments: none';
        const msg = `Bank/statement email received (${label}): From: ${from} | Subject: ${subject} | Preview: ${snippet}${attInfo}`;
        spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-message', 'ledger', 'normal', msg.slice(0, 1200)], { stdio: 'inherit' });
        if (alertLabel) {
          const alertLabelId = getLabelId(file, alertLabel);
          if (alertLabelId) await gmail.applyLabel(file, m.id, alertLabelId).catch(() => {});
        }
        console.log(`Routed to Ledger (${label}): ${subject}`);
        continue;
      }

      // Auto-forward emails matching FORWARD_RULES to designated addresses
      const fwdRule = FORWARD_RULES.find(r => r.pattern.test(from));
      if (fwdRule) {
        const fwdBody = `Fwd from ${from}:\nSubject: ${subject}\n\n${snippet}`;
        await gmail.sendEmail(file, fwdRule.to, `Fwd: ${subject}`, fwdBody).catch(() => {});
        await gmail.markRead(file, m.id);
        await gmail.archiveMessage(file, m.id).catch(() => {});
        console.log(`Forwarded (${label}): ${subject} → ${fwdRule.to}`);
        continue;
      }

      // Auto-send meeting invite when someone receives Jennifer's Blinq card
      if (/mail-relay\.blinq\.me/i.test(from) && /received your blinq card/i.test(subject)) {
        await handleBlinqNotification(file, m.id, full);
        continue;
      }

      // Relay Fyxer meeting notes to Atlas for KB ingestion
      if (/notetaker@fyxer\.com/i.test(from)) {
        await handleFyxerNote(file, m.id, full, label);
        continue;
      }

      if (action === 'suppress') {
        console.log(`Suppressed (${label}): ${subject}`);
        if (alertLabel) {
          // Don't mark read or archive — just label so it's excluded next run
          const alertLabelId = getLabelId(file, alertLabel);
          if (alertLabelId) await gmail.applyLabel(file, m.id, alertLabelId).catch(() => {});
        } else {
          await gmail.markRead(file, m.id);
          await gmail.archiveMessage(file, m.id).catch(() => {});
        }
        continue;
      }

      // Classify and apply label + archive if matched
      const category = classifyEmail(from, subject, snippet);
      if (category) {
        const labelId = getLabelId(file, category);
        if (labelId) {
          await gmail.applyLabel(file, m.id, labelId).catch(() => {});
        }
        if (!alertLabel) {
          // Archive: remove from inbox — email lives under its label only
          await gmail.archiveMessage(file, m.id).catch(() => {});
        }

        // Route to agents based on category — skip if already sent (dedup guard)
        if (action === 'argus' || category === 'Property-Alerts') {
          if (!wasAlertSent(m.id) && !_sentAlertsCache[m.id]) {
            routeByCategory(category || 'Property-Alerts', subject, from, label);
            markAlertSent(m.id); _sentAlertsCache[m.id] = Date.now();
          }
          console.log(`Labeled+archived (${label}): [${category}] ${subject}`);
          if (alertLabel) {
            const alertLabelId = getLabelId(file, alertLabel);
            if (alertLabelId) {
              await gmail.applyLabel(file, m.id, alertLabelId).catch(() => {});
            } else {
              // alertLabel not yet created in Gmail — fall back to markRead to prevent re-alerting
              await gmail.markRead(file, m.id).catch(() => {});
            }
          } else {
            await gmail.markRead(file, m.id);
          }
          continue;
        }
        if (!wasAlertSent(m.id) && !_sentAlertsCache[m.id]) {
          routeByCategory(category, subject, from, label);
          markAlertSent(m.id); _sentAlertsCache[m.id] = Date.now();
        }
      } else if (action === 'argus') {
        if (!wasAlertSent(m.id) && !_sentAlertsCache[m.id]) {
          notifyArgus(subject, from, label + '/neighborhood-alert');
          markAlertSent(m.id); _sentAlertsCache[m.id] = Date.now();
        }
        console.log(`Labeled+archived (${label}): [neighborhood-alert] ${subject}`);
        if (alertLabel) {
          const alertLabelId = getLabelId(file, alertLabel);
          if (alertLabelId) {
            await gmail.applyLabel(file, m.id, alertLabelId).catch(() => {});
          } else {
            await gmail.markRead(file, m.id).catch(() => {});
          }
        } else {
          await gmail.archiveMessage(file, m.id).catch(() => {});
          await gmail.markRead(file, m.id);
        }
        continue;
      }
      // Unclassified emails stay in inbox for Jennifer's attention

      if (isDeal && category !== 'Deals' && !wasAlertSent(m.id) && !_sentAlertsCache[m.id]) {
        notifyArgus(subject, from, label);
        markAlertSent(m.id); _sentAlertsCache[m.id] = Date.now();
      }
      if (!wasAlertSent(m.id) && !_sentAlertsCache[m.id]) {
        items.push({ from, subject, snippet, body, isDeal, category, attachments, messageId: m.id, threadId: full.threadId || m.id, tokenFile: file });
      }
      if (alertLabel) {
        // Don't mark read — apply label so we know we've alerted (inbox owner manages read state)
        const alertLabelId = getLabelId(file, alertLabel);
        if (alertLabelId) await gmail.applyLabel(file, m.id, alertLabelId).catch(() => {});
      } else {
        await gmail.markRead(file, m.id); // mark read after alerting — prevents re-alerting every 30 min
      }
    }

    if (items.length === 0) return;
    const more = messages.messages.length > 3 ? ` +${messages.messages.length - 3} more` : '';
    let msg = `*${label}${more ? ` (${items.length} shown${more})` : ` — ${items.length} new email${items.length > 1 ? 's' : ''}`}*\n`;
    for (const it of items) {
      // Extract display name only — strip <email@address> part
      const senderName = it.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || it.from;
      // Clean subject — strip quotes, trim to 70 chars
      const subject = it.subject.replace(/^["']|["']$/g, '').slice(0, 70);
      const subjectDisplay = it.subject.length > 70 ? subject + '…' : subject;
      // Build bullet
      msg += `• *${senderName}* — "${subjectDisplay}"`;
      if (it.category) msg += ` _(${it.category})_`;
      if (it.isDeal) msg += ` ⚡`;
      msg += '\n';
      // Attachment line — always present so absence is never ambiguous
      const attLine = it.attachments && it.attachments.length > 0
        ? `  📎 ${it.attachments.map(a => `${a.filename} (${a.mimeType}, ${a.sizeKb}kb)`).join(', ')}`
        : '  📎 none';
      msg += attLine + '\n';
      // Show snippet only for real business emails (not newsletters/marketing)
      if (it.snippet && !it.category) {
        const clean = it.snippet
          .replace(/&[a-z]+;|&#[0-9]+;/gi, '') // HTML entities (&zwnj; &nbsp; etc)
          .replace(/[​-‏­﻿‌‍​-‏­﻿]/g, '') // invisible chars
          .replace(/\s{2,}/g, ' ')
          .replace(/^\s+|\s+$/g, '')
          .slice(0, 100);
        if (clean.length > 20) msg += `  _${clean}${it.snippet.length > 100 ? '…' : ''}_\n`;
      }
    }
    busAtlas(msg.trim());
    appendToDigest(label, items);
    // Mark all alerted items as sent so they don't re-surface next run
    for (const it of items) {
      if (it.messageId) { markAlertSent(it.messageId); _sentAlertsCache[it.messageId] = Date.now(); }
    }
    console.log(`${label}: ${messages.messages.length} new email(s)`);
  } catch (e) {
    if (e.message?.includes('invalid_grant') || e.message?.includes('Token refresh failed')) {
      console.log(`${label} (${file}): auth error — skipping`);
    } else {
      console.error(`${label} (${file}): ${e.message}`);
    }
  }
}

async function main() {
  for (const account of ACCOUNTS) {
    await checkAccount(account);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
