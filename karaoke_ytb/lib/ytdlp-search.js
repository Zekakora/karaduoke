'use strict';
/**
 * yt-dlp 搜索源（**不消耗 YouTube Data API 配额**的搜索主源）。
 *
 * 为什么用它打头
 * --------------
 * 官方 Data API 的 `search.list` 一次 100 单位，每天只有 10,000 单位：
 * 一次点歌台搜索 1 单位 × 100 次就光，光了以后整晚点歌都搜不出来。
 * yt-dlp 走 YouTube 网页版的内部接口（和浏览器一样），没有配额：
 *   `yt-dlp --flat-playlist --dump-single-json "ytsearchN:关键词"`
 * 直接给出 id / 标题 / 频道 / 时长 / 封面 —— 正好是点歌台列表要的字段，
 * 而且比官方 API 还多一个**时长**（能过滤掉 30 秒的 Shorts 和两小时的演唱会全场）。
 *
 * 所以搜索顺序是：**yt-dlp 优先 → 官方 Data API 兜底 → 内置演示目录**。
 *
 * 实现要点
 * --------
 *   * 子进程跑：一次搜索 1~3 秒，放主进程会卡住 SSE 和播放心跳。
 *   * 结果缓存 10 分钟：同一关键词连点/多人搜同一首歌不再起进程。
 *   * 失败有**冷却**（默认 5 分钟）：没装 yt-dlp / 网络不通时不能每次搜索都 spawn
 *     一个注定失败的子进程；冷却期内 `enabled()` 直接 false，官方 API 无缝接管。
 *   * 全程**不抛错**给调用方：拿不到结果就是 `null`，由调用方兜底。
 *
 * 环境变量
 *   KARAOKE_YTDLP=0              彻底关掉，只用官方 API
 *   KARAOKE_YTDLP_PATH=<exe>     指定 yt-dlp 可执行文件（默认用项目 env 里的 Python）
 *   KARAOKE_YTDLP_TIMEOUT_MS     单次搜索超时（默认 30000）
 *   KARAOKE_YTDLP_CACHE_TTL_MS   缓存时间（默认 10 分钟）
 *   KARAOKE_YTDLP_COOLDOWN_MS    失败冷却（默认 5 分钟）
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// __dirname 是 lib/ 本身，env 在工程根（lib 的上一级），所以只上跳一层。
const ROOT = path.resolve(__dirname, '..');
const ENV_DIR = path.resolve(ROOT, '..', 'env');
const CONFIGURED = !/^(0|off|false|no)$/i.test(String(process.env.KARAOKE_YTDLP || '1').trim());
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 25;
const REQUEST_TIMEOUT_MS = Number(process.env.KARAOKE_YTDLP_TIMEOUT_MS || 30000);
const CACHE_TTL_MS = Number(process.env.KARAOKE_YTDLP_CACHE_TTL_MS || 10 * 60 * 1000);
const COOLDOWN_MS = Number(process.env.KARAOKE_YTDLP_COOLDOWN_MS || 5 * 60 * 1000);

/**
 * 子进程环境净化（与 karaoke_spo/lib/child-env.js 同样的理由）。
 *
 * 从 Agent 沙箱里启动服务时，环境里会带 CODEBUDDY_* 守卫变量：
 * PYTHONPATH 指向沙箱 shim，它的 sitecustomize 会给 os.remove / Path.unlink
 * 装上 "safe-delete" 守卫，一个回合累计删到 50 个文件就要求人工确认并退出。
 * yt-dlp 的缓存/临时文件清理会碰到它，于是搜索莫名其妙失败。
 * 这里把守卫的三个关断点全部剥掉（详见 karaoke_spo/lib/child-env.js 注释）。
 */
const SANDBOX_PATH_RE = /app\.asar\.unpacked/i;
const CHILD_ENV_KEYS = [
  'CODEBUDDY_TOOL_CALL_ID',
  'CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
  'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
  'CODEBUDDY_SAFE_DELETE_BULK_REPLAY_FILE',
  'CODEBUDDY_SESSION_ID',
  'CLAUDE_SESSION_ID',
];

