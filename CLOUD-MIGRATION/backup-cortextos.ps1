# backup-cortextos.ps1 — runs ON THE VM. Zips the irreplaceable data and uploads to a
# Google Cloud Storage bucket. Keeps the last 14 backups. Excludes rebuildable bulk
# (node_modules, .next, logs — those come back from git + npm install).
$ErrorActionPreference = "Stop"
$FW   = "C:\cortext-test\cortextos"
$ROOT = "$env:USERPROFILE\.cortextos\default"
$proj = (gcloud config get-value project 2>$null).Trim()
$bucket = "gs://$proj-cortextos-backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tmp = "$env:TEMP\ctx-bak-$stamp"
$zip = "$env:TEMP\cortextos-backup-$stamp.zip"

New-Item -ItemType Directory -Force -Path "$tmp\framework","$tmp\root" | Out-Null
Copy-Item "$FW\orgs"                "$tmp\framework\orgs" -Recurse -Force        # agent memory, identities, secrets
Copy-Item "$FW\ecosystem.config.js" "$tmp\framework\" -Force -ErrorAction SilentlyContinue
Copy-Item "$FW\.env"                "$tmp\framework\.env" -Force -ErrorAction SilentlyContinue
Copy-Item "$ROOT\state"             "$tmp\root\state" -Recurse -Force            # heartbeats, crons, oauth

Compress-Archive -Path "$tmp\*" -DestinationPath $zip -Force
Remove-Item $tmp -Recurse -Force

gcloud storage cp $zip "$bucket/cortextos-backup-$stamp.zip"
Remove-Item $zip -Force

# prune: keep only the newest 14
$all = @(gcloud storage ls "$bucket/cortextos-backup-*.zip" 2>$null) | Sort-Object
if ($all.Count -gt 14) { $all[0..($all.Count-15)] | ForEach-Object { gcloud storage rm $_ 2>$null } }

Write-Host "Backup complete: $bucket/cortextos-backup-$stamp.zip"
