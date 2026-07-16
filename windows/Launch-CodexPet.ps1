Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$petScript = Join-Path $PSScriptRoot 'CodexPet.ps1'
$logRoot = Join-Path $env:LOCALAPPDATA 'Codex Pet\logs'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$startupLog = Join-Path $logRoot "startup-$timestamp.log"
$stdoutLog = Join-Path $logRoot "runtime-$timestamp.stdout.log"
$stderrLog = Join-Path $logRoot "runtime-$timestamp.stderr.log"

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Fail-Startup([string]$Message) {
    $details = @($Message)
    foreach ($path in @($startupLog, $stderrLog, $stdoutLog)) {
        if (Test-Path -LiteralPath $path) {
            $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
            if ($content) { $details += "`n--- $path ---`n$content" }
        }
    }
    [IO.File]::WriteAllText($startupLog, ($details -join "`n"), [Text.UTF8Encoding]::new($false))
    Write-Error (($details -join "`n") + "`nStartup log: $startupLog")
}

try {
    if (-not (Test-Path -LiteralPath $petScript)) {
        throw "Pet runtime script not found: $petScript"
    }

    $packageJson = Join-Path $projectRoot 'package.json'
    if (Test-Path -LiteralPath $packageJson) {
        Push-Location $projectRoot
        try {
            "Preparing local assets at $(Get-Date -Format o)" | Set-Content -LiteralPath $startupLog -Encoding UTF8
            & pnpm assets:prepare *>> $startupLog
            if ($LASTEXITCODE -ne 0) { throw "Asset preparation failed with exit code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    }

    $quotedPetScript = '"{0}"' -f $petScript
    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-File', $quotedPetScript) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    Start-Sleep -Seconds 3
    $process.Refresh()
    if ($process.HasExited) {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "Codex Pet exited during startup with code $($process.ExitCode)."
        }
    }

    "Started Codex Pet process $($process.Id) at $(Get-Date -Format o)" | Add-Content -LiteralPath $startupLog -Encoding UTF8
    Write-Output "Codex Pet started. Diagnostic log: $startupLog"
} catch {
    Fail-Startup $_.Exception.Message
    exit 1
}
