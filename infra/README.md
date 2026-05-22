# infra/

Infrastructure for the WYRE cortextOS central host.

- `terraform/` — Azure provisioning (VM, data disk, network, Key Vault, later: Cloudflare Tunnel).
- `systemd/` — unit files copied to the VM by cloud-init (added in SP2b).
- `bin/` — operator scripts (added in SP2c, e.g. `deploy.sh`).

## Quickstart (SP2a)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars            # fill in subscription, tenant, region, ssh pubkey
terraform init
terraform plan
terraform apply
```

## Cost baseline (SP2a state)

- VM Standard_D2s_v3, premium SSD data disk (64 GB), Key Vault, no traffic.
- ≈ $90/month. Tear down with `terraform destroy` between iterations.

## Drift check (SP2b)

Before `terraform apply`, confirm the systemd units embedded in
`terraform/cloud-init.yaml.tftpl` are byte-identical to the standalone
copies in `systemd/`:

```bash
./bin/check-systemd-drift.sh
```

Expected output (exit 0):

```
OK: cortextos-bootstrap.service
OK: cortextos.service
```

Any `DRIFT:` line means the two copies have diverged. The script prints a
unified diff so you can see exactly what changed. The standalone files in
`systemd/` are the human-readable source of truth for editing; after editing
them, copy the content back into the matching `write_files` entry in
`terraform/cloud-init.yaml.tftpl` and rerun the checker before committing.

The script requires Python 3 and PyYAML (`pip3 install --user pyyaml`). It
uses PyYAML to parse the template rather than text extraction, so it is robust
against indentation changes and YAML formatting quirks.

## Status

| Sub-step | What it ships | State |
|---|---|---|
| SP2a | Provisionable VM + disk + Key Vault skeleton | this PR |
| SP2b | cloud-init + systemd actually run cortextOS | not yet |
| SP2c | Cloudflare Tunnel + backups + runbook | not yet |
