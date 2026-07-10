# Pull CortextOS Back to a Computer (Reversibility Guarantee)

You are never locked into the cloud. Because we kept the migration a **Windows-to-Windows
lift-and-shift with identical paths**, moving the system back to any Windows computer is the
same procedure as moving it to the cloud — just in reverse. This doc is your guarantee.

## Why it's reversible by design
- Same OS (Windows), same paths (`C:\cortext-test\cortextos`, `C:\Users\jenni\.cortextos\default`).
- The only thing that ever changes between hosts is *where the files sit* — the structure is identical.
- Nothing is Windows-cloud-specific. No AWS lock-in in the app itself.

## What to pull back (same small bundle as the migration)
The live state, not the rebuildable bulk:
- `C:\cortext-test\cortextos\orgs\`  (agent identities, memory, secrets)
- `C:\Users\jenni\.cortextos\default\state\`  (heartbeats, crons, telegram offsets, oauth)
- `.env` (root) + all agent `.env` files + `ecosystem.config.js` + `start-atlasos.cmd`
- `orgs\atlasos\secrets\` (22 credential files)
- Optionally `.claude\.credentials.json` (or just re-login on the target)

## Procedure (cloud → computer)
1. On the target computer: install Node 24, PM2, Claude Code, cortextos CLI
   (same as setup-ec2.ps1 steps 2-3, or `git clone` + `npm install`).
2. Securely copy the bundle above from the VM to the computer (S3, or RDP drive redirect).
3. Sign into Claude Code and OneDrive on the computer.
4. **Stop the cloud daemon first** (`pm2 stop all` on the VM) — only ONE brain may run at a
   time, or the agents will double-poll Telegram (409 errors) and double-fire crons.
5. On the computer: `pm2 start ecosystem.config.js && pm2 save`.
6. Verify heartbeats + a Telegram test message.
7. When confident, terminate/stop the EC2 instance to stop any billing.

## The golden rule
**Exactly one daemon runs at any time.** Whether it's on the laptop, the cloud, or a new
computer — before starting a new one, stop the old one. Two running daemons on the same
Telegram bot tokens = conflict + dropped messages. This is the single most important thing
to remember whenever you move the system.

## Fast rollback during migration
During the initial cloud migration, the laptop is never wiped — its daemon is just stopped.
If the cloud has any problem, instant rollback is:
```
# on the laptop:
pm2 start all
```
You're back to the original state in seconds, because the laptop still has everything.
