'use strict';
/**
 * 极简 .env 加载 + 环境目录（Python / 模型缓存 / 二进制）解析。
 *
 * 环境目录默认是项目根的 env\，可由控制面板通过 KARAOKE_ENV_DIR 覆盖：
 *   env\python\   Python 虚拟环境（Scripts\python.exe）
 *   env\cache\    torch / huggingface / yt-dlp 模型缓存
 *   env\bin\      ffmpeg / ffprobe / cloudflared
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENV_DIR = process.env.KARAOKE_ENV_DIR
  ? path.resolve(process.env.KARAOKE_ENV_DIR)
  : path.join(ROOT, 'env');

// 统一把临时目录与模型缓存放到项目内（用户主目录下的系统临时目录不可写）。
// 外部已设置的值优先（控制面板注入的路径会覆盖这里的默认值）。
for (const [key, value] of Object.entries({
  TMP: path.join(ROOT, '.tmp'),
  TEMP: path.join(ROOT, '.tmp'),
  TORCH_HOME: path.join(ENV_DIR, 'cache', 'torch'),
  HF_HOME: path.join(ENV_DIR, 'cache', 'huggingface'),
  PYTHONIOENCODING: 'utf-8',
})) {
  if (!process.env[key]) process.env[key] = value;
  try { fs.mkdirSync(process.env[key], { recursive: true }); } catch { /* 忽略 */ }
}

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) {
      out[m[1]] = m[2];
      if (!process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  return out;
}

/** 取第一个存在的候选路径，都没有就返回第一个（便于报错时显示预期位置） */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return candidates.find(Boolean) || '';
}

module.exports = { ROOT, ENV_DIR, loadEnv, firstExisting };
