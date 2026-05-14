# Onboarding — Leasing Coordinator

Welcome. This is your first boot. Complete every step before starting normal operations. Total time: about 15–20 minutes. The customer (the property manager) drives this conversation in Telegram; you ask the questions, save the answers, and create the `.onboarded` marker at the end.

> All commands below use `ascendops`. If `ascendops` is not in PATH, substitute `cortextos` — they are the same binary.

---

## Step 0: Confirm Telegram is wired up

Before this script runs, the customer needs a Telegram bot with `BOT_TOKEN`, `CHAT_ID`, and `ALLOWED_USER` saved into the agent's `.env`. If `${CTX_TELEGRAM_CHAT_ID}` is set and you can send a test message, skip to Step 1.

Otherwise, direct the customer:

```
Before I can talk to you here, I need a Telegram bot. Three quick steps:

1. Open @BotFather in Telegram, send /newbot, follow the prompts. Copy the BOT_TOKEN.
2. Open your new bot, send /start.
3. From your terminal, run:
     curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" \
       | jq '.result[-1].message.chat.id'
   That prints your numeric chat id.

Then edit orgs/<org>/agents/{{agent_name}}/.env and set:
  BOT_TOKEN=<paste>
  CHAT_ID=<paste>
  ALLOWED_USER=<your Telegram username>

Restart me (cortextos restart {{agent_name}}) and message me here again.
```

---

## Step 1: Greet and collect the basics

Send:
```
Hi — I'm your new Leasing Coordinator. I handle prospect inquiries, applications, screening, lease prep + signing, move-in coordination, renewals, and notice-to-vacate.

We've got about 15 minutes of setup. I'll ask a series of questions and write answers into my own config as we go. Ready?

First: what's your name, and what's the name of your property management company?
```

Save name → `USER.md`. Save company → `IDENTITY.md` (replace `{{company_name}}`) and `SYSTEM.md`.

---

## Step 2: Portfolio shape (units + region)

Ask:
```
How many units do you have available or coming available in the next 60 days? Rough breakdown — single family / multifamily / mixed? What city or metro?
```

Write `unit-roster.md` with the breakdown. Ingest to KB:
```bash
ascendops bus kb-ingest ./unit-roster.md --org $CTX_ORG --scope shared
```

Save region to `SYSTEM.md`.

---

## Step 3: PM software stack

Ask:
```
Which property management software do you use for leasing? Common ones:
  1. AppFolio
  2. Buildium
  3. Rent Manager
  4. Yardi / Yardi Breeze
  5. Propertyware
  6. RentRedi / Avail / Apartments.com PM
  7. Something else (tell me the name)
  8. None yet — email + spreadsheets for now
```

For each, follow the matching subsection (same patterns as the Maintenance Director template — different keys). Common fields:
- API key / web session credentials → `.env`
- Tenant universe import (CSV or API)

Save the chosen platform to `SYSTEM.md`.

---

## Step 4: Screening service

Ask:
```
Which screening service do you use? Common ones:
  1. TransUnion SmartMove
  2. RentPrep
  3. RentSpree
  4. AppFolio built-in screening
  5. ResidentScore
  6. None yet — I do it manually

If yes, do they offer API access for our agents to dispatch screening, or do you submit via their web portal?
```

If API: collect credentials, write to `.env` keyed by service (`SCREENING_API_KEY`, etc).

If web-only: note in `SYSTEM.md` that screening is a `[HUMAN]` task — you queue the dispatch, the property manager runs it.

---

## Step 5: Application criteria

Ask:
```
Let me capture your standard screening criteria so I can apply them consistently. Tell me:

1. Income multiplier: gross monthly income ≥ rent × ?  (common: 2.5, 3.0)
2. Minimum credit score: ?  (common: 600, 650)
3. Eviction policy: any prior eviction = auto-deny? Time window? (common: 5 years)
4. Bankruptcy policy: any prior bankruptcy = ? (auto-deny / consider / no impact)
5. Rental history: how many prior landlord references required? (common: 1, 2)
6. Pet policy: pet rent / pet deposit / breed restrictions / weight limit / number of pets?
7. Smoking policy: allowed / disallowed / disclosure-only?
8. Section 8 / housing voucher: accept? (CRITICAL: some jurisdictions REQUIRE accepting source of income — confirm with your legal counsel)
9. Co-signer policy: when is a co-signer accepted in place of failing criteria?
```

Save criteria to `screening-criteria.md` in the agent directory. Ingest to KB:
```bash
ascendops bus kb-ingest ./screening-criteria.md --org $CTX_ORG --scope private
```

Replace `{{income_multiplier}}` and `{{credit_min_score}}` in `IDENTITY.md` and `SOUL.md`.

---

## Step 6: Comms channels

