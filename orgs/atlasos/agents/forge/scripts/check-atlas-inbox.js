#!/usr/bin/env node
// Poll for new emails to atlas@total-investment-solutions.com — called by cron
// Uses query-based search (no server-side filter needed) + applies AtlasOS-Inbox label
// Silent exit if no new messages; Telegram alert if messages found.
'use strict';

const https = require('https');
const gmail = require('./gmail-lib');
const { spawnSync, execSync } = require('child_process');
const path = require('path');
const { parseForwardedEmail, formatTelegramAlert, IMESSAGE_SUBJECT_RE } = require('./parse-imessage-email');

const TOKEN_FILE = 'gmail_tis_tokens.json';
const ATLAS_EMAIL = 'atlas@total-investment-solutions.com';
const LABEL_NAME = 'AtlasOS-Inbox';

// Known marketing/blast domains — suppress silently (same list as check-business-inboxes.js)
const SUPPRESS_SENDERS = /airdna\.co|@airdna\.|kajabimail\.net|kajabi\.com|rentperfect\.com|@rentperfect\.|rehablend\.com|@rehablend\.|toptiertc\.com|@toptiertc\.|top\.tier\.tc|beehiiv\.com|convertkit\.com|mailchimp\.com|constantcontact\.com|klaviyo\.com|substack\.com|frommilitarytomillionaire\.com|newwestern\.com|@newwestern\.|capstoneconnectors\.com|@capstoneconnectors\.|askforfunding\.com|@askforfunding\.|bluehorizon-realestate\.com|arturo@bluehorizon/i;

