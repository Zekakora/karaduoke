@echo off
rem ============================================================
rem  Karaduoke - Basic environment setup
rem
rem  Node.js lookup order (same as start.cmd / start.vbs):
rem    1. Node.js already installed on this machine (20 or newer)
rem    2. Bundled runtime\node\node.exe shipped with this release
rem    3. Download a portable Node.js as a last resort
rem
rem  This release normally ships with Node.js inside runtime\node\,
rem  so on a fresh machine nothing has to be downloaded.
rem
rem  This does NOT modify your system PATH or registry,
rem  needs no administrator rights, and is fully portable.
rem
rem  Order of use:
rem    setup-runtime.cmd  (this file)  ->  start.cmd
rem
rem  Mode B also needs Python. After starting the console,
rem  go to "Environment" and click "Download Python setup".
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "ROOT=%CD%"
set "RUNTIME=%ROOT%\runtime\node"
set "NODE_EXE=%RUNTIME%\node.exe"
set "MIN_MAJOR=20"

echo ============================================================
echo   Karaduoke - Basic environment setup
echo   Project : %ROOT%
echo ============================================================
echo.

rem ---------- 1. System Node.js (preferred, matches start.cmd order) ----------
echo [1/3] Checking for Node.js installed on this machine...
set "SYS_NODE="
set "SYS_MAJOR=0"

rem Must verify with "exist": PATH may contain a stale folder (e.g. the
rem user renamed or uninstalled C:\Program Files\nodejs but PATH was not
rem updated). "where" still returns a path, but the file is gone, and
rem using it directly fails with spawn ENOENT.
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined SYS_NODE if exist "%%i" set "SYS_NODE=%%i"
)

if not defined SYS_NODE goto :check_bundled

for /f "tokens=1 delims=." %%v in ('"!SYS_NODE!" --version 2^>nul') do (
  set "VER_RAW=%%v"
  set "VER_RAW=!VER_RAW:v=!"
  set "SYS_MAJOR=!VER_RAW!"
)
if not defined SYS_MAJOR set "SYS_MAJOR=0"

if !SYS_MAJOR! GEQ %MIN_MAJOR% goto :use_sys_node
echo   Found Node.js major !SYS_MAJOR! at !SYS_NODE! - too old, need %MIN_MAJOR%+.
echo.

:use_sys_node
echo   Using system Node.js: !SYS_NODE!
echo   Version: v!SYS_MAJOR!
echo.
goto :done

rem ---------- 2. Bundled Node.js (fallback, no internet needed) ----------
:check_bundled
echo [2/3] Checking bundled Node.js...
if not exist "%NODE_EXE%" goto :no_bundled

set "BUNDLED_VER="
for /f "delims=" %%v in ('"%NODE_EXE%" --version 2^>nul') do set "BUNDLED_VER=%%v"

if defined BUNDLED_VER (
  echo   Bundled Node.js found: !BUNDLED_VER!
  echo   Location: %NODE_EXE%
  echo.
  goto :done
)

echo   Bundled node.exe exists but cannot run.
echo   Expected: %NODE_EXE%
echo   The file may be corrupted or blocked. Retrying with a download...
echo.
goto :try_network

:no_bundled
echo   No bundled Node.js (runtime\node\node.exe not found).
echo.
goto :try_network


rem ---------- 3. Download portable Node.js ----------
:try_network
echo [3/3] Downloading portable Node.js...
echo.

set "NODE_VERSION=v22.11.0"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip"

rem Use a project-local temp folder: avoids problems when %TEMP% contains
rem non-ASCII characters (e.g. Chinese user names) which breaks tar.
set "WORKDIR=%ROOT%\.tmp\node-download"
if exist "%WORKDIR%" rmdir /s /q "%WORKDIR%" 2>nul
mkdir "%WORKDIR%" 2>nul
if not exist "%WORKDIR%" goto :fail_tmp

set "KD_TMP=%WORKDIR%"
set "KD_URL=%NODE_URL%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Write-Host '  downloading...'; Invoke-WebRequest -Uri $env:KD_URL -OutFile (Join-Path $env:KD_TMP 'node.zip') -UseBasicParsing; exit 0 } catch { Write-Host ('  download failed: ' + $_.Exception.Message); exit 1 }"

if errorlevel 1 goto :fail_download
if not exist "%WORKDIR%\node.zip" goto :fail_download

echo   Extracting...
rem Expand-Archive is used instead of tar: it handles long paths and
rem non-ASCII names more reliably on Chinese Windows installs.
set "KD_ZIP=%WORKDIR%\node.zip"
set "KD_OUT=%WORKDIR%\extracted"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath $env:KD_ZIP -DestinationPath $env:KD_OUT -Force; exit 0 } catch { Write-Host ('  extract failed: ' + $_.Exception.Message); exit 1 }"

if errorlevel 1 goto :fail_extract

set "EXTRACTED="
for /d %%d in ("%WORKDIR%\extracted\node-v*-win-x64") do set "EXTRACTED=%%d"
if not defined EXTRACTED goto :fail_extract
if not exist "!EXTRACTED!\node.exe" goto :fail_extract

if not exist "%ROOT%\runtime" mkdir "%ROOT%\runtime" 2>nul
if exist "%RUNTIME%" rmdir /s /q "%RUNTIME%" 2>nul
move "!EXTRACTED!" "%RUNTIME%" >nul 2>&1
if not exist "%NODE_EXE%" goto :fail_extract

rmdir /s /q "%WORKDIR%" 2>nul

set "NEW_VER="
for /f "delims=" %%v in ('"%NODE_EXE%" --version 2^>nul') do set "NEW_VER=%%v"
if not defined NEW_VER goto :fail_extract

echo   Installed: !NEW_VER!
echo.
goto :done

rem ---------- Success ----------
:done
echo ============================================================
echo   Node.js is ready. You can run start.cmd now.
echo ============================================================
echo.
echo   Mode B (local library) also needs Python:
echo   open the console (start.cmd), go to "Environment",
echo   click "Download Python setup", then run setup-env.cmd.
echo.
echo   System PATH and registry were NOT modified.
echo.
pause
exit /b 0

rem ---------- Failure branches ----------
:fail_tmp
echo.
echo [ERROR] Cannot create a working folder here:
echo   %WORKDIR%
echo.
echo   Check that this folder is writable (not on a read-only drive
echo   or inside a compressed/network location).
echo.
pause
exit /b 1

:fail_download
echo.
echo [ERROR] Could not download Node.js.
echo.
echo   Check your internet connection and try again.
echo.
echo   This release normally includes Node.js already
echo   (runtime\node\node.exe). If that file is missing, you can
echo   also install Node.js manually:
echo     1. Download "Windows Installer (.msi)" from https://nodejs.org/
echo     2. Install it (LTS 20 or newer)
echo     3. Run this script again, or just run start.cmd
echo.
if exist "%WORKDIR%" rmdir /s /q "%WORKDIR%" 2>nul
pause
exit /b 1

:fail_extract
echo.
echo [ERROR] Could not unpack the Node.js package.
echo.
echo   The downloaded file may be incomplete or blocked by
echo   antivirus software.
echo.
echo   You can install Node.js manually instead:
echo     1. Download "Windows Installer (.msi)" from https://nodejs.org/
echo     2. Install it (LTS 20 or newer)
echo     3. Run start.cmd
echo.
echo   Leftover files are in: %WORKDIR%
echo   (you can delete that folder)
echo.
pause
exit /b 1
