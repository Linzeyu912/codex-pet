Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$codexPackage = Get-AppxPackage OpenAI.Codex -ErrorAction SilentlyContinue
if (-not $codexPackage) {
    Write-Warning 'Official Codex atlas validation skipped: Codex Windows App is not installed.'
    exit 0
}

$validator = Join-Path $codexPackage.InstallLocation 'app\resources\skills\skills\.curated\hatch-pet\scripts\validate_atlas.py'
if (-not (Test-Path -LiteralPath $validator)) {
    Write-Warning "Official Codex atlas validation skipped: validator not found at $validator"
    exit 0
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Warning 'Official Codex atlas validation skipped: python is unavailable.'
    exit 0
}

& (Join-Path $projectRoot 'windows\Validate-CodexAtlas.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
