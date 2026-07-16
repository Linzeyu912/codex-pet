@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -File "%~dp0Launch-CodexPet.ps1"
if errorlevel 1 (
  echo.
  echo Codex Pet failed to start. The diagnostic log is shown above.
  echo Please keep this window open when reporting the problem.
  pause
  exit /b 1
)
exit /b 0
