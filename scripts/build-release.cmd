@echo off
rem ============================================================
rem  Karaduoke release builder
rem
rem  Builds a self-contained release that runs on a fresh Windows
rem  machine WITHOUT any preinstalled Node.js or Python:
rem    - app code + node_modules
rem    - bundled portable Node.js (runtime\node\)
rem  Excluded on purpose: env\, assets\, data\, config\, logs
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0.."
set "ROOT=%CD%"

set "VERSION=0.4.0"
set "PKG=Karaduoke-%VERSION%-win64"
set "DIST=%ROOT%\dist"
set "STAGE=%DIST%\%PKG%"
set "ZIP=%DIST%\%PKG%.zip"

echo ============================================================
echo   Building %PKG%
echo   Root : %ROOT%
echo   Out  : %ZIP%
echo ============================================================
echo.

if exist "%STAGE%" rmdir /s /q "%STAGE%"
if not exist "%DIST%" mkdir "%DIST%"
mkdir "%STAGE%" 2>nul

rem ---------- 1. Top-level files ----------
echo [1/6] Copying top-level files...
for %%f in (main.js version.json start.cmd start.vbs setup-runtime.cmd README.md README.zh-CN.md .gitignore) do (
  if exist "%%f" (copy /y "%%f" "%STAGE%\" >nul) else (echo   WARN missing %%f)
)

rem ---------- 2. launcher ----------
echo [2/6] Copying launcher...
robocopy "launcher" "%STAGE%\launcher" /E /NFL /NDL /NJH /NJS /NP /XD tests >nul
if errorlevel 8 goto :fail

rem ---------- 3. karaoke_ytb ----------
echo [3/6] Copying karaoke_ytb...
robocopy "karaoke_ytb" "%STAGE%\karaoke_ytb" /E /NFL /NDL /NJH /NJS /NP ^
  /XD data .tmp tmp logs assets .cache tests >nul
if errorlevel 8 goto :fail

rem ---------- 4. karaoke_spo ----------
echo [4/6] Copying karaoke_spo...
robocopy "karaoke_spo" "%STAGE%\karaoke_spo" /E /NFL /NDL /NJH /NJS /NP ^
  /XD data .tmp tmp logs assets .cache __pycache__ tests ^
  /XF .env *.bak *.orig *.before-merge >nul
if errorlevel 8 goto :fail

rem ---------- 5. Remove leftovers ----------
echo [5/6] Cleaning...
for /d /r "%STAGE%" %%d in (__pycache__) do @if exist "%%d" rmdir /s /q "%%d" 2>nul
del /q "%STAGE%\config\config.json" 2>nul

rem Empty folders the app expects to exist
mkdir "%STAGE%\config" 2>nul
mkdir "%STAGE%\logs" 2>nul
mkdir "%STAGE%\karaoke_spo\data" 2>nul
mkdir "%STAGE%\karaoke_ytb\data" 2>nul

rem ---------- 5b. User-facing docs ----------
rem 这两份文档放在 docs\ 下作为源文件，打进 zip 根目录方便用户直接看到。
echo [5b] Copying docs...
for %%d in (使用说明.md 环境部署指南.md) do (
  if exist "docs\%%d" (copy /y "docs\%%d" "%STAGE%\%%d" >nul) else (echo   WARN missing docs\%%d)
)

rem ---------- 6. Bundled Node.js ----------
echo [6/6] Bundling Node.js...
set "NODE_SRC="
if exist "%ROOT%\runtime\node\node.exe" set "NODE_SRC=%ROOT%\runtime\node\node.exe"
if not defined NODE_SRC if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_SRC=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_SRC (
  echo   ERROR: Node.js not found. Run setup-runtime.cmd first,
  echo          or install Node.js 20+ from https://nodejs.org/
  goto :fail
)
mkdir "%STAGE%\runtime\node" 2>nul
copy /y "!NODE_SRC!" "%STAGE%\runtime\node\node.exe" >nul
if errorlevel 1 goto :fail
echo   bundled: !NODE_SRC!

rem ---------- Verify ----------
echo.
echo [check] Verifying package...
set "PROBLEM=0"
if exist "%STAGE%\env" (echo   ERROR: env found & set "PROBLEM=1")
if exist "%STAGE%\karaoke_spo\assets" (echo   ERROR: assets found & set "PROBLEM=1")
if exist "%STAGE%\karaoke_spo\.env" (echo   ERROR: .env found & set "PROBLEM=1")
if exist "%STAGE%\config\config.json" (echo   ERROR: config.json found & set "PROBLEM=1")
if not exist "%STAGE%\runtime\node\node.exe" (echo   ERROR: bundled node missing & set "PROBLEM=1")
if "%PROBLEM%"=="1" goto :fail
echo   OK

rem ---------- Zip ----------
echo.
echo [zip] Compressing (this takes a while with the 90MB node.exe)...
if exist "%ZIP%" del /q "%ZIP%"
pushd "%DIST%"
tar -a -c -f "%ZIP%" "%PKG%"
popd
if not exist "%ZIP%" goto :fail

echo.
echo ============================================================
echo   Done: %ZIP%
for %%z in ("%ZIP%") do echo   Size: %%~zz bytes
echo ============================================================
pause
exit /b 0

:fail
echo.
echo BUILD FAILED
pause
exit /b 1