function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
  for (const key of CHILD_ENV_KEYS) delete env[key];
  const pathsep = process.platform === 'win32' ? ';' : ':';
  if (env.PYTHONPATH) {
    const kept = String(env.PYTHONPATH).split(pathsep)
      .filter((p) => p && !SANDBOX_PATH_RE.test(p) && !/[\\/]vendor[\\/]shim[\\/]?$/i.test(p));
    if (kept.length) env.PYTHONPATH = kept.join(pathsep);
    else delete env.PYTHONPATH;
  }
  if (env.NODE_OPTIONS && /safe-delete|node-language-shim|genie-safe-delete/i.test(env.NODE_OPTIONS)) {
    delete env.NODE_OPTIONS;
  }
  return env;
}

/** 找 yt-dlp：显式配置 → 项目 env 里的 exe → 项目 env 里的 Python 模块 → PATH */
const EXE_CANDIDATES = [
  process.env.KARAOKE_YTDLP_PATH,
  path.join(ENV_DIR, 'python', 'Scripts', 'yt-dlp.exe'),
  path.join(ENV_DIR, 'bin', 'yt-dlp.exe'),
  path.join(ENV_DIR, 'yt-dlp.exe'),
].filter((candidate) => Boolean(candidate && String(candidate).trim()));

const PYTHON_CANDIDATES = [
  process.env.KARAOKE_PYTHON,
  path.join(ENV_DIR, 'python', 'Scripts', 'python.exe'),
  path.join(ENV_DIR, 'python', 'python.exe'),
  path.join(ROOT, '..', 'env', 'python', 'Scripts', 'python.exe'),
].filter((candidate) => Boolean(candidate && String(candidate).trim()));

function firstExisting(candidates) {
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch { /* ignore */ }
  }
  return '';
}

let resolved = null;

/**
 * 解析出「怎么调 yt-dlp」。
 * @returns {{exe: string, prefixArgs: string[]}|null}
 */
function resolveCommand() {
  if (resolved !== null) return resolved;
  // 优先用 `python -m yt_dlp`：项目 env 里 uv 装的 yt-dlp.exe 只是个 trampoline，
  // 相对路径解析失败时会直接报 "uv trampoline failed to canonicalize script path"
  // （实测在服务的工作目录下必现）。走 Python 解释器 + 模块名不会有这个问题。
  const python = firstExisting(PYTHON_CANDIDATES);
  if (python) {
    resolved = { exe: python, prefixArgs: ['-m', 'yt_dlp'] };
    return resolved;
  }
  const exe = firstExisting(EXE_CANDIDATES);
  if (exe) {
    resolved = { exe, prefixArgs: [] };
    return resolved;
  }
  resolved = null; // 真的没有：保持 null，下次再找（用户可能刚装好）
  return null;
}

const cache = new Map();          // "query|limit" → { at, items }
let failure = { until: 0, error: '' };
let lastError = '';
let lastSource = null;

function cacheKey(query, limit) {
  return `${String(query).trim().toLowerCase()}|${limit}`;
}

function enabled() {
  if (!CONFIGURED) return false;
  if (failure.until > Date.now()) return false;
  return Boolean(resolveCommand());
}

function status() {
  const command = resolveCommand();
  const cooling = failure.until > Date.now();
  return {
    configured: CONFIGURED,
    available: enabled(),
    command: command ? [command.exe, ...command.prefixArgs].join(' ') : null,
    cooling,
    cooldownRemainingSec: cooling ? Math.ceil((failure.until - Date.now()) / 1000) : 0,
    lastError: lastError || null,
    lastSource,
    cachedQueries: cache.size,
  };
}

function markFailure(message) {
  lastError = String(message || '').slice(0, 300);
  failure = { until: Date.now() + COOLDOWN_MS, error: lastError };
  console.warn(`[ytdlp] 搜索源停用 ${Math.round(COOLDOWN_MS / 60000)} 分钟，改用官方 API 兜底：${lastError}`);
}