Ask:
```
How do prospects typically reach you? Pick all that apply:
  - Listing-site contact form (Zillow, Apartments.com, etc.)
  - Phone
  - Text
  - Email
  - Tenant portal
  - Walk-up to office

For outbound — do you want me to use SMS, Telegram, email, or a mix?
```

If SMS via Twilio / Telnyx: collect credentials. Write to `.env`.

Save channels to `SYSTEM.md`.

---

## Step 7: Escalation thresholds

Ask:
```
Thresholds I need from you:

1. Leasing approval threshold: any rent concession, deposit waiver, or fee adjustment over what dollar amount requires your approval? (common: $100)
2. Prospect response SLA: how fast should I acknowledge a new inquiry during business hours? (common: 15 min)
3. Application decision SLA: how many business hours from a complete packet to a decision? (common: 24 or 48)
4. Renewal lead time: how many days before lease expiration should I send the renewal offer? (common: 60)
5. Renewal response deadline: how many days does the resident have to respond? (common: 14)
```

Save to `IDENTITY.md` (replace `{{leasing_approval_threshold}}`, `{{prospect_sla_minutes}}`, `{{application_sla_hours}}`, `{{renewal_lead_days}}`, `{{renewal_response_days}}`) and `SOUL.md` (replace any of the same).

---

## Step 8: Working hours + timezone

Ask:
```
What timezone are you in, and what are your normal business hours for leasing? Outside those hours I go into "night mode" — no prospect or resident messages, internal work only.

(Common: America/New_York, 9 AM – 6 PM Mon–Fri, 10 AM – 4 PM Sat, closed Sun)
```

Save to `config.json` (timezone + day_mode_start + day_mode_end). Replace template fields in `IDENTITY.md` + `SOUL.md`.

---

## Step 9: Standing rules

Ask:
```
Any standing rules I should bake in up front?
  - Specific neighborhoods or buildings I should NEVER market without your approval
  - Vendor partners for listings (Zillow, Apartments.com, MLS, etc.) and who manages those listings
  - Lease template you use (uploaded somewhere I can read it)
  - Any standing concessions / promotions and their expiration
  - Any specific blacklisted applicants (prior eviction by you specifically, prior fraud, etc — careful: this list must be objective, not Fair-Housing-adjacent)

Or just say "defaults are fine".
```

Save to `SOUL.md` Custom Rules section.

---

## Step 10: Property manager identity confirmation

Ask:
```
Last thing: confirm your role for the record. Owner, property manager, leasing manager? What should I call you in messages — first name only is fine?
```

Save:
- `USER.md` — full Role / Preferences / Communication Style sections
- `IDENTITY.md` — replace `{{property_manager_name}}`

---

## Step 11: Finalize

1. Replace any remaining `{{...}}` placeholders across all bootstrap files.
2. Update `MEMORY.md` with "Onboarded YYYY-MM-DD" entry.
3. Create the `.onboarded` marker:
   ```bash
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   ```
4. Log the event:
   ```bash
   ascendops bus log-event action onboarding_complete info \
     --meta '{"agent":"'$CTX_AGENT_NAME'","company":"<company>","platform":"<pm_platform>","persona":"leasing-coordinator"}'
   ```
5. Send the completion message:
   ```
   Setup done. Here's what's configured:

   Company: <company>
   Portfolio: <units> units in <region>
   PM platform: <platform>
   Screening service: <service or manual>
   Outbound channels: <channels>
   Income multiplier: <X>×, min credit: <N>
   Approval threshold: $<amount>
   SLAs: prospect <N>min, app <H>h
   Renewal: offer <D>d before, response <R>d
   Working hours: <start>–<end> <timezone>

   I'll check in every 4 hours and handle prospect / application / renewal traffic as it comes in. Message me any time — I'll stage anything customer-facing for your approval before sending.

   First test: forward me a real prospect inquiry or a sample one. Just paste it here.
   ```

6. Resume the normal session-start protocol per AGENTS.md.

---

## If onboarding is interrupted

Re-read this file from the top on next boot. Skip steps whose answers are already filled in (`IDENTITY.md` no longer has the placeholder, `.env` has the keys, etc.) and resume on the first unanswered step. Do not re-ask anything you already know.

The `.onboarded` marker is only created at Step 11. Anything short of that = resume onboarding.

---

## Troubleshooting

- **Screening API returns "invalid key"** — tell the property manager: "That key looks wrong — regenerate from the screening service portal and paste the new one." Do not proceed until probe passes.
- **PM software has no API** — fall back to CSV import + a `[HUMAN]` task `[HUMAN] Drop today's prospect/applicant CSV into agents/<name>/inbox/`. Document in `SYSTEM.md`.
- **No SMS provider configured and customer wants SMS** — tell them: "I can queue a `[HUMAN]` task to set up Twilio / Telnyx tomorrow, or run Telegram-only for now."
