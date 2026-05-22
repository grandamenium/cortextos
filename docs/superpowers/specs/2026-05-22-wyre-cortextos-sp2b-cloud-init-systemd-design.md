# WYRE cortextOS — SP2b: cloud-init bootstrap & systemd

- **Status:** Draft for review
- **Date:** 2026-05-22
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS — second sub-step of SP2

## Context

SP2a (PR #2 → ready to merge) provisions the Azure VM, data disk, network,
and Key Vault via Terraform. The placeholder cloud-init just writes
`/etc/cortextos-stage`. SP2b replaces that placeholder so the VM, on first
boot, comes up running the cortextOS daemon and Next.js dashboard listening on
localhost — still no public ingress (that's SP2c).

The SP2 parent spec warned that running cortextOS as a system user would
require code changes because `src/utils/paths.ts` and ~8 other call sites
use `homedir()` to build state paths. **That worry was misplaced.** With
systemd's `User=cortextos` and the user's home set to `/var/lib/cortextos`,
`homedir()` returns the data-disk mount and the existing code resolves
`~/.cortextos/<instance>` to `/var/lib/cortextos/.cortextos/<instance>`
unchanged. No application-code edits are needed for SP2b. This is the
single most important simplification in this spec.

## Goal (SP2b)

After SP2b, the VM that SP2a provisions boots into a working cortextOS
installation:
- Data disk formatted and mounted at `/var/lib/cortextos`.
- A `cortextos` system user owns the data dir and the code clone.
- cortextOS code lives at `/opt/cortextos` with `orgs/` symlinked to the
  data disk so per-agent state survives a code wipe.
- Two systemd units run under `cortextos`: the daemon and the Next.js
  dashboard, both via `pm2-runtime` from a generated `ecosystem.config.js`.
- `cortextos add-engineer alice && cortextos add-agent alice/dev --org wyre`
  works end-to-end on the live VM.
- Reboot the VM and everything comes back exactly as it was.

SP2b does **not** expose any of this to the internet — that's SP2c.

## Architecture (additions to the SP2a base)

```
Azure VM (existing from SP2a)
├── /etc/cortextos.env       (env file read by both systemd units)
├── /etc/systemd/system/
│   ├── cortextos.service     (the daemon + dashboard via pm2-runtime)
│   └── data-disk.mount       (optional; we mostly use fstab)
├── /opt/cortextos/           (git clone, owned by cortextos:cortextos)
│   ├── ecosystem.config.js   (generated once at first boot)
│   ├── dist/                 (npm run build output)
│   ├── orgs -> /var/lib/cortextos/orgs   (symlink)
│   └── dashboard/            (Next.js project, also built at first boot)
└── /var/lib/cortextos/       (data disk mount; HOME for cortextos user)
    ├── .cortextos/           (per-instance daemon state — homedir() resolves here)
    ├── orgs/                 (shared + per-engineer agent dirs; survives reinstalls)
    └── dashboard.sqlite      (dashboard DB)
```

## What SP2b ships

1. **`infra/terraform/cloud-init.yaml.tftpl`** — a real cloud-config that
   replaces the SP2a placeholder. Rendered via Terraform's
   `templatefile()` so version pins (Node.js, the repo branch, etc.) live
   in `variables.tf`.

2. **`infra/systemd/cortextos.service`** — single unit that runs
   `pm2-runtime start /opt/cortextos/ecosystem.config.js` as the
   `cortextos` user. Environment loaded from `/etc/cortextos.env`.

3. **`infra/systemd/cortextos-bootstrap.service`** (oneshot, runs once at
   first boot, then disabled) — formats and mounts the data disk if not
   already done, creates the `cortextos` user, clones the repo, installs
   dependencies, builds, generates the PM2 ecosystem, and primes
   `.cortextos/<instance>`. Cloud-init invokes this; subsequent reboots
   skip it.

4. **`infra/terraform/vm.tf`** updated: render the new cloud-init via
   `templatefile()`; expose new variables (`cortextos_repo_url`,
   `cortextos_branch`, `cortextos_instance`, `node_major_version`).

5. **One safety net in the codebase**: when systemd runs cortextOS as the
   `cortextos` user, the bash bus scripts in `bus/*.sh` are still relied
   on by some flows. Verify they don't hardcode `$HOME=/home/$USER` (they
   shouldn't — they use `~` which expands to the user's home — but spot
   check). If a fix is needed, it lands in this PR.

## Non-goals (deferred)

- **Cloudflare Tunnel** — SP2c. Until SP2c, the only way to reach the
  dashboard is `az vm run-command` or a temporary Azure Bastion.
- **Daily backups / snapshot policy** — SP2c.
- **The `deploy.sh` operator script** — SP2c. SP2b's deploys happen by
  re-running `terraform apply` (cloud-init bootstrap is idempotent on
  fields that matter; explicit re-bootstrap via systemd unit re-enable).
- **Per-engineer Telegram bot tokens** — SP3.

## Detailed design

### Data disk format and mount

The data disk arrives at `/dev/disk/azure/scsi1/lun10` (or `/dev/sdc` —
SP2a smoke test confirmed `sdc 64G` unpartitioned).

The bootstrap service:
1. Checks for a filesystem on `/dev/disk/azure/scsi1/lun10`. If absent,
   `mkfs.ext4 -L cortextos-data /dev/disk/azure/scsi1/lun10`.
2. Adds an `fstab` entry by-label:
   `LABEL=cortextos-data /var/lib/cortextos ext4 defaults,nofail,x-systemd.device-timeout=10 0 2`.
3. `mount -a`.

The by-label approach survives Azure reassigning device letters across
host moves (rare but real).

### The `cortextos` system user

- `useradd --system --home /var/lib/cortextos --shell /bin/bash cortextos`
  (created **after** the data disk is mounted so the home dir is on the
  data disk).
- `chown -R cortextos:cortextos /var/lib/cortextos /opt/cortextos`.
- The user's `~/.bashrc` exports `CTX_INSTANCE_ID=prod`,
  `CTX_FRAMEWORK_ROOT=/opt/cortextos`, `CTX_PROJECT_ROOT=/opt/cortextos`.
  systemd's `Environment=` lines duplicate these so the daemon doesn't
  depend on shell init.

### Repo clone and build

```
sudo -u cortextos git clone -b ${cortextos_branch} ${cortextos_repo_url} /opt/cortextos
cd /opt/cortextos
sudo -u cortextos npm ci
sudo -u cortextos npm run build
sudo -u cortextos npm --prefix dashboard ci
sudo -u cortextos npm --prefix dashboard run build
```

### `orgs/` symlink

Before the daemon runs, the bootstrap:
1. Moves `/opt/cortextos/orgs` to `/var/lib/cortextos/orgs` (only on first
   bootstrap, when `/var/lib/cortextos/orgs` does not yet exist).
2. Replaces `/opt/cortextos/orgs` with a symlink to
   `/var/lib/cortextos/orgs`.

The daemon's `CTX_FRAMEWORK_ROOT=/opt/cortextos` then resolves
`orgs/<org>/...` to data-disk-backed storage transparently.

### PM2 ecosystem generation

The bootstrap runs (as `cortextos`):
```
cd /opt/cortextos
node dist/cli.js install   # creates ~/.cortextos/prod skeleton (now on data disk)
node dist/cli.js init wyre || true   # idempotent — already exists if repo had orgs/wyre
node dist/cli.js ecosystem --instance prod --org wyre
```

That writes `/opt/cortextos/ecosystem.config.js`. SP2b does not touch
`ecosystem.ts` — SP1 already taught it about namespaces.

### `cortextos.service` (the systemd unit)

```ini
[Unit]
Description=cortextOS daemon (PM2)
After=network-online.target var-lib-cortextos.mount
Wants=network-online.target
Requires=var-lib-cortextos.mount

[Service]
Type=simple
User=cortextos
Group=cortextos
EnvironmentFile=/etc/cortextos.env
WorkingDirectory=/opt/cortextos
ExecStart=/usr/local/bin/pm2-runtime start /opt/cortextos/ecosystem.config.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/cortextos.env` (written by cloud-init):
```
CTX_INSTANCE_ID=prod
CTX_FRAMEWORK_ROOT=/opt/cortextos
CTX_PROJECT_ROOT=/opt/cortextos
CTX_ORG=wyre
NODE_ENV=production
```

`pm2-runtime` runs PM2 in the foreground so systemd can supervise PM2
itself. Restarting `cortextos.service` cleanly restarts the daemon and
dashboard subprocesses.

### Idempotency

The bootstrap unit is `Type=oneshot` with
`ExecStartPre=test ! -f /var/lib/cortextos/.bootstrap-done` and writes
`/var/lib/cortextos/.bootstrap-done` on success. To re-run, the operator
removes the sentinel (`sudo rm /var/lib/cortextos/.bootstrap-done`) and
runs `systemctl start cortextos-bootstrap`.

## Acceptance / Definition of done

- `terraform apply` against the SP2a baseline brings up a VM that, within
  ~5 minutes of cloud-init completing, runs `cortextos.service` cleanly:
  `systemctl status cortextos` → `active (running)`,
  `journalctl -u cortextos --no-pager | tail -50` shows the daemon and
  dashboard starting.
- `az vm run-command invoke ... --scripts 'sudo -u cortextos /opt/cortextos/dist/cli.js list-agents'`
  prints the agents under `orgs/wyre/`.
- Smoke test: `cortextos add-engineer smoke --org wyre &&
  cortextos add-agent smoke/foo --org wyre --template agent` succeeds;
  `list-agents` shows `smoke/foo`.
- Reboot the VM (`az vm restart`); after boot, `cortextos.service` comes
  back up automatically and `smoke/foo` is still there.
- The CHANGELOG `[Unreleased]` section documents the SP2b additions.
- No application-code changes are required — verified by checking
  `git diff main..feat/sp2b-cloud-init -- src/` is empty.

## Risks & open questions

- **`pm2-runtime` vs `systemctl restart` semantics.** PM2's process tree
  needs to die cleanly when systemd sends SIGTERM. `pm2-runtime` handles
  this; verified by `systemctl restart cortextos && systemctl status -l`
  during smoke testing.

- **`npm ci` time on a small VM.** First-boot `npm ci` for the root
  project (~250 deps) plus `dashboard` (~1500 deps) can take 8-12
  minutes on a `Standard_D2s_v3`. Cloud-init will exceed its default
  300s timeout. Bootstrap therefore moves the heavy work into the
  oneshot systemd unit (which has no timeout), with cloud-init only
  doing the minimum: install Node + PM2 + git + jq, write env file,
  enable systemd units. The user reaches a logged-in shell promptly;
  the daemon comes up a few minutes later.

- **Dashboard SQLite WAL on ext4.** No issues expected (we explicitly
  rejected Azure Files for this reason). Verify during smoke testing
  by hitting the dashboard via Bastion / port-forward.

- **Branch pinning.** Cloud-init clones a specific branch
  (`cortextos_branch` Terraform variable, defaults to `main`). For
  initial bring-up we may want to pin to a known-good tag — leave as
  `main` and document that pinning is a one-line `terraform.tfvars`
  change.

- **What if cortextOS later needs a `homedir()`-independent path?** The
  spec relies on the system user's HOME being the data-disk mount. If
  someone refactors `paths.ts` to take an explicit root, fine. Document
  the dependency in `infra/README.md` so the assumption isn't silent.

## Definition of done

- Cloud-init template, bootstrap systemd unit, daemon systemd unit, and
  Terraform wiring committed.
- `terraform apply` against MCPP Subscription brings the VM up; smoke
  tests above pass against the live VM.
- `terraform destroy` clean — no orphan disks, no stuck soft-deleted
  resources.
- `docs/runbook/sp2b-host.md` (a stub — full runbook in SP2c) documents:
  how to read daemon logs, how to re-run bootstrap, where the sentinel
  file lives.
- PR opened against `wyre-technology/cortextos`; SP2c plan referenced
  in the description as the next step.
