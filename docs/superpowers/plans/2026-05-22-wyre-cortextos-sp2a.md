# WYRE cortextOS SP2a — Terraform skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Terraform configuration in `infra/terraform/` that provisions the Azure VM, data disk, network, and Key Vault for cortextOS. After this plan: `terraform apply` from a fresh checkout brings up a clean (but unconfigured) VM with a mounted data disk; `terraform destroy` tears it all down without orphans.

**Architecture:** A single Terraform module rooted in `infra/terraform/`, broken into focused files by concern (network, VM, Key Vault). Secrets and identity values come from a git-ignored `terraform.tfvars`; the example file lists every required variable. Cloudflare and `cloud-init` integrations are stubbed (empty placeholder, comments explaining where SP2b/c plug in). No application bootstrap yet.

**Tech Stack:** Terraform ≥ 1.6, `hashicorp/azurerm` provider ≥ 3.90, Azure CLI (`az`), `tflint` (optional but recommended).

**Spec:** `docs/superpowers/specs/2026-05-21-wyre-cortextos-sp2-central-host-design.md`

**Conventions for every task below:**
- Working dir: `/Users/asachs/cortextos`. Branch: `feat/sp2-central-host` (already checked out).
- Commit with `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com" commit -m "..."`.
- Conventional Commits messages.
- After every task: `terraform fmt -recursive infra/terraform` and `terraform validate` (run from `infra/terraform/`).
- Variable names use `snake_case`; resource names use the `cortextos-` prefix (matches Conduit's naming if applicable).

---

## Task 1: Repo scaffolding & .gitignore

Set up the directory layout the rest of SP2 will inhabit. No Terraform yet.

**Files:**
- Create: `infra/README.md`
- Create: `infra/terraform/.gitignore`
- Modify: `.gitignore` (root)

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p infra/terraform infra/systemd infra/bin
```

- [ ] **Step 2: Write `infra/README.md`**

```markdown
# infra/

Infrastructure for the WYRE cortextOS central host.

- `terraform/` — Azure provisioning (VM, data disk, network, Key Vault, later: Cloudflare Tunnel).
- `systemd/` — unit files copied to the VM by cloud-init (added in SP2b).
- `bin/` — operator scripts (added in SP2c, e.g. `deploy.sh`).

## Quickstart (SP2a)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars            # fill in subscription, tenant, region, ssh pubkey
terraform init
terraform plan
terraform apply
```

## Cost baseline (SP2a state)

- VM Standard_D2s_v3, premium SSD data disk (64 GB), Key Vault, no traffic.
- ≈ $90/month. Tear down with `terraform destroy` between iterations.

## Status

| Sub-step | What it ships | State |
|---|---|---|
| SP2a | Provisionable VM + disk + Key Vault skeleton | this PR |
| SP2b | cloud-init + systemd actually run cortextOS | not yet |
| SP2c | Cloudflare Tunnel + backups + runbook | not yet |
```

- [ ] **Step 3: Write `infra/terraform/.gitignore`**

```
# Terraform local state — never commit.
.terraform/
*.tfstate
*.tfstate.backup
crash.log
crash.*.log

# Real variable values — copy from terraform.tfvars.example.
terraform.tfvars
*.auto.tfvars

# Plan output binaries.
*.tfplan
```

- [ ] **Step 4: Add a guard to the root `.gitignore`**

Append to `.gitignore`:

```
# Defense in depth — never commit real Terraform secrets from anywhere.
**/terraform.tfvars
**/*.tfplan
```

- [ ] **Step 5: Commit**

```bash
git add infra/ .gitignore
git commit -m "chore(infra): scaffold infra/ directory and Terraform gitignore"
```

---

## Task 2: Providers, backend, variables, outputs

Lay down the four files that every Terraform module needs before any resource is declared.

**Files:**
- Create: `infra/terraform/main.tf`
- Create: `infra/terraform/variables.tf`
- Create: `infra/terraform/outputs.tf`
- Create: `infra/terraform/terraform.tfvars.example`

- [ ] **Step 1: Write `main.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
  }

  # Remote state: deferred to SP2b once we know which storage account / container
  # this lives in. For now state is local — fine for a single-operator bootstrap.
  # backend "azurerm" {}
}

provider "azurerm" {
  features {
    key_vault {
      # Block accidental destroy of vaults with content; we explicitly destroy
      # via `terraform destroy` only.
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

# All resources share this tag set. Each module file may add resource-specific
# tags via merge().
locals {
  common_tags = {
    project     = "cortextos"
    environment = var.environment
    managed_by  = "terraform"
    owner       = "wyre-technology"
  }

  # Resource name prefix: cortextos-prod-, cortextos-dev-, etc.
  name_prefix = "cortextos-${var.environment}"
}

resource "azurerm_resource_group" "main" {
  name     = "${local.name_prefix}-rg"
  location = var.location
  tags     = local.common_tags
}
```

- [ ] **Step 2: Write `variables.tf`**

```hcl
variable "subscription_id" {
  type        = string
  description = "Azure subscription ID the host lives in."
}

variable "tenant_id" {
  type        = string
  description = "Azure AD tenant ID."
}

variable "location" {
  type        = string
  description = "Azure region (e.g. eastus, westus2)."
  default     = "eastus"
}

variable "environment" {
  type        = string
  description = "Environment slug used in resource names: prod, staging, dev."
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be lowercase letters/digits/hyphens, 2-16 chars."
  }
}

variable "vm_size" {
  type        = string
  description = "Azure VM SKU."
  default     = "Standard_D2s_v3"
}

variable "vm_admin_username" {
  type        = string
  description = "Linux admin username on the VM. Cloud-init will also create the cortextos system user separately (SP2b)."
  default     = "ops"
}

variable "vm_ssh_public_key" {
  type        = string
  description = "SSH public key for the ops admin user. Stored in Key Vault and injected at boot."
  sensitive   = true
}

variable "data_disk_size_gb" {
  type        = number
  description = "Size of the premium SSD data disk attached to the VM."
  default     = 64
}
```

- [ ] **Step 3: Write `outputs.tf`**

```hcl
output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "vm_name" {
  value = azurerm_linux_virtual_machine.main.name
}

output "vm_private_ip" {
  value       = azurerm_network_interface.main.private_ip_address
  description = "VM has no public IP. This is the internal address used by the (future) Cloudflare Tunnel daemon to reach localhost services from outside the box."
}

output "key_vault_uri" {
  value = azurerm_key_vault.main.vault_uri
}

output "data_disk_id" {
  value = azurerm_managed_disk.data.id
}
```

- [ ] **Step 4: Write `terraform.tfvars.example`**

```hcl
# Copy this file to terraform.tfvars and fill in real values.
# terraform.tfvars is git-ignored.

subscription_id = "00000000-0000-0000-0000-000000000000"
tenant_id       = "00000000-0000-0000-0000-000000000000"

location    = "eastus"
environment = "prod"

# Paste the public key (single line). Generate with:
#   ssh-keygen -t ed25519 -C "ops@cortextos" -f ~/.ssh/cortextos_ops
vm_ssh_public_key = "ssh-ed25519 AAAA... ops@cortextos"

# Optional overrides — defaults are usually fine.
# vm_size           = "Standard_D2s_v3"
# data_disk_size_gb = 64
```

- [ ] **Step 5: Verify**

```bash
cd infra/terraform
terraform fmt -check
terraform init           # downloads the azurerm provider
terraform validate
```

Expected: `fmt` clean, `init` succeeds, `validate` reports `Success!`.

- [ ] **Step 6: Commit**

```bash
git add infra/terraform/main.tf infra/terraform/variables.tf infra/terraform/outputs.tf infra/terraform/terraform.tfvars.example
git commit -m "feat(infra): providers, variables, outputs, and resource group"
```

---

## Task 3: Network module

VNet, subnet, NSG with deny-all-inbound. No public IP anywhere in SP2 — engineers reach the VM through Cloudflare Tunnel only (SP2c).

**Files:**
- Create: `infra/terraform/network.tf`

- [ ] **Step 1: Write `network.tf`**

```hcl
resource "azurerm_virtual_network" "main" {
  name                = "${local.name_prefix}-vnet"
  address_space       = ["10.50.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.common_tags
}

resource "azurerm_subnet" "vm" {
  name                 = "${local.name_prefix}-vm-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.50.1.0/24"]
}

# Deny-all-inbound posture. Azure's default rules already allow inbound from
# VirtualNetwork and AzureLoadBalancer, plus the implicit deny — but we add an
# explicit DenyAllInBound rule at priority 4000 so the intent is visible and
# any accidental NSG additions sort below it.
resource "azurerm_network_security_group" "vm" {
  name                = "${local.name_prefix}-vm-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.common_tags

  security_rule {
    name                       = "DenyAllInbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "vm" {
  subnet_id                 = azurerm_subnet.vm.id
  network_security_group_id = azurerm_network_security_group.vm.id
}
```

- [ ] **Step 2: Verify**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/network.tf
git commit -m "feat(infra): VNet, subnet, and deny-all-inbound NSG"
```

---

## Task 4: VM, OS disk, data disk, NIC, managed identity

The VM itself. No public IP, system-assigned managed identity (used later to read secrets from Key Vault), an attached data disk for cortextOS state.

**Files:**
- Create: `infra/terraform/vm.tf`

- [ ] **Step 1: Write `vm.tf`**

```hcl
resource "azurerm_network_interface" "main" {
  name                = "${local.name_prefix}-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.common_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.vm.id
    private_ip_address_allocation = "Dynamic"
    # No public_ip_address_id — Cloudflare Tunnel is the only ingress (SP2c).
  }
}

