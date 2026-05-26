# WYRE cortextOS SP2c-1 — Data disk backups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily snapshot backups (14-day retention) of the cortextOS data disk via Azure Backup (Data Protection), provisioned in Terraform, with an on-demand backup + restore drill proving the chain works.

**Architecture:** A `azurerm_data_protection_backup_vault` with a system-assigned identity, a daily disk-snapshot policy (14-day retention), and a backup instance protecting `azurerm_managed_disk.data` from SP2a. Incremental snapshots land in a dedicated snapshot resource group. The vault identity gets `Disk Backup Reader` on the source disk and `Disk Snapshot Contributor` on the snapshot RG — without these, protection silently fails.

**Tech Stack:** Terraform `azurerm` ~> 3.90, Azure Backup (Data Protection / `Microsoft.DataProtection`), `az dataprotection` CLI for the drill.

**Spec:** `docs/superpowers/specs/2026-05-24-wyre-cortextos-sp2c-tunnel-backups-design.md`

**Conventions:**
- Working dir `/Users/asachs/cortextos`, branch `feat/sp2c-tunnel-backups` (already checked out).
- After each Terraform task: `terraform fmt -recursive infra/terraform && terraform validate` from `infra/terraform/`.
- Commit per task with `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com" commit`.
- This sub-project needs NO Cloudflare token — it is fully applicable now.

---

## Task 1: Backup variables + snapshot resource group

**Files:**
- Modify: `infra/terraform/variables.tf`
- Create: `infra/terraform/backup.tf`

- [ ] **Step 1: Append backup variables to `variables.tf`**

```hcl
variable "backup_retention_days" {
  type        = number
  description = "Daily disk-snapshot retention in days."
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 365
    error_message = "backup_retention_days must be between 1 and 365."
  }
}

variable "backup_time_utc" {
  type        = string
  description = "Daily backup time, ISO 8601 UTC (e.g. 02:00 → 2026-01-01T02:00:00Z; only the time-of-day is used)."
  default     = "2026-01-01T07:00:00Z"
}
```

- [ ] **Step 2: Start `backup.tf` with the snapshot resource group**

```hcl
# Incremental disk snapshots created by Azure Backup land here, separate from
# the main RG so lifecycle and permissions are clearly scoped.
resource "azurerm_resource_group" "snapshots" {
  name     = "${local.name_prefix}-snapshots-rg"
  location = var.location
  tags     = merge(local.common_tags, { role = "disk-snapshots" })
}
```

- [ ] **Step 3: Verify**

```bash
cd infra/terraform && terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/variables.tf infra/terraform/backup.tf
git commit -m "feat(infra): backup variables and snapshot resource group"
```

---

## Task 2: Backup vault + daily disk policy

**Files:**
- Modify: `infra/terraform/backup.tf`

- [ ] **Step 1: Append the vault and policy**

```hcl
resource "azurerm_data_protection_backup_vault" "main" {
  name                = "${local.name_prefix}-bvault"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  datastore_type      = "VaultStore"
  redundancy          = "LocallyRedundant"

  identity {
    type = "SystemAssigned"
  }

  tags = local.common_tags
}

resource "azurerm_data_protection_backup_policy_disk" "daily" {
  name     = "${local.name_prefix}-disk-daily"
  vault_id = azurerm_data_protection_backup_vault.main.id

  # Daily snapshot at the configured time.
  backup_repeating_time_intervals = ["R/${var.backup_time_utc}/P1D"]
  default_retention_duration      = "P${var.backup_retention_days}D"

  # Snapshots are created in the snapshot RG.
  time_zone = "UTC"
}
```

> Note: `azurerm_data_protection_backup_policy_disk` uses ISO 8601 repeating
> intervals (`R/<start>/P1D` = repeat daily) and ISO 8601 durations
> (`P14D` = 14 days). If the installed provider version rejects `time_zone`
> on this resource, drop that line — it defaults to UTC.

- [ ] **Step 2: Verify**

```bash
cd infra/terraform && terraform fmt && terraform validate
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/backup.tf
git commit -m "feat(infra): Data Protection backup vault + daily disk policy"
```

---

## Task 3: Role assignments + backup instance

The vault's managed identity must read the source disk and write snapshots, or the backup instance provisions but never protects.

**Files:**
- Modify: `infra/terraform/backup.tf`

- [ ] **Step 1: Append role assignments and the backup instance**

