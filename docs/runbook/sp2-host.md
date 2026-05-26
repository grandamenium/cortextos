# WYRE Agents host — operations runbook

> Central cortextOS host (internal name "cortextos"; team-facing "WYRE Agents").
> Provisioned by `infra/terraform/`. This runbook grows across SP2c sub-steps;
> this section covers backups (SP2c-1). Tunnel / ops / restore-swap sections
> are added in SP2c-2 and SP2c-3.

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
