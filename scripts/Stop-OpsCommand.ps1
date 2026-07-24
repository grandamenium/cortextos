# Stop-OpsCommand.ps1
#
# Stops the cortextos-daemon (Ops Command fleet). Action of the
# "OpsCommand-Stop" Scheduled Task (daily 09:00).
#
# Delegates to scripts/daemon-ops.js, which hard-kills the daemon's PID tree
# (taskkill /T /F) - the only method proven to reliably stop the fleet on
# Windows (pm2 stop/delete hang here). This is a hard stop, not a graceful
# drain: in-flight cron/agent sessions are interrupted and their exits log as
# crashes (cosmetic; reconciled on next start). The cron schedules are
# deliberately kept clear of the 08:00-09:00 approach (nothing fixed-time fires
# after ~07:30) to minimise interrupting real work.
#
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\Stop-OpsCommand.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:USERPROFILE '.cortextos\default\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'ops-command-schedule.log'
function Log($msg) {
    $line = "{0}  [stop]  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log "ERROR: node.exe not found on PATH."; exit 1 }

$wrapper = Join-Path $PSScriptRoot 'daemon-ops.js'
if (-not (Test-Path $wrapper)) { Log "ERROR: daemon-ops.js not found at $wrapper."; exit 1 }

Log "Stopping cortextos-daemon via daemon-ops.js (identity-verified hard taskkill of the PID tree)..."
& $node $wrapper stop
$rc = $LASTEXITCODE

if ($rc -eq 0) {
    Log "Stop confirmed - daemon process is down (or nothing was running)."
} else {
    Log ("Stop FAILED or unconfirmed (daemon-ops.js exit {0}). Daemon may still be alive - check daemon logs. Exit codes: 6 still-alive-after-taskkill / 7 pid identity unverifiable." -f $rc)
}
exit $rc
