<#
  gcp-vm-setup.ps1 — Run INSIDE the GCP Windows VM (RDP in first, elevated PowerShell).
  GCP-specific version of the setup. Installs runtimes, clones framework, prepares tree.
  Copy the migration bundle (from make-migration-bundle.ps1) onto the VM first, or after §5.

  Two-pass: run bare to install+build, then run with -Launch after state+auth are in place.
#>
param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$FW   = 'C:\cortext-test\cortextos'
$ROOT = "$env:USERPROFILE\.cortextos\default"
$REPO = 'https://github.com/grandamenium/cortextos.git'

if (-not $Launch) {
  Write-Host "=== 1. Chocolatey ===" -ForegroundColor Cyan
  if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [Net.ServicePointManager]::SecurityProtocol = 3072
    iex ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path += ";$env:ALLUSERSPROFILE\chocolatey\bin"
  }

  Write-Host "=== 2. Node 24 + git + OneDrive ===" -ForegroundColor Cyan
  choco install -y nodejs --version=24.16.0
  choco install -y git
  choco install -y onedrive
  $env:Path += ";$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd"

  Write-Host "=== 3. Global npm (pm2 + Claude Code) ===" -ForegroundColor Cyan
  npm install -g pm2@7.0.1
  npm install -g @anthropic-ai/claude-code

  Write-Host "=== 4. Clone + build framework ===" -ForegroundColor Cyan
  if (-not (Test-Path $FW)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $FW) | Out-Null
    git clone $REPO $FW
  }
  Set-Location $FW
  npm install
  npm run build 2>$null
  Push-Location "$FW\dashboard"; npm install; npm run build; Pop-Location
  npm link 2>$null

  Write-Host ""
  Write-Host "#### NEXT (manual): ####" -ForegroundColor Yellow
  Write-Host "# 5. Unzip migration bundle:" -ForegroundColor Yellow
  Write-Host "#      framework\orgs           -> $FW\orgs" -ForegroundColor Yellow
  Write-Host "#      framework\ecosystem.config.js, .env, start-atlasos.cmd -> $FW\" -ForegroundColor Yellow
  Write-Host "#      root\state              -> $ROOT\state" -ForegroundColor Yellow
  Write-Host "#      claude\.credentials.json -> $env:USERPROFILE\.claude\  (or run 'claude' /login)" -ForegroundColor Yellow
  Write-Host "# 6. Sign into OneDrive -> let 'Jen's Brain' vault sync" -ForegroundColor Yellow
  Write-Host "# 7. Verify Claude auth:  claude   (then /login if needed)" -ForegroundColor Yellow
  Write-Host "# Then: .\gcp-vm-setup.ps1 -Launch" -ForegroundColor Green
  return
}

# ---- Launch pass ----
Write-Host "=== 8. PM2 launch ===" -ForegroundColor Cyan
Set-Location $FW
pm2 start ecosystem.config.js
pm2 save
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 25M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

Write-Host "=== 9. Auto-start on boot ===" -ForegroundColor Cyan
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$FW\start-atlasos.cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'AtlasOS - Start cortextOS daemon' -Action $action -Trigger $trigger -RunLevel Highest -Force

Write-Host "`nDONE. Verify: pm2 list ; test Telegram from phone." -ForegroundColor Green
Write-Host "THEN on the LAPTOP: pm2 stop all   (ONE brain rule — no double Telegram polling)." -ForegroundColor Red
