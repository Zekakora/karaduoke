@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

node "launcher\main.js"
if errorlevel 1 pause
