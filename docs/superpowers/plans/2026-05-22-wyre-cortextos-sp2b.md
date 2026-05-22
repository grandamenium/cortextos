# WYRE cortextOS SP2b — cloud-init & systemd — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SP2a's placeholder cloud-init with a real bootstrap so a freshly-provisioned VM comes up running the cortextOS daemon and dashboard as a `cortextos` system user, with state on the mounted data disk, surviving reboots — no public ingress yet.

**Architecture:** Terraform renders `cloud-init.yaml.tftpl` via `templatefile()`. Cloud-init does only the fast, deterministic work (install packages, write systemd unit files, enable them). A `cortextos-bootstrap.service` oneshot handles the slow work (format disk, create user, clone repo, `npm ci`, build, generate ecosystem) once on first boot. `cortextos.service` runs `pm2-runtime` against the generated `ecosystem.config.js` thereafter. All state lives on the data disk at `/var/lib/cortextos`, which is also the `cortextos` user's `HOME` — so existing `homedir()`-based path resolution in the application works without modification.

**Tech Stack:** Cloud-init (YAML), systemd (oneshot + simple), Terraform (`templatefile()`), Node.js 20, PM2 (`pm2-runtime`), Ubuntu 22.04 LTS.

**Spec:** `docs/superpowers/specs/2026-05-22-wyre-cortextos-sp2b-cloud-init-systemd-design.md`

**Conventions for every task below:**
- Working dir: `/Users/asachs/cortextos`. Branch: `feat/sp2b-cloud-init` (already checked out).
- Commit with `git -c user.name="Aaron Sachs" -c user.email="aaron@wyretechnology.com" commit -m "..."`. Conventional Commits.
- After every Terraform task: `terraform fmt -recursive infra/terraform && terraform validate` (from `infra/terraform/`).
- After every shell/systemd task: `shellcheck` the script if shellcheck is installed; `systemd-analyze verify infra/systemd/*.service` if installed. If neither tool is installed, skip — these are quality nets, not gates.
- File ownership in cloud-init: scripts and unit files are written as `root:root` 0644 / 0755 unless noted.

---

## Task 1: Cloud-init template — minimal install layer

The fast layer: install Node.js, PM2, git, and jq; create the data-disk fstab entry; write `/etc/cortextos.env`; drop the two systemd units and a bootstrap script; enable everything. Heavy lifting (npm ci, build, repo clone) is **not** here — that's the bootstrap unit in Task 3 to keep cloud-init under its default 300s timeout.

**Files:**
- Create: `infra/terraform/cloud-init.yaml.tftpl`

- [ ] **Step 1: Write the template**

