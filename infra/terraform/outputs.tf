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

output "backup_vault_name" {
  value = azurerm_data_protection_backup_vault.main.name
}

output "backup_instance_id" {
  value = azurerm_data_protection_backup_instance_disk.data.id
}

output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id
  description = "Cloudflare Tunnel id."
}

output "dashboard_url" {
  value       = "https://${var.dashboard_hostname}"
  description = "Access-gated dashboard URL."
}

output "ssh_hostname" {
  value       = var.ssh_hostname
  description = "Ops SSH hostname (reach via cloudflared access ssh ProxyCommand)."
}
