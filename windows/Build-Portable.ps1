param(
    [switch]$IncludeLocalClassicAssets
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Invalid package version: $version"
}

if ($IncludeLocalClassicAssets -and ($env:CI -eq 'true' -or $env:GITHUB_ACTIONS -eq 'true')) {
    throw 'Classic local assets are blocked in CI and public release environments.'
}

$releaseRoot = Join-Path $projectRoot 'release'
$flavour = if ($IncludeLocalClassicAssets) { 'local-classic' } else { 'public-placeholder' }
$portableRoot = Join-Path $releaseRoot "CodexPet-$version-$flavour"
$archiveName = if ($IncludeLocalClassicAssets) {
    "Codex-Pet-$version-local-classic-portable.zip"
} else {
    "Codex-Pet-$version-portable.zip"
}
$archivePath = Join-Path $releaseRoot $archiveName
$checksumPath = "$archivePath.sha256"
$manifestSidecar = Join-Path $releaseRoot ($archiveName -replace '\.zip$', '.build-manifest.json')

$resolvedProject = [IO.Path]::GetFullPath($projectRoot)
$resolvedPortable = [IO.Path]::GetFullPath($portableRoot)
if (-not $resolvedPortable.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Portable output escaped the project directory.'
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Assert-NoReparsePoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to use a reparse-point build path: $($item.FullName)"
    }
    if (-not $item.PSIsContainer) { return }
    foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to traverse a reparse point while cleaning build output: $($child.FullName)"
        }
        if ($child.PSIsContainer) {
            Assert-NoReparsePoint -Path $child.FullName
        }
    }
}

