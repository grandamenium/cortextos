# Cloud Migration — ✅ COMPLETE (2026-07-04, ~00:xx)

**STATUS: MIGRATION SUCCEEDED.** All 14 agents running on GCP Windows VM, laptop daemon stopped.
**Provider:** Google Cloud · VM `cortextos` (e2-standard-4, us-central1-a) · IP 136.65.65.251 · user `jenb`
**Credits:** $300 GCP free trial (90-day expiry). Windows VM ≈ 6 weeks of runtime.

## ⚠️ FOLLOW-UPS (do when fresh — not blocking):
1. **Security: lock RDP to Jennifer's IP.** Right now GCP default allows 3389 from 0.0.0.0/0. Restrict it (see gcloud-commands.md §2).
2. **OneDrive vault sync.** NOT set up on VM yet — Atlas & others can't read the "Jen's Brain" Obsidian vault until OneDrive is signed in on the VM. Agents run degraded (no vault) until then. Sign into OneDrive on the VM → vault syncs to C:\Users\jenb\OneDrive\...
3. **Delete the secrets bundle:** `cortextos-migration-*.zip` from BOTH laptop Downloads and VM Downloads (+ the extracted ctx-bundle folder on VM). Contains live credentials.
4. **Auto-start on reboot:** pm2 save is done, but register the Windows scheduled task (gcp-vm-setup.ps1 §9) so the daemon relaunches if the VM ever reboots.
5. **DO NOT restart the laptop daemon** — one-brain rule. Cloud is authoritative now. Laptop stays stopped (it's the rollback if ever needed).

## Old resume notes (historical):

## ✅ Done so far
- Google Cloud set up, project = "My First Project", $300 credit confirmed
- Compute Engine API enabled
- **Windows Server VM CREATED AND RUNNING** — name `cortextos`, zone `us-central1-a`,
  OS = Windows Server 2025 Datacenter, Connect = RDP (confirmed Windows)
- (First attempt came out Linux → deleted → recreated as Windows)

## ⚠️ Verify at start of next session
- **Machine size:** confirm it's `e2-standard-4` (4 vCPU / 16 GB). The create form briefly showed
  e2-medium (2 vCPU / 4 GB) which is TOO SMALL (system needs ~9 GB). If it's e2-medium:
  stop the VM → Edit → change machine type to e2-standard-4 → start. (Resize, no need to recreate.)
- **Disk:** 50 GB was showing; 60+ GB preferred. Can grow the disk later if needed.
- **Credit burn:** the VM bills while RUNNING (~$5/day for e2-standard-4 Windows). If we won't
  finish setup for a few days, STOP the instance (Instances list → check cortextos → STOP) to
  pause charges — disk cost only (~pennies). START it again when we resume.

## ▶️ Resume from here (PHASE 2 — setup, ~45-60 min, needs Jennifer present)
1. Verify/resize machine type per above.
2. Set Windows password on the VM (Instances → cortextos → "Set Windows password").
3. RDP into the VM (download the RDP file from the console, or use Remote Desktop app).
4. Inside the VM, run the setup (see setup-ec2.ps1 — reuse for GCP, ignore AWS-only bits):
   install Node 24 + PM2 + Claude Code + git + OneDrive; git clone framework; npm install; build.
5. Securely copy state onto VM: orgs/, state/, .env files, secrets (see MIGRATION-CHECKLIST §1).
6. Sign into Claude Code (/login) + OneDrive (vault sync) on the VM.
7. `pm2 start ecosystem.config.js && pm2 save` + scheduled task for auto-start.
8. Test Telegram from phone. Then STOP the laptop daemon (one brain rule).

## Notes for next session
- Jennifer is non-technical + on a hotspot. Console navigation by voice got confusing.
- **Better method next time:** longer calm session (45-60 min), and a reliable way to see her screen — have her SAVE a screenshot with **Windows key + PrtScn** (auto-saves to Pictures\Screenshots) then I read the file; OR she photographs the screen with her phone.
- Laptop is untouched and still running everything — zero risk, full rollback available.
- The MIGRATION-CHECKLIST.md / setup-ec2.ps1 say "AWS" — swap to Google Cloud (Compute Engine). Same concepts.
