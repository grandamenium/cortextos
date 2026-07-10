<#
  patch-vm-username.ps1 — Run INSIDE the VM, AFTER unzipping the migration bundle,
  BEFORE launching. Rewrites the old laptop home path (C:\Users\jenni) to the VM
  home path (C:\Users\JenB) in configs + agent docs.

  SAFE: only replaces the literal path prefix "C:\Users\jenni" (and its \\-escaped and
  forward-slash forms). It does NOT touch the bare word "jenni", so "Jennifer" and any
  other prose is untouched.

  Change $NEW if the VM username is ever different.
#>
$ErrorActionPreference = 'Stop'
$OLD = 'jenni'
$NEW = 'jenb'

# The three path spellings that appear across .js/.json (\\), .md/.txt/.env (\), and any /-style.
$pairs = @(
  @{ from = "C:\Users\$OLD";   to = "C:\Users\$NEW" }       # single backslash
  @{ from = "C:\\Users\\$OLD"; to = "C:\\Users\\$NEW" }     # JSON/JS escaped
  @{ from = "C:/Users/$OLD";   to = "C:/Users/$NEW" }       # forward slash
)

$targets = @(
  'C:\cortext-test\cortextos\ecosystem.config.js'
) + (Get-ChildItem 'C:\cortext-test\cortextos\orgs' -Recurse -File -Include *.md,*.json,*.js,*.txt,*.env,*.cmd -ErrorAction SilentlyContinue).FullName `
  + (Get-ChildItem "C:\Users\$NEW\.cortextos\default\state" -Recurse -File -ErrorAction SilentlyContinue).FullName

$changed = 0
foreach ($f in ($targets | Where-Object { $_ -and (Test-Path $_) })) {
  $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { continue }
  $new = $raw
  foreach ($p in $pairs) { $new = $new.Replace($p.from, $p.to) }
  if ($new -ne $raw) {
    Copy-Item $f "$f.prejenb.bak" -Force
    Set-Content -Path $f -Value $new -NoNewline -Encoding UTF8
    Write-Host "patched: $f"
    $changed++
  }
}
Write-Host ""
Write-Host "DONE. Files changed: $changed  (backups saved as *.prejenb.bak)" -ForegroundColor Green
Write-Host "Spot-check: Get-Content C:\cortext-test\cortextos\ecosystem.config.js | Select-String Users" -ForegroundColor Green
