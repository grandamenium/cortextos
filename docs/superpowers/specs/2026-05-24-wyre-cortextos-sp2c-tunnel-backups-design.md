# WYRE cortextOS — SP2c: Cloudflare Tunnel, backups & runbook

- **Status:** Draft for review
- **Date:** 2026-05-24
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — final sub-step of SP2

## Context

SP2a (PR #2) and SP2b (PR #3) are merged. A `terraform apply` brings up an
Azure VM that boots into a running cortextOS daemon + dashboard, verified
end-to-end (first boot 124s, reboot recovery 62s, agent state persists on the
data disk). But the host today is **unreachable from outside Azure** (NSG
denies all inbound, no public IP) and **has no backups**. SP2c closes both
gaps and ships the operations runbook, making the host genuinely usable by
the team.

Decisions already locked (SP2 parent brainstorm + SP2c review 2026-05-26;
routing revised 2026-05-24 — see below):
- **Reachability:** Cloudflare Tunnel only (no public IP).
- **Dashboard URL:** `wyre-agents.wyre.ai` (subdomain, host-based). The
  team-facing surface drops the upstream "cortextos" name — see the rename note.
  **Revised from the earlier `wyre-agents.wyre.ai` path-based plan**: the
  dashboard has 54 client-side `fetch('/api/...')` calls that a Next.js
  `basePath` does not rewrite (basePath only prefixes `next/link`/`next/router`/
  `_next` assets, not raw `fetch`), so path-based routing would require
  rewriting all 54 call sites with real regression risk. A subdomain serves the
  dashboard at `/` exactly as local dev with **zero application-code change** —
  the simpler, lower-risk path to the same clean WYRE-Agents URL.
- **Access identity:** Entra ID (Azure AD) SSO, restricted to `@wyretechnology.com`.
- **Backups:** single Azure managed data disk, daily snapshot, 14-day retention.

### Rename scope (user-facing only)

This is a hard fork; the team-facing surface is branded **WYRE Agents**, not
"cortextos". SP2c renames only what the team sees:
- Hostname: `wyre-agents.wyre.ai` (subdomain, serves the dashboard at `/`).
- Ops SSH host: `wyre-agents-ssh.wyre.ai`.
- Access app names: "WYRE Agents". (A dashboard page-title rebrand is an
  optional one-string nicety, not load-bearing.)

The internal guts stay `cortextos` for now — the CLI command (`cortextos`),
paths (`/opt/cortextos`, `/var/lib/cortextos`), systemd unit names
(`cortextos.service`, `cortextos-bootstrap.service`), and the repo name are
unchanged. A full fork-wide rename is a separate future project, deliberately
out of SP2c scope.

### Key finding from reading the code

cortextOS ships a `cortextos tunnel` command (`src/cli/tunnel.ts`), but it is
**macOS-only** (launchd), single-ingress, and routes to the throwaway
`<tunnel-id>.cfargotunnel.com` hostname with no Access policy. It is the
*local-developer* path and is explicitly **not** used on the central host.
SP2c provisions the tunnel declaratively (Terraform Cloudflare provider) and
runs `cloudflared` as a **systemd service** on the Linux VM, with a named
hostname, path-based ingress, and a Zero Trust Access policy. The macOS
command is left untouched.

## Goal (SP2c)

After SP2c:
- The dashboard is reachable at `https://wyre-agents.wyre.ai`, gated by
  Cloudflare Access (WYRE identity only).
- Ops SSH reaches the VM at `wyre-agents-ssh.wyre.ai` through the same
  tunnel (no public :22).
- The data disk is snapshotted daily with 14-day retention; a restore drill
  has been run and documented.
- `docs/runbook/sp2-host.md` covers day-to-day operations.

## Decisions this spec makes (locked)

1. **Tunnel provisioning: Terraform Cloudflare provider + systemd `cloudflared`.**
   The `cloudflare_zero_trust_tunnel_cloudflared` resource creates a
   remotely-managed tunnel; its token is stored in Key Vault; cloud-init
   installs a `cloudflared.service` systemd unit that runs
   `cloudflared tunnel run --token <token>`. Ingress + DNS + Access are all
   Terraform-managed.

2. **Host-based routing on a subdomain — no dashboard code change.**
   The dashboard is served at `https://wyre-agents.wyre.ai/` (root).
   Cloudflare Tunnel ingress matches the hostname and proxies to
   `localhost:3000` unchanged, so the dashboard runs exactly as in local dev.
   This replaces the earlier path-based `/agents` plan, which would have
   required a Next.js `basePath` plus rewriting 54 client-side `fetch('/api/...')`
   calls (basePath does not touch raw `fetch`). **SP2c-2 therefore has no
   application-code change** beyond an optional dashboard page-title rebrand.

3. **Cloudflare Access identity = Entra ID (Azure AD) SSO.** WYRE is a
   Microsoft shop (Entra tenant for `wyretechnology.com`, M365, CIPP). Access
   is wired to the Entra IdP (its id supplied via `var.cloudflare_access_idp_id`)
   and restricted to the `@wyretechnology.com` email domain. Setting up the
   Entra IdP in Cloudflare Zero Trust (app registration + IdP record) is an
   operator prerequisite documented in the runbook; the IdP id is then a
   Terraform variable.

4. **Cloudflare credentials.** Terraform needs a Cloudflare API token scoped to
   the `wyre.ai` zone (DNS edit) + Account-level Zero Trust (tunnel + Access
   edit). Provided via a `CLOUDFLARE_API_TOKEN` env var at apply time, never
   committed. The `cloudflare_account_id` and `wyre.ai` `zone_id` become
   Terraform variables. **No token is available at authoring time**, so SP2c-2
   (tunnel) is written and `terraform validate`-clean but applied later;
   SP2c-1 (backups) needs no Cloudflare token and is applied now.

## Architecture (additions to SP2a/b)

```
Engineers ── browser ──▶ https://wyre-agents.wyre.ai
Ops      ── ssh ───────▶ wyre-agents-ssh.wyre.ai
                              │  Cloudflare edge (TLS terminated)
                              │  Access policy: Entra SSO, @wyretechnology.com
                              ▼  Cloudflare Tunnel (outbound from VM)
┌── Azure VM (unchanged NSG: deny all inbound) ───────────────┐
│  cloudflared.service (systemd) — tunnel run --token <kv>    │
│     ingress:                                                │
│       wyre-agents.wyre.ai             → localhost:3000  │
│       wyre-agents-ssh.wyre.ai         → ssh://localhost:22│
│  cortextos.service — daemon + dashboard (served at /)       │
│  data disk /var/lib/cortextos ── Azure Backup (daily, 14d)  │
└──────────────────────────────────────────────────────────────┘
```

## What SP2c ships

1. **`infra/terraform/cloudflare.tf`** — provider config + resources:
   - `cloudflare_zero_trust_tunnel_cloudflared "cortextos"` (remotely-managed).
   - `cloudflare_zero_trust_tunnel_cloudflared_config` — two ingress rules
     (dashboard hostname → :3000, ssh hostname → ssh://:22) + catch-all 404.
   - `cloudflare_record` — CNAME `agents.internal` and `agents-ssh.internal` →
     the tunnel's `cfargotunnel.com` target.
   - `cloudflare_zero_trust_access_application` ×2 ("WYRE Agents" dashboard,
     ssh) + `cloudflare_zero_trust_access_policy` requiring the Entra IdP
     (`var.cloudflare_access_idp_id`) and restricting to `@wyretechnology.com`.
   - Writes the tunnel token to Key Vault
     (`azurerm_key_vault_secret "cloudflared-token"`).

2. **`infra/terraform/backup.tf`** — `azurerm_recovery_services_vault` +
   `azurerm_backup_policy_vm`/disk snapshot policy (daily, 14-day retention)
   attached to the data disk. (If disk-snapshot backup via Recovery Services
   is awkward, fall back to `azurerm_data_protection_backup_vault` +
   `azurerm_data_protection_backup_policy_disk` — decide during implementation
   based on which the provider models cleanly for managed disks.)

3. **cloud-init / systemd additions** (`cloud-init.yaml.tftpl`,
   `infra/systemd/cloudflared.service`):
   - Install `cloudflared` (already referenced by `doctor.ts`).
   - Fetch the tunnel token from Key Vault at first boot (the VM's managed
     identity already has Key Vault Get/List from SP2a).
   - `cloudflared.service` runs `cloudflared tunnel run --token <token>`.
   - Drift checker (`check-systemd-drift.sh`) extended to cover the new unit.

4. **No dashboard routing change** — host-based subdomain routing serves the
   dashboard at `/`, so `next.config.ts` and the 54 client `fetch('/api/...')`
   calls are untouched. Optional: rebrand the dashboard page title to
   "WYRE Agents" (a one-string cosmetic change, not required for SP2c-2).

5. **`docs/runbook/sp2-host.md`** — start/stop/restart, log locations,
   tunnel re-auth, disk growth, **restore-from-snapshot drill** (with timings),
   rollback, break-glass (Azure Bastion start).

6. **`infra/terraform/variables.tf`** — new variables:
   `cloudflare_account_id`, `cloudflare_zone_id`, `cloudflare_zone_name`
   (default `wyre.ai`), `dashboard_hostname` (default `wyre-agents.wyre.ai`),
   `ssh_hostname` (default `wyre-agents-ssh.wyre.ai`),
   `cloudflare_access_idp_id` (Entra IdP id — required for the Access policy),
   `access_email_domain` (default `wyretechnology.com`). (No `dashboard_base_path` —
   host-based routing needs none.)

## Decomposition inside SP2c

Three PRs against `main`, each leaving the system working:

| # | Sub-step | Ships | Risk |
|---|---|---|---|
| **SP2c-1** | Backups | `backup.tf`, restore drill, runbook backup section | Low — pure Terraform + Azure |
| **SP2c-2** | Tunnel + Access | `cloudflare.tf`, `cloudflared.service`, KV token (subdomain routing, no dashboard change) | Medium — Cloudflare provider + Entra IdP wiring |
| **SP2c-3** | Runbook + polish | full `docs/runbook/sp2-host.md`, drift-check extension, CHANGELOG, tag `v0.3.0` | Low |

SP2c-1 first because it's independent and immediately valuable (a running host
with no backups is the scariest state). SP2c-2 is the headline. SP2c-3 closes out.

## Definition of done

- `terraform apply` (with `CLOUDFLARE_API_TOKEN` set) provisions the tunnel,
  DNS, Access apps/policies, and backup vault cleanly; `terraform destroy`
  tears them down without orphan DNS records or stuck tunnels.
- `https://wyre-agents.wyre.ai` loads the dashboard at `/`, gated by Access
  (an un-authenticated request gets the Cloudflare Access login; a
  `@wyretechnology.com` identity gets in).
- `ssh -o ProxyCommand="cloudflared access ssh --hostname wyre-agents-ssh.wyre.ai" ops@wyre-agents-ssh.wyre.ai` works for the ops user.
- A daily snapshot has fired; one snapshot has been restored into a fresh VM
  and the daemon comes up with `smoke/foo` (or equivalent) intact. Timed and
  recorded in the runbook.
- `docs/runbook/sp2-host.md` complete.
- `CHANGELOG.md` updated; a `v0.3.0` tag is cut once SP2c-3 lands.
- The drift checker passes for all three systemd units
  (`cortextos`, `cortextos-bootstrap`, `cloudflared`).

## Risks & open questions

- **Cloudflare API token scope.** The token must cover Zone:DNS:Edit on
  `wyre.ai` AND Account:Cloudflare Tunnel:Edit + Access:Edit. A too-narrow
  token fails mid-apply. The runbook documents the exact scopes.
- **Provider resource names.** The Cloudflare provider renamed several Zero
  Trust resources across v4→v5 (`cloudflare_tunnel` →
  `cloudflare_zero_trust_tunnel_cloudflared`, etc.). SP2c pins the provider
  version and uses the v5 names; implementation must confirm against the
  installed provider version.
- **(Resolved) Path-based routing vs. the dashboard's API calls.** The original
  path-based `/agents` plan was abandoned: the dashboard has 54 client-side
  `fetch('/api/...')` calls that a Next.js `basePath` does not rewrite, so the
  refactor risk was high. Host-based subdomain routing
  (`wyre-agents.wyre.ai`) serves the dashboard at `/` and needs no code
  change. Decided 2026-05-24.
- **Access + SSH UX.** Engineers need `cloudflared` installed locally and an
  `~/.ssh/config` ProxyCommand entry. The runbook provides the snippet; this
  is the same setup Aaron already uses for Conduit.
- **Recovery Services vs Data Protection.** Azure has two backup models for
  managed disks. The provider models them differently; pick the one that
  applies cleanly to a single data disk and document why.
- **Tunnel token rotation.** The token in Key Vault is long-lived. Rotation is
  out of scope for SP2c (documented as a future runbook task).

## Non-goals (deferred)

- **Per-engineer Telegram bot wiring** — SP3.
- **Multi-user Telegram access policy on shared agents** — SP3.
- **New-engineer self-service onboarding** — SP4.
- **Automated deploy on merge-to-main** — SP4.
- **HA / multi-host, tunnel-token rotation automation** — out of scope.