```hcl
# The vault identity must read the source disk...
resource "azurerm_role_assignment" "vault_disk_reader" {
  scope                = azurerm_managed_disk.data.id
  role_definition_name = "Disk Backup Reader"
  principal_id         = azurerm_data_protection_backup_vault.main.identity[0].principal_id
}

# ...and create snapshots in the snapshot RG.
resource "azurerm_role_assignment" "vault_snapshot_contributor" {
  scope                = azurerm_resource_group.snapshots.id
  role_definition_name = "Disk Snapshot Contributor"
  principal_id         = azurerm_data_protection_backup_vault.main.identity[0].principal_id
}

# Protect the data disk. Depends on the role assignments — Azure validates
# permissions at instance-creation time, so creating this before the roles
# propagate fails with an authorization error.
resource "azurerm_data_protection_backup_instance_disk" "data" {
  name                         = "${local.name_prefix}-data-backup"
  location                     = var.location
  vault_id                     = azurerm_data_protection_backup_vault.main.id
  disk_id                      = azurerm_managed_disk.data.id
  snapshot_resource_group_name = azurerm_resource_group.snapshots.name
  backup_policy_id             = azurerm_data_protection_backup_policy_disk.daily.id

  depends_on = [
    azurerm_role_assignment.vault_disk_reader,
    azurerm_role_assignment.vault_snapshot_contributor,
  ]
}
```

- [ ] **Step 2: Add outputs**

Append to `infra/terraform/outputs.tf`:

```hcl
output "backup_vault_name" {
  value = azurerm_data_protection_backup_vault.main.name
}

output "backup_instance_id" {
  value = azurerm_data_protection_backup_instance_disk.data.id
}
```

- [ ] **Step 3: Verify**

```bash
cd infra/terraform && terraform fmt && terraform validate
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/backup.tf infra/terraform/outputs.tf
git commit -m "feat(infra): role assignments + disk backup instance"
```

---

## Task 4: Apply, on-demand backup drill, destroy

Real Azure. Cost ~$0.10. The controller runs this task (needs the live subscription).

- [ ] **Step 1: Apply**

```bash
cd infra/terraform && terraform apply -auto-approve
```
Expected: SP2a/b's 12 resources + the snapshot RG, backup vault, policy, 2 role assignments, and backup instance. ~6 minutes (role-assignment propagation can add a minute).

- [ ] **Step 2: Confirm the backup instance is healthy**

```bash
VAULT=$(terraform output -raw backup_vault_name)
az dataprotection backup-instance list \
  --resource-group cortextos-prod-rg \
  --vault-name "$VAULT" \
  --query "[].{name:name, status:properties.currentProtectionState}" -o table
```
Expected: one instance, `currentProtectionState = ProtectionConfigured` (may briefly show `ConfiguringProtection`).

- [ ] **Step 3: Trigger an on-demand backup (proves the snapshot chain)**

```bash
VAULT=$(terraform output -raw backup_vault_name)
INSTANCE=$(az dataprotection backup-instance list -g cortextos-prod-rg --vault-name "$VAULT" --query "[0].name" -o tsv)
RULE=$(az dataprotection backup-instance list -g cortextos-prod-rg --vault-name "$VAULT" --query "[0].properties.policyInfo.policyId" -o tsv | xargs -I{} az dataprotection backup-policy show --ids {} --query "properties.policyRules[?backupParameters].name | [0]" -o tsv)
az dataprotection backup-instance adhoc-backup \
  --resource-group cortextos-prod-rg --vault-name "$VAULT" \
  --backup-instance-name "$INSTANCE" \
  --rule-name "$RULE" \
  --retention-tag-override "Default"
```
Expected: returns a job. Poll it:
```bash
az dataprotection job list -g cortextos-prod-rg --vault-name "$VAULT" \
  --query "[0].{op:properties.operationCategory, status:properties.status}" -o table
```
Expected: status moves `InProgress` → `Completed` within a few minutes. A snapshot now exists in `cortextos-prod-snapshots-rg`:
```bash
az snapshot list -g cortextos-prod-snapshots-rg --query "[].name" -o tsv
```
Expected: one snapshot listed.

- [ ] **Step 4: Capture timings for the runbook**

Note the apply duration and the on-demand backup job duration; they go into the runbook in Task 5.

- [ ] **Step 5: Destroy**

```bash
terraform destroy -auto-approve
```
Expected: clean. The backup vault has soft-delete; if `destroy` errors that the vault has protected instances, the dependency order should handle it (instance destroyed before vault). If a stuck snapshot blocks the snapshot-RG delete, list and remove it:
```bash
az snapshot list -g cortextos-prod-snapshots-rg -o table 2>/dev/null || echo "snapshot RG already gone"
```

- [ ] **Step 6: Commit any fix-ups**

