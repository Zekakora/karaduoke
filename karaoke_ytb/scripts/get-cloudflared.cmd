@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-cloudflared.ps1" %*
if errorlevel 1 (
  echo.
  echo 下载失败，请检查网络后重试。
  pause
  exit /b 1
)
