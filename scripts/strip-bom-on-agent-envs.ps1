#requires -Version 5.1
<#
.SYNOPSIS
  Strip the UTF-8 BOM (EF BB BF) from cortextOS agent .env files.

.DESCRIPTION
  On Windows, PowerShell and VS Code commonly write UTF-8 files with a
  byte-order mark. The cortextOS daemon (`src/daemon/agent-manager.ts`) parses
  .env with `/^BOT_TOKEN=(.+)$/m`. When BOT_TOKEN= sits on line 1, the BOM
  breaks the `^` anchor and the token is missed, so the Telegram poller never
  starts and the agent is silent.

  This helper rewrites each affected .env without the leading BOM. Other bytes
  (line endings, content) are preserved untouched. Idempotent — running again
  is a no-op.

.PARAMETER Agents
  Comma-separated agent names whose .env files should be checked (relative to
  orgs/<Org>/agents/<name>/.env).

.PARAMETER Org
  Org slug under orgs/. Defaults to sitesmith-agency.

.PARAMETER RepoRoot
  Absolute path to the cortextos repo root. Defaults to C:\Users\lukes\cortextos.

.PARAMETER DryRun
  Report what would change without writing any files. Default: $false.

.EXAMPLE
  pwsh scripts/strip-bom-on-agent-envs.ps1 -Agents smith,analyst,crm-ops -DryRun
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Agents,

    [string]$Org = 'sitesmith-agency',

    [string]$RepoRoot = 'C:\Users\lukes\cortextos',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$bomBytes = [byte[]](0xEF, 0xBB, 0xBF)

$results = @()
$agentNameRegex = '^[A-Za-z0-9_-]+$'

# Validate the org slug once.
if ($Org -notmatch $agentNameRegex) {
    throw "Invalid -Org slug '$Org' (allowed: A-Z, a-z, 0-9, _, -)."
}

foreach ($agent in $Agents) {
    # Reject anything that could escape the intended agent directory.
    if ($agent -notmatch $agentNameRegex) {
        throw "Invalid agent name '$agent' (allowed: A-Z, a-z, 0-9, _, -). Refusing to touch any file."
    }
    $envPath = Join-Path -Path $RepoRoot -ChildPath ("orgs/" + $Org + "/agents/" + $agent + "/.env")
    $entry = [ordered]@{
        agent  = $agent
        path   = $envPath
        exists = $false
        hadBOM = $false
        action = 'skip'
        bytes  = 0
    }

    if (-not (Test-Path -LiteralPath $envPath)) {
        $entry.action = 'missing'
        $results += [pscustomobject]$entry
        continue
    }
    $entry.exists = $true

    # Codex-flagged guard: refuse symlinks/junctions/reparse points. Otherwise
    # the script could follow a link out of the agents tree and overwrite an
    # arbitrary file.
    $item = Get-Item -LiteralPath $envPath -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to touch '$envPath': it is a symlink/junction/reparse point."
    }
    if (-not $item.PSIsContainer -eq $false) {
        # Defensive: should be a file, not a directory.
        throw "Refusing to touch '$envPath': not a regular file."
    }

    # Containment check: resolved real path must stay under <RepoRoot>/orgs/<Org>/agents/
    # AND every ancestor directory up to that root must NOT be a reparse point.
    # GetFullPath alone is lexical normalisation, so a junction'd parent could
    # still escape — Codex flagged this. Walk the ancestor chain and assert.
    $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $RepoRoot -ChildPath ("orgs/" + $Org + "/agents")))
    $resolved = [System.IO.Path]::GetFullPath($envPath)
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $expectedRootWithSep = $expectedRoot.TrimEnd($sep) + $sep
    if (-not $resolved.StartsWith($expectedRootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to touch '$resolved': outside expected root '$expectedRootWithSep'."
    }
    $ancestor = [System.IO.Path]::GetDirectoryName($resolved)
    while ($ancestor -and ($ancestor.Length -ge $expectedRoot.Length)) {
        if (Test-Path -LiteralPath $ancestor) {
            $ancestorItem = Get-Item -LiteralPath $ancestor -Force
            if ($ancestorItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to touch '$envPath': ancestor '$ancestor' is a symlink/junction/reparse point."
            }
        }
        if ($ancestor -eq $expectedRoot) { break }
        $parent = [System.IO.Path]::GetDirectoryName($ancestor)
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }

    $bytes = [System.IO.File]::ReadAllBytes($envPath)
    $entry.bytes = $bytes.Length

    $hasBOM = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $entry.hadBOM = $hasBOM

    if (-not $hasBOM) {
        $entry.action = 'no-bom'
        $results += [pscustomobject]$entry
        continue
    }

    if ($DryRun) {
        $entry.action = 'dry-run-would-strip'
        $results += [pscustomobject]$entry
        continue
    }

    # Strip the 3 BOM bytes only. Do not touch the remaining payload.
    $stripped = New-Object byte[] ($bytes.Length - 3)
    [System.Buffer]::BlockCopy($bytes, 3, $stripped, 0, $stripped.Length)

    $backupPath = "$envPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    [System.IO.File]::Copy($envPath, $backupPath, $true)
    [System.IO.File]::WriteAllBytes($envPath, $stripped)

    $entry.action = "stripped (backup: $backupPath)"
    $results += [pscustomobject]$entry
}

$results | Format-Table -AutoSize -Property agent, exists, hadBOM, action, bytes

$stripped = ($results | Where-Object { $_.action -like 'stripped*' }).Count
$wouldStrip = ($results | Where-Object { $_.action -eq 'dry-run-would-strip' }).Count
$alreadyClean = ($results | Where-Object { $_.action -eq 'no-bom' }).Count
$missing = ($results | Where-Object { $_.action -eq 'missing' }).Count

Write-Output ""
Write-Output ("Summary: stripped={0}, would-strip-on-real-run={1}, already-clean={2}, missing={3}" -f $stripped, $wouldStrip, $alreadyClean, $missing)

if ($DryRun) {
    Write-Output "Re-run without -DryRun to apply."
}
