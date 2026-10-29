'use strict';

// 用 Node 自带的 fetch 下载 cloudflared：比 Windows PowerShell 的 TLS 栈更稳，
// 在被系统代理或 TLS 策略折腾过的机器上也能用。
const fs = require('fs');
const path = require('path');

const URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const destination = path.resolve(process.argv[2] || path.join(__dirname, '..', 'bin', 'cloudflared.exe'));
const MIN_BYTES = 10 * 1024 * 1024;

(async () => {
  const response = await fetch(URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < MIN_BYTES) throw new Error(`下载的文件不完整（${buffer.length} 字节）`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
  console.log(`已写入 ${destination}（${(buffer.length / 1048576).toFixed(1)} MB）`);
})().catch(error => {
  console.error(`[错误] ${error.message}`);
  process.exit(1);
});
