# WYRE cortextOS SP2c-4 — Dashboard env bootstrap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud-init provisions a working dashboard environment (`ADMIN_PASSWORD`, `AUTH_SECRET`, NextAuth URL config) at first boot, stores recoverable copies in Key Vault, and idempotently skips on re-runs. A freshly provisioned VM presents a working login form on first browser visit with no manual env hacking.

**Architecture:** New step in the cloud-init bootstrap script generates two random secrets if a sentinel file is absent, writes `dashboard/.env.local` (chmod 600, owned by `cortextos`), and stores both values in Key Vault as separate secrets. The VM's existing managed identity, granted a new `Set` permission, is the credential. Sentinel makes the step a no-op across reboots and bootstrap re-runs. Operator recovery is one `az keyvault secret show`.

**Tech Stack:** Bash (cloud-init embedded), `az keyvault secret set`, Terraform `azurerm_key_vault_access_policy`.

**Spec:** `docs/superpowers/specs/2026-05-29-wyre-cortextos-sp2c-4-admin-bootstrap.md`

**Conventions:**
- Working dir `/Users/asachs/cortextos`, branch `feat/sp2c-4-admin-bootstrap` (already checked out).
- After each Terraform task: `terraform fmt -recursive infra/terraform && terraform validate` from `infra/terraform/`.
- After each cloud-init edit: run the YAML validation snippet documented in SP2b's plan/runbook.
- Drift checker should still pass for the systemd units (we're not touching them).
- Commit per task with `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com"`.

---

## Task 1: Key Vault — add Set to VM identity

The VM identity currently has `Get, List`. Cloud-init needs `Set` to upload the generated secrets.

**Files:**
- Modify: `infra/terraform/keyvault.tf`

- [ ] **Step 1: Edit the VM access policy**

In `infra/terraform/keyvault.tf`, find:

```hcl
resource "azurerm_key_vault_access_policy" "vm" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = var.tenant_id
  object_id    = azurerm_linux_virtual_machine.main.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}
```

Change `secret_permissions` to:

```hcl
  secret_permissions = ["Get", "List", "Set"]
```

- [ ] **Step 2: Verify**

```bash
cd infra/terraform && terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/keyvault.tf
git commit -m "feat(infra): grant VM identity Set on Key Vault (cloud-init writes dashboard secrets)"
```

---

## Task 2: cloud-init — provision dashboard env

The provisioning step runs inside the existing bootstrap script. It must run **after** the dashboard's `npm ci && npm run build` (so the `dashboard/` dir exists) and **before** `cortextos.service` starts (so the dashboard reads the env on its first launch).

**Files:**
- Modify: `infra/terraform/cloud-init.yaml.tftpl`

- [ ] **Step 1: Locate the insertion point**

Find the existing block in the embedded bootstrap script that runs the dashboard build:

```bash
      if [ -d /opt/cortextos/dashboard ]; then
        log "npm ci (dashboard)"
        sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos/dashboard && npm ci --no-audit --no-fund'
        log "npm run build (dashboard)"
        sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos/dashboard && npm run build'
      fi
```

Immediately AFTER this block (and before the existing `# ── initialise the org skeleton …` block), insert the new provisioning step:

```bash
      # ── provision dashboard env on first boot (SP2c-4) ─────────
      # Generates ADMIN_PASSWORD + AUTH_SECRET, writes dashboard/.env.local,
      # stores both in Key Vault. Sentinel makes the step idempotent.
      DASHBOARD_ENV=/opt/cortextos/dashboard/.env.local
      SENTINEL=$DATA_MOUNT/.dashboard-env-provisioned
      KV_NAME="${key_vault_name}"
      DASHBOARD_URL="https://${dashboard_hostname}"
      if [ ! -f "$SENTINEL" ] && [ -d /opt/cortextos/dashboard ]; then
        log "provisioning dashboard env (admin password + auth secret)"

        # Login to az with the VM's managed identity (no client secret).
        if ! az account show >/dev/null 2>&1; then
          az login --identity --allow-no-subscriptions >/dev/null
        fi

        # Generate strong random values.
        ADMIN_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
        AUTH_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')

        # Write the env file as the cortextos user.
        sudo -u cortextos bash -lc "cat > $DASHBOARD_ENV <<EOF
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PASSWORD
AUTH_SECRET=$AUTH_SECRET
AUTH_TRUST_HOST=true
NEXTAUTH_URL=$DASHBOARD_URL
AUTH_URL=$DASHBOARD_URL
EOF"
        chmod 600 "$DASHBOARD_ENV"
        chown cortextos:cortextos "$DASHBOARD_ENV"

        # Mirror both secrets to Key Vault for operator recovery.
        az keyvault secret set --vault-name "$KV_NAME" \
          --name dashboard-admin-password --value "$ADMIN_PASSWORD" --output none
        az keyvault secret set --vault-name "$KV_NAME" \
          --name dashboard-auth-secret --value "$AUTH_SECRET" --output none

        # Sentinel — never re-provision on this disk.
        touch "$SENTINEL"
        chown cortextos:cortextos "$SENTINEL"
        log "dashboard env provisioned; secrets mirrored to KV $KV_NAME"

        # Clear local secret variables so they don't leak into later logs.
        unset ADMIN_PASSWORD AUTH_SECRET
      else
        log "dashboard env already provisioned (sentinel present) — skipping"
      fi
```

> Note the `${key_vault_name}` and `${dashboard_hostname}` are new templatefile() substitutions — we add them next.

- [ ] **Step 2: Add the templatefile() substitutions in vm.tf**

In `infra/terraform/vm.tf`, find the `templatefile(…)` call that renders cloud-init. Add two new keys to the substitution map:

```hcl
    key_vault_name     = azurerm_key_vault.main.name
    dashboard_hostname = var.dashboard_hostname
```

- [ ] **Step 3: Ensure `az` and `python3` are installed at this point**

`python3` is already installed by SP2b. `az` is **not** — Azure CLI needs adding to the `packages:` list at the top of the cloud-init template. Microsoft's apt source is the standard install path. Add to the bootstrap script BEFORE the provisioning step (after the node/pm2 install block):

```bash
      # ── install azure-cli for managed-identity-driven KV writes ────
      if ! command -v az >/dev/null 2>&1; then
        log "installing azure-cli (for cloud-init KV writes via managed identity)"
        curl -sL https://aka.ms/InstallAzureCLIDeb | bash >/dev/null
      fi
```

- [ ] **Step 4: Verify YAML + terraform**

```bash
cd infra/terraform
# YAML render check
sed -e 's/${cortextos_instance}/prod/g' \
    -e 's/${cortextos_org}/wyre/g' \
    -e 's|${cortextos_repo_url}|https://github.com/wyre-technology/cortextos|g' \
    -e 's/${cortextos_branch}/main/g' \
    -e 's/${node_major_version}/20/g' \
    -e 's/${key_vault_name}/cortextos-prod-kv-test/g' \
    -e 's/${dashboard_hostname}/wyre-agents.wyre.ai/g' \
    cloud-init.yaml.tftpl | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" && echo "YAML OK"

terraform fmt && terraform validate
```

Expected: `YAML OK` + `Success! The configuration is valid.`.

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/cloud-init.yaml.tftpl infra/terraform/vm.tf
git commit -m "feat(infra): cloud-init provisions dashboard env (ADMIN_PASSWORD, AUTH_SECRET) into KV"
```

---

## Task 3: Apply against the live VM (the controller drives this)

This task is operator-driven — needs the live Azure subscription. Cost: just a reboot.

- [ ] **Step 1: Apply**

```bash
cd infra/terraform
CLOUDFLARE_API_TOKEN='<token>' terraform apply -auto-approve
```

Expected: cloud-init isn't re-run on existing VMs (cloud-init only runs on first boot), so the apply changes the cloud-init *template* but doesn't trigger anything on the running VM. KV `Set` permission is added.

- [ ] **Step 2: Manually trigger the new provisioning step on the live VM**

The existing VM was bootstrapped BEFORE this code existed — the sentinel doesn't exist, so we can run just this step out of band:

```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts '...inline copy of just the provisioning block, with vars substituted...'
```

Then restart the dashboard service:
```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts 'sudo systemctl restart cortextos'
```

- [ ] **Step 3: Verify**

```bash
# Both KV secrets exist
az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 --name dashboard-admin-password --query value -o tsv
az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 --name dashboard-auth-secret --query value -o tsv

# Browser sign-in works with the KV-stored password (no SYNC dance)
# (controller asks user to test in browser; expect success on first attempt)
```

- [ ] **Step 4: Destroy + apply cycle — final SP2c-4 DoD**

For full DoD compliance the cloud-init flow should be exercised end-to-end on a fresh VM:

```bash
terraform destroy -auto-approve
# (then the Azure Backup teardown gotchas if any — see runbook)
terraform apply -auto-approve
# Wait for bootstrap to complete; verify everything per Step 3.
```

This is the "cold-boot proof" — apply against a never-existed VM, browser sign-in works.

If a full cycle is too expensive for this iteration, skip Step 4 and document that the live-VM-only verification was done — the cold-boot proof becomes follow-up.

---

## Task 4: Runbook + CHANGELOG

**Files:**
- Modify: `docs/runbook/sp2-host.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add "Dashboard credentials" section to runbook**

Insert a new section after "Tunnel re-auth" (or wherever fits the TOC ordering):

```markdown
## Dashboard credentials

The dashboard auth model is NextAuth credentials (single admin user, SQLite). Both values are generated at first boot and mirrored to Key Vault:

| Secret | Key Vault name |
|---|---|
| Admin password | `dashboard-admin-password` |
| NextAuth session secret | `dashboard-auth-secret` |

### Recovery

    az keyvault secret show --vault-name cortextos-prod-kv-d1fd92 \
      --name dashboard-admin-password --query value -o tsv

(Your IP must be in `operator_ip_cidrs` first.)

### Rotation — admin password (preferred via dashboard UI)

Sign in → settings → change password. KV stays out of sync after this; the runbook's hard-rotation path is the alternative if you ever need the values to match.

### Hard rotation (delete sentinel, re-provision)

    ssh wyre-agents-ssh.wyre.ai
    sudo rm /var/lib/cortextos/.dashboard-env-provisioned
    sudo az keyvault secret delete --vault-name cortextos-prod-kv-d1fd92 --name dashboard-admin-password
    sudo az keyvault secret delete --vault-name cortextos-prod-kv-d1fd92 --name dashboard-auth-secret
    sudo systemctl start cortextos-bootstrap.service

The provisioning step re-runs, generates fresh values, writes them. **Note:** rotating `AUTH_SECRET` invalidates every active dashboard session — everyone signs out.
```

- [ ] **Step 2: CHANGELOG entry**

Append to the `[Unreleased]` → `### Added`:

```markdown
- SP2c-4 — dashboard env auto-provisioning at first boot. Cloud-init
  generates `ADMIN_PASSWORD` and `AUTH_SECRET`, writes them to
  `dashboard/.env.local`, and stores recoverable copies in Key Vault.
  Idempotent via sentinel file. VM managed identity granted `Set` on
  Key Vault. A fresh VM now presents a working dashboard login on first
  visit with no manual env hacking.
```

And to `### Changed`:

```markdown
- `cortextos ecosystem` now uses `next start` when `NODE_ENV=production`
  (was hardcoded `next dev`, which caused 30-second cold compiles per
  route on deployed installs).
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbook/sp2-host.md CHANGELOG.md
git commit -m "docs: SP2c-4 — dashboard credentials section in runbook + changelog"
git push origin feat/sp2c-4-admin-bootstrap
```

---

## Task 5: PR

- [ ] **Step 1: Open**

```bash
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp2c-4-admin-bootstrap \
  --title "SP2c-4: dashboard env auto-provisioning at first boot" \
  --body "Implements docs/superpowers/specs/2026-05-29-wyre-cortextos-sp2c-4-admin-bootstrap.md. Cloud-init generates ADMIN_PASSWORD + AUTH_SECRET, writes dashboard/.env.local, mirrors to Key Vault. Plus the ecosystem.ts fix to use next start in production. A fresh VM now signs in on first browser visit."
```

---

## Self-review notes

- **Spec coverage:** Task 1 = KV Set permission. Task 2 = the provisioning script + az install + templatefile() substitutions. Task 3 = real-Azure verification. Task 4 = runbook + CHANGELOG. Task 5 = PR. The ecosystem.ts fix is already committed separately (`bf95efb`).
- **Placeholder scan:** Task 3 Step 2 has an "inline copy of just the provisioning block" placeholder — the controller fills in the actual `az vm run-command` script when running Task 3. That's appropriate (it's a Terraform-template substitution we're hand-rendering for an out-of-band invocation).
- **Sequencing:** the new provisioning step explicitly runs after `npm run build dashboard` and before the `cortextos init` block, so the dashboard build artifacts exist when we write the env, and the env exists when `cortextos.service` starts after bootstrap.
