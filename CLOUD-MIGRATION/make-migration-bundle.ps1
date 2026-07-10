<#
  make-migration-bundle.ps1 — Run on the LAPTOP to package everything the cloud VM needs.
  Produces a single encrypted-in-transit zip you upload to the VM (via GCS bucket or RDP copy).

  Excludes the rebuildable bulk (node_modules, .next, logs) — bundle should be ~230 MB.
  INCLUDES live secrets — treat the output zip as sensitive; delete after transfer.
#>
$ErrorActionPreference = 'Stop'
$FW   = 'C:\cortext-test\cortextos'
$ROOT = "$env:USERPROFILE\.cortextos\default"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = "$env:TEMP\ctx-migrate-$stamp"
$zip = "$env:USERPROFILE\Downloads\cortextos-migration-$stamp.zip"

New-Item -ItemType Directory -Force -Path "$staging\framework","$staging\root" | Out-Null

Write-Host "Staging framework state (orgs, ecosystem, start script, root .env)..."
Copy-Item "$FW\orgs"                -Destination "$staging\framework\orgs" -Recurse -Force
Copy-Item "$FW\ecosystem.config.js" -Destination "$staging\framework\" -Force
Copy-Item "$FW\start-atlasos.cmd"   -Destination "$staging\framework\" -Force -ErrorAction SilentlyContinue
Copy-Item "$FW\.env"                -Destination "$staging\framework\.env" -Force -ErrorAction SilentlyContinue

Write-Host "Staging instance state (heartbeats, crons, offsets, oauth)..."
Copy-Item "$ROOT\state" -Destination "$staging\root\state" -Recurse -Force

Write-Host "Staging Claude credentials (optional — or just re-login on VM)..."
New-Item -ItemType Directory -Force -Path "$staging\claude" | Out-Null
Copy-Item "$env:USERPROFILE\.claude\.credentials.json" -Destination "$staging\claude\" -Force -ErrorAction SilentlyContinue

Write-Host "Zipping -> $zip"
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length/1MB,1)
Write-Host ""
Write-Host "DONE. Bundle: $zip  (${mb} MB)" -ForegroundColor Green
Write-Host "Transfer to VM via: GCS bucket (gcloud storage cp) or paste through RDP session." -ForegroundColor Green
Write-Host "On the VM, unzip: framework\* -> C:\cortext-test\cortextos\  ;  root\state -> %USERPROFILE%\.cortextos\default\" -ForegroundColor Green
Write-Host "SECURITY: delete this zip from Downloads (and any bucket) after the VM is verified." -ForegroundColor Yellow
