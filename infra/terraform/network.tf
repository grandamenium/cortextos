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
  service_endpoints    = ["Microsoft.KeyVault"]
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
