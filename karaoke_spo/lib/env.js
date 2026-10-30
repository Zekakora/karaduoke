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

/**
 * 环境目录（Python / 模型缓存 / 二进制）。
 *
 * 顺序：KARAOKE_ENV_DIR（控制面板注入）→ **真正可用的**那个 env\。
 *
 * 判断"可用"的标准是 **`<dir>\python\Scripts\python.exe` 存在**，而不是"目录存在"：
 * 以前只看 `<ROOT>\env`（= karaoke_spo\env），而这个目录可能是别处残留的空壳
 * （只有 cache/，没有 python/），于是 Python / ffmpeg 全部找不到，
 * 后台制作每首都会失败（错误信息只有 `spawn ... ENOENT`，很难看出根因）。
 */
function isUsableEnvDir(dir) {
  try {
    return fs.existsSync(path.join(dir, 'python', 'Scripts', 'python.exe'))
      || fs.existsSync(path.join(dir, 'python', 'python.exe'));
  } catch {
    return false;
  }
}

function resolveEnvDir() {
  const explicit = String(process.env.KARAOKE_ENV_DIR || '').trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (isUsableEnvDir(resolved)) return resolved;
    // 显式配置了但里面没有 Python：仍然优先用它（用户可能只想要个 cache 目录），
    // 不能因为"没有 python"就悄悄换成别的目录。
    return resolved;
  }
  const candidates = [path.join(ROOT, '..', 'env'), path.join(ROOT, 'env')];
  for (const candidate of candidates) {
    if (isUsableEnvDir(candidate)) return path.resolve(candidate);
  }
  // 都不完整时按"项目根 env\（旧布局）→ 工程根 env\"的顺序给个默认值，便于报错时看到位置
  return path.resolve(candidates[0]);
}

const ENV_DIR = resolveEnvDir();

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

/**
 * 读 YouTube API Key —— 与模式 A 用**同一份**配置。
 *
 * 正常由启动器通过环境变量注入（控制面板「设置 → YouTube API Key」）。直接启动工程
 * （不经控制面板）时环境变量可能为空，这时回退到项目根的 `config/config.json`，
 * 也就是模式 A 读的那份，保证两个模式的搜索/匹配行为一致。
 */
function youtubeApiKey() {
  const fromEnv = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const candidates = [path.join(ROOT, '..', 'config', 'config.json'), path.join(ROOT, 'config', 'config.json')];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const key = String((config && config.youtubeApiKey) || '').trim();
      if (key) {
        process.env.YOUTUBE_API_KEY = key;
        return key;
      }
    } catch { /* 配置坏了就当没有 */ }
  }
  return '';
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

module.exports = { ROOT, ENV_DIR, resolveEnvDir, loadEnv, firstExisting, youtubeApiKey };
