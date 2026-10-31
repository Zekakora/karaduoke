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
// uv：单文件 exe，能自己下载 Python 并建 venv，不需要用户预装任何 Python。
const UV_WINDOWS_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
const PYTHON_VERSION = '3.12';

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

const ENV_KEYS = ['dir', 'python', 'cache', 'bin'];
const ENV_DIR_NAME = 'env';

/**
 * 把单个环境目录值规范化成「相对项目根」的形式。
 *
 * 为什么必须这么做：环境目录输入框的设计就是相对路径（见 UI 的提示文案），
 * 但早期版本会把解析后的绝对路径原样存进 config.json。一旦存了绝对路径，
 * 整个项目复制到别处（比如复制到桌面）后，环境面板还会指着旧位置，
 * 新副本因此误报「环境已就绪」。存成相对路径才能跟着项目根走。
 *
 * @returns {{value: string, changed: boolean, rebased: boolean}}
 *   rebased = 这条是从别的副本继承来的，已经重新挂到当前项目根下
 */
function normalizeEnvValue(root, value) {
  const raw = String(value || '').trim();
  if (!raw) return { value: '', changed: false, rebased: false };

  // 相对路径：只统一分隔符，天然跟随项目根
  if (!path.isAbsolute(raw)) {
    const clean = raw.split(/[\\/]+/).filter(Boolean).join('/');
    return { value: clean, changed: clean !== raw, rebased: false };
  }

  const abs = path.resolve(root, raw);
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return { value: rel.split(path.sep).join('/'), changed: true, rebased: false };
  }

  // 逃出项目根：形如「<别的副本>\env\python」说明是从旧位置继承来的，
  // 取 env 及其之后的部分，让它重新挂到当前项目根下。
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  const index = parts.map((part) => part.toLowerCase()).lastIndexOf(ENV_DIR_NAME);
  if (index >= 0) return { value: parts.slice(index).join('/'), changed: true, rebased: true };

  // 确实指向项目根外的另一处（比如共享的模型缓存盘）→ 尊重手动指定
  return { value: abs, changed: false, rebased: false };
}

