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
