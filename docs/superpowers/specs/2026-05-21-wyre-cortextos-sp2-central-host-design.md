# WYRE cortextOS — SP2: Central host & deployment

- **Status:** Draft for review
- **Date:** 2026-05-21
- **Author:** Aaron Sachs (with Claude)
- **Initiative:** Team-wide WYRE cortextOS (multi-spec — see SP1 spec for the
  full decomposition)

## Context

SP1 landed the per-engineer namespace foundation on `wyre-technology/cortextos`
(merged as `afb6ebf` in PR #1). The code now structurally supports shared org
agents and per-engineer personal agents on one host. SP2 builds that host.

Decisions already made in brainstorming:
- **Topology:** central host with engineer namespaces (decided in SP1).
- **Host:** Azure VM (not Proxmox, not Container Apps).
- **Reachability:** Cloudflare Tunnel only — no public IP, no NSG ingress.
- **Storage:** single Azure managed premium SSD as a dedicated data disk,
  snapshotted daily.
- **IaC home:** inside this repo, under `infra/`.
- **Dashboard URL:** `internal.wyre.ai/cortextos` (path-based).

## Goal (SP2)

A reproducible Azure deployment of WYRE cortextOS, behind Cloudflare Tunnel,
with backed-up state. After SP2, an operator runs `cortextos add-engineer alice`
on the central host and the resulting namespace persists across reboots,
redeployments, and a verified snapshot restore.

## Architecture

```
Engineers / Telegram
        │
        │ Cloudflare Tunnel (TLS terminated at edge)
        ▼
┌── Azure VNet ────────────────────────────────────────────┐
│ NSG: deny inbound, allow outbound                        │
│ ┌── Azure VM (Ubuntu 22.04 LTS, Standard_D2s_v3) ──────┐ │
│ │  cloudflared (systemd): routes                       │ │
│ │     internal.wyre.ai/cortextos → :3000 (dashboard)   │ │
│ │     cortextos-ssh.internal.wyre.ai → :22 (ops SSH)   │ │
│ │  cortextos.service (systemd → pm2-runtime)           │ │
│ │     cortextos-daemon  +  cortextos-dashboard         │ │
│ │  /opt/cortextos           code (git clone)           │ │
│ │  /var/lib/cortextos       state on data disk         │ │
│ │     ├─ .cortextos/                                   │ │
│ │     ├─ orgs/                                         │ │
│ │     └─ dashboard.sqlite                              │ │
│ └──────────────────────────────────────────────────────┘ │
│ Premium SSD data disk ──── Azure Backup (daily, 14d)    │
│ Azure Key Vault: cloudflared token, infra secrets        │
└──────────────────────────────────────────────────────────┘
```

## Decomposition inside SP2

Even SP2 is too big for one implementation plan. Three sequential PRs against
`wyre-technology/cortextos`, each leaving the system in a working state:

| # | Sub-step | What it ships |
|---|---|---|
| **SP2a** | Terraform skeleton | Provisionable RG + VNet + NSG + VM + data disk + Key Vault. `terraform apply` and `terraform destroy` both clean. VM boots, no app yet. |
| **SP2b** | cloud-init + systemd | VM bootstraps Node, clones the repo, builds, runs the daemon + dashboard under PM2 as the `cortextos` user. State on the data disk. Local-only — no ingress yet. |
| **SP2c** | Cloudflare Tunnel + backups + runbook | `internal.wyre.ai/cortextos` and `cortextos-ssh.internal.wyre.ai` resolve. Daily snapshot policy live. Snapshot-restore drill passes. Runbook checked in. |

## Layout

```
cortextos/
└── infra/
    ├── README.md                # operator quickstart, links to runbook
    ├── terraform/
    │   ├── main.tf              # providers, backend
    │   ├── variables.tf
    │   ├── outputs.tf
    │   ├── network.tf           # VNet, subnet, NSG
    │   ├── vm.tf                # VM, data disk, cloud-init wiring
    │   ├── keyvault.tf
    │   ├── backup.tf            # snapshot vault + policy
    │   ├── cloudflare.tf        # tunnel + DNS records + Access policy
    │   └── cloud-init.yaml.tftpl # rendered with var values
    ├── systemd/
    │   ├── cortextos.service
    │   └── cloudflared.service
    └── bin/
        └── deploy.sh            # operator-run, SSHes via tunnel and pulls
docs/runbook/sp2-host.md         # operations runbook
```

## Detailed design

### Network

- One resource group, one VNet (`10.50.0.0/16`), one subnet (`10.50.1.0/24`).
- NSG attached to the subnet: **deny all inbound**, allow all outbound. No
  exception for SSH — ops SSH flows through Cloudflare Tunnel.
- No public IP on the VM. The VM's only routes to the world are outbound NAT
  and the persistent outbound connection cloudflared opens to Cloudflare.

### VM

- `Standard_D2s_v3` (2 vCPU, 8 GB) as the baseline. Documented in
  `variables.tf` so it's easy to bump.
- Ubuntu 22.04 LTS server image.
- OS disk: standard 64 GB SSD; **disposable** — nothing important lives here.
- Data disk: Premium SSD, 64 GB, attached as `/dev/disk/by-id/...`, mounted at
  `/var/lib/cortextos` via `fstab` (`nofail` for boot safety).
- SSH on the VM is configured for one ops user via a key pair stored in Key
  Vault; cloudflared exposes :22 only over the tunnel.

### State on disk

- `/opt/cortextos` — `git clone`, owned by `cortextos:cortextos`. Updates are
  pulls; the working tree is treated as read-only at runtime by the daemon.
- `/var/lib/cortextos/` — data disk mount point. Contains:
  - `.cortextos/` (the per-instance state the daemon writes to; mirror of
    `~/.cortextos/<instance>` in dev).
  - `orgs/` lives on the data disk at `/var/lib/cortextos/orgs`.
    `/opt/cortextos/orgs` is a **symlink** to it. The daemon writes into
    `orgs/<org>/agents/<name>/memory/` and per-agent `.env` files; routing
    those writes to the data disk keeps them out of the disposable code tree
    and inside the snapshot.
  - `dashboard.sqlite` (and WAL files) — ext4 + premium SSD, so no WAL issues.

### systemd

`cortextos.service` runs as user `cortextos`:

```
[Service]
Type=forking
User=cortextos
Group=cortextos
Environment=CTX_INSTANCE_ID=prod
Environment=CTX_ROOT=/var/lib/cortextos/.cortextos/prod
Environment=CTX_FRAMEWORK_ROOT=/opt/cortextos
Environment=CTX_PROJECT_ROOT=/opt/cortextos
ExecStart=/usr/local/bin/pm2-runtime start /opt/cortextos/ecosystem.config.js
Restart=on-failure
RestartSec=5
```

`cloudflared.service` runs as user `cloudflared`, reads its token from
`/etc/cloudflared/credentials.json` (placed at provisioning time via Key
Vault → cloud-init).

### Cloudflare Tunnel

- One named tunnel, `cortextos-prod`.
- Two ingress rules:
  - `internal.wyre.ai/cortextos` → `http://localhost:3000` (dashboard).
    Requires the dashboard to be configured with Next.js `basePath: '/cortextos'`.
    Documented as a separate small PR against the cortextOS dashboard.
  - `cortextos-ssh.internal.wyre.ai` → `ssh://localhost:22` (ops SSH).
- Cloudflare Access policy on both: WYRE Google Workspace SSO,
  `@wyretechnology.com` email domain only. Same posture as Conduit.

### Backups

- Azure Backup Vault with a single daily policy attached to the data disk.
- 14-day retention.
- Restore is tested as part of SP2c acceptance: snapshot → destroy VM →
  terraform-apply → attach restored disk → daemon comes up with all agents
  intact. This drill is recorded in the runbook with timing.

### Secrets

- Azure Key Vault stores:
  - `cloudflared-token` — the tunnel credentials JSON.
  - `ops-ssh-public-key` — the SSH pubkey injected into the VM at boot.
  - `cortextos-anthropic-api-key` — read by agents at runtime (set as an env
    var in `cortextos.service`).
- Per-agent Telegram bot tokens stay in
  `orgs/wyre/.../agents/<name>/.env` as today; SP2 does **not** centralise
  them. That's SP3's concern.

### Deploy flow

Operator-driven for SP2 v1:

```bash
# from laptop, with cloudflared access pre-configured
cd cortextos/
./infra/bin/deploy.sh prod
```

The script SSHes via tunnel (`ssh cortextos@cortextos-ssh.internal.wyre.ai`)
and runs:

```bash
cd /opt/cortextos
git fetch origin && git reset --hard origin/main
npm ci && npm run build
sudo systemctl restart cortextos
```

Automated deploy on merge-to-main is **explicitly SP4**.

## Definition of done (SP2)

- `terraform apply` from a fresh shell provisions the VM, data disk, Key Vault,
  backup vault, and Cloudflare resources cleanly. `terraform destroy` is also
  clean (Cloudflare resources teardown without orphaning DNS).
- `internal.wyre.ai/cortextos` loads the dashboard behind Cloudflare Access.
- `ssh cortextos@cortextos-ssh.internal.wyre.ai` works for the ops user.
- `cortextos add-engineer alice` on the VM, followed by
  `cortextos add-agent alice/dev --org wyre --template agent`, results in an
  agent the dashboard lists; rebooting the VM brings it back exactly as it was.
- A daily snapshot has fired at least once; one snapshot has been restored
  into a fresh VM and the daemon comes up clean.
- `docs/runbook/sp2-host.md` covers: start/stop/restart, log locations
  (`journalctl -u cortextos -f`, `pm2 logs`, dashboard logs), disk growth,
  tunnel re-auth, restore-from-snapshot, and rollback.
- `CHANGELOG.md` entry under a new `[Unreleased]` section (or a tagged
  `[0.3.0]` once SP2c lands).

## Risks & open questions

- **Next.js basePath wiring.** Path-based routing requires the dashboard to
  build with `basePath: '/cortextos'`. The dashboard has tests; we'll need
  to verify they still pass with the prefix. Light, but real — flagged as
  the first thing to verify in SP2c.
- **cortextOS as a system user.** Upstream docs assume the daemon runs as the
  shell user. Running as a dedicated `cortextos` system user means the
  expected `~/.cortextos` path is now `/var/lib/cortextos/.cortextos`, and
  several CLI commands compute paths against `homedir()`. SP1 didn't touch
  this (it routes path resolution through `resolveAgentDir`, but state paths
  in `src/utils/paths.ts` still use `homedir()`). SP2b must override via
  `CTX_ROOT` and confirm every code path honours it. Add a smoke test to
  the acceptance.
- **PM2 under systemd as PID 2-or-3.** `pm2-runtime` makes PM2 itself the
  foreground process; that pattern is well-documented. Restart semantics
  (`systemctl restart cortextos`) should propagate to the children cleanly.
  Verify in SP2b.
- **Tunnel single point of failure.** If the tunnel drops, the dashboard and
  ops SSH both vanish. Cloudflare Tunnel auto-reconnects; the worst case is
  an outage of Cloudflare's edge. Acceptable given the alternative is a
  public IP. Runbook notes a break-glass: Azure Bastion provisioned but
  stopped, can be started manually for emergency console access.
- **Costs.** Standard_D2s_v3 + 64 GB premium SSD + Key Vault + Cloudflare
  Tunnel (free) ≈ $90/month baseline. Documented in `infra/README.md` so
  there are no surprises.

## Non-goals (deferred)

- **Per-engineer Telegram bot wiring** — SP3.
- **Multi-user Telegram access policy on shared agents** — SP3.
- **New-engineer self-service onboarding** — SP4.
- **Automated deploy on merge-to-main** — SP4.
- **HA / multi-host** — explicitly out of scope; one host is the topology.
- **Containerising cortextOS** — out of scope; the Azure VM choice is
  specifically to avoid this work.
