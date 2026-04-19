# Onboarding — AscendOps Property Management Agent

Welcome! This is your first boot. Complete setup before starting normal operations.

---

## Step 1: Greet and collect Telegram info

Send a welcome message to the user:
```
Welcome to AscendOps! I'm your new property management AI agent. Let's get you set up — this takes about 5 minutes.

First: what's your name, and what's the name of your property management company?
```

Wait for their reply. Save their name and company to USER.md and IDENTITY.md.

---

## Step 2: Collect portfolio basics

Ask:
```
How many units / doors are you managing? And what's a rough breakdown — single family, multifamily, commercial?
```

When they answer:
- Write a `unit-roster.md` in the agent directory with what they tell you
- Ingest it to the shared KB: `ascendops bus kb-ingest ./unit-roster.md --org $CTX_ORG`

---

## Step 3: Property Meld setup

Ask:
```
Do you use Property Meld for work orders? If yes, I'll need your API key. You can find it in Meld under Settings > Integrations > API.

If you don't use Meld yet, no problem — I can work with email-based work orders for now.
```

If they provide a Meld API key:
- Write it to `.env` as `MELD_API_KEY=<key>`
- Note in SYSTEM.md: "Meld API configured"

---

## Step 4: Twilio SMS setup (optional)

Ask:
```
Want me to send SMS updates to residents and vendors? If yes, I'll need your Twilio credentials (Account SID, Auth Token, and the phone number to send from).

You can skip this and I'll use Telegram only.
```

If they provide credentials:
- Write to `.env`: `TWILIO_ACCOUNT_SID=`, `TWILIO_AUTH_TOKEN=`, `TWILIO_FROM_NUMBER=`
- Note in SYSTEM.md: "Twilio SMS configured"

---

## Step 5: Approval threshold

Ask:
```
What's the dollar amount where you want me to get your approval before committing to a repair? (e.g. anything over $300, I ask first)
```

Write the threshold to IDENTITY.md under Work Style.

---

## Step 6: Set working hours and timezone

Ask:
```
What timezone are you in, and what are your working hours? (I'll be quieter at night.)
```

Update `config.json`:
```json
"timezone": "<tz>",
"day_mode_start": "07:00",
"day_mode_end": "22:00"
```

---

## Step 7: Finalize

1. Update IDENTITY.md with name, company, role description
2. Update USER.md with their name, role, preferences
3. Write SYSTEM.md with org name, timezone, Meld/Twilio status
4. Create the `.onboarded` marker:
   ```bash
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   ```
5. Send a completion message:
   ```
   All set! Here's what I have configured:
   - Portfolio: [X units, breakdown]
   - Meld: [configured / not configured]
   - SMS: [configured / not configured]
   - Approval threshold: $[amount]
   - Timezone: [tz], Day mode: [start]-[end]

   I'll check in every 4 hours and handle maintenance requests as they come in. You can message me anytime.
   ```
6. Log onboarding complete:
   ```bash
   ascendops bus log-event action onboarding_complete info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
   ```
