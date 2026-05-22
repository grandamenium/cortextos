#!/usr/bin/env bash
# infra/bin/check-systemd-drift.sh
# Confirm the systemd units inside cloud-init.yaml.tftpl match the standalone
# files in infra/systemd/. Used by operators before `terraform apply`.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFTPL="$INFRA_DIR/terraform/cloud-init.yaml.tftpl"
UNITS_DIR="$INFRA_DIR/systemd"

if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 not found; required for YAML-based drift check" >&2
  exit 2
fi

python3 - "$TFTPL" "$UNITS_DIR" <<'PY'
import sys, os
try:
    import yaml
except ModuleNotFoundError:
    sys.stderr.write(
        "FATAL: PyYAML not installed. Install with one of:\n"
        "  pip3 install --user pyyaml\n"
        "  python3 -m pip install pyyaml\n"
    )
    sys.exit(2)

tftpl_path, units_dir = sys.argv[1], sys.argv[2]

# Strip Terraform ${...} placeholders so YAML can load. Each placeholder is
# replaced with the same harmless token so subsequent string comparison is
# stable.
PLACEHOLDERS = [
    "${cortextos_instance}",
    "${cortextos_org}",
    "${cortextos_repo_url}",
    "${cortextos_branch}",
    "${node_major_version}",
]
text = open(tftpl_path).read()
for ph in PLACEHOLDERS:
    text = text.replace(ph, "X")
data = yaml.safe_load(text)

embedded = {
    f["path"]: f["content"]
    for f in data.get("write_files", [])
    if f.get("path", "").startswith("/etc/systemd/system/")
}

if not embedded:
    sys.stderr.write("FATAL: no systemd unit write_files entries found in cloud-init template\n")
    sys.exit(2)

fail = 0
for path, content in sorted(embedded.items()):
    unit_name = os.path.basename(path)
    standalone_path = os.path.join(units_dir, unit_name)
    if not os.path.exists(standalone_path):
        print(f"DRIFT: {unit_name} embedded in cloud-init but no standalone copy at {standalone_path}")
        fail = 1
        continue
    standalone = open(standalone_path).read()
    if content != standalone:
        print(f"DRIFT: {unit_name} differs between {standalone_path} and {tftpl_path}")
        import difflib
        for line in difflib.unified_diff(
            content.splitlines(keepends=True),
            standalone.splitlines(keepends=True),
            fromfile=f"embedded:{path}",
            tofile=f"standalone:{standalone_path}",
        ):
            sys.stdout.write(line)
        fail = 1
    else:
        print(f"OK: {unit_name}")

sys.exit(fail)
PY