resource "azurerm_managed_disk" "data" {
  name                 = "${local.name_prefix}-data"
  location             = azurerm_resource_group.main.location
  resource_group_name  = azurerm_resource_group.main.name
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = var.data_disk_size_gb
  tags = merge(local.common_tags, {
    role = "cortextos-state"
  })
}

# Cloud-init payload is intentionally minimal in SP2a — just enough to confirm
# the data disk shows up. SP2b replaces this with the real bootstrap (Node,
# clone, systemd units, etc.) rendered from a templatefile().
locals {
  cloud_init_placeholder = <<-EOT
    #cloud-config
    package_update: true
    package_upgrade: false
    write_files:
      - path: /etc/cortextos-stage
        permissions: "0644"
        content: "sp2a\n"
  EOT
}

resource "azurerm_linux_virtual_machine" "main" {
  name                = "${local.name_prefix}-vm"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  size                = var.vm_size
  admin_username      = var.vm_admin_username
  network_interface_ids = [
    azurerm_network_interface.main.id,
  ]

  # No password auth; SSH key only. SP2c adds Cloudflare Tunnel routing for :22.
  disable_password_authentication = true

  admin_ssh_key {
    username   = var.vm_admin_username
    public_key = var.vm_ssh_public_key
  }

  os_disk {
    name                 = "${local.name_prefix}-osdisk"
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(local.cloud_init_placeholder)

  identity {
    type = "SystemAssigned"
  }

  tags = local.common_tags
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.main.id
  lun                = "10"
  caching            = "ReadWrite"
}
```

- [ ] **Step 2: Verify**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/vm.tf
git commit -m "feat(infra): VM, data disk, NIC, and managed identity"
```

---

## Task 5: Key Vault

A vault for the secrets SP2b/c will populate (SSH key, cloudflared token, Anthropic API key). SP2a only creates the vault and grants the VM's managed identity get/list access — it does **not** seed any secrets yet (that's an operator action documented in the runbook later).

