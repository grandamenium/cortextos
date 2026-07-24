# Start-OpsCommand.ps1
#
# Starts the cortextos-daemon (Ops Command fleet) ONLY during the 19:00-09:00
# local overnight window. Action of the "OpsCommand-Start" Scheduled Task
# (daily 19:00). Also runnable by hand with -TestOverride for a same-day dry run.
#
# Daemon control is delegated to scripts/daemon-ops.js, a direct (pm2-free)
# launcher. The 2026-07-21 dry run proved pm2 cannot reliably STOP the fleet on
# Windows (pm2 stop/delete hang, kill_timeout SIGKILL doesn't enforce,
# autorestart resurrects the daemon). daemon-ops.js runs the daemon as a plain
# detached node process and stops it with a hard taskkill of its PID tree. See
# its header for the full rationale and trade-offs (no autorestart).
#
# This script's job is the WINDOW GUARD + logging + exit-code propagation.
# The daemon starts persistent Claude sessions for all 3 enabled agents
# immediately, so this is a real fleet start, not a lazy per-cron spawn.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI without a
# BOM, so non-ASCII punctuation (em-dashes, smart quotes) corrupts parsing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\Start-OpsCommand.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\Start-OpsCommand.ps1 -TestOverride

[CmdletBinding()]
param(
    [switch]$TestOverride
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$logDir   = Join-Path $env:USERPROFILE '.cortextos\default\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$logFile  = Join-Path $logDir 'ops-command-schedule.log'
function Log($msg) {
    $line = "{0}  [start] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

# --- time-window guard (19:00-09:00 local: hour greater-equal 19 OR hour less-than 9) ---
$hour = (Get-Date).Hour
$inWindow = ($hour -ge 19) -or ($hour -lt 9)
if ($TestOverride) {
    Log ("TEST OVERRIDE USED - bypassing the 19:00-09:00 window guard (hour={0}). This flag must NEVER be wired into the Scheduled Task." -f $hour)
} elseif (-not $inWindow) {
    Log ("Outside the 19:00-09:00 window (hour={0}) - no-op. Likely a missed/late trigger firing during the day." -f $hour)
    exit 0
}

# --- resolve node + delegate to the programmatic pm2 wrapper ---------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Log "ERROR: node.exe not found on PATH."; exit 1 }

$wrapper   = Join-Path $PSScriptRoot 'daemon-ops.js'
$ecosystem = Join-Path $repoRoot 'ecosystem.config.js'
if (-not (Test-Path $wrapper))   { Log "ERROR: daemon-ops.js not found at $wrapper."; exit 1 }
if (-not (Test-Path $ecosystem)) { Log "ERROR: ecosystem.config.js not found at $ecosystem. Run 'cortextos ecosystem --instance default --org vl-systems' first."; exit 1 }

Log "Starting cortextos-daemon via daemon-ops.js (direct detached node, health-gated)..."
& $node $wrapper start $ecosystem
$rc = $LASTEXITCODE

if ($rc -eq 0) {
    Log "Start confirmed healthy (fresh live daemon.pid). Agents come up as persistent sessions; verify per-agent heartbeat.json."
} else {
    Log ("Start FAILED or unhealthy (daemon-ops.js exit {0}). Check daemon-out.log / daemon-err.log / per-agent logs. Exit codes: 4 app-or-ecosystem-not-found / 5 started-but-agents-did-not-bootstrap." -f $rc)
}
exit $rc
