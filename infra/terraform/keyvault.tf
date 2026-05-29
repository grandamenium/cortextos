data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  # Key Vault names must be globally unique; append the subscription's short id
  # tail to avoid collisions across environments.
  name                       = "${local.name_prefix}-kv-${substr(replace(var.subscription_id, "-", ""), 0, 6)}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = var.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = false

  # Network ACLs: deny by default; only the VM's subnet can reach the vault.
  # Bypass = "AzureServices" allows Azure Backup, Container Registry, etc. to
  # work without IP rules. The operator's laptop can still reach the vault via
  # the Azure portal (control plane) but cannot read data without a policy.
  network_acls {
    default_action             = "Deny"
    bypass                     = "AzureServices"
    virtual_network_subnet_ids = [azurerm_subnet.vm.id]
    ip_rules                   = var.operator_ip_cidrs # operator/break-glass; default empty.
  }

  tags = local.common_tags
}

# The operator who runs `terraform apply` needs to write secrets. Azure's RBAC
# vs. access-policy model is messy; SP2a uses the legacy access-policy approach
# (matches Conduit's pattern). Switch to RBAC in SP2c if Conduit has by then.
resource "azurerm_key_vault_access_policy" "operator" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = var.tenant_id
  object_id    = data.azurerm_client_config.current.object_id

  secret_permissions = [
    "Get", "List", "Set", "Delete", "Recover", "Backup", "Restore", "Purge",
  ]
}

# The VM's managed identity gets read-only access. It will fetch the
# cloudflared token (SP2c) and Anthropic key (SP2b) at boot.
resource "azurerm_key_vault_access_policy" "vm" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = var.tenant_id
  object_id    = azurerm_linux_virtual_machine.main.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}
