Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$files = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'windows') -Filter '*.ps1' -File
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File
) | Sort-Object FullName -Unique

$failures = @()
$codexPetAst = $null
$codexPetPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'windows\CodexPet.ps1'))
foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    $source = [IO.File]::ReadAllText($file.FullName, [Text.UTF8Encoding]::new($false))
    $ast = [Management.Automation.Language.Parser]::ParseInput(
        $source,
        $file.FullName,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ([IO.Path]::GetFullPath($file.FullName) -eq $codexPetPath) { $codexPetAst = $ast }
    foreach ($parseError in $parseErrors) {
        $failures += "$($file.FullName):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
    }
}

if ($failures.Count -gt 0) {
    throw "PowerShell syntax validation failed:`n$($failures -join "`n")"
}
Write-Output "PowerShell syntax passed for $($files.Count) scripts."

if (-not $codexPetAst) { throw "CodexPet.ps1 was not included in PowerShell validation." }
foreach ($functionName in @(
    'Get-StateExpiryMilliseconds',
    'Get-NormalizedSessionId',
    'Test-ValidExternalUpdatedAt',
    'Start-LocalAction'
)) {
    $definition = $codexPetAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
    }, $true)
    if (-not $definition) { throw "Required runtime function is missing: $functionName" }
    . ([ScriptBlock]::Create($definition.Extent.Text))
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

$legacyStateTtlMilliseconds = [long](15 * 60 * 1000)
$stamp = [long]1000000
$fallbackExpiry = $stamp + $legacyStateTtlMilliseconds
foreach ($invalidExpiry in @('not-a-date', 0, -1, '0', '-1')) {
    $payload = [pscustomobject]@{ expiresAt = $invalidExpiry }
    Assert-Equal (Get-StateExpiryMilliseconds -Payload $payload -Stamp $stamp -State 'running') `
        $fallbackExpiry "Non-positive or invalid expiresAt must use the compatibility TTL."
}
foreach ($payload in @(
    [pscustomobject]@{ expiresAt = -0.5 },
    [pscustomobject]@{ expiresAt = $true },
    [pscustomobject]@{ expiresAt = [pscustomobject]@{ unexpected = $true } },
    [pscustomobject]@{ expiresAt = [object[]]@(1, 2) }
)) {
    Assert-Equal (Get-StateExpiryMilliseconds -Payload $payload -Stamp $stamp -State 'running') `
        $fallbackExpiry "A negative fraction or non-numeric expiresAt must use the compatibility TTL."
}
$missingExpiry = [pscustomobject]@{ state = 'running' }
Assert-Equal (Get-StateExpiryMilliseconds -Payload $missingExpiry -Stamp $stamp -State 'running') `
    $fallbackExpiry "A legacy non-idle payload must use the compatibility TTL."
$validExpiry = $stamp + 5000
Assert-Equal (Get-StateExpiryMilliseconds -Payload ([pscustomobject]@{ expiresAt = $validExpiry }) -Stamp $stamp -State 'running') `
    $validExpiry "A valid positive expiresAt must be preserved."
Assert-Equal (Get-StateExpiryMilliseconds -Payload ([pscustomobject]@{ expiresAt = [string]$validExpiry }) -Stamp $stamp -State 'running') `
    $validExpiry "A positive numeric-string expiresAt must be preserved."
Assert-Equal (Get-StateExpiryMilliseconds -Payload ([pscustomobject]@{ expiresAt = 0.5 }) -Stamp $stamp -State 'running') `
    0.5 "A positive fractional expiresAt must remain finite so it expires immediately rather than pinning state."
$isoExpiry = [long]1784174400000
Assert-Equal (Get-StateExpiryMilliseconds -Payload ([pscustomobject]@{ expiresAt = '2026-07-16T12:00:00+08:00' }) -Stamp $stamp -State 'running') `
    $isoExpiry "A valid ISO expiresAt must be preserved."
Assert-Equal (Get-NormalizedSessionId -Payload ([pscustomobject]@{ state = 'running' })) `
    'legacy' "A missing sessionId must use the legacy read identity."
Assert-Equal (Get-NormalizedSessionId -Payload ([pscustomobject]@{ sessionId = '   ' })) `
    'legacy' "A blank sessionId must use the legacy read identity."
Assert-Equal (Get-NormalizedSessionId -Payload ([pscustomobject]@{ sessionId = 123 })) `
    'legacy' "A non-string sessionId must use the legacy read identity."
Assert-Equal (Get-NormalizedSessionId -Payload ([pscustomobject]@{ sessionId = @('task-1') })) `
    'legacy' "An array sessionId must use the legacy read identity."
Assert-Equal (Get-NormalizedSessionId -Payload ([pscustomobject]@{ sessionId = '  task-1  ' })) `
    'task-1' "A sessionId must be trimmed before comparison."
Assert-Equal (Test-ValidExternalUpdatedAt -Stamp 1) $true "A positive safe-integer updatedAt must be accepted."
Assert-Equal (Test-ValidExternalUpdatedAt -Stamp ([long]9007199254740991)) $true `
    "The largest safe-integer updatedAt must be accepted."
foreach ($invalidUpdatedAt in @(
    0,
    -1,
    1.5,
    '1',
    $true,
    [double]::NaN,
    [double]::PositiveInfinity,
    [double]9007199254740992
)) {
    Assert-Equal (Test-ValidExternalUpdatedAt -Stamp $invalidUpdatedAt) $false `
        "A non-positive, non-numeric, fractional, non-finite, or unsafe updatedAt must not take over state."
}

$animations = @{ waving = @{} }
$script:reduceMotion = $false
$script:dragReleasePending = $true
$script:directionalStopPending = $true
$script:pendingDirection = 'running-left'
$script:recordedAction = ''
$script:recordedRestart = $false
function Set-PetAction([string]$Action, [bool]$Restart = $false) {
    $script:recordedAction = $Action
    $script:recordedRestart = $Restart
}
Start-LocalAction -Action 'waving' -Kind 'manual'
Assert-Equal $script:dragReleasePending $false "A new local action must cancel a stale drag-release transition."
Assert-Equal $script:recordedAction 'waving' "The requested local action must still start."
Assert-Equal $script:recordedRestart $true "A local action must restart from its first frame."
Write-Output "PowerShell runtime logic regressions passed."