/** 规范化 env 的四个字段。@returns {{env: object, changed: boolean, rebased: boolean}} */
function normalizeEnv(root, env) {
  const input = (env && typeof env === 'object') ? env : {};
  const out = {};
  let changed = false;
  let rebased = false;
  for (const key of ENV_KEYS) {
    const result = normalizeEnvValue(root, input[key]);
    out[key] = result.value;
    if (result.changed) changed = true;
    if (result.rebased) rebased = true;
  }
  return { env: out, changed, rebased };
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

// ---------------------------------------------------------------- 选择文件夹
const PICK_TIMEOUT_MS = 5 * 60 * 1000;

/** PowerShell 单引号字符串的转义：单引号写成两个。 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 弹出系统「选择文件夹」对话框，返回选中的绝对路径（取消则返回 null）。
 *
 * 浏览器出于安全不会把本地路径交给网页，所以借 PowerShell 的 FolderBrowserDialog。
 * 脚本走 -EncodedCommand（UTF-16LE + base64）传进去，路径里的空格和引号都不用转义。
 * -STA 是必需的：FolderBrowserDialog 在非单线程单元下会抛异常。
 */
function pickDirectory(startDir, description) {
  return new Promise((resolvePromise) => {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = ${psQuote(description || 'Select the environment folder')}`,
      '$d.ShowNewFolderButton = $true',
      startDir ? `$d.SelectedPath = ${psQuote(startDir)}` : '',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
    ].filter(Boolean).join('\n');

    // 用 -Command 而不是 -EncodedCommand：后者会把代码藏进 base64，
    // 容易被安全策略当成可疑行为拦掉，排查时也看不到到底跑了什么。
    // 参数直接交给 execFile（不经 shell），内部字符串由 psQuote 转义单引号。
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      windowsHide: true,
      timeout: PICK_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      // 超时被 kill、用户取消、PowerShell 不在 PATH 上：都当作没选
      if (error && !String(stdout || '').trim()) { resolvePromise(null); return; }
      const picked = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      resolvePromise(picked || null);
    });
  });
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

/**
 * 便携版 Node.js 所在目录（发行版自带 runtime\node\）。
 *
 * 存在的意义：把发行版拷到一台「没装 Node.js」的电脑上时，服务子进程、
 * 以及 Python 脚本里通过 `node` 调起的辅助进程，都应该命中项目自带的这一份，
 * 而不是报 ENOENT 或误用别的版本。返回空字符串表示没有便携版（走系统 PATH）。
 */
function portableNodeDir(root) {
  const dir = path.join(root, 'runtime', 'node');
  const exe = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    return fs.existsSync(exe) ? dir : '';
  } catch {
    return '';
  }
}

/** 便携版 node.exe 的完整路径；没有则返回空字符串 */
function portableNodeExe(root) {
  const dir = portableNodeDir(root);
  if (!dir) return '';
  return path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
}

/**
 * 决定用哪个 node 可执行文件，顺序与 start.cmd / start.vbs 保持一致：
 *   1. 系统安装的 Node.js（PATH 里能找到的 node）
 *   2. 项目自带的便携版（runtime\node）
 *   3. 当前进程自己的 node（process.execPath）—— 最后兜底
 *
 * 第 1 条优先是用户明确要求的：装了 Node 的机器就用系统那份，
 * 避免同一台机器上出现两个 Node 版本、行为不一致。
 *
 * 注意：Windows 的 App Execution Alias（例如
 * %LOCALAPPDATA%\Microsoft\WindowsApps\node.exe）在没装 Node 时也会
 * 「存在」但一运行就失败。这里用 spawnSync --version 实际验证一次，
 * 验证不过就继续往后找，避免把服务起在某个人没法用的壳上。
 */
function isUsableNodeExe(exe) {
  try {
    if (!fs.existsSync(exe)) return false;
    const { spawnSync } = require('child_process');
    const probe = spawnSync(exe, ['--version'], { timeout: 5000, windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function resolveNodeBinary(root) {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';

  // 1. 系统 PATH —— 找到第一个真正能跑的
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exeName);
    if (isUsableNodeExe(candidate)) return candidate;
  }

  // 2. 便携版
  const portable = portableNodeExe(root);
  if (portable && isUsableNodeExe(portable)) return portable;

  // 3. 兜底：既然控制面板已经跑起来了，它自己的解释器一定可用
  return process.execPath;
}

/**
 * 生成「在新机器上从零装好 Python 环境」的批处理。
 *
 * 关键设计：**不要求新机器预装 Python**。
 * 老版本直接调 `py -3.12 -m venv`，但 `py`（Python Launcher）是随 Python 安装包
 * 装进系统 PATH 的，不会跟着项目走 —— 新电脑没装 Python 时脚本第一步就退出。
 *
 * 现在的流程（全部落在项目内，不碰系统 PATH / 注册表）：
 *   1. 下载 uv.exe 到 <env>\bin\uv.exe（约 15MB，单文件）
 *   2. uv python install 3.12 --install-dir <env>\python-runtime
 *      → Python 本体装进项目，不写注册表、不改 PATH
 *   3. uv venv <env>\python --python <上一步的 python.exe> --seed
 *   4. 用 venv 的 pip 装 torch(XPU) / demucs 等依赖
 *
 * 为什么 Python 本体单独放 python-runtime 而不在 env\python 里：
 * venv 只是一个指向 base 解释器的壳（没有自己的 python312.dll），
 * 若把 base 装在别处，整个 env 目录就没法随项目一起搬走。
 * 放进来之后，env 目录整体可复制。
 *
 * @returns {string} 生成的 setup-env.cmd 路径
 */
function setupScript(root, config) {
  const paths = resolve(root, config);
  const target = path.join(root, 'setup-env.cmd');
  const uvExe = path.join(paths.binDir, 'uv.exe');
  // Python 本体目录（uv 管理的解释器），与 venv 分开
  const runtimeDir = path.join(paths.dir, 'python-runtime');
  const uvCacheDir = path.join(paths.dir, 'cache', 'uv');

  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableDelayedExpansion',
    `cd /d "${root}"`,
    'echo ============================================================',
    'echo  Karaduoke - Python environment setup',
    'echo  Project: ' + root.replace(/[&|<>^]/g, ''),
    'echo  Target : ' + paths.dir.replace(/[&|<>^]/g, ''),
    'echo ============================================================',
    'echo.',
    '',
    'rem ---------- uv: 全局缓存/安装目录都指向项目内，避免污染用户目录 ----------',
    `set "UV_CACHE_DIR=${uvCacheDir}"`,
    `set "UV_PYTHON_INSTALL_DIR=${runtimeDir}"`,
    'set "UV_NO_MODIFY_PATH=1"',
    'set "UV_PYTHON_DOWNLOADS=automatic"',
    '',
    'rem ---------- 1/4 找到或下载 uv ----------',
    `if not exist "${paths.binDir}" mkdir "${paths.binDir}"`,
    `if exist "${uvExe}" goto :uv_ready`,
    '',
    'rem 先看系统 PATH 里有没有现成的 uv（有就直接用，省一次下载）',
    'where uv >nul 2>nul',
    'if not errorlevel 1 (',
    '  for /f "delims=" %%i in (\'where uv\') do @set "UV_FROM_PATH=%%i"',
    '  echo [1/4] Found uv on PATH: !UV_FROM_PATH!',
    '  copy /y "!UV_FROM_PATH!" "' + uvExe.replace(/[&|<>^]/g, '') + '" >nul 2>nul',
    `  if exist "${uvExe}" goto :uv_ready`,
    ')',
    '',
    'echo [1/4] Downloading uv (about 15 MB)...',
    'set "UV_TMP=%TEMP%\\karaduoke-uv-%RANDOM%"',
    'mkdir "!UV_TMP!" 2>nul',
    // 路径通过环境变量 UV_TMP 传给 PowerShell（setlocal 下 set 的变量会继承给子进程），
    // 避免在 cmd 与 PS 之间做多层引号转义。
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
      '"$ProgressPreference=\'SilentlyContinue\';' +
      ` try { Invoke-WebRequest -Uri \'${UV_WINDOWS_URL}\' -OutFile (Join-Path $env:UV_TMP \'uv.zip\') -UseBasicParsing; exit 0 }` +
      ' catch { Write-Host (\"download failed: \" + $_.Exception.Message); exit 1 }"' +
      ' || goto :fail_uv',
    'rem Windows 10+ 自带 tar 支持 zip',
    'tar -xf "!UV_TMP!\\uv.zip" -C "!UV_TMP!" 2>nul',
    'if not exist "!UV_TMP!\\uv.exe" goto :fail_uv',
    `copy /y "!UV_TMP!\\uv.exe" "${uvExe}" >nul`,
    'rmdir /s /q "!UV_TMP!" 2>nul',
    'echo   uv installed.',
    '',
    ':uv_ready',
    `if not exist "${uvExe}" goto :fail_uv`,
    `"${uvExe}" --version || goto :fail_uv`,
    'echo.',
    '',
    'rem ---------- 2/4 下载 Python 本体到项目内 ----------',
    `if exist "${runtimeDir}" (echo [2/4] Removing previous Python runtime...)`,
    `if exist "${runtimeDir}" rmdir /s /q "${runtimeDir}"`,
    `echo [2/4] Installing Python ${PYTHON_VERSION} into ${runtimeDir}`,
    `"${uvExe}" python install ${PYTHON_VERSION} --install-dir "${runtimeDir}" || goto :fail_python`,
    // uv 把解释器放在 <install-dir>\cpython-<ver>-windows-x86_64-none\ 下，找一下
    `set "BASE_PY="`,
    `for /d %%d in ("${runtimeDir}\\cpython-${PYTHON_VERSION}*") do (` +
      ` if exist "%%d\\python.exe" set "BASE_PY=%%d\\python.exe" )`,
    'if not defined BASE_PY goto :fail_python',
    'echo   Python ready: !BASE_PY!',
    'echo.',
    '',
    'rem ---------- 3/4 创建 venv ----------',
    `if exist "${paths.pythonDir}" (echo [3/4] Removing previous venv...)`,
    `if exist "${paths.pythonDir}" rmdir /s /q "${paths.pythonDir}"`,
    `echo [3/4] Creating venv at ${paths.pythonDir}`,
    `"${uvExe}" venv "${paths.pythonDir}" --python "!BASE_PY!" --seed || goto :fail_venv`,
    `if not exist "${paths.python}" goto :fail_venv`,
    'echo.',
    '',
    'rem ---------- 4/4 安装依赖 ----------',
    'echo [4/4] Installing dependencies (this can take 10-30 min, several GB)...',
    'echo       torch(XPU) / torchaudio / demucs / yt-dlp ...',
    `"${paths.python}" -m pip install --upgrade pip || goto :fail_pip`,
    `"${paths.python}" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/xpu || goto :fail_pip`,
    `"${paths.python}" -m pip install demucs yt-dlp soundfile numpy requests || goto :fail_pip`,
    'echo.',
    'echo ============================================================',
    'echo  Done. Python and all dependencies are ready.',
    'echo  Go back to the console and click "Refresh".',
    'echo ============================================================',
    'pause',
    'exit /b 0',
    '',
    ':fail_uv',
    'echo.',
    'echo [ERROR] Could not prepare uv.',
    'echo   Check your network, or download it manually and put it here:',
    `echo   ${uvExe}`,
    `echo   Download: ${UV_WINDOWS_URL}`,
    'pause',
    'exit /b 1',
    '',
    ':fail_python',
    'echo.',
    'echo [ERROR] Could not install the Python runtime.',
    'echo   Check your network connection and try again.',
    'pause',
    'exit /b 1',
    '',
    ':fail_venv',
    'echo.',
    'echo [ERROR] Could not create the virtual environment.',
    'pause',
    'exit /b 1',
    '',
    ':fail_pip',
    'echo.',
    'echo [ERROR] Failed to install Python dependencies.',
    'echo   Usually a network issue. Re-run this script - it will reuse',
    'echo   the existing Python runtime and only retry the packages.',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

module.exports = {
  resolve,
  legacyPaths,
  normalizeEnv,
  pickDirectory,
  status,
  sizes,
  migrate,
  downloadCloudflared,
  downloadFfmpeg,
  warmModels,
  setupScript,
  portableNodeDir,
  portableNodeExe,
  resolveNodeBinary,
  CLOUDFLARED_URL,
  FFMPEG_ZIP_URL,
};
