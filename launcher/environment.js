'use strict';

/**
 * 运行环境管理：Python 虚拟环境 / 模型缓存 / 二进制工具。
 *
 * 默认布局（项目根\env）：
 *   env\python\  Scripts\python.exe + site-packages
 *   env\cache\   torch\ huggingface\ yt-dlp\
 *   env\bin\     ffmpeg.exe ffprobe.exe cloudflared.exe
 *
 * 性能约定：status() 只做 existsSync 检查，绝不遍历目录；
 * 目录体积走 sizes() 异步统计并缓存，避免打开弹窗时卡住。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

/** 把控制面板里的相对路径解析成项目根下的绝对路径 */
function resolve(root, config) {
  const env = (config && config.env) || {};
  const rel = (value, fallback) => (value ? path.resolve(root, value) : fallback);
  const dir = rel(env.dir, path.join(root, 'env'));
  const pythonDir = rel(env.python, path.join(dir, 'python'));
  const cacheDir = rel(env.cache, path.join(dir, 'cache'));
  const binDir = rel(env.bin, path.join(dir, 'bin'));
  return {
    dir,
    pythonDir,
    cacheDir,
    binDir,
    python: path.join(pythonDir, 'Scripts', 'python.exe'),
    ffmpeg: path.join(binDir, 'ffmpeg.exe'),
    ffprobe: path.join(binDir, 'ffprobe.exe'),
    cloudflared: path.join(binDir, 'cloudflared.exe'),
    torch: path.join(cacheDir, 'torch'),
    hf: path.join(cacheDir, 'huggingface'),
  };
}

/** 旧布局下的位置（迁移源） */
function legacyPaths(root) {
  return {
    python: path.join(root, 'karaoke_spo', 'python', '.venv-xpu'),
    pythonAlt: path.join(root, 'karaoke_spo', 'python', '.venv'),
    cache: path.join(root, 'karaoke_spo', '.cache'),
    bin: path.join(root, 'karaoke_spo', 'data', 'bin'),
    binAlt: path.join(root, 'karaoke_ytb', 'bin'),
  };
}

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};

// ---------------------------------------------------------------- 体积统计（异步 + 缓存）
const sizeCache = new Map(); // dir -> { at, bytes }
const SIZE_TTL = 5 * 60 * 1000;

async function dirSize(dir) {
  const cached = sizeCache.get(dir);
  if (cached && Date.now() - cached.at < SIZE_TTL) return cached.bytes;

  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += (await fsp.stat(full)).size; } catch { /* ignore */ }
      }
    }
  }
  sizeCache.set(dir, { at: Date.now(), bytes: total });
  return total;
}

/**
 * 各目录体积（异步）。
 * 只统计 cache 和 bin：Python 目录有近 3 万个文件，遍历要好几秒，
 * 而用户真正关心的是「模型缓存占多大」，所以 python 直接返回 null。
 */
async function sizes(root, config) {
  const p = resolve(root, config);
  const [cache, bin] = await Promise.all([dirSize(p.cacheDir), dirSize(p.binDir)]);
  return { python: null, cache, bin, total: cache + bin };
}

// ---------------------------------------------------------------- 状态（快速，不遍历目录）
function status(root, config) {
  const paths = resolve(root, config);
  const legacy = legacyPaths(root);

  const pendingPython = exists(legacy.python) ? legacy.python : (exists(legacy.pythonAlt) ? legacy.pythonAlt : '');

  return {
    paths,
    legacy,
    ready: {
      python: exists(paths.python),
      ffmpeg: exists(paths.ffmpeg),
      ffprobe: exists(paths.ffprobe),
      cloudflared: exists(paths.cloudflared),
    },
    // 缓存命中就带上，否则由前端另外请求 /api/env/sizes
    sizes: (() => {
      const python = sizeCache.get(paths.pythonDir);
      const cache = sizeCache.get(paths.cacheDir);
      const bin = sizeCache.get(paths.binDir);
      if (!python || !cache || !bin) return null;
      return { python: python.bytes, cache: cache.bytes, bin: bin.bytes };
    })(),
    pendingMigration: {
      python: pendingPython,
      cache: exists(legacy.cache) ? legacy.cache : '',
      bin: [legacy.bin, legacy.binAlt].filter(exists),
    },
  };
}

