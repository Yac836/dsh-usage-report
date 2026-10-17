@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7.2 or later is required. Run this on the Windows host with pwsh installed.
  pause
  exit /b 1
)
pwsh.exe -NoProfile -File "%~dp0scripts\sync-deploy.ps1" %*
set "DSH_UPDATE_EXIT=%ERRORLEVEL%"
pause
exit /b %DSH_UPDATE_EXIT%
