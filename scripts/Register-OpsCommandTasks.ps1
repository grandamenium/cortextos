# Register-OpsCommandTasks.ps1
#
# Registers two Scheduled Tasks that time-box the Ops Command fleet to the
# 19:00-09:00 local overnight window:
#   OpsCommand-Start  daily 19:00 -> scripts\Start-OpsCommand.ps1
#   OpsCommand-Stop   daily 09:00 -> scripts\Stop-OpsCommand.ps1
#
# Principal: Interactive (the logged-on user's token). NOT S4U - Microsoft
# documents that S4U tasks have NO network or encrypted-file access, and the
# detached daemon would inherit that token, breaking Claude API / Telegram /
# GitHub for every agent. Interactive requires a logged-on session, which is
# fine here: the machine stays powered on AND logged in overnight. WakeToRun is
# not needed; StartWhenAvailable covers an unexpected reboot near a trigger time.
# MultipleInstances=IgnoreNew prevents overlap if a run is still finishing.
#
# This is SEPARATE from the existing "PM2 Resurrect" logon task and must not
# interfere with it. cortextos-daemon is deliberately kept OUT of the PM2
# resurrect dump, so PM2 Resurrect never revives it - only OpsCommand-Start
# (inside its 19:00-09:00 guard) ever starts it.
#
# Idempotent: unregisters existing tasks of the same name before recreating.
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\Register-OpsCommandTasks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\Register-OpsCommandTasks.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$startTaskName = 'OpsCommand-Start'
$stopTaskName  = 'OpsCommand-Stop'

if ($Uninstall) {
    foreach ($t in @($startTaskName, $stopTaskName)) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "[ok] Removed scheduled task: $t"
        } else {
            Write-Host "[skip] No scheduled task named '$t'."
        }
    }
    return
}

$scriptsDir = $PSScriptRoot
$startScript = Join-Path $scriptsDir 'Start-OpsCommand.ps1'
$stopScript  = Join-Path $scriptsDir 'Stop-OpsCommand.ps1'
foreach ($s in @($startScript, $stopScript)) {
    if (-not (Test-Path $s)) { Write-Error "Required script not found: $s"; exit 1 }
}

$psExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

$userId = "$env:USERDOMAIN\$env:USERNAME"

# Shared settings: survive battery, start-when-available after a missed trigger
# (e.g. unexpected reboot), never overlap a still-running instance, cap runtime.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Interactive principal: uses the logged-on user's token (has network access,
# unlike S4U). Requires an active logon session, which Vince maintains overnight.
# RunLevel Limited - the daemon runs as the user, no admin needed.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

function Register-One($taskName, $scriptPath, $atTime, $desc, $repeatStop = $false) {
    $action  = New-ScheduledTaskAction -Execute $psExe `
        -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    if ($repeatStop) {
        # PS 5.1: -Daily cannot combine with -RepetitionInterval in one call
        # (separate parameter sets). Build a daily trigger, then borrow a
        # Repetition object from a -Once trigger and attach it.
        $trigger = New-ScheduledTaskTrigger -Daily -At $atTime
        $rep = (New-ScheduledTaskTrigger -Once -At $atTime `
            -RepetitionInterval (New-TimeSpan -Minutes 5) `
            -RepetitionDuration (New-TimeSpan -Minutes 20)).Repetition
        $trigger.Repetition = $rep
    } else {
        $trigger = New-ScheduledTaskTrigger -Daily -At $atTime
    }

    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description $desc | Out-Null
    Write-Host "[ok] Registered '$taskName'  ->  daily $atTime  ->  $scriptPath"
}

Register-One $startTaskName $startScript '7:00PM' `
    'Ops Command: start cortextos-daemon for the 19:00-09:00 overnight window. See scripts/Start-OpsCommand.ps1.'
Register-One $stopTaskName  $stopScript  '9:00AM' `
    'Ops Command: stop cortextos-daemon at the end of the overnight window. See scripts/Stop-OpsCommand.ps1.' $true

Write-Host ""
Write-Host "Verify with:  Get-ScheduledTask -TaskName 'OpsCommand-*' | Get-ScheduledTaskInfo"
Write-Host "Both tasks run as $userId (Interactive - requires a logged-on session, which is maintained overnight)."