function Remove-BuildPath([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the project: $resolved"
    }
    Assert-NoReparsePoint -Path $resolved
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

Assert-NoReparsePoint -Path $releaseRoot

& node (Join-Path $projectRoot 'scripts\check-version-sync.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Version consistency check failed.' }

if (-not $IncludeLocalClassicAssets -and (Test-Path -LiteralPath $releaseRoot)) {
    $resolvedRelease = [IO.Path]::GetFullPath($releaseRoot)
    Assert-NoReparsePoint -Path $resolvedRelease
    Get-ChildItem -LiteralPath $resolvedRelease -Force |
        Where-Object { $_.Name -match '(?i)^(?:CodexPet-|Codex-Pet-)' } |
        ForEach-Object {
            $candidate = [IO.Path]::GetFullPath($_.FullName)
            if (-not $candidate.StartsWith($resolvedRelease + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove a generated artifact outside the release directory: $candidate"
            }
            Remove-BuildPath $candidate
        }
}

$previousForcePlaceholder = $env:CODEX_PET_FORCE_PLACEHOLDER
try {
    if ($IncludeLocalClassicAssets) {
        Remove-Item Env:CODEX_PET_FORCE_PLACEHOLDER -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_PET_FORCE_PLACEHOLDER = '1'
    }
    & node (Join-Path $projectRoot 'scripts\prepare-local-assets.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Asset preparation failed.' }
} finally {
    if ($null -eq $previousForcePlaceholder) {
        Remove-Item Env:CODEX_PET_FORCE_PLACEHOLDER -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_PET_FORCE_PLACEHOLDER = $previousForcePlaceholder
    }
}

$assetManifestPath = Join-Path $projectRoot 'public\local\pet.json'
$assetManifest = Get-Content -LiteralPath $assetManifestPath -Raw | ConvertFrom-Json
$publicSafe = [string]$assetManifest.id -eq 'codex-penguin-placeholder'
if (-not $IncludeLocalClassicAssets -and -not $publicSafe) {
    throw "PUBLIC RELEASE BLOCKED: expected codex-penguin-placeholder, got $($assetManifest.id)."
}
if ($IncludeLocalClassicAssets -and $publicSafe) {
    throw 'The explicit local-classic build was requested, but no classic local asset was selected.'
}

Remove-BuildPath $portableRoot
foreach ($path in @($archivePath, $checksumPath, $manifestSidecar)) { Remove-BuildPath $path }

$directories = @(
    (Join-Path $portableRoot 'windows'),
    (Join-Path $portableRoot 'public\local'),
    (Join-Path $portableRoot 'src-tauri\icons')
)
$directories | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

foreach ($file in @('CodexPet.ps1', 'Start-CodexPet.cmd', 'Launch-CodexPet.ps1')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "windows\$file") -Destination (Join-Path $portableRoot "windows\$file")
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'public\local\spritesheet.png') -Destination (Join-Path $portableRoot 'public\local\spritesheet.png')
Copy-Item -LiteralPath (Join-Path $projectRoot 'public\local\spritesheet.webp') -Destination (Join-Path $portableRoot 'public\local\spritesheet.webp')
Copy-Item -LiteralPath $assetManifestPath -Destination (Join-Path $portableRoot 'public\local\pet.json')
$desktopPoseSource = Join-Path $projectRoot 'public\local\desktop-poses.png'
if ($IncludeLocalClassicAssets -and (Test-Path -LiteralPath $desktopPoseSource)) {
    Copy-Item -LiteralPath $desktopPoseSource -Destination (Join-Path $portableRoot 'public\local\desktop-poses.png')
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\icons\icon.ico') -Destination (Join-Path $portableRoot 'src-tauri\icons\icon.ico')
foreach ($file in @('LICENSE', 'ASSET-LICENSES.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $portableRoot $file)
}

$instructions = @'
Codex Pet 便携版

1. 双击 windows\Start-CodexPet.cmd 启动。
2. 按住企鹅左键可拖动，右键打开菜单，双击企鹅会挥手。
3. 右键菜单可以控制动作、自动闲逛、动画暂停和退出。
4. 启动诊断日志保存在 %LOCALAPPDATA%\Codex Pet\logs。
5. 代码采用 MIT 许可证；宠物素材许可请查看 ASSET-LICENSES.md。
'@
[IO.File]::WriteAllText((Join-Path $portableRoot '使用说明.txt'), $instructions, [Text.UTF8Encoding]::new($true))

if ($IncludeLocalClassicAssets) {
    $warning = @'
LOCAL ONLY — DO NOT REDISTRIBUTE

This archive contains a locally supplied classic-penguin derivative that is not
licensed for public distribution by this project. Do not upload it to GitHub
Releases, package registries, app stores, or other public channels.
'@
    [IO.File]::WriteAllText(
        (Join-Path $portableRoot 'LOCAL-ONLY-NOT-FOR-REDISTRIBUTION.txt'),
        $warning,
        [Text.UTF8Encoding]::new($false)
    )
}

$commit = $null
try {
    $commit = (& git -C $projectRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { $commit = $null }
} catch { $commit = $null }

$fileEntries = @()
Get-ChildItem -LiteralPath $portableRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($portableRoot.Length + 1).Replace('\', '/')
    $fileEntries += [ordered]@{
        path = $relative
        bytes = $_.Length
        sha256 = Get-Sha256 $_.FullName
    }
}
$buildManifest = [ordered]@{
    schemaVersion = 1
    product = 'Codex Pet'
    version = $version
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    gitCommit = $commit
    packageType = 'portable-wpf'
    flavour = $flavour
    publicSafe = $publicSafe
    localOnly = [bool]$IncludeLocalClassicAssets
    petId = [string]$assetManifest.id
    files = $fileEntries
}
$manifestJson = $buildManifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText((Join-Path $portableRoot 'build-manifest.json'), $manifestJson + "`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($manifestSidecar, $manifestJson + "`n", [Text.UTF8Encoding]::new($false))

Compress-Archive -LiteralPath $portableRoot -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = Get-Sha256 $archivePath
[IO.File]::WriteAllText($checksumPath, "$archiveHash  $archiveName`n", [Text.UTF8Encoding]::new($false))

Write-Output "Portable app: $portableRoot"
Write-Output "Portable archive: $archivePath"
Write-Output "SHA-256: $archiveHash"
Write-Output "Build manifest: $manifestSidecar"
if ($IncludeLocalClassicAssets) {
    Write-Warning 'This local-only archive is blocked from every public release gate.'
}
