Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$classicSource = Join-Path $projectRoot '.local-assets\qq-penguin\pixel-base.png'
$coherentAtlas = Join-Path $projectRoot '.local-assets\qq-penguin\coherent-v2-run\final\spritesheet-extended.webp'
$coherentValidation = Join-Path $projectRoot '.local-assets\qq-penguin\coherent-v2-run\final\validation-extended.json'
$hasClassicSource = Test-Path -LiteralPath $classicSource
$hasValidatedCoherentAtlas = (Test-Path -LiteralPath $coherentAtlas) -and (Test-Path -LiteralPath $coherentValidation)
$forcePublicMascot = $env:CODEX_PET_FORCE_PUBLIC_MASCOT -eq '1' -or $env:CODEX_PET_FORCE_PLACEHOLDER -eq '1'
$useCoherentAtlas = -not $forcePublicMascot -and $hasValidatedCoherentAtlas
$atlasRoot = if (-not $forcePublicMascot -and ($hasClassicSource -or $useCoherentAtlas)) {
    Join-Path $projectRoot '.local-assets\qq-penguin\codex-pet'
} else {
    Join-Path $projectRoot '.local-assets\public-mascot\codex-pet'
}
$atlasPaths = @(
    (Join-Path $atlasRoot 'spritesheet.webp'),
    (Join-Path $atlasRoot 'spritesheet.png')
)
if ($useCoherentAtlas) {
    # The local output adds deterministic repairs after the approved source
    # atlas: stable idle/hover upright scale, one directional scarf panel with transparent occlusion, and
    # cyan-matte removal. Verify the exact expected outputs instead of requiring
    # a raw byte-for-byte copy of the pre-repair source.
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $projectRoot 'scripts\check-local-atlas-freshness.mjs')
    if ($LASTEXITCODE -ne 0) {
        throw "Generated local atlas is stale. Run 'pnpm assets:prepare' first."
    }
}
$codexPackage = Get-AppxPackage OpenAI.Codex
if (-not $codexPackage) {
    throw 'The Codex Windows App is not installed.'
}

$validator = Join-Path $codexPackage.InstallLocation 'app\resources\skills\skills\.curated\hatch-pet\scripts\validate_atlas.py'
if (-not (Test-Path -LiteralPath $validator)) {
    throw "Codex pet validator not found: $validator"
}
$python = (Get-Command python -ErrorAction Stop).Source
$chromaArguments = if ($useCoherentAtlas) { @('--chroma-key', '#00FFFF') } else { @() }
foreach ($atlasPath in $atlasPaths) {
    if (-not (Test-Path -LiteralPath $atlasPath)) {
        throw "Generated atlas not found: $atlasPath"
    }
    & $python $validator $atlasPath --require-v2 @chromaArguments
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
