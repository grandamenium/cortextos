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

variable "cortextos_repo_url" {
  type        = string
  description = "Git URL the bootstrap clones into /opt/cortextos."
  default     = "https://github.com/wyre-technology/cortextos.git"
}

variable "cortextos_branch" {
  type        = string
  description = "Branch (or tag) the bootstrap checks out. Pin to a tag once SP2b is verified in prod."
  default     = "main"
}

variable "cortextos_instance" {
  type        = string
  description = "cortextOS instance id (the directory name under ~/.cortextos/)."
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_-]{1,15}$", var.cortextos_instance))
    error_message = "cortextos_instance must match /^[a-z][a-z0-9_-]{1,15}$/."
  }
}

variable "cortextos_org" {
  type        = string
  description = "Default org passed to `cortextos ecosystem --org`."
  default     = "wyre"
}

variable "node_major_version" {
  type        = number
  description = "Node.js major version installed via NodeSource."
  default     = 20

  validation {
    condition     = contains([18, 20, 22], var.node_major_version)
    error_message = "node_major_version must be a current LTS line: 18, 20, or 22."
  }
}

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
