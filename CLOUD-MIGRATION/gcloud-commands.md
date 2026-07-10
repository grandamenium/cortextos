# GCP Copy-Paste Commands — Migration Night

Reference for the technical steps. Fill in the `<PLACEHOLDERS>`. Project = "My First Project"
(find the real project ID: console top bar, or `gcloud config get-value project`).

## 0. One-time gcloud setup (on laptop, if gcloud CLI installed; else use console)
```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud config set compute/zone us-central1-a
```

## 1. Verify / resize the VM to e2-standard-4 (if it came up as e2-medium)
```bash
gcloud compute instances describe cortextos --zone=us-central1-a --format="value(machineType)"
# if not e2-standard-4:
gcloud compute instances stop cortextos --zone=us-central1-a
gcloud compute instances set-machine-type cortextos --zone=us-central1-a --machine-type=e2-standard-4
gcloud compute instances start cortextos --zone=us-central1-a
```

## 2. Lock RDP (tcp:3389) to YOUR current IP only (don't leave it 0.0.0.0/0)
```bash
# your public IP:
curl -s ifconfig.me
# create a restricted firewall rule (replace <YOUR_IP>):
gcloud compute firewall-rules create allow-rdp-jennifer \
  --direction=INGRESS --action=ALLOW --rules=tcp:3389 \
  --source-ranges=<YOUR_IP>/32 --target-tags=rdp
# tag the VM so the rule applies:
gcloud compute instances add-tags cortextos --zone=us-central1-a --tags=rdp
```
> If your hotspot IP changes (it will), re-run with the new IP or update the rule's source-range.

## 3. Set Windows password + get external IP
```bash
gcloud compute reset-windows-password cortextos --zone=us-central1-a --user=jenni
gcloud compute instances describe cortextos --zone=us-central1-a \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```
Then RDP to that IP with user `jenni` and the password it prints.

## 4. Transfer the migration bundle via GCS (cleanest, survives disconnects)
```bash
# make a bucket (globally-unique name):
gcloud storage buckets create gs://ctx-migrate-<RANDOM> --location=us-central1
# upload from laptop (after running make-migration-bundle.ps1):
gcloud storage cp "$env:USERPROFILE\Downloads\cortextos-migration-*.zip" gs://ctx-migrate-<RANDOM>/
# on the VM (in its PowerShell, gcloud is preinstalled on GCP Windows images):
gcloud storage cp gs://ctx-migrate-<RANDOM>/cortextos-migration-*.zip C:\
# AFTER verified, nuke the bucket (contains secrets):
gcloud storage rm --recursive gs://ctx-migrate-<RANDOM>
```
> Alternative: just paste the zip through the RDP clipboard/drive redirect. Bucket is more robust.

## 5. On the VM
```powershell
# unzip C:\cortextos-migration-*.zip, then:
.\gcp-vm-setup.ps1            # install + build
# ...unzip state over the tree, claude /login, OneDrive sign-in...
.\gcp-vm-setup.ps1 -Launch    # pm2 up + autostart
pm2 list                      # verify daemon + dashboard online
```

## 6. Cutover (ONE BRAIN RULE)
```powershell
# ONLY after cloud verified + Telegram test from phone works:
# on the LAPTOP:
pm2 stop all
# rollback if needed: pm2 start all  (laptop untouched, instant revert)
```

## Cost hygiene
- Running e2-standard-4 Windows ≈ $0.20/hr ≈ ~$5/day off the $300 credit.
- `gcloud compute instances stop cortextos --zone=us-central1-a` when not needed (disk-only cost).
- Credit expires 90 days from trial start regardless of usage.
