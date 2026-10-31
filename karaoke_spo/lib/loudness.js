'use strict';
/**
 * 伴奏响度测量（LUFS / True Peak）—— 服务端入口。
 *
 * 测量本身在 Python 里做（scripts/measure_loudness.py 调 ffmpeg loudnorm），
 * 这里只负责：找到解释器 → 起子进程 → 解析最后一行 JSON。
 *
 * 设计上与 lib/ytmusic.js 一致：
 *   * **子进程**：一次 ffmpeg 分析要几秒钟，放主进程会卡住点歌/播放的 HTTP 响应；
 *   * **失败冷却**：ffmpeg/Python 不可用时不能每首歌都 spawn 一次注定失败的子进程；
 *   * **不抛致命错误**：拿不到结果就是 null，由调用方（补测任务）记成 failed。
 *
 * 注意：测量结果由 Python 直接写进 SQLite，这里只把数字带回来给调用方看。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ENV_DIR } = require('./env.js');
const { childEnv } = require('./child-env');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'measure_loudness.py');

const FAILURE_COOLDOWN_MS = Number(process.env.KARAOKE_LOUDNESS_COOLDOWN_MS || 10 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.KARAOKE_LOUDNESS_TIMEOUT_MS || 600000);

/** Python 解释器：与 lib/prepare-queue.js / lib/ytmusic.js 同一套候选顺序 */
const PYTHON_CANDIDATES = [
  process.env.KARAOKE_PYTHON,
  path.join(ENV_DIR, 'python', 'Scripts', 'python.exe'),
  path.join(ENV_DIR, 'python', 'python.exe'),
  path.join(ROOT, '..', 'env', 'python', 'Scripts', 'python.exe'),
  path.join(ROOT, '..', 'env', 'python', 'python.exe'),
].filter((candidate) => Boolean(candidate && String(candidate).trim()));

function resolvePython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
    try { if (fs.existsSync(abs)) return abs; } catch { /* ignore */ }
  }
  return '';
}

let failure = { until: 0, error: '' };
let lastError = '';

function pythonExe() { return resolvePython(); }
function scriptExists() { try { return fs.existsSync(SCRIPT); } catch { return false; } }

/** 冷却期里不算可用（失败后歇一会儿） */
function enabled() {
  if (failure.until > Date.now()) return false;
  return Boolean(pythonExe() && scriptExists());
}

/** 给曲库页 / 设置页展示 */
function status() {
  const exe = pythonExe();
  const cooling = failure.until > Date.now();
  return {
    available: enabled(),
    pythonExe: exe || null,
    pythonExists: Boolean(exe),
    scriptExists: scriptExists(),
    cooling,
    cooldownRemainingSec: cooling ? Math.ceil((failure.until - Date.now()) / 1000) : 0,
    lastError: lastError || null,
  };
}

function markFailure(message) {
  lastError = String(message || '').slice(0, 300);
  failure = { until: Date.now() + FAILURE_COOLDOWN_MS, error: lastError };
  console.warn(`[loudness] 测量不可用，${Math.round(FAILURE_COOLDOWN_MS / 60000)} 分钟内不再尝试：${lastError}`);
}

function markOk() {
  failure = { until: 0, error: '' };
}

/**
 * 测一首歌的伴奏响度。
 *
 * @param {string} spotifyId
 * @param {{force?: boolean}} [opts] force=true 时忽略已有测量值，重新测
 * @returns {Promise<{ok: boolean, lufs?: number, truePeakDbfs?: number|null, lra?: number|null,
 *   written?: boolean, code?: string, error?: string}>}
 *   失败**不抛错**（返回 {ok:false,...}），调用方决定怎么记。
 */
function measure(spotifyId, opts = {}) {
  const id = String(spotifyId || '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(id)) {
    return Promise.resolve({ ok: false, code: 'BAD_SPOTIFY_ID', error: 'spotifyId 不合法' });
  }
  // 走 module.exports 而不是直接调 enabled()：单测可能替换它，内部调用必须跟着走同一个入口
  if (!module.exports.enabled()) {
    return Promise.resolve({ ok: false, code: 'DISABLED', error: lastError || '响度测量不可用（Python / 脚本缺失）' });
  }
  const exe = pythonExe();
  const args = [SCRIPT, '--spotify-id', id];
  if (opts.force) args.push('--force');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, {
        cwd: ROOT,
        windowsHide: true,
        env: childEnv({
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          // 脚本要靠这两个找到 ffmpeg；手工跑时它会自己回退到项目根 env\
          KARAOKE_ENV_DIR: process.env.KARAOKE_ENV_DIR || ENV_DIR,
          KARAOKE_FFMPEG: process.env.KARAOKE_FFMPEG || path.join(ENV_DIR, 'bin', 'ffmpeg.exe'),
        }),
      });
    } catch (error) {
      markFailure(error.message);
      resolve({ ok: false, code: 'SPAWN_FAILED', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', error: `响度测量超时（${REQUEST_TIMEOUT_MS}ms）` });
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      markFailure(error.message);
      finish({ ok: false, code: 'SPAWN_FAILED', error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
      let data = null;
      try { data = JSON.parse(line); } catch { data = null; }
      if (!data) {
        markFailure((stderr || stdout || `退出码 ${code}`).slice(0, 300));
        finish({ ok: false, code: 'BAD_OUTPUT', error: (stderr || stdout).slice(0, 200) || `退出码 ${code}` });
        return;
      }
      if (data.ok === false) {
        // NO_ACCOMPANIMENT / FILE_MISSING 是"这首歌没法测"，不是"测量器坏了" ——
        // 不该因此把整个测量器关掉 10 分钟（其它歌还等着测）。
        const fatal = !['NO_ACCOMPANIMENT', 'FILE_MISSING'].includes(data.code);
        if (fatal) markFailure(data.error || data.code);
        finish({ ok: false, code: data.code || 'MEASURE_FAILED', error: data.error || null, spotifyId: id });
        return;
      }
      markOk();
      finish({
        ok: true,
        spotifyId: id,
        lufs: data.lufs,
        truePeakDbfs: data.truePeakDbfs ?? null,
        lra: data.lra ?? null,
        written: Boolean(data.written),
      });
    });
  });
}

function resetForTests() {
  failure = { until: 0, error: '' };
  lastError = '';
}

module.exports = { measure, enabled, status, resetForTests, SCRIPT };