```yaml
#cloud-config
# WYRE cortextOS — first-boot bootstrap (SP2b)
# Rendered from cloud-init.yaml.tftpl. Variables in ${...} are templatefile() substitutions.

package_update: true
package_upgrade: false
package_reboot_if_required: false

packages:
  - git
  - jq
  - build-essential
  - ca-certificates
  - curl
  - python3   # Some npm deps still need it for node-gyp on first install
  - e2fsprogs # mkfs.ext4

write_files:

  # ── 1. Environment file consumed by both systemd units ─────────
  - path: /etc/cortextos.env
    permissions: "0644"
    owner: root:root
    content: |
      CTX_INSTANCE_ID=${cortextos_instance}
      CTX_FRAMEWORK_ROOT=/opt/cortextos
      CTX_PROJECT_ROOT=/opt/cortextos
      CTX_ORG=${cortextos_org}
      NODE_ENV=production
      HOME=/var/lib/cortextos

  # ── 2. The slow-bootstrap script run by cortextos-bootstrap.service ──
  - path: /usr/local/sbin/cortextos-bootstrap.sh
    permissions: "0755"
    owner: root:root
    content: |
      #!/usr/bin/env bash
      # Slow, one-shot first-boot bootstrap. Idempotent on every step;
      # the systemd unit also guards with /var/lib/cortextos/.bootstrap-done.
      set -euo pipefail

      log() { printf '[bootstrap] %s\n' "$*"; }

      DATA_DEV="/dev/disk/azure/scsi1/lun10"
      DATA_LABEL="cortextos-data"
      DATA_MOUNT="/var/lib/cortextos"
      REPO_URL="${cortextos_repo_url}"
      REPO_BRANCH="${cortextos_branch}"
      INSTANCE="${cortextos_instance}"
      ORG="${cortextos_org}"

      # ── format the data disk if blank ───────────────────────────
      log "checking data disk at $DATA_DEV"
      if ! blkid "$DATA_DEV" >/dev/null 2>&1; then
        log "formatting $DATA_DEV as ext4 (label=$DATA_LABEL)"
        mkfs.ext4 -L "$DATA_LABEL" "$DATA_DEV"
      else
        log "data disk already has a filesystem; skipping mkfs"
      fi

      mkdir -p "$DATA_MOUNT"
      if ! grep -q "^LABEL=$DATA_LABEL" /etc/fstab; then
        log "adding fstab entry"
        echo "LABEL=$DATA_LABEL $DATA_MOUNT ext4 defaults,nofail,x-systemd.device-timeout=10 0 2" >> /etc/fstab
      fi
      if ! mountpoint -q "$DATA_MOUNT"; then
        log "mounting $DATA_MOUNT"
        mount "$DATA_MOUNT"
      fi

      # ── create cortextos user with data-disk HOME ──────────────
      if ! id cortextos >/dev/null 2>&1; then
        log "creating cortextos system user (HOME=$DATA_MOUNT)"
        useradd --system --home-dir "$DATA_MOUNT" --shell /bin/bash cortextos
      fi
      chown -R cortextos:cortextos "$DATA_MOUNT"

      # ── install Node.js LTS via NodeSource ─────────────────────
      if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//;s/\..*//')" -lt "${node_major_version}" ]; then
        log "installing Node.js ${node_major_version}.x"
        curl -fsSL "https://deb.nodesource.com/setup_${node_major_version}.x" | bash -
        apt-get install -y nodejs
      fi

      # ── install pm2 globally ───────────────────────────────────
      if ! command -v pm2-runtime >/dev/null 2>&1; then
        log "installing pm2"
        npm install -g pm2
      fi

      # ── clone repo ─────────────────────────────────────────────
      if [ ! -d /opt/cortextos/.git ]; then
        log "cloning $REPO_URL (branch $REPO_BRANCH) to /opt/cortextos"
        git clone --branch "$REPO_BRANCH" "$REPO_URL" /opt/cortextos
      else
        log "/opt/cortextos already a git clone; pulling"
        git -C /opt/cortextos fetch --all --quiet
        git -C /opt/cortextos checkout --quiet "$REPO_BRANCH"
        git -C /opt/cortextos pull --ff-only --quiet
      fi
      chown -R cortextos:cortextos /opt/cortextos

      # ── move orgs/ to data disk on first boot, symlink ─────────
      if [ -d /opt/cortextos/orgs ] && [ ! -L /opt/cortextos/orgs ]; then
        if [ ! -d "$DATA_MOUNT/orgs" ]; then
          log "relocating orgs/ to $DATA_MOUNT/orgs"
          mv /opt/cortextos/orgs "$DATA_MOUNT/orgs"
        else
          log "$DATA_MOUNT/orgs exists; discarding repo's orgs/"
          rm -rf /opt/cortextos/orgs
        fi
        ln -s "$DATA_MOUNT/orgs" /opt/cortextos/orgs
        chown -h cortextos:cortextos /opt/cortextos/orgs
      fi
      chown -R cortextos:cortextos "$DATA_MOUNT/orgs" || true

      # ── npm ci + build (root project) ──────────────────────────
      log "npm ci (root)"
      sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos && npm ci --no-audit --no-fund'
      log "npm run build (root)"
      sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos && npm run build'

      # ── dashboard install + build ──────────────────────────────
      if [ -d /opt/cortextos/dashboard ]; then
        log "npm ci (dashboard)"
        sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos/dashboard && npm ci --no-audit --no-fund'
        log "npm run build (dashboard)"
        sudo -u cortextos --preserve-env=HOME bash -lc 'cd /opt/cortextos/dashboard && npm run build'
      fi

      # ── generate ecosystem.config.js ───────────────────────────
      log "running cortextos install/ecosystem"
      sudo -u cortextos --preserve-env=HOME bash -lc "cd /opt/cortextos && node dist/cli.js install --instance $INSTANCE || true"
      sudo -u cortextos --preserve-env=HOME bash -lc "cd /opt/cortextos && node dist/cli.js ecosystem --instance $INSTANCE --org $ORG --output /opt/cortextos/ecosystem.config.js"

      # ── sentinel ───────────────────────────────────────────────
      touch "$DATA_MOUNT/.bootstrap-done"
      chown cortextos:cortextos "$DATA_MOUNT/.bootstrap-done"
      log "bootstrap complete"

  # ── 3. cortextos-bootstrap.service (oneshot, gated by sentinel) ──
  - path: /etc/systemd/system/cortextos-bootstrap.service
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=cortextOS first-boot bootstrap (format disk, create user, clone, build)
      After=network-online.target cloud-init.service
      Wants=network-online.target
      ConditionPathExists=!/var/lib/cortextos/.bootstrap-done

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/usr/local/sbin/cortextos-bootstrap.sh
      TimeoutStartSec=1800

      [Install]
      WantedBy=multi-user.target

  # ── 4. cortextos.service (the daemon + dashboard via pm2-runtime) ──
  - path: /etc/systemd/system/cortextos.service
    permissions: "0644"
    owner: root:root
    content: |
      [Unit]
      Description=cortextOS daemon (PM2)
      After=network-online.target cortextos-bootstrap.service
      Wants=network-online.target
      Requires=cortextos-bootstrap.service

      [Service]
      Type=simple
      User=cortextos
      Group=cortextos
      EnvironmentFile=/etc/cortextos.env
      WorkingDirectory=/opt/cortextos
      ExecStart=/usr/bin/pm2-runtime start /opt/cortextos/ecosystem.config.js
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target

runcmd:
  - systemctl daemon-reload
  - systemctl enable cortextos-bootstrap.service
  - systemctl enable cortextos.service
  - systemctl start cortextos-bootstrap.service
  # cortextos.service starts itself once bootstrap finishes (Requires=).
```

