# WYRE Agents host — operations runbook

> Central cortextOS host (internal name "cortextos"; team-facing "WYRE Agents").
> Provisioned by `infra/terraform/`. This runbook grows across SP2c sub-steps;
> this section covers backups (SP2c-1). Tunnel / ops / restore-swap sections
> are added in SP2c-2 and SP2c-3.

## Contents

- [Backups](#backups)
- [SP2c-2 apply prerequisites (Cloudflare Tunnel + Access)](#sp2c-2-apply-prerequisites-cloudflare-tunnel-+-access)
- [SP2c-2 verification notes (2026-05-29)](#sp2c-2-verification-notes-2026-05-29)
- [Day-to-day operations](#day-to-day-operations)
- [Disk growth](#disk-growth)
- [Tunnel re-auth (token rotation)](#tunnel-re-auth-token-rotation)
- [Restore from snapshot](#restore-from-snapshot)
- [Rollback](#rollback)
- [Break-glass](#break-glass)
- [SSO troubleshooting](#sso-troubleshooting)

---

## Backups

- **What is backed up:** the data disk (`cortextos-prod-data`) only. The OS
  disk is disposable — a rebuild re-runs cloud-init and re-attaches (or
  re-creates) the data disk.
- **How:** Azure Backup (Data Protection) vault `cortextos-prod-bvault`, daily
  disk snapshots, 14-day retention. Snapshots live in
  `cortextos-prod-snapshots-rg`.
- **Schedule:** daily at the time set by the `backup_time_utc` variable
  (default 07:00 UTC).
- **Backup policy rule name:** `BackupIntervals` (needed for on-demand backups).

### Trigger an on-demand backup

    VAULT=cortextos-prod-bvault
    INSTANCE=$(az dataprotection backup-instance list -g cortextos-prod-rg --vault-name "$VAULT" --query "[0].name" -o tsv)
    az dataprotection backup-instance adhoc-backup -g cortextos-prod-rg \
      --vault-name "$VAULT" --backup-instance-name "$INSTANCE" \
      --rule-name BackupIntervals --retention-tag-override Default

Poll the job:

    az dataprotection job list -g cortextos-prod-rg --vault-name "$VAULT" \
      --query "[0].{op:properties.operationCategory, status:properties.status}" -o table

### Restore drill

1. List recovery points:

       az dataprotection recovery-point list -g cortextos-prod-rg \
         --vault-name "$VAULT" --backup-instance-name "$INSTANCE" -o table

2. Restore the latest point to a new disk in the snapshot RG (creates a
   restored disk), then either swap it for the live data disk (detach old,
   attach restored, reconcile the Terraform `azurerm_managed_disk` state) or
   mount it read-only on a throwaway VM to recover specific files.

3. Verify: mount the restored disk and confirm
   `orgs/wyre/engineers/*/agents/*` and `.cortextos/` are present.

### Measured timings (SP2c-1 validation, 2026-05-26, MCPP / eastus)

- Full `terraform apply` (18 resources incl. VM + backup stack): ~6 min.
- On-demand backup job (first snapshot of a 64 GB disk): **193 s** to `Completed`.
- Snapshot lands in `cortextos-prod-snapshots-rg` named
  `AzureBackup_<instance-guid>_<timestamp>`.

### Tearing down (`terraform destroy`) — two Azure Backup traps

`terraform destroy` does **not** cleanly remove the backup stack on its own.
Two manual steps are required, in this order, before/around the destroy:

**1. Sweep out-of-band snapshots first.** Azure Backup creates snapshots that
are **not** in Terraform state (e.g. anything from an on-demand backup or a
fired daily job). They block the snapshot RG deletion. Before `destroy`:

    for s in $(az snapshot list -g cortextos-prod-snapshots-rg --query "[].name" -o tsv); do
      az snapshot delete -g cortextos-prod-snapshots-rg -n "$s"
    done

**2. Purge soft-deleted backup instances.** Data Protection vaults default to
soft-delete **On** (14-day retention). When `destroy` removes the backup
instance it goes to a soft-deleted state, and the policy/vault then refuse to
delete with `UserErrorPolicyAssociatedWithSoftDeletedItems`. Turning soft-delete
off does **not** retroactively purge already-soft-deleted items — you must
undelete then hard-delete:

    VAULT=cortextos-prod-bvault; INST=cortextos-prod-data-backup
    az dataprotection backup-vault update -g cortextos-prod-rg --vault-name "$VAULT" --soft-delete-state Off
    az dataprotection backup-instance deleted-backup-instance undelete -g cortextos-prod-rg --vault-name "$VAULT" --backup-instance-name "$INST"
    az dataprotection backup-instance delete -g cortextos-prod-rg --vault-name "$VAULT" --backup-instance-name "$INST" --yes
    # then re-run: terraform destroy -auto-approve

In production you generally do **not** destroy this stack — these notes are for
test/iteration cycles. The `deleted-backup-instance` CLI has no direct purge;
undelete→delete (with soft-delete off) is the supported path.

## SP2c-2 apply prerequisites (Cloudflare Tunnel + Access)

Before `terraform apply` with the Cloudflare resources:

1. **Cloudflare API token** — create one scoped to:
   - Zone : DNS : Edit  (on the `wyre.ai` zone)
   - Account : Cloudflare Tunnel : Edit
   - Account : Access: Apps and Policies : Edit
   Export it: `export CLOUDFLARE_API_TOKEN=...` (never commit).

2. **Account / zone ids** — put in `terraform.tfvars`:
   - `cloudflare_account_id` = (Cloudflare dashboard → account id)
   - `cloudflare_zone_id`    = (wyre.ai zone → zone id)

3. **Entra IdP in Cloudflare Zero Trust** — Zero Trust dashboard → Settings →
   Authentication → add **Azure AD** login method (app registration in the
   `wyretechnology.com` Entra tenant; redirect URI from the CF setup wizard).
   Copy the resulting IdP id into `terraform.tfvars` as `cloudflare_access_idp_id`.

4. `terraform apply`. Then verify:
   - `https://wyre-agents.wyre.ai` → Cloudflare Access login → WYRE SSO → dashboard.
   - Local `~/.ssh/config`:
     ```
     Host wyre-agents-ssh.wyre.ai
       ProxyCommand cloudflared access ssh --hostname %h
       User ops
     ```
     then `ssh wyre-agents-ssh.wyre.ai`.

## SP2c-2 verification notes (2026-05-29)

Two gotchas surfaced during the first end-to-end apply, both reflected in the
infra and now documented for the next operator:

1. **Universal SSL doesn't cover third-level subdomains.** The original plan used
   `agents.internal.wyre.ai` (third level). Cloudflare's free Universal SSL only
   covers `*.zone.tld` (single level), so TLS handshake failed at the edge.
   Final hostname is `wyre-agents.wyre.ai` (single level → covered). Adding
   Advanced Certificate Manager (~$10/mo) would re-enable arbitrary depth.
2. **Operator IP must be on Key Vault's network ACL** for `terraform apply` to
   write the cloudflared token secret. Set via the new `operator_ip_cidrs`
   variable (default `[]`). Leave empty in steady state; set to your `/32` only
   while applying changes that touch KV secrets.

## Day-to-day operations

### Start / stop / restart

The VM runs two systemd units that own everything:

- `cortextos.service` — the daemon + dashboard (PM2 supervised).
- `cloudflared.service` — the tunnel that exposes the dashboard and SSH.

Standard control (over Cloudflare-tunnelled SSH):

    ssh wyre-agents-ssh.wyre.ai
    sudo systemctl status cortextos cloudflared
    sudo systemctl restart cortextos        # restarts daemon + dashboard
    sudo systemctl restart cloudflared      # rotates the tunnel connection

If SSH is unreachable, use the Azure RunCommand fallback:

    az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
      --command-id RunShellScript \
      --scripts 'sudo systemctl restart cortextos'

### Logs

| What | Where |
|---|---|
| Bootstrap (first boot) | `journalctl -u cortextos-bootstrap.service` |
| Daemon + dashboard (PM2) | `journalctl -u cortextos.service` and `sudo -u cortextos pm2 logs` |
| Tunnel | `journalctl -u cloudflared.service` |
| Per-agent | `/var/lib/cortextos/.cortextos/prod/logs/<agent>/` |

### Updating code on the VM

Code lives at `/opt/cortextos` (git clone). To pull a new tag/commit:

    ssh wyre-agents-ssh.wyre.ai
    sudo -u cortextos git -C /opt/cortextos fetch --tags origin
    sudo -u cortextos git -C /opt/cortextos checkout <tag>
    sudo -u cortextos bash -lc 'cd /opt/cortextos && npm ci --no-audit --no-fund && npm run build'
    sudo systemctl restart cortextos

For dashboard changes also re-run `npm ci && npm run build` in `/opt/cortextos/dashboard`.

## Disk growth

The data disk holds all per-engineer agent state. To grow it:

1. Grow in Terraform — edit `data_disk_size_gb` in `terraform.tfvars`, `terraform apply`. Azure resizes the disk online.
2. Resize the filesystem on the VM:

       ssh wyre-agents-ssh.wyre.ai
       lsblk                                          # confirm new size on sdc
       sudo resize2fs /dev/disk/azure/scsi1/lun10     # ext4 online resize

The data disk's filesystem label is `cortextos-data`; the mount point is `/var/lib/cortextos`.

## Tunnel re-auth (token rotation)

The tunnel runs from a token stored in Key Vault (`cloudflared-token`). To rotate:

1. In CF Zero Trust → Networks → Tunnels → `cortextos` → **Refresh token**, OR  
   `cloudflared tunnel token <tunnel-id>` after re-authenticating locally.
2. Update Key Vault:

       az keyvault secret set --vault-name cortextos-prod-kv-d1fd92 \
         --name cloudflared-token --value '<new-token>' \
         --output none
   (Operator IP must be allowed on the vault — set `operator_ip_cidrs` first.)
3. Restart the tunnel:

       ssh wyre-agents-ssh.wyre.ai
       sudo systemctl restart cloudflared

## Restore from snapshot

> Documented procedure; a measured drill against a fresh VM is **open work** for the next iteration cycle.

Recover the data disk from a daily snapshot:

1. List recovery points:

       VAULT=cortextos-prod-bvault
       INSTANCE=$(az dataprotection backup-instance list -g cortextos-prod-rg \
         --vault-name "$VAULT" --query "[0].name" -o tsv)
       az dataprotection recovery-point list -g cortextos-prod-rg \
         --vault-name "$VAULT" --backup-instance-name "$INSTANCE" -o table

2. Restore the chosen point to a new disk in `cortextos-prod-snapshots-rg` (the disk lands as `cortextos-prod-data-restored-<timestamp>`):

       az dataprotection backup-instance restore initialize-for-data-recovery \
         --datasource-type AzureDisk \
         --restore-location eastus \
         --source-datastore VaultStore \
         --target-resource-id "<chosen-recovery-point>" \
         --rehydration-priority Standard ...

3. Stop `cortextos.service`, detach the live data disk via `az vm disk detach`, attach the restored disk at LUN 10, mount it (the fstab entry already uses `LABEL=cortextos-data` so it just works), reconcile Terraform state with `terraform import` if needed.
4. Start `cortextos.service` and confirm agents come back:

       sudo -u cortextos /opt/cortextos/dist/cli.js list-agents

5. Record the wall-clock time in this runbook the first time you run it for real.

## Rollback

If a code deploy breaks the daemon:

    ssh wyre-agents-ssh.wyre.ai
    sudo -u cortextos git -C /opt/cortextos checkout <previous-tag>
    sudo -u cortextos bash -lc 'cd /opt/cortextos && npm ci && npm run build'
    sudo systemctl restart cortextos

If a Terraform change breaks ingress (DNS, tunnel config, Access policy):

    cd infra/terraform
    terraform plan -refresh-only
    git checkout HEAD~1 -- infra/terraform/<changed-file>
    terraform apply -auto-approve

For irreversible-on-Cloudflare-side changes (e.g. the tunnel config resource is create-only — see SP2c spec), revert via the Cloudflare API directly:

    curl -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/<acct>/cfd_tunnel/<tunnel-id>/configurations" \
      -d '<previous-config-json>'

## Break-glass

If both Cloudflare Tunnel and the dashboard SSO break (CF outage, expired token, IdP misconfiguration), the VM has no public ingress. To recover:

- **Azure RunCommand** (lowest-level — sends a shell script to the VM via Azure Resource Manager, no VM-side service needed): `az vm run-command invoke ...` as shown in the start/stop section.
- **Azure Bastion** — not provisioned by default to keep cost down. Add temporarily:

      az network bastion create -g cortextos-prod-rg -n cortextos-bastion \
        --vnet-name cortextos-prod-vnet --location eastus

  Then connect via the Azure portal → VM → Connect → Bastion. Delete when done.

## SSO troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser shows CF Access page → click "WYRE Entra ID" → blank or "needs admin consent" | Entra app needs admin consent for `openid`/`profile` scopes | Grant in Entra portal → App registrations → (the Cloudflare Access app) → API permissions → "Grant admin consent for `wyretechnology.com`" |
| `AADSTS50011: redirect URI does not match` | Entra app's redirect URI differs from CF team domain | Ensure web redirect URI is `https://jolly-bar-cdb4.cloudflareaccess.com/cdn-cgi/access/callback`. CF team domain visible at `https://one.dash.cloudflare.com → Settings → Custom Pages` |
| `https://wyre-agents.wyre.ai` returns 502/503 | `cortextos.service` is down, OR tunnel ingress unhealthy | `sudo systemctl status cortextos cloudflared` on the VM; restart whichever is failed |
| TLS handshake failure on a new hostname | Universal SSL doesn't cover sub-sub-domains | Use one-level hostnames (e.g. `wyre-agents.wyre.ai`) OR pay for Advanced Certificate Manager — see the "SP2c-2 verification notes" above |
