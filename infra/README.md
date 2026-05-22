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

## Status

| Sub-step | What it ships | State |
|---|---|---|
| SP2a | Provisionable VM + disk + Key Vault skeleton | this PR |
| SP2b | cloud-init + systemd actually run cortextOS | not yet |
| SP2c | Cloudflare Tunnel + backups + runbook | not yet |
