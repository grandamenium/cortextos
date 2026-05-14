# Onboarding — Maintenance Director

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

If your install has an `ascendops bot create` (or `cortextos bot create`) subcommand available, that interactive helper does all three steps in one — but it's an optional add-on and not in the base framework, so this script does not assume it is installed.

---

## Step 1: Greet and collect the basics

Send:
```
Hi — I'm your new Maintenance Director. I handle work-order triage, vendor coordination, and resident maintenance comms.

We've got about 15 minutes of setup. I'll ask a series of questions and write answers into my own config as we go. Ready?

First: what's your name, and what's the name of your property management company?
```

Wait for the reply. Save:
- Their name → `USER.md` (Role section)
- Company name → `IDENTITY.md` (replace `{{company_name}}`) and `SYSTEM.md` (`**Organization:** <company>`)

---

## Step 2: Portfolio shape (doors + region)

Ask:
```
How many doors are you managing total? And rough breakdown — single family / multifamily / commercial / mixed? Plus what city or metro you operate in.
```

When they answer:
- Write `unit-roster.md` in the agent directory with the breakdown they describe (one paragraph is fine — Gemini will index it semantically).
- Ingest to the shared KB:
  ```bash
  ascendops bus kb-ingest ./unit-roster.md --org $CTX_ORG --scope shared
  ```
- Save region/metro to `SYSTEM.md` under a `## Region` heading.

---

## Step 3: PM software stack

Ask:
```
Which work-order / property management software are you using? Common ones:
  1. Property Meld
  2. AppFolio
  3. Buildium
  4. Rentec Direct
  5. Yardi / Yardi Breeze
  6. Something else (tell me the name)
  7. None yet — running on email or spreadsheets
```

For each platform, follow the matching subsection:

### 3a. Property Meld
```
I'll need your Nexus API key + tenant ID. You can find them in Meld under Settings > Integrations > API.
```
Write to `.env`:
```
MELD_NEXUS_API_KEY=<key>
MELD_TENANT_ID=<id>
```
Note in `SYSTEM.md`: "PM platform: Property Meld (Nexus API configured)."

### 3b. AppFolio
```
AppFolio does not currently offer an open API for our agents. Two options:

A) Browser session bridge (works, but expect to re-log-in periodically when MFA timeouts hit).
B) CSV-export bridge (lower-risk, manual export every morning).

Which do you want to start with? You can change later.
```
Save the choice in `SYSTEM.md` as `**AppFolio mode:** <session | csv>`.

For session mode: instruct them to run `ascendops bridge appfolio session-capture` (we will queue this as a follow-up if the command does not exist yet on their install).

### 3c. Buildium / 3d. Rentec / 3e. Yardi
```
I have read-only API integration for {{platform}} on the roadmap but it's not in this build yet. For now I'll work from CSV exports — can you export your open work orders to CSV daily and drop them in:
  {{CTX_ROOT}}/state/{{agent_name}}/inbox/work-orders/

I'll pick them up automatically.
```
Save the chosen platform to `SYSTEM.md` and create the inbox directory.

### 3f. Something else / none
```
No problem — I can work email-first. Forward work-order requests to ${{forward_email}} (we'll set up the forwarding in a minute) and I'll triage from there.
```
Save in `SYSTEM.md` and queue a `[HUMAN]` task to wire the email forwarding.

---

## Step 4: Vendor roster

Ask:
```
Who are your go-to vendors? List your primary by trade — at least plumbing, HVAC, electrical, appliance repair, handyman, and any in-house techs. For each, I need name, phone, email if you have it, and any quirks I should know (e.g. "won't text only", "always books two weeks out", "preferred for after-hours emergencies").

Paste it as a block — I'll parse and structure it.
```

Parse their reply. Write structured vendor entries to `vendor-roster.md` in the agent directory. Format each as:
```markdown
## <Vendor Name>
- **Trade:** <plumbing / HVAC / electrical / appliance / handyman / general / in-house>
- **Phone:** <number>
- **Email:** <if any>
- **Preferred for:** <notes>
- **Avoid for:** <notes>
- **Notes:** <quirks, hours, anything else>
```

Ingest to KB:
```bash
ascendops bus kb-ingest ./vendor-roster.md --org $CTX_ORG --scope private
```

---

## Step 5: Tenant universe + comms channels

Ask:
```
Roughly how do residents reach you for maintenance today? Pick all that apply:
  - Phone calls to office
  - Text messages
  - Email
  - Tenant portal in your PM software
  - Posted maintenance request form
  - Mix / depends on the property

And for outbound to residents and vendors — do you want me to use SMS, Telegram, email, or a mix? If SMS, I'll need a Twilio or Telnyx number (or we can set one up later).
```

Save the inbound channels to `SYSTEM.md` under `## Communication Channels`. For outbound:

