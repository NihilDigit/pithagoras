@echo off
setlocal

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
)

exit /b %ERRORLEVEL%
