Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$classicSource = Join-Path $projectRoot '.local-assets\qq-penguin\pixel-base.png'
$coherentAtlas = Join-Path $projectRoot '.local-assets\qq-penguin\coherent-v2-run\final\spritesheet-extended.webp'
$coherentValidation = Join-Path $projectRoot '.local-assets\qq-penguin\coherent-v2-run\final\validation-extended.json'
$hasClassicSource = Test-Path -LiteralPath $classicSource
$hasValidatedCoherentAtlas = (Test-Path -LiteralPath $coherentAtlas) -and (Test-Path -LiteralPath $coherentValidation)
$useCoherentAtlas = $env:CODEX_PET_FORCE_PLACEHOLDER -ne '1' -and $hasValidatedCoherentAtlas
$atlasRoot = if ($env:CODEX_PET_FORCE_PLACEHOLDER -ne '1' -and ($hasClassicSource -or $useCoherentAtlas)) {
    Join-Path $projectRoot '.local-assets\qq-penguin\codex-pet'
} else {
    Join-Path $projectRoot '.local-assets\placeholder\codex-pet'
}
$atlasPaths = @(
    (Join-Path $atlasRoot 'spritesheet.webp'),
    (Join-Path $atlasRoot 'spritesheet.png')
)
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}
if ($useCoherentAtlas) {
    $builtWebp = $atlasPaths[0]
    if (-not (Test-Path -LiteralPath $builtWebp)) {
        throw "Generated coherent atlas not found: $builtWebp. Run 'pnpm assets:prepare' first."
    }
    $sourceHash = Get-Sha256 -Path $coherentAtlas
    $builtHash = Get-Sha256 -Path $builtWebp
    if ($sourceHash -ne $builtHash) {
        throw "Generated atlas is stale and does not match the validated coherent source. Run 'pnpm assets:prepare' first."
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
