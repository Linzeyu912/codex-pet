Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$classicSource = Join-Path $projectRoot '.local-assets\qq-penguin\pixel-base.png'
$atlasRoot = if ($env:CODEX_PET_FORCE_PLACEHOLDER -ne '1' -and (Test-Path -LiteralPath $classicSource)) {
    Join-Path $projectRoot '.local-assets\qq-penguin\codex-pet'
} else {
    Join-Path $projectRoot '.local-assets\placeholder\codex-pet'
}
$atlasPaths = @(
    (Join-Path $atlasRoot 'spritesheet.webp'),
    (Join-Path $atlasRoot 'spritesheet.png')
)
$codexPackage = Get-AppxPackage OpenAI.Codex
if (-not $codexPackage) {
    throw 'The Codex Windows App is not installed.'
}

$validator = Join-Path $codexPackage.InstallLocation 'app\resources\skills\skills\.curated\hatch-pet\scripts\validate_atlas.py'
if (-not (Test-Path -LiteralPath $validator)) {
    throw "Codex pet validator not found: $validator"
}
$python = (Get-Command python -ErrorAction Stop).Source
foreach ($atlasPath in $atlasPaths) {
    if (-not (Test-Path -LiteralPath $atlasPath)) {
        throw "Generated atlas not found: $atlasPath"
    }
    & $python $validator $atlasPath --require-v2
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
