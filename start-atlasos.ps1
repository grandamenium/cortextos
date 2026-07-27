# start-atlasos.ps1 - resilient autostart for the cortextOS fleet.
#
# History / why this looks the way it does:
#   The old version was `pm2 start ecosystem.config.js 2>nul` - fire and forget,
#   errors swallowed. On 2026-07-26 a shutdown killed pm2 and the autostart task
#   died with 0xC000013A, leaving all 15 agents dark with no trace of why.
#
# Hard-won constraints (each of these caused a real failure while building this):
#   1. ASCII ONLY. No em-dashes, no box-drawing chars. Windows PowerShell 5.1
#      reads a BOM-less file as ANSI, so any non-ASCII byte can turn into a
#      parse error - the script then dies before it can log anything at all.
#   2. Do NOT use ConvertFrom-Json on `pm2 jlist`. pm2 embeds the process env,
#      which has both 'username' and 'USERNAME'; that throws on casing collision,
#      and -AsHashtable does not exist in PS 5.1. Use `pm2 pid <name>` instead.
#   3. `pm2 start <ecosystem>` RESTARTS already-running apps. Never call it
#      without first confirming the daemon is actually down, or the task will
#      bounce the daemon and all 15 agents on every retry.
#   4. Absolute paths only - the npm global bin is not reliably on PATH at logon.

$ErrorActionPreference = 'Continue'

$Pm2      = 'C:\Users\jenni\AppData\Roaming\npm\pm2.cmd'
$Root     = 'C:\cortext-test\cortextos'
$Eco      = Join-Path $Root 'ecosystem.config.js'
$LogDir   = Join-Path $Root 'logs'
$LogFile  = Join-Path $LogDir 'autostart.log'
$MaxTries = 5

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 2MB)) {
    Move-Item $LogFile "$LogFile.old" -Force
}

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line
}

Log "=== autostart invoked (user=$env:USERNAME, ps=$($PSVersionTable.PSVersion)) ==="

if (-not (Test-Path $Pm2)) { Log "FATAL: pm2 not found at $Pm2"; exit 1 }
if (-not (Test-Path $Eco)) { Log "FATAL: ecosystem config not found at $Eco"; exit 1 }

Set-Location $Root

# Returns the pid pm2 has for an app, or 0 if not running / not answering.
# Uses `pm2 pid` because it emits a bare integer - no JSON parsing to go wrong.
function Get-AppPid($name) {
    try {
        $out = & $Pm2 pid $name 2>$null | Out-String
        $m = [regex]::Match($out, '(?m)^\s*(\d+)\s*$')
        if ($m.Success) { return [int]$m.Groups[1].Value }
        return 0
    } catch { return 0 }
}

# Independent of pm2 bookkeeping: is the cortextOS daemon actually alive?
# Safety net so an unreadable pm2 never triggers a blind restart of a live fleet.
#
# CAREFUL: pm2's own God process runs `pm2\lib\Daemon.js`, and PowerShell -match
# is case-insensitive, so a loose 'daemon\.js' pattern matches pm2 itself. Since
# `pm2 pid` spawns that God process on demand, the loose pattern is ALWAYS true -
# which made this safety net veto every legitimate recovery. Anchor on the
# cortextOS-specific path instead.
function Test-DaemonProcess {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine -match 'cortextos[\\/]dist[\\/]daemon\.js') { return $true }
        }
        return $false
    } catch { return $false }
}

function Test-PidAlive($procId) {
    if ($procId -le 0) { return $false }
    return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
}

# --- Guard: never touch a fleet that is already healthy ---------------------
$existing = Get-AppPid 'cortextos-daemon'
if (Test-PidAlive $existing) {
    Log "cortextos-daemon already running (pid $existing) - leaving fleet untouched"
    Log "=== SUCCESS: no action needed ==="
    exit 0
}
if (Test-DaemonProcess) {
    Log "pm2 reports no daemon pid, but a daemon.js process is alive."
    Log "Refusing to start a second instance on top of a possibly-healthy fleet."
    Log "=== BAILED: manual check needed (fleet left running) ==="
    exit 2
}

Log "daemon is down (pm2 pid=$existing, no daemon.js process) - starting fleet"

for ($try = 1; $try -le $MaxTries; $try++) {
    Log "attempt $try/$MaxTries : pm2 start $Eco"

    $out = & $Pm2 start $Eco 2>&1 | Out-String
    foreach ($l in ($out -split "`r?`n")) {
        $t = $l.Trim()
        # Log only pm2's own [PM2] messages; skip its box-drawing status table.
        if ($t -like '`[PM2`]*') { Log "  pm2> $t" }
    }

    Start-Sleep -Seconds 12

    $procId = Get-AppPid 'cortextos-daemon'
    if (Test-PidAlive $procId) {
        Log "cortextos-daemon online (pid $procId)"
        $dashPid = Get-AppPid 'cortextos-dashboard'
        Log "cortextos-dashboard pid = $dashPid"
        & $Pm2 save 2>&1 | Out-Null
        Log "pm2 process list saved"
        Log "=== SUCCESS: fleet online after $try attempt(s) ==="
        exit 0
    }

    Log "daemon not up yet (pm2 pid=$procId)"

    # If pm2's bookkeeping is unreadable but a daemon really is running, stop -
    # retrying here is what turns a retry loop into a restart loop.
    if (Test-DaemonProcess) {
        Log "daemon.js process detected despite pm2 pid=$procId - refusing further restarts"
        Log "=== BAILED: manual check needed (fleet left running) ==="
        exit 2
    }

    Log "backing off before retry"
    Start-Sleep -Seconds 15
}

Log "=== FAILED: daemon never came up after $MaxTries attempts ==="
exit 1
