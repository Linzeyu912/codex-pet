@echo off
set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"
if exist "%PROJECT_DIR%\package.json" pnpm assets:prepare >nul 2>&1
start "Codex Pet" powershell.exe -NoProfile -WindowStyle Hidden -File "%~dp0CodexPet.ps1"
