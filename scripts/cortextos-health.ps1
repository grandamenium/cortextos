# cortextos-health.ps1
# One-shot health check for cortextOS on Windows. Reports:
#   - PM2 daemon + dashboard status, uptime, restart count
#   - Daemon AttachConsole crash count (last 1h, last 24h)
#   - Per-agent Telegram poller state (started / conflict-self-die / running)
#   - Per-agent last outbound message timestamp
#   - BUG-011 alarm count (last 1h)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\cortextos-health.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\cortextos-health.ps1 -Instance default

[CmdletBinding()]
param(
    [string]$Instance = 'default'
)

$ErrorActionPreference = 'Stop'

$ctxRoot = Join-Path $env:USERPROFILE ".cortextos\$Instance"
$pm2LogDir = Join-Path $env:USERPROFILE '.pm2\logs'
$daemonOutLog = Join-Path $pm2LogDir 'cortextos-daemon-out.log'
$daemonErrLog = Join-Path $pm2LogDir 'cortextos-daemon-error.log'

Write-Host ""
Write-Host "===== cortextOS Health Check =====" -ForegroundColor Cyan
Write-Host "Instance: $Instance"
Write-Host "CTX_ROOT: $ctxRoot"
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') UTC$([TimeZoneInfo]::Local.BaseUtcOffset.TotalHours)"
Write-Host ""

# --- PM2 status ---------------------------------------------------------
Write-Host "--- PM2 processes ---" -ForegroundColor Yellow
try {
    $pm2Raw = & pm2 jlist 2>$null | Out-String
    if ($pm2Raw) {
        $pm2List = $pm2Raw | ConvertFrom-Json
        foreach ($p in $pm2List) {
            $status = $p.pm2_env.status
            $restarts = $p.pm2_env.restart_time
            $uptimeMs = if ($p.pm2_env.pm_uptime) { (Get-Date).ToFileTimeUtc() / 10000 - $p.pm2_env.pm_uptime } else { 0 }
            $uptimeMin = [math]::Round($uptimeMs / 60000, 1)
            $color = if ($status -eq 'online') { 'Green' } else { 'Red' }
            Write-Host ("  {0,-26} {1,-9} pid={2,-7} restarts={3,-4} uptime~={4}min" -f $p.name, $status, $p.pid, $restarts, $uptimeMin) -ForegroundColor $color
        }
    } else {
        Write-Host "  pm2 jlist returned no data" -ForegroundColor Red
    }
} catch {
    Write-Host "  pm2 not available or errored: $_" -ForegroundColor Red
}
Write-Host ""

# --- AttachConsole crash counts ------------------------------------------
Write-Host "--- Daemon crash signals ---" -ForegroundColor Yellow
if (Test-Path $daemonErrLog) {
    $log = Get-Content $daemonErrLog -Raw -ErrorAction SilentlyContinue
    $attachAll = [regex]::Matches($log, 'AttachConsole failed').Count
    $bug011All = [regex]::Matches($log, 'BUG-011 REGRESSION CHECK').Count
    $benignAll = [regex]::Matches($log, 'benign node-pty conpty cleanup race').Count
    Write-Host ("  AttachConsole crash lines in error log:    {0}" -f $attachAll)
    Write-Host ("  BUG-011 REGRESSION alarm lines (lifetime): {0}" -f $bug011All)
    Write-Host ("  Benign-recovered (post-patch):             {0}" -f $benignAll)

    if ($attachAll -gt 0 -and $benignAll -eq 0) {
        Write-Host "  [WARN] AttachConsole crashes present and the recovery filter has not logged. Verify patch is built + deployed." -ForegroundColor Yellow
    } elseif ($benignAll -gt 0) {
        Write-Host "  [OK] Recovery filter is active." -ForegroundColor Green
    }
} else {
    Write-Host "  No daemon error log at $daemonErrLog" -ForegroundColor DarkGray
}
Write-Host ""

# --- Telegram poller state per agent -------------------------------------
Write-Host "--- Per-agent Telegram pollers ---" -ForegroundColor Yellow
$agentsLogDir = Join-Path $ctxRoot 'logs'
if (Test-Path $agentsLogDir) {
    $agentDirs = Get-ChildItem -Path $agentsLogDir -Directory -ErrorAction SilentlyContinue
    if ($daemonOutLog -and (Test-Path $daemonOutLog)) {
        $daemonOutTail = Get-Content $daemonOutLog -Tail 2000 -ErrorAction SilentlyContinue | Out-String
    } else {
        $daemonOutTail = ''
    }
    foreach ($d in $agentDirs) {
        $name = $d.Name
        $outboundFile = Join-Path $d.FullName 'outbound-messages.jsonl'
        $lastOutbound = $null
        if (Test-Path $outboundFile) {
            $lastLine = Get-Content $outboundFile -Tail 1 -ErrorAction SilentlyContinue
            if ($lastLine) {
                try {
                    $obj = $lastLine | ConvertFrom-Json
                    $lastOutbound = $obj.timestamp
                } catch {}
            }
        }
        $pollerStarted = $daemonOutTail -match "$name.*Telegram poller started"
        $pollerWrapper = $daemonOutTail -match "$name.*with Conflict-restart wrapper"
        $conflictDie = $daemonOutTail -match "$name.*conflict-self-die"
        $state = if ($pollerWrapper) { 'wrapper-active' }
                 elseif ($pollerStarted) { 'started (unwrapped)' }
                 else { 'unknown' }
        $lastOutMsg = if ($lastOutbound) { $lastOutbound } else { '(never)' }

        $color = switch ($state) {
            'wrapper-active'     { 'Green' }
            'started (unwrapped)' { 'Yellow' }
            default              { 'DarkGray' }
        }
        Write-Host ("  {0,-20} state={1,-22} last_outbound={2}" -f $name, $state, $lastOutMsg) -ForegroundColor $color
    }
} else {
    Write-Host "  No agent log dir at $agentsLogDir" -ForegroundColor DarkGray
}
Write-Host ""

# --- Daemon crash history ------------------------------------------------
$crashHistFile = Join-Path $ctxRoot 'state\.daemon-crash-history.json'
if (Test-Path $crashHistFile) {
    Write-Host "--- Daemon crash history (last 5) ---" -ForegroundColor Yellow
    try {
        $hist = Get-Content $crashHistFile -Raw | ConvertFrom-Json
        $recent = @($hist.crashes) | Select-Object -Last 5
        foreach ($c in $recent) {
            $oneLine = ($c.err -split "`n")[0]
            if ($oneLine.Length -gt 120) { $oneLine = $oneLine.Substring(0, 120) + '...' }
            Write-Host ("  {0}  {1}" -f $c.ts, $oneLine)
        }
        if (-not $recent) {
            Write-Host "  (no recorded crashes)" -ForegroundColor Green
        }
    } catch {
        Write-Host "  could not parse crash history: $_" -ForegroundColor Red
    }
} else {
    Write-Host "--- Daemon crash history ---" -ForegroundColor Yellow
    Write-Host "  no crash history file (no crashes recorded yet)" -ForegroundColor Green
}
Write-Host ""

Write-Host "===== End =====" -ForegroundColor Cyan
Write-Host ""
