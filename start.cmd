@echo off
rem ============================================================
rem  Karaduoke launcher
rem
rem  Node.js lookup order:
rem    1. node found on the system PATH (preferred)
rem    2. runtime\node\node.exe  (portable copy shipped with this
rem                              release, used as a fallback)
rem
rem  If neither exists, tells the user to run setup-runtime.cmd.
rem ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PORTABLE_NODE=%~dp0runtime\node\node.exe"

rem ---------- 1. Prefer the Node.js installed on this machine ----------
rem Do not rely on "where node" alone. PATH may still contain a stale
rem folder (e.g. C:\Program Files\nodejs was renamed or uninstalled but
rem PATH was not updated). "where" can then return a path whose file no
rem longer exists, and spawning it fails with ENOENT.
rem So we additionally verify each candidate with "exist".
set "SYS_NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined SYS_NODE if exist "%%i" set "SYS_NODE=%%i"
)

if defined SYS_NODE (
  "%SYS_NODE%" "launcher\main.js"
  if errorlevel 1 pause
  exit /b 0
)

rem ---------- 2. Fall back to the bundled portable Node.js ----------
if exist "%PORTABLE_NODE%" (
  "%PORTABLE_NODE%" "launcher\main.js"
  if errorlevel 1 pause
  exit /b 0
)

rem ---------- 3. Nothing available ----------
echo.
echo ============================================================
echo   Node.js is required
echo ============================================================
echo.
echo   No Node.js was found on this computer, and the bundled
echo   copy is missing too.
echo.
echo   Please run this first:   setup-runtime.cmd
echo   It downloads Node.js into this project folder and does
echo   not modify your system environment.
echo.
echo   Alternatively install Node.js 20+ from https://nodejs.org/
echo.
pause
exit /b 1
