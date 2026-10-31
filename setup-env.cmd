@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "D:\Projects\Karaduoke"
echo ============================================================
echo  Karaduoke - Python environment setup
echo  Project: D:\Projects\Karaduoke
echo  Target : D:\Projects\Karaduoke\env
echo ============================================================
echo.

rem ---------- uv: 全局缓存/安装目录都指向项目内，避免污染用户目录 ----------
set "UV_CACHE_DIR=D:\Projects\Karaduoke\env\cache\uv"
set "UV_PYTHON_INSTALL_DIR=D:\Projects\Karaduoke\env\python-runtime"
set "UV_NO_MODIFY_PATH=1"
set "UV_PYTHON_DOWNLOADS=automatic"

rem ---------- 1/4 找到或下载 uv ----------
if not exist "D:\Projects\Karaduoke\env\bin" mkdir "D:\Projects\Karaduoke\env\bin"
if exist "D:\Projects\Karaduoke\env\bin\uv.exe" goto :uv_ready

rem 先看系统 PATH 里有没有现成的 uv（有就直接用，省一次下载）
where uv >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('where uv') do @set "UV_FROM_PATH=%%i"
  echo [1/4] Found uv on PATH: !UV_FROM_PATH!
  copy /y "!UV_FROM_PATH!" "D:\Projects\Karaduoke\env\bin\uv.exe" >nul 2>nul
  if exist "D:\Projects\Karaduoke\env\bin\uv.exe" goto :uv_ready
)

echo [1/4] Downloading uv (about 15 MB)...
set "UV_TMP=%TEMP%\karaduoke-uv-%RANDOM%"
mkdir "!UV_TMP!" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile (Join-Path $env:UV_TMP 'uv.zip') -UseBasicParsing; exit 0 } catch { Write-Host ("download failed: " + $_.Exception.Message); exit 1 }" || goto :fail_uv
rem Windows 10+ 自带 tar 支持 zip
tar -xf "!UV_TMP!\uv.zip" -C "!UV_TMP!" 2>nul
if not exist "!UV_TMP!\uv.exe" goto :fail_uv
copy /y "!UV_TMP!\uv.exe" "D:\Projects\Karaduoke\env\bin\uv.exe" >nul
rmdir /s /q "!UV_TMP!" 2>nul
echo   uv installed.

:uv_ready
if not exist "D:\Projects\Karaduoke\env\bin\uv.exe" goto :fail_uv
"D:\Projects\Karaduoke\env\bin\uv.exe" --version || goto :fail_uv
echo.

rem ---------- 2/4 下载 Python 本体到项目内 ----------
if exist "D:\Projects\Karaduoke\env\python-runtime" (echo [2/4] Removing previous Python runtime...)
if exist "D:\Projects\Karaduoke\env\python-runtime" rmdir /s /q "D:\Projects\Karaduoke\env\python-runtime"
echo [2/4] Installing Python 3.12 into D:\Projects\Karaduoke\env\python-runtime
"D:\Projects\Karaduoke\env\bin\uv.exe" python install 3.12 --install-dir "D:\Projects\Karaduoke\env\python-runtime" || goto :fail_python
set "BASE_PY="
for /d %%d in ("D:\Projects\Karaduoke\env\python-runtime\cpython-3.12*") do ( if exist "%%d\python.exe" set "BASE_PY=%%d\python.exe" )
if not defined BASE_PY goto :fail_python
echo   Python ready: !BASE_PY!
echo.

rem ---------- 3/4 创建 venv ----------
if exist "D:\Projects\Karaduoke\env\python" (echo [3/4] Removing previous venv...)
if exist "D:\Projects\Karaduoke\env\python" rmdir /s /q "D:\Projects\Karaduoke\env\python"
echo [3/4] Creating venv at D:\Projects\Karaduoke\env\python
"D:\Projects\Karaduoke\env\bin\uv.exe" venv "D:\Projects\Karaduoke\env\python" --python "!BASE_PY!" --seed || goto :fail_venv
if not exist "D:\Projects\Karaduoke\env\python\Scripts\python.exe" goto :fail_venv
echo.

rem ---------- 4/4 安装依赖 ----------
echo [4/4] Installing dependencies (this can take 10-30 min, several GB)...
echo       torch(XPU) / torchaudio / demucs / yt-dlp ...
"D:\Projects\Karaduoke\env\python\Scripts\python.exe" -m pip install --upgrade pip || goto :fail_pip
"D:\Projects\Karaduoke\env\python\Scripts\python.exe" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/xpu || goto :fail_pip
"D:\Projects\Karaduoke\env\python\Scripts\python.exe" -m pip install demucs yt-dlp soundfile numpy requests || goto :fail_pip
echo.
echo ============================================================
echo  Done. Python and all dependencies are ready.
echo  Go back to the console and click "Refresh".
echo ============================================================
pause
exit /b 0

:fail_uv
echo.
echo [ERROR] Could not prepare uv.
echo   Check your network, or download it manually and put it here:
echo   D:\Projects\Karaduoke\env\bin\uv.exe
echo   Download: https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip
pause
exit /b 1

:fail_python
echo.
echo [ERROR] Could not install the Python runtime.
echo   Check your network connection and try again.
pause
exit /b 1

:fail_venv
echo.
echo [ERROR] Could not create the virtual environment.
pause
exit /b 1

:fail_pip
echo.
echo [ERROR] Failed to install Python dependencies.
echo   Usually a network issue. Re-run this script - it will reuse
echo   the existing Python runtime and only retry the packages.
pause
exit /b 1