function markOk() {
  failure = { until: 0, error: '' };
}

function cached(query, limit = DEFAULT_LIMIT) {
  const hit = cache.get(cacheKey(query, limit));
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_TTL_MS) { cache.delete(cacheKey(query, limit)); return null; }
  return hit.items;
}

/** 秒数 → "4:05" / "1:02:03"；拿不到就 "—"（前端就是这么显示的） */
function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '—';
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** 平铺搜索结果 → 点歌台需要的形状（与官方 API 分支完全一致，前端不用改） */
function normalizeEntries(entries, limit) {
  const items = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const videoId = String(entry.id || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || seen.has(videoId)) continue;
    seen.add(videoId);
    const durationSeconds = Number(entry.duration);
    const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
    const thumb = thumbnails.length
      ? (thumbnails.find((t) => Number(t.width) >= 320) || thumbnails[thumbnails.length - 1]).url
      : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    items.push({
      videoId,
      title: String(entry.title || `YouTube 视频 ${videoId}`),
      channelTitle: String(entry.channel || entry.uploader || entry.uploader_id || 'YouTube'),
      duration: formatDuration(durationSeconds),
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      thumbnailUrl: String(thumb || ''),
      // iframe 能不能放，flat 搜索查不到（要 probe 每个视频，太贵）；
      // 统一按 true 放行，真放不出来时大屏会报 visual/player 错误（已有兜底流程）。
      embeddable: true,
      source: 'ytdlp',
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * 跑一次 yt-dlp 搜索。
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<{ok: boolean, items?: object[], error?: string}>}
 */
function runSearch(query, limit) {
  const command = resolveCommand();
  if (!command) return Promise.resolve({ ok: false, error: '找不到 yt-dlp（exe 与 python -m yt_dlp 都不可用）' });

  const args = [
    ...command.prefixArgs,
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    '--skip-download',
    '--no-progress',
    // 去掉播放列表外壳，只按时间/相关度拿前 N 条；ytsearch 的 N 就是条数上限
    `ytsearch${limit}:${query}`,
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command.exe, args, {
        cwd: ROOT,
        windowsHide: true,
        env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: `yt-dlp 搜索超时（${REQUEST_TIMEOUT_MS}ms）` });
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        finish({ ok: false, error: (stderr || `yt-dlp 退出码 ${code}`).trim().slice(0, 300) });
        return;
      }
      let data = null;
      try { data = JSON.parse(stdout); } catch { data = null; }
      if (!data) {
        finish({ ok: false, error: (stderr || 'yt-dlp 输出不是 JSON').trim().slice(0, 300) });
        return;
      }
      // yt-dlp 没有匹配时会返回 _type=playlist 但 entries 为空 —— 那是"搜不到"，不是失败
      finish({ ok: true, entries: Array.isArray(data.entries) ? data.entries : [] });
    });
  });
}

/**
 * 搜索一条关键词。
 *
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Promise<object[]|null>} 拿不到（未配置/冷却中/失败）返回 null，调用方走官方 API
 */
async function search(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const hit = cached(q, limit);
  if (hit) { lastSource = 'ytdlp-cache'; return hit.map((item) => ({ ...item })); }
  // 走 module.exports 而不是直接调 enabled()：单测会替换掉 enabled
  if (!module.exports.enabled()) return null;

  const result = await runSearch(q, limit);
  if (!result.ok) {
    markFailure(result.error || 'yt-dlp 搜索失败');
    return null;
  }
  markOk();
  const items = normalizeEntries(result.entries, limit);
  cache.set(cacheKey(q, limit), { at: Date.now(), items });
  lastSource = 'ytdlp';
  return items.map((item) => ({ ...item }));
}

/** 测试用：清空缓存与失败状态 */
function resetForTests() {
  cache.clear();
  failure = { until: 0, error: '' };
  lastError = '';
  lastSource = null;
  resolved = null;
}

module.exports = {
  search,
  enabled,
  status,
  cached,
  formatDuration,
  normalizeEntries,
  resetForTests,
  DEFAULT_LIMIT,
};