- [ ] **Step 2: Verify template renders**

Quick sanity check that the file is valid YAML when the templatefile variables are filled in. From `infra/terraform/`:

```bash
# Hand-render with a fake var set just to validate YAML shape.
sed -e 's/${cortextos_instance}/prod/g' \
    -e 's/${cortextos_org}/wyre/g' \
    -e 's|${cortextos_repo_url}|https://github.com/wyre-technology/cortextos|g' \
    -e 's/${cortextos_branch}/main/g' \
    -e 's/${node_major_version}/20/g' \
    cloud-init.yaml.tftpl | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" && echo "YAML OK"
```

Expected: prints `YAML OK`. If `python3 -c "import yaml"` fails (PyYAML not installed), use `cloud-init schema --config-file -` from a system with cloud-init installed — or skip this check; Terraform's `terraform validate` in Task 4 catches template-substitution errors.

- [ ] **Step 3: Commit**

```bash
git add infra/terraform/cloud-init.yaml.tftpl
git commit -m "feat(infra): real cloud-init template (install layer + units)"
```

---

## Task 2: Mirror cortextos.service into `infra/systemd/`

The unit file is authoritative inside the cloud-init template; this task duplicates it (and the bootstrap unit) into `infra/systemd/` for **reading convenience** and for any future "install onto an existing host" path. The two copies must stay in sync — Task 7 adds a CI-equivalent check that fails if they drift.