// Cold-blast subject patterns — only suppress for non-whitelisted senders
const SUPPRESS_SUBJECTS = /\bLIVE NOW:|bonus.*underwriting|underwriting.*bonus|market.*(shifted|favor)|shifted.*favor|collect rent without|close in \d+ (business )?(days?|weeks?)|dscr (from|as low as|at) \d|hard money (lender|loan|available|fast)|private (money|lender|lending) (available|offer|solution)|we('re)? (fund|lending)|can fund your (deal|flip|project|rehab)|asset.based lend|no income.*verif|quick (close|fund)|fast close|close fast|fix.?and.?flip loan|rental (loan|financing) offer|bridge (loan|lender|funding) (offer|available|fast)|free training|free masterclass|free workshop|webinar.*register|register.*webinar|join us (live|online|virtually)|replay.*available|watch the replay/i;

// Known real counterparties — always pass regardless of subject match
const SENDER_WHITELIST = /dahae|rok\.financial|rokfinancial|billingsrealtybrokers\.com|kathy@billings|initialrentals\.com|@sitewire\.|sitewire\.com|beartooth|tamara\.jensen|tammy\.jensen|gilbertresilientrealty|nancy.*hanson@|@doorloop\.|@turbotenant\.|rufus.*peace|integrity.*first|juneitha|shambee|@kultivate/i;
const CHAT_ID = process.env.CTX_TELEGRAM_CHAT_ID || '8993058901';
const CORTEXTOS_CLI = path.resolve(__dirname, '../../../../../dist/cli.js');
const AUDIO_MIME_TYPES = ['audio/m4a', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4', 'audio/mp4', 'audio/x-m4a'];
const TRANSCRIPTS_DIR = path.join(__dirname, '../transcripts');

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function truncate(str, len = 200) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function decodeBody(payload) {
  // Try to get plain text body
  function findPart(parts, mimeType) {
    if (!parts) return null;
    for (const p of parts) {
      if (p.mimeType === mimeType && p.body?.data) return p.body.data;
      if (p.parts) {
        const found = findPart(p.parts, mimeType);
        if (found) return found;
      }
    }
    return null;
  }

  let data = null;
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    data = payload.body.data;
  } else {
    data = findPart(payload.parts, 'text/plain');
  }
  if (!data) return '';
  return Buffer.from(data, 'base64').toString('utf8');
}

function sendTelegram(message) {
  try {
    spawnSync(process.execPath, [CORTEXTOS_CLI, 'bus', 'send-telegram', CHAT_ID, message], { stdio: 'inherit' });
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

// Route summaries/alerts through Atlas per comms model
function busAtlas(message) {
  try {
    const safe = message.replace(/'/g, "\\'").slice(0, 1200);
    execSync(`cortextos bus send-message atlas normal '${safe}'`, { stdio: 'inherit' });
  } catch (e) {
    console.error('Bus send to Atlas failed:', e.message);
  }
}

async function applyLabel(tokenFile, messageId, labelId) {
  const token = await gmail.getAccessToken(tokenFile);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ['INBOX'] });
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/me/messages/${messageId}/modify`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let out=''; res.on('data', d=>out+=d); res.on('end', () => resolve(JSON.parse(out))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  // Ensure label exists
  const label = await gmail.createLabel(TOKEN_FILE, LABEL_NAME);

  // Query for unread emails sent to the atlas@ address
  const messages = await gmail.listMessages(TOKEN_FILE, `to:${ATLAS_EMAIL} is:unread`, 10);
  if (!messages.messages || messages.messages.length === 0) {
    // No new emails — silent exit
    process.exit(0);
  }

  const summaries = [];
  for (const m of messages.messages.slice(0, 5)) {
    const full = await gmail.getMessage(TOKEN_FILE, m.id);
    const headers = full.payload?.headers || [];
    const from = getHeader(headers, 'from');
    const subject = getHeader(headers, 'subject');
    const date = getHeader(headers, 'date');
    const body = truncate(decodeBody(full.payload), 300);

    // Detect audio attachments for call transcription
    const audioParts = [];
    function findAudioParts(payload) {
      if (AUDIO_MIME_TYPES.includes(payload.mimeType) && payload.body?.attachmentId) {
        audioParts.push({ attachmentId: payload.body.attachmentId, filename: payload.filename, mimeType: payload.mimeType });
      }
      (payload.parts || []).forEach(findAudioParts);
    }
    if (full.payload) findAudioParts(full.payload);

    // Suppress known marketing/blast emails before routing to Atlas
    const isMarketingSender = SUPPRESS_SENDERS.test(from);
    const isMarketingSubject = !SENDER_WHITELIST.test(from) && SUPPRESS_SUBJECTS.test(subject);
    if (isMarketingSender || isMarketingSubject) {
      await applyLabel(TOKEN_FILE, m.id, label.id);
      await gmail.markRead(TOKEN_FILE, m.id);
      console.log(`Suppressed (atlas-inbox): ${subject}`);
      continue;
    }

    summaries.push({ id: m.id, from, subject, date, body, isImessage: IMESSAGE_SUBJECT_RE.test(subject), audioParts });

    // Apply AtlasOS-Inbox label + mark read so we don't re-process
    await applyLabel(TOKEN_FILE, m.id, label.id);
    await gmail.markRead(TOKEN_FILE, m.id);
  }

  // Log to stdout for agent context
  console.log(`\nNew emails in AtlasOS-Inbox (${summaries.length}):`);
  for (const s of summaries) {
    console.log(`\nFrom: ${s.from}\nSubject: ${s.subject}\nDate: ${s.date}`);
    if (s.body) console.log(`Preview: ${s.body.substring(0, 200)}`);
  }

  // Alert on audio attachments (call recordings) — transcription handled separately
  for (const s of summaries) {
    if (s.audioParts && s.audioParts.length > 0) {
      const files = s.audioParts.map(p => p.filename || p.mimeType).join(', ');
      console.log(`Audio attachment detected from ${s.from}: ${files}`);
      busAtlas(`[atlas-inbox] Call recording received — From: ${s.from} | File: ${files} | Transcription pipeline not yet configured`);
      s._routed = true;
    }
  }

  // Route iMessage forwards through dedicated parser
  for (const s of summaries) {
    if (s.isImessage) {
      const parsed = parseForwardedEmail(s.subject, s.body);
      if (parsed.message) {
        sendTelegram(formatTelegramAlert(parsed));
        console.log(`iMessage routed: from ${parsed.sender || parsed.number}`);
        s._routed = true;
      }
    }
  }

  // Notify via Telegram for non-iMessage emails
  const unrouted = summaries.filter(s => !s._routed);
  if (unrouted.length === 0) process.exit(0);

  const more = messages.messages.length > 5 ? ` (+${messages.messages.length - 5} more)` : '';
  let msg = `[atlas-inbox] New email${unrouted.length > 1 ? 's' : ''} (${unrouted.length}${more}): `;
  for (const s of unrouted) {
    msg += `From: ${s.from} | Subject: ${s.subject}`;
    if (s.body) msg += ` | ${s.body.substring(0, 100)}`;
    msg += ' || ';
  }
  msg = msg.replace(/ \|\| $/, '').trim();
  busAtlas(msg);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
