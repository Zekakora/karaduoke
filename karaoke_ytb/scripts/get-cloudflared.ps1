param(
  [string]$Destination = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $root "bin\cloudflared.exe" }
$Destination = [System.IO.Path]::GetFullPath($Destination)

if ((Test-Path $Destination) -and -not $Force) {
  Write-Host "已存在：$Destination"
  & $Destination --version
  exit $LASTEXITCODE
}

$directory = Split-Path -Parent $Destination
if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Host "正在下载 cloudflared 到 $Destination ..."
  & node (Join-Path $PSScriptRoot "download-cloudflared.js") $Destination
  if ($LASTEXITCODE -ne 0) { throw "下载失败，请检查网络后重试。" }
} else {
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Write-Host "未检测到 Node.js，改用 PowerShell 下载 ..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $Destination -UseBasicParsing
  $size = (Get-Item $Destination).Length
  if ($size -lt 10MB) {
    Remove-Item $Destination -Force -ErrorAction SilentlyContinue
    throw "下载的文件不完整（$size 字节），请检查网络后重试。"
  }
}

Write-Host "下载完成。"
& $Destination --version