**Files:**
- Create: `infra/systemd/cortextos.service`
- Create: `infra/systemd/cortextos-bootstrap.service`

- [ ] **Step 1: Write `infra/systemd/cortextos.service`**

```ini
[Unit]
Description=cortextOS daemon (PM2)
After=network-online.target cortextos-bootstrap.service
Wants=network-online.target
Requires=cortextos-bootstrap.service

[Service]
Type=simple
User=cortextos
Group=cortextos
EnvironmentFile=/etc/cortextos.env
WorkingDirectory=/opt/cortextos
ExecStart=/usr/bin/pm2-runtime start /opt/cortextos/ecosystem.config.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `infra/systemd/cortextos-bootstrap.service`**

```ini
[Unit]
Description=cortextOS first-boot bootstrap (format disk, create user, clone, build)
After=network-online.target cloud-init.service
Wants=network-online.target
ConditionPathExists=!/var/lib/cortextos/.bootstrap-done

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/cortextos-bootstrap.sh
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Verify (if systemd-analyze available)**

If you have a Linux box (or a Docker container with systemd) handy:

```bash
systemd-analyze verify infra/systemd/cortextos.service infra/systemd/cortextos-bootstrap.service
```

Expected: no errors. On macOS this binary isn't available — skip; Task 6 catches structural problems at boot.

- [ ] **Step 4: Commit**

```bash
git add infra/systemd/
git commit -m "feat(infra): systemd unit files for daemon + bootstrap"
```

---

## Task 3: Terraform — new variables for bootstrap parameters

The cloud-init template needs five variables that Terraform substitutes. Add them with sensible defaults so most operators never set them in `terraform.tfvars`.

**Files:**
- Modify: `infra/terraform/variables.tf`

- [ ] **Step 1: Append to `variables.tf`**

Add at the bottom of `infra/terraform/variables.tf`:

```hcl
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
git add infra/terraform/variables.tf
git commit -m "feat(infra): cloud-init / bootstrap Terraform variables"
```

---

## Task 4: Terraform — wire the rendered cloud-init into the VM

Replace the heredoc placeholder in `vm.tf` with a `templatefile()` call against the new template.

