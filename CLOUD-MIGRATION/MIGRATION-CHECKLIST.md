# CortextOS → AWS Cloud Migration Checklist

**Goal:** Run the always-on "brain" (daemon + all agents + dashboard) on an AWS Windows
EC2 instance so it survives travel, reboots, and hotspot drops. Laptop stays as optional
"hands" for printing / local files / iMessage when it's on.

**Strategy:** Windows lift-and-shift (same OS, same `C:\` paths) → simple, and reversible
back to any Windows computer later (see REVERSIBILITY.md).

**Prepared:** 2026-07-03 · Target: live before travel on Jul 8

---

## 0. Environment to reproduce on the VM
| Component | Version on laptop | Notes |
|---|---|---|
| Node.js | v24.16.0 | install exact major (24.x) |
| npm | 11.16.0 | ships with Node 24 |
| PM2 | 7.0.1 | `npm i -g pm2` |
| Claude Code | (global) | `npm i -g @anthropic-ai/claude-code` |
| cortextos CLI | (global) | installed from framework or npm |

Paths to preserve exactly (do NOT change — keeps it reversible):
- Framework: `C:\cortext-test\cortextos`
- Instance root (CTX_ROOT): `C:\Users\<user>\.cortextos\default`
- Claude creds: `C:\Users\<user>\.claude\.credentials.json`
- Obsidian vault: `C:\Users\<user>\OneDrive\Documents\Jen's Brain`

> If the VM username differs from `jenni`, either create a `jenni` user on the VM (cleanest —
> zero path edits) OR do a find/replace of the home path. **Recommend: make the VM user `jenni`.**

---

## 1. WHAT MOVES (small — ~230 MB of real data)

### COPY (the irreplaceable state):
- [ ] `C:\cortext-test\cortextos\orgs\`  (**229 MB** — agent identities, memory, GOALS, config, **secrets**)
- [ ] `C:\Users\jenni\.cortextos\default\state\`  (**1 MB** — heartbeats, crons.json, telegram offsets, oauth)
- [ ] `C:\cortext-test\cortextos\.env`  (root env)
- [ ] All 14 agent `.env` files (under `orgs/atlasos/agents/*/.env` + `forge/.env.doorloop`)
- [ ] `ecosystem.config.js` (has the heap cap + PATH fix)
- [ ] `start-atlasos.cmd`
- [ ] `C:\Users\jenni\.claude\.credentials.json`  (Claude login — OR just re-run `claude` login on VM)

### 22 secret/credential files in `orgs/atlasos/secrets/` (all must copy):
```
calendar_jordanreyes_tokens.json   gmail_jb1979_tokens.json      plaid_client_id.txt
calendar_tis_tokens.json           gmail_jordanreyes_tokens.json plaid_secret_sandbox.txt
calendar_wti_tokens.json           gmail_tis4u_tokens.json       sheets_tokens.json
contacts_tokens.json               gmail_tis_tokens.json         zarelda_sheets_tokens.json
doorloop_api_key.txt               gmail_tt23_tokens.json        gcp-service-account.json
drive_jordanreyes_tokens.json      gmail_wti_tokens.json         gmail_client_secret.json
drive_tokens.json                  gmail_ahr_tokens.json
gmail_ilp_tokens.json              gmail_tokens.json
```
> ⚠️ These are live credentials. Transfer over a private channel (see §4), never email/chat.

### REBUILD on VM (do NOT copy — saves ~2 GB and avoids platform issues):
- `node_modules/` → `npm install`
- `dashboard/.next/` (1.4 GB) → `npm run build` (or dev mode)
- `logs/` (517 MB) → starts fresh
- The framework SOURCE (`dist/`, `src/`, everything else) → `git clone` the repo, then copy state on top

---

## 2. VM PROVISIONING (you drive — needs your AWS login)
- [ ] Launch EC2 **Windows Server 2022** instance
- [ ] Size: **t3.xlarge (4 vCPU / 16 GB)** to start — system uses ~9 GB; 16 GB leaves headroom.
      Resize to t3.2xlarge (32 GB) later in 2 min if agents feel starved. (Both $0 on your credits.)
- [ ] Storage: 60 GB gp3 (framework + node_modules + OneDrive vault + logs)
- [ ] Security group: allow RDP (3389) from your IP only; dashboard stays behind ngrok (no inbound web port needed)
- [ ] Elastic IP (so the address doesn't change on restart)
- [ ] Enable "start on boot" / set instance to auto-recover

## 3. VM SETUP (run setup-ec2.ps1 — see that file)
- [ ] RDP into the instance
- [ ] Install Node 24, PM2, Claude Code, git, OneDrive
- [ ] `git clone` the cortextos framework to `C:\cortext-test\cortextos`
- [ ] Copy `orgs/`, `state/`, `.env` files, secrets on top
- [ ] `npm install` + build dashboard
- [ ] Sign into OneDrive → vault syncs to `C:\Users\jenni\OneDrive\...`
- [ ] Sign into Claude Code (`claude` → /login) OR drop in `.credentials.json`
- [ ] `pm2 start ecosystem.config.js && pm2 save`
- [ ] Install pm2-logrotate (already configured settings will carry if state copied)
- [ ] Register the Windows scheduled task for auto-start on reboot

## 4. SECURE TRANSFER OPTIONS (pick one)
- **AWS S3** (private bucket, encrypted): zip state+secrets, upload, download on VM, delete from S3
- **RDP clipboard/drive redirect**: copy the zip through the RDP session directly
- Avoid: email, Telegram, public links

## 5. CUTOVER
- [ ] Bring VM up, confirm all agents heartbeat + Telegram replies work (test from your phone)
- [ ] **STOP the laptop's daemon** (`pm2 stop all` on laptop) so two copies don't double-poll
      Telegram (409 conflicts) or double-fire crons. Only ONE brain runs at a time.
- [ ] Laptop's role now = optional "hands" only (print/local files/iMessage), daemon OFF
- [ ] Verify for a few hours, then you're travel-ready

## 6. KNOWN GAPS (features that need the laptop, will pause when it's off)
- Printing to your physical printer
- Reading truly-local files (anything NOT in OneDrive/Drive)
- iMessage / text scanning (needs your Mac/iPhone)
> Everything else — Gmail, Drive, DoorLoop, GHL, calendar, the Obsidian vault (via OneDrive) —
> works fully in the cloud, independent of your laptop.

---

## Rollback
If anything goes wrong, the laptop is untouched — just `pm2 start all` on the laptop and
you're exactly where you started. Nothing is deleted from the laptop during migration.
See REVERSIBILITY.md for the full "pull it back to a computer" procedure.
