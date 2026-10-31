'use strict';
/**
 * YouTube Music（ytmusicapi）官方 MV 搜索 —— **不消耗 YouTube Data API 配额**的候选源。
 *
 * 为什么单独抽一个模块
 * --------------------
 * 官方 Data API 的 `search.list` 一次 100 单位，每天 10,000 单位，批量匹配曲库
 * 很快就打光；配额一光，整晚都只能用模糊专辑封面。ytmusicapi 走 YouTube Music
 * 的内部接口（和网页版一样），没有每日配额，而且结果里带 `videoType`
 * （OMV = 官方 MV / ATV = 自动生成音频 / UGC = 用户上传），这是官方 API 没有的信号。
 *
 * 所以匹配顺序变成：**ytmusicapi 优先 → 官方 Data API 兜底**（见 lib/official-mv.js）。
 *
 * 实现要点
 * --------
 *   * 搜索在**子进程**里跑：Python 的 ytmusicapi 无法在 Node 里直接调用，
 *     而且一次搜索 1~3 秒，放进主进程会卡住点歌/播放的 HTTP 响应。
 *   * 结果按 (query, limit) 缓存 6 小时 —— 和官方 API 的缓存策略一致，
 *     重复匹配同一首歌不再起 Python 进程。
 *   * 失败有**冷却**：Python 没装 ytmusicapi / 网络不通时，不能每首歌都 spawn
 *     一次进程（一首 1 次 × 28 首 = 28 次注定失败的子进程）。失败后歇 10 分钟，
 *     期间 `enabled()` 直接返回 false，官方 API 无缝接管。
 *   * 全程**不抛致命错误**给调用方：拿不到结果就是空结果，由 official-mv.js 兜底。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ENV_DIR } = require('./env.js');
const { childEnv } = require('./child-env');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ytmusic_mv.py');

// KARAOKE_YTMUSIC=0 可以彻底关掉这个源（退回纯官方 API 行为）
const CONFIGURED = !/^(0|off|false|no)$/i.test(String(process.env.KARAOKE_YTMUSIC || '1').trim());

const CACHE_TTL_MS = Number(process.env.KARAOKE_YTMUSIC_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const FAILURE_COOLDOWN_MS = Number(process.env.KARAOKE_YTMUSIC_COOLDOWN_MS || 10 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.KARAOKE_YTMUSIC_TIMEOUT_MS || 45000);
const DEFAULT_LIMIT = 8;

/** Python 解释器：与 lib/prepare-queue.js 同一套候选顺序（KARAOKE_PYTHON → 项目根 env\python） */
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

const cache = new Map();      // "query|limit" → { at, items }
let failure = { until: 0, error: '' };
let lastError = '';

function cacheKey(query, limit) {
  return `${String(query).trim()}|${limit}`;
}

function pythonExe() {
  return resolvePython();
}

function scriptExists() {
  try { return fs.existsSync(SCRIPT); } catch { return false; }
}

/** 冷却期里不算可用（失败后歇一会儿，别每首歌都起一次注定失败的子进程） */
function enabled() {
  if (!CONFIGURED) return false;
  if (failure.until > Date.now()) return false;
  const exe = pythonExe();
  return Boolean(exe && scriptExists());
}

/** 给 API / 曲库页展示：为什么可用/不可用 */
function status() {
  const exe = pythonExe();
  const cooling = failure.until > Date.now();
  return {
    configured: CONFIGURED,
    pythonExe: exe || null,
    pythonExists: Boolean(exe),
    scriptExists: scriptExists(),
    available: enabled(),
    cooling,
    cooldownRemainingSec: cooling ? Math.ceil((failure.until - Date.now()) / 1000) : 0,
    lastError: lastError || null,
    cachedQueries: cache.size,
  };
}

function markFailure(message) {
  lastError = String(message || '').slice(0, 300);
  failure = { until: Date.now() + FAILURE_COOLDOWN_MS, error: lastError };
  console.warn(`[ytmusic] 禁用 ${Math.round(FAILURE_COOLDOWN_MS / 60000)} 分钟，改用官方 API 兜底：${lastError}`);
}

function markOk() {
  failure = { until: 0, error: '' };
}

/** 单条查询的缓存读取（导出给测试用） */
function cached(query, limit = DEFAULT_LIMIT) {
  const hit = cache.get(cacheKey(query, limit));
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_TTL_MS) { cache.delete(cacheKey(query, limit)); return null; }
  return hit.items;
}

