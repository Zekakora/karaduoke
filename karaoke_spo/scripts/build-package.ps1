param(
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$name = "Karaoke-$($package.version)-win-x64"
$dist = Join-Path $root "dist"
$stage = Join-Path $dist $name
$zip = Join-Path $dist "$name.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$items = @("launcher", "public", "node_modules", "server.js", "main.js", "package.json", "package-lock.json")
foreach ($item in $items) {
  $source = Join-Path $root $item
  if (-not (Test-Path $source)) { throw "缺少必要文件：$item" }
  Copy-Item $source -Destination $stage -Recurse -Force
}

foreach ($dir in @("bin", "runtime", "config", "data", "logs")) {
  New-Item -ItemType Directory -Path (Join-Path $stage $dir) -Force | Out-Null
}

$cloudflared = Join-Path $root "bin\cloudflared.exe"
if (-not (Test-Path $cloudflared)) { throw "缺少 bin\cloudflared.exe，请先运行 scripts\get-cloudflared.cmd" }
Copy-Item $cloudflared (Join-Path $stage "bin\cloudflared.exe") -Force

$node = (Get-Command node).Source
Copy-Item $node (Join-Path $stage "runtime\node.exe") -Force

$startScript = @'
@echo off
setlocal
cd /d "%~dp0"

if exist "runtime\node.exe" (
  "runtime\node.exe" "launcher\main.js" %*
  goto done
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js runtime was not found. Please extract the package again.
  pause
  exit /b 1
)
node "launcher\main.js" %*

:done
if errorlevel 1 pause
'@
Set-Content -Path (Join-Path $stage "Start Karaoke.cmd") -Value $startScript -Encoding ASCII

$hiddenStartScript = @'
Option Explicit

Dim shell, fso, root, nodePath, launcherPath, command, arg
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = fso.BuildPath(root, "runtime\node.exe")
launcherPath = fso.BuildPath(root, "launcher\main.js")

If fso.FileExists(nodePath) Then
  command = Quote(nodePath) & " " & Quote(launcherPath)
Else
  command = "node " & Quote(launcherPath)
End If

For Each arg In WScript.Arguments
  command = command & " " & Quote(arg)
Next

shell.CurrentDirectory = root
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
'@
Set-Content -Path (Join-Path $stage "Start Karaoke.vbs") -Value $hiddenStartScript -Encoding ASCII

$readme = @'
KARAOKE CONSOLE
===============

1. Double-click "Start Karaoke.vbs". The control panel appears in its own
   window without showing a command window (http://127.0.0.1:8787).
   Use "Start Karaoke.cmd" when you need to see startup errors.
   If Windows shows a security warning, choose "More info" > "Run anyway".
2. Click "Start service".
3. Open http://localhost:3000/display on the projector, press the fullscreen
   button. Guests scan the QR code, pick songs and join the queue.
4. If guests are not on the same network, click "Enable tunnel" and share the
   public address shown in the panel. The address changes on every start.

Language: switch between English, 中文 and Deutsch at the top right.
DJ console: http://localhost:3000/admin - the password is in "Settings".
Settings, data and logs live in config\, data\ and logs\.
cloudflared is bundled in bin\. Config file: config\config.json.

----------------------------------------------------------------------

KARAOKE-KONSOLE
===============

1. "Start Karaoke.vbs" doppelklicken. Das Bedienfenster unter
   http://127.0.0.1:8787 oeffnet sich ohne Konsolenfenster.
   Fuer Fehlersuche "Start Karaoke.cmd" verwenden.
2. "Dienst starten" anklicken.
3. Auf dem Beamer http://localhost:3000/display oeffnen und Vollbild
   aktivieren. Gaeste scannen den QR-Code und waehlen Songs.
4. Wenn die Gaeste nicht im selben Netzwerk sind: "Tunnel starten" und die
   oeffentliche Adresse teilen. Sie aendert sich bei jedem Start.

Sprache: oben rechts zwischen English, 中文 und Deutsch wechseln.
DJ-Konsole: http://localhost:3000/admin - Passwort steht in "Einstellungen".
Konfiguration, Daten und Protokolle: config\, data\, logs\.

----------------------------------------------------------------------

卡拉OK 控制台
=============

1. 双击 "Start Karaoke.vbs"，只打开控制面板，不显示命令行窗口
   （http://127.0.0.1:8787）。需要查看启动错误时再使用 "Start Karaoke.cmd"。
2. 点「Start service / 开启服务」。
3. 在投影仪上打开 http://localhost:3000/display 并全屏，观众扫码点歌。
4. 如果观众和电脑不在同一网络，点「Enable tunnel / 开启穿透」，
   把面板上显示的公网地址发给观众；每次启动地址都会变。

右上角可切换 English / 中文 / Deutsch。
DJ 控制台：http://localhost:3000/admin，密码在「环境设置」里查看。
配置、数据和日志分别在 config\、data\、logs\。
'@
Set-Content -Path (Join-Path $stage "README.txt") -Value $readme -Encoding UTF8

$notices = @'
Third-party components bundled with this package
================================================

Node.js
  Copyright Node.js contributors. MIT License.
  https://nodejs.org

cloudflared
  Copyright Cloudflare, Inc. Apache License 2.0.
  https://github.com/cloudflare/cloudflared

qrcode (npm)
  Copyright Ryan Day. MIT License.
  https://github.com/soldair/node-qrcode

The full license texts are available at the project URLs above.
'@
Set-Content -Path (Join-Path $stage "THIRD-PARTY-NOTICES.txt") -Value $notices -Encoding UTF8

if ($SkipZip) {
  Write-Host "已生成目录：$stage"
  exit 0
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "正在压缩 $name ..."
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$size = (Get-Item $zip).Length / 1MB
Write-Host ("完成：{0}（{1:N1} MB）" -f $zip, $size)
