# Review-OpsCommandNight.ps1
#
# Read-only morning report: compiles the overnight Ops Command evidence into one
# view so the 19:00-09:00 run can be assessed at a glance. Run it in the morning
# (after the 09:00 stop). Changes nothing.
#
# ASCII-only (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\Review-OpsCommandNight.ps1

[CmdletBinding()]
param()

$ctxRoot = if ($env:CTX_ROOT) { $env:CTX_ROOT } else { Join-Path $env:USERPROFILE '.cortextos\default' }
$logDir  = Join-Path $ctxRoot 'logs'
$agents  = @('orchestrator','analyst','atlas')

function Head($t) { Write-Host ""; Write-Host "==== $t ====" }
function TailFile($path, $n) {
    if (Test-Path $path) { Get-Content $path -Tail $n | ForEach-Object { "  $_" } }
    else { "  (no file: $path)" }
}

Head "1. Is the fleet currently DOWN? (expected after 09:00 stop)"
$daemon = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*cortextos*dist*daemon.js*' }
if ($daemon) { Write-Host "  STILL RUNNING: pid $($daemon.ProcessId) - the 09:00 stop may have failed." }
else { Write-Host "  Down (no cortextos daemon process). Good." }
$freeMB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
$totMB  = [math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1024)
Write-Host "  RAM now: $freeMB MB free of $totMB MB total."

Head "2. Start/Stop outcomes (ops-command-schedule.log, last 25)"
TailFile (Join-Path $logDir 'ops-command-schedule.log') 25

Head "3. Daemon startup health (daemon-out.log)"
$outLog = Join-Path $logDir 'daemon-out.log'
if (Test-Path $outLog) {
    $content = Get-Content $outLog -Raw
    $boot = ([regex]::Matches($content, 'Bootstrap complete')).Count
    Write-Host "  'Bootstrap complete' occurrences (all-time in file): $boot  (expect 3 per healthy start)"
    Write-Host "  --- last 15 lines ---"
    TailFile $outLog 15
} else { Write-Host "  (no daemon-out.log)" }

Head "4. Daemon errors (daemon-err.log, last 20)"
TailFile (Join-Path $logDir 'daemon-err.log') 20

Head "5. Per-agent crashes / restarts"
foreach ($a in $agents) {
    $ad = Join-Path $logDir $a
    $crashes  = Join-Path $ad 'crashes.log'
    $restarts = Join-Path $ad 'restarts.log'
    $cCount = if (Test-Path $crashes)  { (Get-Content $crashes  | Measure-Object -Line).Lines } else { 'n/a' }
    $rCount = if (Test-Path $restarts) { (Get-Content $restarts | Measure-Object -Line).Lines } else { 'n/a' }
    Write-Host ("  {0,-13} crashes.log lines={1}  restarts.log lines={2}" -f $a, $cCount, $rCount)
}

Head "6. Cron fires overnight (cron-execution.log per agent, last 8 each)"
foreach ($a in $agents) {
    $cx = Join-Path $ctxRoot ".cortextOS\state\agents\$a\cron-execution.log"
    Write-Host "  -- $a --"
    TailFile $cx 8
}

Head "7. Agent heartbeats (freshness)"
foreach ($a in $agents) {
    $hb = Join-Path $ctxRoot "state\$a\heartbeat.json"
    if (Test-Path $hb) {
        $age = [math]::Round((New-TimeSpan -Start (Get-Item $hb).LastWriteTime -End (Get-Date)).TotalMinutes)
        Write-Host ("  {0,-13} heartbeat.json last write {1} min ago" -f $a, $age)
    } else { Write-Host ("  {0,-13} no heartbeat.json" -f $a) }
}

Head "VERDICT CHECKLIST (eyeball)"
Write-Host "  [ ] Fleet is DOWN now (09:00 stop worked)"
Write-Host "  [ ] Start log shows a healthy start (3 agents bootstrapped) at ~19:00"
Write-Host "  [ ] Stop log shows a clean stop at ~09:00 (exit 0)"
Write-Host "  [ ] No OOM / crash-loop in daemon-err.log or per-agent crashes.log"
Write-Host "  [ ] Crons fired on schedule (section 6) with no thundering-herd at 19:00"
Write-Host ""
