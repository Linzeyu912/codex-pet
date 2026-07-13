Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot 'release'
$portableRoot = Join-Path $releaseRoot 'CodexPet-portable'
$archivePath = Join-Path $releaseRoot 'Codex-Pet-0.1.0-portable.zip'

$resolvedProject = [IO.Path]::GetFullPath($projectRoot)
$resolvedPortable = [IO.Path]::GetFullPath($portableRoot)
if (-not $resolvedPortable.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Portable output escaped the project directory.'
}

if (Test-Path -LiteralPath $portableRoot) {
    Remove-Item -LiteralPath $portableRoot -Recurse -Force
}
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}

$directories = @(
    (Join-Path $portableRoot 'windows'),
    (Join-Path $portableRoot 'public\local'),
    (Join-Path $portableRoot 'src-tauri\icons')
)
$directories | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

Copy-Item -LiteralPath (Join-Path $projectRoot 'windows\CodexPet.ps1') -Destination (Join-Path $portableRoot 'windows\CodexPet.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'windows\Start-CodexPet.cmd') -Destination (Join-Path $portableRoot 'windows\Start-CodexPet.cmd')
Copy-Item -LiteralPath (Join-Path $projectRoot 'public\local\spritesheet.png') -Destination (Join-Path $portableRoot 'public\local\spritesheet.png')
Copy-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\icons\icon.ico') -Destination (Join-Path $portableRoot 'src-tauri\icons\icon.ico')

$instructions = @'
Codex Pet 便携版

1. 双击 windows\Start-CodexPet.cmd 启动。
2. 按住企鹅左键可拖动，右键打开菜单，双击企鹅会挥手。
3. 右键菜单可暂停动画、演示动作、设置开机启动、隐藏或退出。
4. 经典企鹅素材仅供当前本地原型使用，请勿在未获授权时公开分发。
'@
[IO.File]::WriteAllText(
    (Join-Path $portableRoot '使用说明.txt'),
    $instructions,
    [Text.UTF8Encoding]::new($true)
)

Compress-Archive -LiteralPath $portableRoot -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "Portable app: $portableRoot"
Write-Output "Portable archive: $archivePath"
