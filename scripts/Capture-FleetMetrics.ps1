# Capture-FleetMetrics.ps1
# Append one fleet and system resource sample for the Ops Command measure gate.
# ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).

$ErrorActionPreference = 'Stop'

$processes = @(Get-Process -Name node, claude -ErrorAction SilentlyContinue)
$processCount = $processes.Count
$workingSetMb = ($processes | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
$privateBytesMb = ($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum / 1MB

$counterPaths = @(
    '\Memory\Available MBytes',
    '\Memory\% Committed Bytes In Use',
    '\Memory\Pages Input/sec',
    '\PhysicalDisk(_Total)\Avg. Disk Queue Length'
)
$samples = (Get-Counter -Counter $counterPaths -SampleInterval 1 -MaxSamples 1).CounterSamples

function Get-CounterValue($pathSuffix) {
    $sample = $samples | Where-Object { $_.Path.EndsWith($pathSuffix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($null -eq $sample) { return $null }
    return $sample.CookedValue
}

$profileDir = [Environment]::GetFolderPath('UserProfile')
$logDir = Join-Path $profileDir '.cortextos\default\logs'
$csvPath = Join-Path $logDir 'fleet-metrics.csv'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$row = [PSCustomObject][ordered]@{
    timestamp = (Get-Date).ToString('o')
    process_count = $processCount
    working_set_mb = [Math]::Round($workingSetMb, 2)
    private_bytes_mb = [Math]::Round($privateBytesMb, 2)
    available_mb = [Math]::Round((Get-CounterValue '\memory\available mbytes'), 2)
    committed_bytes_in_use_pct = [Math]::Round((Get-CounterValue '\memory\% committed bytes in use'), 2)
    page_reads_per_sec = [Math]::Round((Get-CounterValue '\memory\pages input/sec'), 2)
    avg_disk_queue_length = [Math]::Round((Get-CounterValue '\physicaldisk(_total)\avg. disk queue length'), 2)
}

if (Test-Path -LiteralPath $csvPath) {
    $row | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Append
} else {
    $row | Export-Csv -LiteralPath $csvPath -NoTypeInformation
}