**Files:**
- Modify: `infra/terraform/vm.tf` (the `cloud_init_placeholder` local and the VM's `custom_data` attribute)

- [ ] **Step 1: Replace the placeholder local**

In `infra/terraform/vm.tf`, find this block:

```hcl
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
```

Replace it with:

```hcl
locals {
  cloud_init_rendered = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    cortextos_instance    = var.cortextos_instance
    cortextos_org         = var.cortextos_org
    cortextos_repo_url    = var.cortextos_repo_url
    cortextos_branch      = var.cortextos_branch
    node_major_version    = var.node_major_version
  })
}
```

- [ ] **Step 2: Point the VM at the rendered template**

In the same file, in the `azurerm_linux_virtual_machine "main"` resource, find:

```hcl
  custom_data = base64encode(local.cloud_init_placeholder)
```

Replace with:

```hcl
  custom_data = base64encode(local.cloud_init_rendered)
```

- [ ] **Step 3: Verify**

```bash
cd infra/terraform
terraform fmt
terraform validate
```

Expected: clean.

Then a render-only sanity check:

```bash
terraform plan -out=/tmp/sp2b.tfplan >/dev/null
terraform show -json /tmp/sp2b.tfplan | \
  jq -r '.planned_values.root_module.resources[] | select(.address=="azurerm_linux_virtual_machine.main") | .values.custom_data' | \
  base64 -d | head -30
rm /tmp/sp2b.tfplan
```

Expected output: the first ~30 lines of the cortextOS cloud-config with `${...}` placeholders substituted to real values (e.g. `CTX_INSTANCE_ID=prod`). Confirms the template renders.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/vm.tf
git commit -m "feat(infra): render cortextOS cloud-init via templatefile()"
```

---

## Task 5: Drift check — keep the in-repo systemd units in sync with cloud-init

The two systemd unit files exist twice: once embedded in `cloud-init.yaml.tftpl`, once standalone in `infra/systemd/`. They must stay identical. Add a small verifier that ops can run before deploying.

**Files:**
- Create: `infra/bin/check-systemd-drift.sh`

- [ ] **Step 1: Write the verifier**

```bash
#!/usr/bin/env bash
# infra/bin/check-systemd-drift.sh
# Confirm the systemd units inside cloud-init.yaml.tftpl match the standalone
# files in infra/systemd/. Used by operators before `terraform apply`.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFTPL="$INFRA_DIR/terraform/cloud-init.yaml.tftpl"
UNITS_DIR="$INFRA_DIR/systemd"

fail=0
check() {
  local unit="$1"
  local standalone="$UNITS_DIR/$unit"
  local embedded
  # Extract the body of the matching write_files block in cloud-init.yaml.tftpl.
  # Body is indented with 6 spaces (under `- path:` and `content: |`).
  embedded="$(awk -v unit="$unit" '
    $0 ~ "path: /etc/systemd/system/" unit "$" { found=1 }
    found && /content: \|/ { incontent=1; next }
    incontent && /^  - path:/ { exit }
    incontent && /^[^ ]/      { exit }
    incontent { sub(/^      /, "", $0); print }
  ' "$TFTPL")"

  if ! diff -u <(cat "$standalone") <(printf '%s' "$embedded") >/dev/null; then
    echo "DRIFT: $unit differs between $standalone and $TFTPL"
    diff -u <(cat "$standalone") <(printf '%s' "$embedded") || true
    fail=1
  else
    echo "OK: $unit"
  fi
}

check cortextos.service
check cortextos-bootstrap.service

exit "$fail"
```

- [ ] **Step 2: Make it executable and run it**

```bash
chmod +x infra/bin/check-systemd-drift.sh
./infra/bin/check-systemd-drift.sh
```

Expected: `OK: cortextos.service` and `OK: cortextos-bootstrap.service`. If it reports DRIFT, the file contents diverged during Task 1/2 — fix by editing whichever copy is wrong so the diff is empty.

- [ ] **Step 3: Document the verifier**

Append to `infra/README.md`, after the existing "Quickstart" section:

```markdown
## Pre-deploy checks

Before running `terraform apply` after touching either the cloud-init template
or the standalone systemd unit files:

    ./infra/bin/check-systemd-drift.sh

Fails non-zero if the embedded unit definitions in
`terraform/cloud-init.yaml.tftpl` have drifted from the standalone copies in
`systemd/`. Keep them identical — the standalone files are the human-readable
source of truth.
```

- [ ] **Step 4: Commit**

```bash
git add infra/bin/check-systemd-drift.sh infra/README.md
git commit -m "feat(infra): drift check between cloud-init and standalone systemd units"
```

---

## Task 6: Apply against MCPP and smoke-test the bootstrap

This task runs real Azure and proves the bootstrap actually works. Cost: ~$0.10 of VM compute for the full test cycle (most of which is destroyed at the end).

- [ ] **Step 1: Apply**

```bash
cd infra/terraform
# terraform.tfvars from SP2a is still present and valid.
terraform apply -auto-approve
```

Expected: ~5 minutes, all 12 resources created.

- [ ] **Step 2: Wait for cortextos.service to come up**

The bootstrap takes ~8-12 minutes after `terraform apply` returns (npm ci on a `Standard_D2s_v3` is the slow part). Poll until ready:

```bash
# Use Bash `run_in_background: true` for this exact pattern — one notification when ready.
until az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
        --command-id RunShellScript \
        --scripts 'systemctl is-active cortextos.service' \
        --query "value[0].message" -o tsv 2>/dev/null | grep -q '^active$'; do
  sleep 30
done
echo "cortextos.service is active"
```

Expected: eventually prints `cortextos.service is active`. If it never goes active, dump diagnostics with the next step.

- [ ] **Step 3: Bootstrap diagnostics — first proof of life**

```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts '
    echo "--- bootstrap unit ---"
    systemctl is-active cortextos-bootstrap.service || true
    echo "--- daemon unit ---"
    systemctl status cortextos.service --no-pager -n 30 || true
    echo "--- mounts ---"
    findmnt /var/lib/cortextos || true
    echo "--- orgs symlink ---"
    ls -la /opt/cortextos/orgs
    echo "--- pm2 list (as cortextos) ---"
    sudo -u cortextos /usr/bin/pm2 list || true
  ' --query "value[0].message" -o tsv
```

Required outputs:
- bootstrap unit reports `inactive` (oneshot completed and exited).
- daemon status reports `Active: active (running)`.
- `findmnt` shows the data disk mounted at `/var/lib/cortextos`.
- `orgs` is a symlink pointing into `/var/lib/cortextos/orgs/`.
- pm2 list shows `cortextos-daemon` (and `cortextos-dashboard` if present) in `online` state.

If any required output is missing, that's a SP2b defect — collect `journalctl -u cortextos-bootstrap.service --no-pager` and `journalctl -u cortextos.service --no-pager`, fix the relevant code, then re-run from Step 1 of this task (after `terraform destroy` first).

- [ ] **Step 4: Functional smoke — namespace round-trip on the live VM**

```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts '
    set -e
    sudo -u cortextos --preserve-env=HOME bash -lc "
      cd /opt/cortextos &&
      node dist/cli.js add-engineer smoke --org wyre &&
      node dist/cli.js add-agent smoke/foo --org wyre --template agent &&
      node dist/cli.js list-agents | grep smoke
    "
  ' --query "value[0].message" -o tsv
```

Expected: output contains a line with `smoke/foo`. This is the proof that SP1's namespace work survives the SP2b transplant.

- [ ] **Step 5: Reboot test**

```bash
az vm restart -g cortextos-prod-rg -n cortextos-prod-vm
# wait
until az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
        --command-id RunShellScript \
        --scripts 'systemctl is-active cortextos.service' \
        --query "value[0].message" -o tsv 2>/dev/null | grep -q '^active$'; do
  sleep 15
done
# verify the smoke agent still exists
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts 'sudo -u cortextos --preserve-env=HOME bash -lc "cd /opt/cortextos && node dist/cli.js list-agents"' \
  --query "value[0].message" -o tsv | grep smoke
```

Expected: `smoke/foo` is still listed after reboot. The bootstrap unit must **not** re-run (sentinel file present) — verify with:

```bash
az vm run-command invoke -g cortextos-prod-rg -n cortextos-prod-vm \
  --command-id RunShellScript \
  --scripts 'cat /var/lib/cortextos/.bootstrap-done && echo "(sentinel intact)"; systemctl is-enabled cortextos-bootstrap.service' \
  --query "value[0].message" -o tsv
```

Expected: sentinel content (a timestamp or empty), and the unit reports `enabled` but inactive — the `ConditionPathExists=!/var/lib/cortextos/.bootstrap-done` guard short-circuited it on boot.

- [ ] **Step 6: Destroy**

```bash
terraform destroy -auto-approve
```

Expected: clean teardown.

- [ ] **Step 7: Commit any fix-ups discovered during the apply**

If steps 3-5 surfaced defects requiring `.tftpl` / `.tf` / `.service` changes, commit them now:

```bash
git add infra/
git commit -m "fix(infra): adjustments from first sp2b apply"
```

If none, skip. Either way, push the branch:

```bash
git push -u origin feat/sp2b-cloud-init
```

---

## Task 7: CHANGELOG and PR

- [ ] **Step 1: Update `CHANGELOG.md`**

Append to the existing `[Unreleased]` section's **Added** list (the section opened in SP1):

```markdown
- SP2b — cloud-init bootstrap and systemd units (`cortextos.service`,
  `cortextos-bootstrap.service`) under `infra/`. Fresh Azure VM provisioned
  by `infra/terraform/` boots into a working cortextOS install with state
  on the mounted data disk.
- `infra/bin/check-systemd-drift.sh` keeps the embedded and standalone
  systemd unit definitions in sync.
```

Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG entry for SP2b"
git push origin feat/sp2b-cloud-init
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --repo wyre-technology/cortextos --base main --head feat/sp2b-cloud-init \
  --title "SP2b: cloud-init bootstrap and systemd units" \
  --body "Implements docs/superpowers/specs/2026-05-22-wyre-cortextos-sp2b-cloud-init-systemd-design.md.

A freshly-provisioned VM now boots into a working cortextOS install: data disk formatted and mounted at /var/lib/cortextos, cortextos system user with HOME on the data disk, repo cloned to /opt/cortextos with orgs/ symlinked into the data disk, two systemd units (cortextos-bootstrap.service oneshot + cortextos.service long-running) under pm2-runtime supervision.

Key simplification: no application-code changes are needed. systemd's User=cortextos with HOME=/var/lib/cortextos makes existing homedir()-based path resolution in src/utils/paths.ts and the bus/* scripts resolve to data-disk paths automatically.

Verified end-to-end against MCPP Subscription: apply → bootstrap completed → cortextos.service active → cortextos add-engineer smoke + add-agent smoke/foo succeeded on the live VM → VM rebooted → smoke/foo still present → destroy clean.

Next: SP2c — Cloudflare Tunnel, Azure Backup, runbook."
```

---

## Self-review notes

- **Spec coverage:**
  - Data disk format + mount → Task 1 (script), Task 6 step 3 (verification).
  - `cortextos` system user with HOME on data disk → Task 1 (script).
  - Repo clone + npm ci + build → Task 1 (script).
  - `orgs/` symlink → Task 1 (script), Task 6 step 3 (verification).
  - `cortextos-bootstrap.service` oneshot with sentinel → Task 1, Task 6 step 5.
  - `cortextos.service` via pm2-runtime → Task 1 & Task 2.
  - Terraform variables for repo/branch/instance/org/node-major → Task 3.
  - `templatefile()` wiring → Task 4.
  - End-to-end apply + smoke + reboot + destroy → Task 6.
  - No application-code edits (spec's stated invariant) → no task touches `src/`. The spec's "verify bus scripts don't hardcode HOME" line is covered indirectly: the bootstrap runs everything via `sudo -u cortextos --preserve-env=HOME`, so any bash script reading `$HOME` reads `/var/lib/cortextos`. If a real defect surfaces in Task 6, it lands in a Task-6 fix commit.

- **Placeholder scan:** No TBDs, no "add appropriate", no "similar to". The bootstrap script is full; the systemd units are full; the verifier is full. The only place I leaned on convention rather than code is the `package_reboot_if_required: false` line at the top of the cloud-init — that's a cloud-init directive, not a placeholder.

- **Type / name consistency:** Variable names `cortextos_instance`, `cortextos_org`, `cortextos_repo_url`, `cortextos_branch`, `node_major_version` are referenced identically in `variables.tf`, `vm.tf`'s `templatefile()` call, and the `${...}` placeholders in the template. Unit names `cortextos-bootstrap.service` and `cortextos.service` are used consistently across cloud-init, standalone files, the drift checker, and the verification steps.

- **One thing the engineer should be told but isn't in the steps**: if `npm ci` fails inside the bootstrap, the daemon will never start. The diagnostic step (Task 6 step 3) reports `cortextos.service` status but a failed bootstrap leaves the daemon `inactive (failed)` and the bootstrap unit `failed`. The implementer should treat "failed" on the bootstrap unit as a fatal-but-recoverable: `journalctl -u cortextos-bootstrap.service --no-pager -n 200`, delete `/var/lib/cortextos/.bootstrap-done`, and `systemctl start cortextos-bootstrap.service` to retry without re-provisioning.