If the apply surfaced provider-attribute mismatches (most likely on the policy's interval/duration syntax or `time_zone`), fix and commit:
```bash
git add infra/terraform/
git commit -m "fix(infra): backup resource attribute corrections from first apply"
```
Otherwise skip. Push the branch:
```bash
git push -u origin feat/sp2c-tunnel-backups
```

---

## Task 5: Runbook backup section + CHANGELOG

**Files:**
- Create: `docs/runbook/sp2-host.md` (backup section only; tunnel/ops sections added in SP2c-3)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Create `docs/runbook/sp2-host.md`**

```markdown
# WYRE Agents host — operations runbook

> Central cortextOS host (internal name "cortextos"; team-facing "WYRE Agents").
> Provisioned by `infra/terraform/`. This runbook grows across SP2c sub-steps;
> this section covers backups (SP2c-1).

## Backups

- **What is backed up:** the data disk (`cortextos-prod-data`) only. The OS
  disk is disposable — a rebuild re-runs cloud-init and re-attaches the data disk.
- **How:** Azure Backup (Data Protection) vault `cortextos-prod-bvault`, daily
  disk snapshots, 14-day retention. Snapshots live in
  `cortextos-prod-snapshots-rg`.
- **Schedule:** daily at the time set by `backup_time_utc` (default 07:00 UTC).

### Trigger an on-demand backup

    VAULT=cortextos-prod-bvault
    INSTANCE=$(az dataprotection backup-instance list -g cortextos-prod-rg --vault-name "$VAULT" --query "[0].name" -o tsv)
    az dataprotection backup-instance adhoc-backup -g cortextos-prod-rg \
      --vault-name "$VAULT" --backup-instance-name "$INSTANCE" \
      --rule-name BackupIntervals --retention-tag-override Default

### Restore drill

1. List recovery points:

       az dataprotection recovery-point list -g cortextos-prod-rg \
         --vault-name "$VAULT" --backup-instance-name "$INSTANCE" -o table

2. Restore the latest point to a new disk in the snapshot RG (creates
   `cortextos-prod-data-restored`), then either swap it for the live data disk
   (detach old, attach restored, update the Terraform `azurerm_managed_disk`
   import) or mount it read-only to recover specific files.

3. Verify: attach the restored disk to a throwaway VM, mount it, confirm
   `orgs/wyre/engineers/*/agents/*` and `.cortextos/` are present.

_Measured timings (fill in from the SP2c-1 apply): on-demand backup job ~__ min;
restore-to-new-disk ~__ min._
```

> Replace the `~__ min` placeholders with the real timings captured in Task 4
> Step 4 before committing.

- [ ] **Step 2: Update `CHANGELOG.md`**

Append to the `[Unreleased]` → `### Added` list:

```markdown
- SP2c-1 — daily data-disk backups via Azure Backup (Data Protection): backup
  vault, daily disk-snapshot policy (14-day retention), and a backup instance
  protecting the data disk. Snapshots in a dedicated snapshot resource group.
- `docs/runbook/sp2-host.md` — operations runbook (backup section).
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbook/sp2-host.md CHANGELOG.md
git commit -m "docs: backup runbook section + SP2c-1 changelog"
git push origin feat/sp2c-tunnel-backups
```

---

## Task 6: PR

- [ ] **Step 1: Open the PR**

```bash
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp2c-tunnel-backups \
  --title "SP2c-1: daily data-disk backups" \
  --body "First sub-step of SP2c (spec: docs/superpowers/specs/2026-05-24-wyre-cortextos-sp2c-tunnel-backups-design.md).

Adds Azure Backup (Data Protection) for the data disk: backup vault with system-assigned identity, daily disk-snapshot policy (14-day retention), role assignments (Disk Backup Reader on the disk, Disk Snapshot Contributor on the snapshot RG), and a backup instance. Plus the runbook backup section.

Verified against MCPP Subscription: apply clean, backup instance reached ProtectionConfigured, on-demand backup job Completed and produced a snapshot, terraform destroy clean.

SP2c-2 (Cloudflare Tunnel + Entra Access, internal.wyre.ai/agents) and SP2c-3 (runbook completion) follow — SP2c-2 is authored but applied separately once a Cloudflare API token is available."
```

> NOTE: This branch (`feat/sp2c-tunnel-backups`) will also carry SP2c-2 and
> SP2c-3 commits. Decide at PR time whether to ship SP2c-1 as its own PR off a
> dedicated `feat/sp2c-1-backups` branch, or hold one PR for all of SP2c. The
> controller resolves this — if shipping SP2c-1 alone, cut the branch from
> `main` before Task 1 instead.

---

## Self-review notes

- **Spec coverage:** backup vault + daily policy + retention (Tasks 2), disk
  protection with correct RBAC (Task 3), the restore drill (Task 4 Step 3 +
  runbook), runbook backup section (Task 5). The spec's "Recovery Services vs
  Data Protection" open question is resolved in favor of Data Protection
  (disk-level backup is the correct model for a single managed disk).
- **Placeholder scan:** the runbook has two intentional `~__ min` timing
  placeholders that Task 4 Step 4 fills from real measurement — flagged
  explicitly, not silent TODOs.
- **Branch caveat:** Task 6 flags the one-PR-vs-split decision rather than
  silently assuming. Default: SP2c-1 ships on its own branch off main so it can
  merge without waiting for the (token-blocked) tunnel work.
- **Type/name consistency:** `azurerm_data_protection_backup_vault.main`,
  `_backup_policy_disk.daily`, `_backup_instance_disk.data`,
  `azurerm_resource_group.snapshots` referenced consistently across tasks.
