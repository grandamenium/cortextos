<#
  setup-ec2.ps1 — Provision a fresh AWS Windows Server 2022 EC2 instance to run CortextOS.
  Run this INSIDE the VM (RDP in first), in an elevated PowerShell.

  Prereqs handled by you before running:
    1. VM user should be named 'jenni' (keeps all C:\Users\jenni\... paths identical → reversible).
    2. Have the migration bundle ready to drop in (orgs/, state/, .env files, secrets) — see §STATE below.

  This script installs runtimes, clones the framework, and prepares the tree.
  It does NOT copy your live state/secrets automatically — that's the manual, secure step (§STATE).
#>

$ErrorActionPreference = 'Stop'
$FRAMEWORK = 'C:\cortext-test\cortextos'
$CTX_ROOT  = "$env:USERPROFILE\.cortextos\default"
$REPO      = 'https://github.com/grandamenium/cortextos.git'   # your fork/origin

Write-Host "=== 1. Install Chocolatey (package manager) ===" -ForegroundColor Cyan
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = 3072
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  $env:Path += ";$env:ALLUSERSPROFILE\chocolatey\bin"
}

Write-Host "=== 2. Install Node 24, git, OneDrive ===" -ForegroundColor Cyan
choco install -y nodejs --version=24.16.0
choco install -y git
choco install -y onedrive
$env:Path += ";$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd"

Write-Host "=== 3. Global npm packages (match laptop) ===" -ForegroundColor Cyan
npm install -g pm2@7.0.1
npm install -g @anthropic-ai/claude-code
# cortextos CLI: installed from the framework after clone (npm link) or from npm if published

Write-Host "=== 4. Clone framework ===" -ForegroundColor Cyan
if (-not (Test-Path $FRAMEWORK)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $FRAMEWORK) | Out-Null
  git clone $REPO $FRAMEWORK
}
Set-Location $FRAMEWORK

Write-Host "=== 5. Install deps + build ===" -ForegroundColor Cyan
npm install
npm run build 2>$null            # builds dist/ (the daemon)
Push-Location "$FRAMEWORK\dashboard"; npm install; npm run build; Pop-Location
# Link the cortextos CLI globally so agents can call it
npm link 2>$null

Write-Host ""
Write-Host "############################################################" -ForegroundColor Yellow
Write-Host "# MANUAL STEPS (do these now, then re-run §6 below):" -ForegroundColor Yellow
Write-Host "#" -ForegroundColor Yellow
Write-Host "# STATE — securely copy from laptop bundle onto this VM:" -ForegroundColor Yellow
Write-Host "#   - $FRAMEWORK\orgs\               (agent data + secrets)" -ForegroundColor Yellow
Write-Host "#   - $CTX_ROOT\state\               (heartbeats, crons, offsets)" -ForegroundColor Yellow
Write-Host "#   - $FRAMEWORK\.env  + all agents' .env files" -ForegroundColor Yellow
Write-Host "#   - $FRAMEWORK\ecosystem.config.js + start-atlasos.cmd" -ForegroundColor Yellow
Write-Host "#" -ForegroundColor Yellow
Write-Host "# AUTH:" -ForegroundColor Yellow
Write-Host "#   - Run:  claude   → /login   (or drop in .claude\.credentials.json)" -ForegroundColor Yellow
Write-Host "#   - Sign into OneDrive → let the 'Jen's Brain' vault sync down" -ForegroundColor Yellow
Write-Host "############################################################" -ForegroundColor Yellow
Write-Host ""
Write-Host "When state + auth are in place, run:  .\setup-ec2.ps1 -Launch" -ForegroundColor Green

param([switch]$Launch)
if ($Launch) {
  Write-Host "=== 6. Launch under PM2 ===" -ForegroundColor Cyan
  Set-Location $FRAMEWORK
  pm2 start ecosystem.config.js
  pm2 save
  pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 25M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true

  Write-Host "=== 7. Auto-start on reboot (scheduled task) ===" -ForegroundColor Cyan
  $action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$FRAMEWORK\start-atlasos.cmd`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'AtlasOS - Start cortextOS daemon' -Action $action -Trigger $trigger -RunLevel Limited -Force

  Write-Host "`nDONE. Verify: pm2 list ; then test Telegram from your phone." -ForegroundColor Green
  Write-Host "IMPORTANT: stop the laptop daemon (pm2 stop all on laptop) so only ONE brain runs." -ForegroundColor Red
}