/**
 * 跑一次 Python 子进程。
 * @returns {Promise<{ok: boolean, results?: object, errors?: object, code?: string, error?: string}>}
 */
function runScript(queries, limit) {
  const exe = pythonExe();
  if (!exe) return Promise.resolve({ ok: false, code: 'NO_PYTHON', error: '找不到 Python 解释器' });
  if (!scriptExists()) return Promise.resolve({ ok: false, code: 'NO_SCRIPT', error: `脚本不存在：${SCRIPT}` });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, [SCRIPT], {
        cwd: ROOT,
        windowsHide: true,
        env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      });
    } catch (error) {
      resolve({ ok: false, code: 'SPAWN_FAILED', error: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', error: `YouTube Music 搜索超时（${REQUEST_TIMEOUT_MS}ms）` });
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, code: 'SPAWN_FAILED', error: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 只取最后一行：ytmusicapi / requests 可能往 stdout 打警告
      const line = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
      let data = null;
      try { data = JSON.parse(line); } catch { data = null; }
      if (!data) {
        finish({ ok: false, code: 'BAD_OUTPUT', error: (stderr || stdout || `子进程退出码 ${code}`).slice(0, 300) });
        return;
      }
      finish(data);
    });
    try { child.stdin.end(JSON.stringify({ queries, limit })); } catch { /* ignore */ }
  });
}

/**
 * 搜索多个查询词。
 *
 * @param {string[]} queries
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{items: Map<string, object[]>, errors: object, source: string}>}
 *   拿不到任何结果时 items 为空 Map（**不抛错**），由调用方决定是否走官方 API 兜底。
 */
async function searchVideos(queries, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_LIMIT, 25));
  const wanted = [...new Set((queries || []).map((q) => String(q || '').trim()).filter(Boolean))].slice(0, 8);
  const out = new Map();
  const errors = {};
  // 走 module.exports 而不是直接调 enabled()：单测（以及将来可能的热开关）会替换掉
  // enabled，内部调用必须跟着走同一个入口，否则会出现"外面说不可用、里面照跑"的分裂。
  if (!wanted.length || !module.exports.enabled()) return { items: out, errors, source: 'ytmusic' };

  const missing = [];
  for (const query of wanted) {
    const hit = cached(query, limit);
    if (hit) out.set(query, hit.map((item) => ({ ...item })));
    else missing.push(query);
  }
  if (!missing.length) return { items: out, errors, source: 'ytmusic' };

  const payload = await runScript(missing, limit);
  if (!payload || payload.ok === false) {
    markFailure((payload && payload.error) || 'ytmusicapi 搜索失败');
    return { items: out, errors, source: 'ytmusic' };
  }
  markOk();
  const results = payload.results || {};
  for (const query of missing) {
    const rows = Array.isArray(results[query]) ? results[query] : [];
    const items = rows
      .filter((row) => row && /^[A-Za-z0-9_-]{11}$/.test(String(row.videoId || '')))
      // ytmusicapi 的 limit 对 videos 过滤不严格（一次经常返回 20 条），这里自己截一刀：
      // 既不让评分遍历一大堆翻唱/歌词号，也留够余量（真正的 MV 有时排在第 6~10 位）。
      .slice(0, Math.max(limit, 12))
      .map((row) => ({
        videoId: String(row.videoId),
        title: String(row.title || ''),
        artists: Array.isArray(row.artists) ? row.artists.map(String) : [],
        durationSeconds: Number.isFinite(Number(row.durationSeconds)) ? Number(row.durationSeconds) : null,
        videoType: String(row.videoType || ''),
        thumbnailUrl: String(row.thumbnailUrl || ''),
      }));
    cache.set(cacheKey(query, limit), { at: Date.now(), items });
    out.set(query, items.map((item) => ({ ...item })));
    if (payload.errors && payload.errors[query]) errors[query] = String(payload.errors[query]).slice(0, 200);
  }
  return { items: out, errors, source: 'ytmusic' };
}

/** 测试用：清空缓存与失败状态 */
function resetForTests() {
  cache.clear();
  failure = { until: 0, error: '' };
  lastError = '';
}

module.exports = {
  searchVideos,
  enabled,
  status,
  cached,
  resetForTests,
  DEFAULT_LIMIT,
  SCRIPT,
};