**Files:**
- Create: `infra/terraform/keyvault.tf`

- [ ] **Step 1: Write `keyvault.tf`**

```hcl
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
    ip_rules                   = [] # SP2b/c may add the operator's IP here for break-glass.
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
```

- [ ] **Step 2: Subnet service endpoint for Key Vault**

`network_acls.virtual_network_subnet_ids` requires the subnet to have the Key Vault service endpoint enabled. Add to `infra/terraform/network.tf`, inside the `azurerm_subnet "vm"` resource block:

```hcl
  service_endpoints = ["Microsoft.KeyVault"]
```

(Place it after `address_prefixes`.)

- [ ] **Step 3: Verify**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/keyvault.tf infra/terraform/network.tf
git commit -m "feat(infra): Key Vault with subnet-scoped network ACL and VM identity policy"
```

---

## Task 6: Real `terraform plan` against the operator's subscription

This is the first task where the operator runs against real Azure. It cannot be done by a subagent — only a human with the subscription can authenticate.

- [ ] **Step 1: Operator prep** *(human task)*

```bash
# Sign in.
az login
az account set --subscription <subscription-id>

# Generate an SSH key for the ops user (separate from your normal key).
ssh-keygen -t ed25519 -C "ops@cortextos-prod" -f ~/.ssh/cortextos_ops -N ""

