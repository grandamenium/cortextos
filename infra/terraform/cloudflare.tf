# A remotely-managed Cloudflare Tunnel. The token this produces is stored in
# Key Vault (see Task 4) and consumed by cloudflared.service on the VM.
#
# Schema note (v5.19.1): account_id is optional on this resource (unlike many
# other CF v5 resources). config_src drives remote vs. local management.
resource "cloudflare_zero_trust_tunnel_cloudflared" "cortextos" {
  account_id = var.cloudflare_account_id
  name       = "${local.name_prefix}-tunnel"
  # config_src = "cloudflare" makes this a remotely-managed tunnel whose ingress
  # is defined by the _config resource below.
  config_src = "cloudflare"
}

# Ingress rules: hostname-based routing. Dashboard → local Next.js; ssh hostname
# → local sshd. Final catch-all returns 404 as required by cloudflared.
#
# Schema note (v5.19.1): both `config` and its nested `ingress` are
# nested_type attributes (not block_type), so assignment syntax (=) is
# required. The plan's HCL was already correct on this point.
# `source` is the attribute that mirrors config_src on the tunnel resource;
# `tunnel_id` is required.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cortextos" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id

  config = {
    ingress = [
      {
        hostname = var.dashboard_hostname
        service  = "http://localhost:3000"
      },
      {
        hostname = var.ssh_hostname
        service  = "ssh://localhost:22"
      },
      {
        # Required catch-all rule: no hostname means match everything else.
        service = "http_status:404"
      },
    ]
  }
}

# DNS: both hostnames are CNAMEs to the tunnel's <id>.cfargotunnel.com target,
# proxied through Cloudflare (orange cloud) so Access can gate them.
#
# Schema note (v5.19.1):
# - Content field is `content` (was `value` in v4) — correct.
# - `name` accepts the FQDN; the provider strips the zone suffix internally.
# - `ttl` is required (not optional); value 1 = automatic, valid when proxied.
# - `zone_id` is optional in schema but needed at apply time via var.
resource "cloudflare_dns_record" "dashboard" {
  zone_id = var.cloudflare_zone_id
  name    = var.dashboard_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # 1 = automatic; required when proxied
}

resource "cloudflare_dns_record" "ssh" {
  zone_id = var.cloudflare_zone_id
  name    = var.ssh_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cortextos.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ── Zero Trust Access policy + applications ──────────────────────────────────

# One reusable policy: allow identities from the Entra IdP whose email is in the
# WYRE domain. Referenced by both Access applications below.
#
# Schema note (v5.19.1): `include` and `require` are nested_type with
# nesting_mode="set", so assignment syntax (= [...]) is required. Each element
# is an object with optional typed sub-keys (email_domain, login_method, etc.)
# whose own attributes are themselves nested_type/single objects.
resource "cloudflare_zero_trust_access_policy" "wyre_staff" {
  account_id = var.cloudflare_account_id
  name       = "WYRE staff (Entra, ${var.access_email_domain})"
  decision   = "allow"

  include = [
    {
      email_domain = {
        domain = var.access_email_domain
      }
    },
  ]

  # Require the Entra IdP specifically (not just any login method).
  require = [
    {
      login_method = {
        id = var.cloudflare_access_idp_id
      }
    },
  ]
}

# Schema note (v5.19.1): `policies` on the application is nested_type with
# nesting_mode="list". All sub-attributes are optional/computed; providing
# only `id` (cross-reference to the policy above) and `precedence` is valid.
resource "cloudflare_zero_trust_access_application" "dashboard" {
  account_id       = var.cloudflare_account_id
  name             = "WYRE Agents"
  domain           = var.dashboard_hostname
  type             = "self_hosted"
  session_duration = "24h"

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.wyre_staff.id
      precedence = 1
    },
  ]
}

resource "cloudflare_zero_trust_access_application" "ssh" {
  account_id       = var.cloudflare_account_id
  name             = "WYRE Agents — SSH"
  domain           = var.ssh_hostname
  type             = "ssh"
  session_duration = "24h"

  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.wyre_staff.id
      precedence = 1
    },
  ]
}

# ── Tunnel token → Key Vault ──────────────────────────────────────────────────

# Schema note (v5.19.1): the tunnel resource does NOT expose a `.token`
# attribute directly. The token is retrieved via this data source, which has
# required `tunnel_id` and optional `account_id`; the exported `token`
# attribute is sensitive and computed.
data "cloudflare_zero_trust_tunnel_cloudflared_token" "cortextos" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cortextos.id
}

# The tunnel's run token, stored in Key Vault. cloud-init fetches it at first
# boot via the VM's managed identity and hands it to cloudflared.service.
resource "azurerm_key_vault_secret" "cloudflared_token" {
  name         = "cloudflared-token"
  value        = data.cloudflare_zero_trust_tunnel_cloudflared_token.cortextos.token
  key_vault_id = azurerm_key_vault.main.id

  # The operator access policy must exist before we can write secrets.
  depends_on = [azurerm_key_vault_access_policy.operator]
}