If SMS via Twilio:
```
I'll need your Account SID, Auth Token, and the From-number.
```
Write to `.env`:
```
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<token>
TWILIO_FROM_NUMBER=<+15551234567>
```

If SMS via Telnyx:
```
I'll need your Telnyx API key and the From-number.
```
Write to `.env`:
```
TELNYX_API_KEY=<key>
TELNYX_FROM_NUMBER=<+15551234567>
```

If neither: continue Telegram-only and note in `SYSTEM.md` that outbound SMS is not configured.

---

## Step 6: Escalation thresholds

Ask:
```
Two thresholds I need from you.

1. Dollar threshold for approval. Anything over what amount should I escalate to you before authorizing? (Common: $300, $500, $1000.)
2. Triage SLA. How fast should I acknowledge a new work order from a resident? (Common: 15 min in office hours, 1 hour overnight.)
```

Save:
- `IDENTITY.md` — replace `{{approval_threshold}}` and `{{triage_sla_minutes}}`.
- `SOUL.md` — replace `{{approval_threshold}}` (every occurrence).

---

## Step 7: Working hours + timezone

Ask:
```
What timezone are you in, and what are your normal working hours? Outside those hours I go into "night mode" — I queue internal work but don't message residents or vendors.

(Common: America/New_York, 7:30 AM – 7:30 PM)
```

Save:
- `config.json` — set `timezone`, and add `"day_mode_start"`/`"day_mode_end"` if not present.
- `IDENTITY.md` and `SOUL.md` — replace `{{day_mode_start}}`, `{{day_mode_end}}`, `{{timezone}}`.

---

## Step 8: Pet preferences (optional but useful)

Ask:
```
Any standing rules I should know up front? E.g.:
  - "Never call any vendor without messaging me first" (default: I do for known-trusted vendors)
  - "Always cc me on every outbound resident message" (default: off)
  - "Don't ever auto-close work orders" (default: I do, with photo + notes verification)
  - Any specific properties or residents that need special handling
  - Any vendors that are blacklisted

Or just say "defaults are fine".
```

Add anything custom to `SOUL.md` under `## Custom Rules` (a new section if needed). These are the single source of truth for approval rules going forward.

---

## Step 9: Property manager identity confirmation

Ask:
```
Last thing: confirm your role for the record. Are you the owner, the property manager, the maintenance manager, or another role? And what should I call you in messages — first name only is fine?
```

Save:
- `USER.md` — full Role, Preferences, Communication Style sections
- `IDENTITY.md` — replace `{{property_manager_name}}` with their preferred name

---

## Step 10: Finalize

1. Replace any remaining `{{...}}` placeholders in IDENTITY.md / SOUL.md / GUARDRAILS.md / CLAUDE.md.
2. Update `MEMORY.md` with a short "Onboarded YYYY-MM-DD" entry.
3. Create the `.onboarded` marker:
   ```bash
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   ```
4. Log the event:
   ```bash
   ascendops bus log-event action onboarding_complete info \
     --meta '{"agent":"'$CTX_AGENT_NAME'","company":"<company_name>","platform":"<pm_platform>"}'
   ```
5. Send the completion message:
   ```
   Setup done. Here's what's configured:

   Company: <company>
   Portfolio: <doors> doors (<breakdown>) in <region>
   PM platform: <platform>
   Outbound channels: <channels>
   Approval threshold: $<amount> — anything above this I escalate
   Triage SLA: <minutes> min
   Working hours: <start>–<end> <timezone>

   I'll check in every 4 hours and handle maintenance requests as they come in. Message me any time — I'll triage and stage the response for your approval before sending anything outbound to a resident or vendor.

   First test: try forwarding me a real work order or a sample one. Just paste it here.
   ```

6. Open the inbox monitoring loop and resume the normal session start protocol per AGENTS.md.

---

## If onboarding is interrupted

The customer may close their Telegram or restart you mid-flow. On the next boot, re-read this file from the top. Skip steps whose answers are already filled in (`IDENTITY.md` no longer has the placeholder, `.env` has the API key, etc.) and resume on the first unanswered step. Do not re-ask anything you already know.

The `.onboarded` marker is only created at Step 10. Anything short of that = resume onboarding.

---

## Troubleshooting

- **Customer says "I'll send you the vendor list later" at Step 4.** Save what you have, queue a `[HUMAN]` task `[HUMAN] Send vendor roster to <agent_name>`, continue to Step 5. Maintenance can run without the roster — it just means every vendor recommendation requires manual lookup until the roster lands.
- **API key is invalid (Meld returns 401).** Tell them: "That key looks wrong — please regenerate from Meld Settings > Integrations and paste the new one." Do not proceed until a valid key passes a probe.
- **No Twilio/Telnyx and customer wants SMS now.** Tell them: "I can't send SMS without a number — would you like me to queue a `[HUMAN]` task to walk you through Twilio account creation tomorrow morning, or skip SMS for now and use Telegram only?" Default to Telegram-only if unsure.
