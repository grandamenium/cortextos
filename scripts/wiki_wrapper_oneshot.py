#!/usr/bin/env python3
"""
wiki_wrapper_oneshot.py — durable one-shot wiki-sync wrapper

Tracked source for the Wiki-Ingestion-Worker Orgo VM.
Replaces the /tmp-only hotfix applied 2026-05-15.

Behaviour
---------
- On each loop iteration: invoke wiki_deep_sync.py (one-shot git
  clone/pull) via subprocess.run (NOT a long-running daemon).
- Check the return code, write a timestamped log entry to
  /tmp/wiki_wrapper.log, then sleep SLEEP_SECONDS (default 7200 = 2 h).
- If /tmp/.gh_token exists, inject GH_TOKEN and GITHUB_TOKEN into the
  child environment so the git clone can authenticate.

VM target
---------
  vm_id   : e0848ad0-70d9-409e-9384-baca933f281a  (Wiki-Ingestion-Worker)
  node_key: orgo-wiki-ingestion-worker
  workload: wiki-ingestion-sync
  runner  : /home/user/wiki-ingestion-sync/runner.py  (vm_workload_runner.py)

This file is the canonical source.  Copy it to /tmp/wiki_wrapper.py on
the VM during provisioning (install_vm_fleet.py or manual bootstrap).
"""

from __future__ import annotations

import datetime
import os
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SYNC_SCRIPT = "/tmp/wiki_deep_sync.py"
LOG_FILE = "/tmp/wiki_wrapper.log"
TOKEN_FILE = "/tmp/.gh_token"
SLEEP_SECONDS = 7200  # 2 hours between sync cycles


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(msg: str) -> None:
    line = f"{_now()} {msg}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    try:
        with open(LOG_FILE, "a") as fh:
            fh.write(line)
    except OSError:
        pass  # /tmp may be read-only in degraded states; best-effort


def _build_env() -> dict:
    """Return a copy of the current env, optionally injecting GH tokens."""
    env = os.environ.copy()
    if os.path.exists(TOKEN_FILE):
        try:
            token = open(TOKEN_FILE).read().strip()
            if token:
                env["GH_TOKEN"] = token
                env["GITHUB_TOKEN"] = token
        except OSError:
            _log(f"WARN: could not read {TOKEN_FILE}")
    return env


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_once(env: dict) -> int:
    """Run wiki_deep_sync.py once; return its exit code."""
    if not os.path.exists(SYNC_SCRIPT):
        _log(f"ERROR: sync script not found: {SYNC_SCRIPT}")
        return 1

    _log(f"START one-shot sync via {SYNC_SCRIPT}")
    try:
        result = subprocess.run(
            [sys.executable, SYNC_SCRIPT],
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        rc = result.returncode
        if result.stdout:
            _log(f"STDOUT: {result.stdout.strip()[:500]}")
        if result.stderr:
            _log(f"STDERR: {result.stderr.strip()[:500]}")
        status = "OK" if rc == 0 else f"FAIL rc={rc}"
        _log(f"END {status}")
        return rc
    except subprocess.TimeoutExpired:
        _log("ERROR: sync script timed out after 300s")
        return 2
    except Exception as exc:  # noqa: BLE001
        _log(f"ERROR: unexpected exception: {exc}")
        return 3


def main() -> None:
    _log(f"wiki_wrapper_oneshot.py starting — cycle={SLEEP_SECONDS}s")
    while True:
        env = _build_env()
        run_once(env)
        _log(f"Sleeping {SLEEP_SECONDS}s until next cycle")
        time.sleep(SLEEP_SECONDS)


if __name__ == "__main__":
    main()
