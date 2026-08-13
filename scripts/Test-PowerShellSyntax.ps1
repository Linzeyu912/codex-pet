Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$files = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'windows') -Filter '*.ps1' -File
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File
) | Sort-Object FullName -Unique

$failures = @()
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    $source = [IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false))
    [void][Management.Automation.Language.Parser]::ParseInput(
        $source,
        $file.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    )
    foreach ($parseError in $parseErrors) {
        $failures += "$($file.FullName):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
    }
}

if ($failures.Count -gt 0) {
    throw "PowerShell syntax validation failed:`n$($failures -join "`n")"
}
Write-Output "PowerShell syntax passed for $($files.Count) support scripts."
