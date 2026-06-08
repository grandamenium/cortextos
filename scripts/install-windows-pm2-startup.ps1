# install-windows-pm2-startup.ps1
#
# Native Windows replacement for `pm2 startup` — which is broken on Windows
# (no Unix init system) and the third-party shims (pm2-windows-startup,
# pm2-windows-service) require Visual Studio Build Tools or are abandoned.
#
# Registers a Scheduled Task named "PM2 Resurrect" that runs at user logon
# and executes `node <pm2-bin> resurrect`, which restarts every PM2 process
# captured by `pm2 save`. This is the same mechanism `pm2 startup` produces
# on macOS/Linux, just expressed via Windows Task Scheduler.
#
# Run once after `pm2 save`. Re-run is idempotent — it deletes the existing
# task before recreating it.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-pm2-startup.ps1
#   # or, to remove:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-pm2-startup.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = 'PM2 Resurrect'
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[ok] Removed scheduled task: $TaskName"
    } else {
        Write-Host "[skip] No scheduled task named '$TaskName' is registered."
    }
    return
}

# Resolve node.exe — required to launch pm2's bin entry point.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Error "node.exe not found on PATH. Install Node.js 20+ before running this script."
    exit 1
}

# Resolve pm2's bin entry point. PM2 installed via `npm install -g pm2`
# lives under %APPDATA%\npm\node_modules\pm2\bin\pm2 (no extension — it's
# a Node script). Prefer that over the .cmd shim so Task Scheduler runs
# node.exe directly (no extra cmd.exe in the process tree).
$pm2BinCandidates = @(
    (Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'),
    (Join-Path (Split-Path $node -Parent) 'node_modules\pm2\bin\pm2')
)
$pm2Bin = $pm2BinCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pm2Bin) {
    Write-Error "Could not locate pm2 bin script. Install with: npm install -g pm2"
    exit 1
}

# Verify the user has run `pm2 save` at least once. Without a dump file,
# `pm2 resurrect` does nothing useful at logon.
$dumpFile = Join-Path $env:USERPROFILE '.pm2\dump.pm2'
if (-not (Test-Path $dumpFile)) {
    Write-Warning "PM2 dump file not found at $dumpFile."
    Write-Warning "Run 'pm2 save' AFTER starting your processes, otherwise resurrect has nothing to restore."
}

# Compose the action: node.exe <pm2-bin> resurrect
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$pm2Bin`" resurrect"

# Trigger at the current user's logon. AtLogon (not AtStartup) avoids needing
# admin rights / SYSTEM-level service config; Task Scheduler runs under your
# user, which is what PM2 expects (it stores state in %USERPROFILE%\.pm2).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 72) `
    -MultipleInstances IgnoreNew `
    -Hidden  # Hide the task and prevent its action from inheriting a console.
             # Without this, PM2 children (e.g. the dashboard "next dev") spawn
             # with a visible "next-server (vX)" terminal at logon. PM2's own
             # `windowsHide: true` is unreliable, so we hide the launcher.

# Re-register cleanly so the script is idempotent.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'cortextOS: revive PM2-managed daemon + dashboard at user logon. See scripts/install-windows-pm2-startup.ps1.' | Out-Null

Write-Host ""
Write-Host "[ok] Registered scheduled task: $TaskName"
Write-Host "      Trigger:   At logon ($env:USERDOMAIN\$env:USERNAME)"
Write-Host "      Action:    $node `"$pm2Bin`" resurrect"
Write-Host ""
Write-Host "Verify with:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Test now:     Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "TIP: set your Windows power plan to 'Never sleep' for true 24/7 operation."
