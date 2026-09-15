Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$atlasRoot = Join-Path $projectRoot '.local-assets\qq-penguin\codex-pet'
$atlasPaths = @((Join-Path $atlasRoot 'spritesheet.webp'), (Join-Path $atlasRoot 'spritesheet.png'))
& node (Join-Path $projectRoot 'scripts\check-local-atlas-freshness.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Generated assets are stale.' }
$codexPackage = Get-AppxPackage OpenAI.Codex
if (-not $codexPackage) {
    throw 'The Codex Windows App is not installed.'
}

$validator = Join-Path $codexPackage.InstallLocation 'app\resources\skills\skills\.curated\hatch-pet\scripts\validate_atlas.py'
if (-not (Test-Path -LiteralPath $validator)) {
    throw "Codex pet validator not found: $validator"
}
$python = (Get-Command python -ErrorAction Stop).Source
$chromaArguments = @('--chroma-key', '#00FF00')
foreach ($atlasPath in $atlasPaths) {
    if (-not (Test-Path -LiteralPath $atlasPath)) {
        throw "Generated atlas not found: $atlasPath"
    }
    & $python $validator $atlasPath --require-v2 @chromaArguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
