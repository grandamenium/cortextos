# Incremental disk snapshots created by Azure Backup land here, separate from
# the main RG so lifecycle and permissions are clearly scoped.
resource "azurerm_resource_group" "snapshots" {
  name     = "${local.name_prefix}-snapshots-rg"
  location = var.location
  tags     = merge(local.common_tags, { role = "disk-snapshots" })
}

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
