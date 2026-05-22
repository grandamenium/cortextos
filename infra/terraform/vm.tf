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

locals {
  cloud_init_rendered = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    cortextos_instance = var.cortextos_instance
    cortextos_org      = var.cortextos_org
    cortextos_repo_url = var.cortextos_repo_url
    cortextos_branch   = var.cortextos_branch
    node_major_version = var.node_major_version
  })
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

  custom_data = base64encode(local.cloud_init_rendered)

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