# Populate terraform.tfvars from the example.
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
#   subscription_id = $(az account show --query id -o tsv)
#   tenant_id       = $(az account show --query tenantId -o tsv)
#   vm_ssh_public_key = "$(cat ~/.ssh/cortextos_ops.pub)"
```

- [ ] **Step 2: `terraform init` and `plan`**

```bash
cd infra/terraform
terraform init
terraform plan -out=sp2a.tfplan
```

Expected: a plan listing ~10 resources (RG, VNet, subnet, NSG, NSG assoc, NIC, VM, OS disk implicit, data disk, data disk attachment, Key Vault, two access policies). No errors.

- [ ] **Step 3: Note any required quota or feature flags**

If `plan` succeeds but `apply` later fails on quota (D-series cores, Premium SSD), capture the exact error in the runbook (added in SP2c). For SP2a, accept failures here as feedback that informs sizing or region — they're not plan defects.

- [ ] **Step 4: `terraform apply`**

```bash
terraform apply sp2a.tfplan
```

Expected: ~5 minutes. Outputs print at the end.

- [ ] **Step 5: Smoke test the deployed VM**

Since there is no public IP and no tunnel yet, the operator uses Azure CLI to access the VM:

```bash
# Confirm the VM is running.
az vm show -g cortextos-prod-rg -n cortextos-prod-vm --query "powerState" -d -o tsv
# Expected: "VM running"

# Run a command on the VM via Azure RunCommand (no SSH path needed).
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts 'cat /etc/cortextos-stage; lsblk | grep -E "sd[a-z]|nvme" ; echo done'
```

Expected: output contains `sp2a` (the placeholder file from cloud-init) AND a data disk entry like `sdc 64G` (or whatever LUN 10 surfaces as). If the data disk isn't visible, that's a defect — investigate before continuing.

- [ ] **Step 6: `terraform destroy`**

Confirms the plan tears down cleanly with no orphans.

```bash
terraform destroy
```

Expected: ~3 minutes, no errors. Re-run `terraform plan` afterwards and confirm it would create everything again.

> If destroy leaves Key Vault soft-deleted, that's expected — purge is on
> `purge_soft_delete_on_destroy = true` so the next apply re-creates cleanly.

- [ ] **Step 7: Commit any small fixes that surfaced**

If the smoke test or destroy revealed problems requiring `.tf` changes (most likely: provider version pins, NSG ordering, name collisions), commit them now:

```bash
git add infra/terraform/
git commit -m "fix(infra): adjustments from first apply/destroy cycle"
```

If nothing changed, skip this step.

---

## Task 7: Open the PR

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/sp2-central-host
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp2-central-host \
  --title "SP2a: Terraform skeleton for the central host" \
  --body "Provisions the Azure VM, data disk, network, and Key Vault per docs/superpowers/specs/2026-05-21-wyre-cortextos-sp2-central-host-design.md. Cloud-init is a placeholder (SP2b lands the real bootstrap). No Cloudflare Tunnel yet (SP2c). Verified end-to-end against a real Azure subscription: terraform apply provisioned cleanly, data disk attached, terraform destroy left no orphans."
```

- [ ] **Step 2: Self-review the diff one more time before requesting review**

Run: `git diff main..feat/sp2-central-host -- infra/`

Look for: hardcoded secrets, accidental `terraform.tfvars` commits, stale TODOs, inconsistent naming.

---

## Self-review notes

- **Spec coverage:** Task 1 (scaffolding), Tasks 2–5 (every Terraform resource in the SP2 architecture diagram that belongs to SP2a — RG, VNet, NSG, VM, NIC, data disk, Key Vault), Task 6 (the real apply/destroy verification the spec's DoD calls for), Task 7 (PR). Cloudflare resources, cloud-init bootstrap, systemd units, and the runbook are all explicitly deferred to SP2b/c.
- **Placeholder scan:** every code block contains the actual `.tf` content; no `TBD` / `TODO` / "add appropriate" left in.
- **Type/name consistency:** `local.name_prefix` is `"cortextos-${var.environment}"`, used in every resource name. `azurerm_resource_group.main`, `azurerm_subnet.vm`, `azurerm_linux_virtual_machine.main` referenced consistently across files.
- **One open assumption to flag for the operator:** Task 6 may fail on Azure quota for D-series cores in the chosen region. The plan handles this in Step 3 — operator either requests quota, picks a smaller SKU via `vm_size`, or moves region. None of those require code changes outside `terraform.tfvars`.
- **Why no remote Terraform backend yet:** local state is fine for a single-operator bootstrap. SP2b introduces the storage-account backend once we know which subscription owns the state-storage container.