// ---------------------------------------------------------------- 迁移
function moveInto(source, target, label, notes) {
  if (!exists(source)) return;
  if (exists(target)) {
    notes.push(`${label}: 目标已存在，跳过（${target}）`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
    notes.push(`${label}: 已移动 → ${target}`);
  } catch {
    try {
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
      notes.push(`${label}: 已复制并删除源 → ${target}`);
    } catch (error) {
      notes.push(`${label}: 移动失败（${error.message}）`);
    }
  }
}

function migrate(root, config) {
  const paths = resolve(root, config);
  const legacy = legacyPaths(root);
  const notes = [];

  const pythonSource = exists(legacy.python) ? legacy.python : (exists(legacy.pythonAlt) ? legacy.pythonAlt : '');
  if (pythonSource) moveInto(pythonSource, paths.pythonDir, 'Python 环境', notes);

  moveInto(legacy.cache, paths.cacheDir, '模型缓存', notes);

  for (const binDir of [legacy.bin, legacy.binAlt]) {
    if (!exists(binDir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(binDir); } catch { continue; }
    for (const name of entries) {
      if (!/^(ffmpeg|ffprobe|cloudflared)(\.exe)?$/i.test(name)) continue;
      moveInto(path.join(binDir, name), path.join(paths.binDir, name), `工具 ${name}`, notes);
    }
  }

  sizeCache.clear();
  return { notes, status: status(root, config) };
}

// ---------------------------------------------------------------- 下载
async function downloadCloudflared(root, config) {
  const paths = resolve(root, config);
  const response = await fetch(CLOUDFLARED_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`cloudflared 下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 10 * 1024 * 1024) throw new Error(`cloudflared 文件不完整（${buffer.length} 字节）`);
  fs.mkdirSync(path.dirname(paths.cloudflared), { recursive: true });
  fs.writeFileSync(paths.cloudflared, buffer);
  sizeCache.delete(paths.binDir);
  return { path: paths.cloudflared, bytes: buffer.length };
}

/** 解压 zip 到临时目录并挑出 ffmpeg/ffprobe —— 用系统 tar（Windows 10+ 自带 bsdtar 支持 zip） */
function extractZip(zipFile, destDir) {
  return new Promise((resolvePromise, reject) => {
    execFile('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true }, (error) => {
      if (error) reject(new Error(`解压失败：${error.message}`));
      else resolvePromise();
    });
  });
}

function walkFind(dir, names, found = new Map()) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFind(full, names, found);
    else if (names.has(entry.name.toLowerCase())) found.set(entry.name.toLowerCase(), full);
  }
  return found;
}

async function downloadFfmpeg(root, config) {
  const paths = resolve(root, config);
  const tmpDir = path.join(root, '.tmp', `ffmpeg-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const zipFile = path.join(tmpDir, 'ffmpeg.zip');
  let bytes = 0;
  try {
    const response = await fetch(FFMPEG_ZIP_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`ffmpeg 下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.length;
    if (bytes < 20 * 1024 * 1024) throw new Error(`ffmpeg 包不完整（${bytes} 字节）`);
    fs.writeFileSync(zipFile, buffer);

    const unpacked = path.join(tmpDir, 'unpacked');
    fs.mkdirSync(unpacked, { recursive: true });
    await extractZip(zipFile, unpacked);

    const wanted = new Set(['ffmpeg.exe', 'ffprobe.exe']);
    const found = walkFind(unpacked, wanted);
    if (!found.has('ffmpeg.exe')) throw new Error('压缩包里没找到 ffmpeg.exe');

    fs.mkdirSync(paths.binDir, { recursive: true });
    const written = [];
    for (const [name, source] of found) {
      const target = path.join(paths.binDir, name);
      fs.copyFileSync(source, target);
      written.push(target);
    }
    sizeCache.delete(paths.binDir);
    return { paths: written, bytes };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 预热模型：跑一次 demucs 的模型加载，让权重落到 env\cache */
function warmModels(root, config, timeoutMs = 10 * 60 * 1000) {
  const paths = resolve(root, config);
  return new Promise((resolvePromise, reject) => {
    if (!exists(paths.python)) { reject(new Error('Python 环境未就绪')); return; }
    const script = 'import demucs.pretrained as p; p.get_model("htdemucs"); print("models ready")';
    execFile(paths.python, ['-c', script], {
      cwd: root,
      env: {
        ...process.env,
        TORCH_HOME: paths.torch,
        HF_HOME: paths.hf,
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      sizeCache.delete(paths.cacheDir);
      if (error) {
        reject(new Error(`${error.message}\n${String(stderr || '').slice(-400)}`));
        return;
      }
      resolvePromise({ output: String(stdout || '').trim().slice(-400) });
    });
  });
}

/** 生成一个「在新机器上重建 Python 环境」的批处理，避免控制面板被几 GB 的 pip 下载卡住 */
function setupScript(root, config) {
  const paths = resolve(root, config);
  const target = path.join(root, 'setup-env.cmd');
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    `cd /d "${root}"`,
    '',
    'where py >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [错误] 没有找到 Python 启动器 py，请先安装 Python 3.12。',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    `if not exist "${paths.pythonDir}" (`,
    `  echo [1/2] 创建虚拟环境 ${paths.pythonDir}`,
    `  py -3.12 -m venv "${paths.pythonDir}"`,
    ')',
    '',
    'echo [2/2] 安装依赖（体积较大，请耐心等待）',
    `"${paths.python}" -m pip install --upgrade pip`,
    `"${paths.python}" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/xpu`,
    `"${paths.python}" -m pip install demucs yt-dlp soundfile numpy requests`,
    '',
    'echo.',
    'echo 完成。回到控制面板点「刷新状态」即可。',
    'pause',
    '',
  ].join('\r\n');
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

module.exports = {
  resolve,
  legacyPaths,
  status,
  sizes,
  migrate,
  downloadCloudflared,
  downloadFfmpeg,
  warmModels,
  setupScript,
  CLOUDFLARED_URL,
  FFMPEG_ZIP_URL,
};
