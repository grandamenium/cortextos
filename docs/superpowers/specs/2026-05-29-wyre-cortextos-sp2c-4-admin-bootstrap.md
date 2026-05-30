# WYRE cortextOS — SP2c-4: Dashboard admin password bootstrap

- **Status:** Draft for review
- **Date:** 2026-05-29
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — SP2c follow-up

## Context

SP2c-2 brought the central host live behind Cloudflare Tunnel + Entra Access at
`https://wyre-agents.wyre.ai`. Browser-testing the first end-to-end sign-in
surfaced a real gap: once Cloudflare Access + Entra SSO pass, the user lands on
the **cortextOS dashboard's own login form** (NextAuth credentials provider,
SQLite-backed). That form requires an `admin` user whose password is seeded
from the `ADMIN_PASSWORD` env var on first sign-in attempt. **The cloud-init
bootstrap (SP2b) never sets `ADMIN_PASSWORD`**, so a fresh deploy has no usable
dashboard credentials — and the seed function's "user already exists" guard
makes after-the-fact fixes require a fiddly `SYNC_ADMIN_PASSWORD=true` dance
(observed and worked around manually on 2026-05-29).

`dashboard/src/lib/auth.ts:seedAdminUser` is the relevant code path:
- Reads `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` (required).
- Refuses to seed if `ADMIN_PASSWORD` is unset OR is a known default.
- Skips re-seeding when a user exists unless `SYNC_ADMIN_PASSWORD=true`.

The clean fix is to provision an admin password during cloud-init, persist it
to Key Vault so an operator can recover/rotate it without re-running cloud-init,
and document the rotation procedure.

## Goal

After SP2c-4, **a freshly provisioned VM presents a working dashboard login**
on the first browser visit. No manual `dashboard/.env.local` editing. Password
recovery is one `az keyvault secret show` away. Rotation is a documented one-
command flow that survives reboots.

## Decisions

1. **Random password at first boot, stored in Key Vault.** Cloud-init generates
   a 32-character `secrets.token_urlsafe`-style password if a sentinel
   (`/var/lib/cortextos/.admin-password-provisioned`) is absent, writes
   `ADMIN_USERNAME` + `ADMIN_PASSWORD` to `dashboard/.env.local`, **and** stores
   the password in Key Vault as `dashboard-admin-password`. Sentinel makes the
   step idempotent across reboots and bootstrap re-runs.

2. **Key Vault is the source of truth for operator recovery.** Operators do
   not read the password from the VM filesystem (the file is `chmod 600`
   `cortextos:cortextos`, only that user can read it). Recovery is always
   `az keyvault secret show --name dashboard-admin-password --vault-name <vault>`.

3. **The VM's managed identity needs Set permission on Key Vault.** SP2a only
   granted `Get, List` to the VM identity (correct for read-only secrets like
   the cloudflared token). SP2c-4 adds `Set` so cloud-init can write the
   admin password on first boot. Set is scoped to the VM identity; the
   operator's access policy is unchanged.

4. **Rotation is a documented runbook flow, not automated.** The runbook
   describes two paths: (a) regenerate via the dashboard UI's password-change
   form (preferred), (b) hard-rotate via cloud-init by deleting the sentinel
   and the `dashboard-admin-password` KV secret, then re-running the bootstrap
   service. Automating rotation on a schedule is out of scope.

5. **No spec-time SSO substitution.** The dashboard's NextAuth Credentials
   provider stays in place. A future project might replace it with NextAuth's
   Azure AD provider so Entra SSO carries all the way through to the dashboard
   identity. SP2c-4 explicitly does **not** do that — the goal here is to make
   the existing model work, not redesign it.

## What ships

1. **`infra/terraform/cloud-init.yaml.tftpl`** — new bootstrap step
   (`provision_admin_password.sh` helper) that:
   - Skips if `/var/lib/cortextos/.admin-password-provisioned` exists.
   - Otherwise: generate password, write `dashboard/.env.local` (or update only
     `ADMIN_PASSWORD` if file pre-exists), set `ADMIN_USERNAME=admin`, store
     the password to Key Vault via the VM's managed identity, write the
     sentinel, log success.

2. **`infra/terraform/keyvault.tf`** — add `Set` to the VM identity's
   `secret_permissions` list. Operator policy unchanged.

3. **`infra/systemd/cortextos-bootstrap.service`** — no change needed; the
   admin-password step runs inside the existing bootstrap script.

4. **`docs/runbook/sp2-host.md`** — add a "Dashboard admin password" section:
   - Where the password lives (Key Vault), how to retrieve it.
   - Rotation via the dashboard UI (preferred).
   - Hard-rotation via cloud-init (operator deletes sentinel + KV secret,
     restarts the bootstrap service).
   - Note: the operator IP must be on the Key Vault network ACL
     (`operator_ip_cidrs` variable) to read the secret from a laptop.

5. **CHANGELOG entry** under `[Unreleased]`.

## Definition of done

- A `terraform destroy` + `terraform apply` cycle (on a feature branch with
  `cortextos_branch` pointed at this work) brings up a VM where:
  - `az keyvault secret show --name dashboard-admin-password ...` returns a
    non-empty value.
  - `/opt/cortextos/dashboard/.env.local` exists, contains `ADMIN_USERNAME=admin`
    and `ADMIN_PASSWORD=<same as KV>`, owned `cortextos:cortextos`, mode 600.
  - Browser sign-in at `https://wyre-agents.wyre.ai` with the
    KV-stored password succeeds end-to-end. No `SYNC_ADMIN_PASSWORD` dance.
- A reboot does not change the password (sentinel skips the step).
- The hard-rotation runbook procedure has been exercised once and produces a
  new working password.

## Risks & open questions

- **KV write at boot fails if KV firewall isn't ready.** SP2a's KV has
  `network_acls.virtual_network_subnet_ids = [vm subnet]`, so the VM can
  always reach KV from inside. This should be reliable. Bootstrap fails loudly
  if the `az keyvault secret set` call returns non-zero, so the operator sees
  the failure rather than getting a silent half-provisioned state.
- **First-boot ordering.** The admin-password step must run *after* the repo
  clone (so `dashboard/` exists) and *before* `cortextos.service` starts (so
  the dashboard reads the env on its first launch). The bootstrap script
  already has the right order — admin-password slots between `npm run build
  dashboard` and `cortextos install`.
- **Password not changed automatically over time.** A long-running install
  keeps the same password until an operator rotates. That matches every other
  secret in this stack (CF token, Entra app secret). Documented; not solved.

## Non-goals

- **Replacing dashboard auth with Entra SSO** — separate future project.
- **Multi-user dashboard accounts** — the dashboard's user model already
  supports it; SP2c-4 only seeds the single admin account.
- **Automated rotation** — runbook-driven, not scheduled.
