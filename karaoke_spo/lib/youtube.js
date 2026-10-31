'use strict';
/**
 * YouTube Data API v3 客户端（模式 B 的**唯一**一处 YouTube 网络访问）。
 *
 * 以前 server.js 里直接内联了 `youtubeSearch()` / `youtubeVideoItem()`，
 * 官方 MV Resolver（lib/official-mv.js）也需要同样三件事：搜索、按 id 取视频详情、
 * 把 ISO 8601 时长转成秒。如果各处再写一份，配额统计、错误处理、缓存就会各写各的。
 * 所以这里统一抽出：
 *
 *   search({ q, maxResults, videoEmbeddable })  → [{videoId, title, channelTitle, channelId, description, ...}]
 *   videos([ids])                               → 同上 + durationSeconds / embeddable / privacyStatus / live
 *
 * 硬性约束：
 *   * **API Key 只从环境变量 / 运行时配置读**（`YOUTUBE_API_KEY`，控制面板注入），
 *     绝不写进代码或仓库；没有 Key 时抛 `YOUTUBE_NO_KEY`，调用方自行降级。
 *   * **配额**：YouTube Data API 每天只有 10,000 单位，`search.list` 一次 100 单位、
 *     `videos.list` 一次 1 单位。所以：
 *       - search 结果按 (q, maxResults, videoEmbeddable) 缓存 6 小时；
 *       - videos 结果按 videoId 缓存 24 小时；
 *       - 本进程内统计消耗量，超过 `YOUTUBE_DAILY_UNIT_BUDGET`（默认 4500，
 *         留一半给模式 A 的搜索框）后不再发新的 search，直接抛 `YOUTUBE_QUOTA_GUARD`。
 *     Resolver 把这种情况当作"暂时没有结果"（保持 pending），下一天/手动重试就会继续。
 *   * 失败一律抛带 `code` 的 Error，调用方决定降级方式；这里不吞错。
 */

const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const SEARCH_COST = 100;
const VIDEOS_COST = 1;

const SEARCH_TTL_MS = Number(process.env.YOUTUBE_SEARCH_TTL_MS || 6 * 60 * 60 * 1000);
const VIDEOS_TTL_MS = Number(process.env.YOUTUBE_VIDEOS_TTL_MS || 24 * 60 * 60 * 1000);
// 进程内的配额预算（不是 YouTube 的硬限，是我们自己的刹车）
const DAILY_UNIT_BUDGET = Number(process.env.YOUTUBE_DAILY_UNIT_BUDGET || 4500);

const searchCache = new Map();   // key → { at, items }
const videosCache = new Map();   // videoId → { at, item }
let budget = { day: dayKey(), used: 0 };
/**
 * 被 YouTube 429 后的冷却截止时间（毫秒时间戳）。
 * 默认 10 分钟：Google 对同一个 Key 的 search.list 限流是滚动窗口的，
 * 冷却期内不再发 search（后台 MV 匹配会跳过，不会把歌标成"没找到"），
 * 过期后自动恢复，不需要重启服务。
 * 可用 YOUTUBE_RATE_LIMIT_COOLDOWN_MS 调整。
 */
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.YOUTUBE_RATE_LIMIT_COOLDOWN_MS || 10 * 60 * 1000);
let cooldown = loadCooldown();

/**
 * 这个 429 是"每日搜索配额用完"吗？
 * Google 的报错是 `Quota exceeded for quota metric 'Search Queries' and limit
 * 'Search Queries per day'`（reason=rateLimitExceeded），和短时 429 不是一回事：
 * 前者要等第二天配额重置，后者几十秒/几分钟就恢复。
 */
function isDailySearchQuotaExhausted(error) {
  const text = String((error && (error.detail || error.message)) || '');
  return /per day/i.test(text) || /daily/i.test(text);
}

/** YouTube 配额按太平洋时间零点重置 → 返回下一个太平洋零点的毫秒时间戳 */
function nextPacificMidnight() {
  const nowMs = Date.now();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const hh = Number(parts.hour) % 24;
  const mm = Number(parts.minute);
  const ss = Number(parts.second);
  const elapsed = ((hh * 3600) + (mm * 60) + ss) * 1000;
  // 多加 5 分钟余量，避免刚好卡在重置瞬间
  return nowMs - elapsed + 24 * 3600 * 1000 + 5 * 60 * 1000;
}

/**
 * 冷却状态落盘到 `data/youtube-cooldown.json`：
 * 重启服务不该把"刚被限流"这件事忘掉（否则一重启就继续撞 429，限流反而更久）。
 */
function cooldownFile() {
  try {
    const path = require('node:path');
    const fs = require('node:fs');
    const root = path.resolve(__dirname, '..');
    const dir = process.env.KARAOKE_DATA_DIR ? path.resolve(process.env.KARAOKE_DATA_DIR) : path.join(root, 'data');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'youtube-cooldown.json');
  } catch {
    return null;
  }
}

function loadCooldown() {
  try {
    const file = cooldownFile();
    if (!file) return { until: 0, since: 0 };
    const fs = require('node:fs');
    if (!fs.existsSync(file)) return { until: 0, since: 0 };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const until = Number(data.until) || 0;
    return until > Date.now()
      ? { until, since: Number(data.since) || 0, exhausted: Boolean(data.exhausted) }
      : { until: 0, since: 0 };
  } catch {
    return { until: 0, since: 0 };
  }
}

function saveCooldown(next) {
  cooldown = next;
  try {
    const file = cooldownFile();
    if (!file) return;
    const fs = require('node:fs');
    if (!next || !next.until) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(next), 'utf8');
  } catch { /* 落盘失败不影响运行 */ }
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * API Key 的来源顺序（与模式 A 完全一致，见 lib/env.js 的 youtubeApiKey）：
 *   1. 启动器热更新 / 启动时注入的 `process.env.YOUTUBE_API_KEY`；
 *   2. 项目根 `config/config.json` 的 `youtubeApiKey`（直接启动工程时）。
 * 注意用 `require` 在函数里懒加载：env.js 会在加载时读配置并回填 env，
 * 这里每次调用都重新取，控制面板热更新后立即生效。
 */
function apiKey() {
  const explicit = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (explicit) return explicit;
  try {
    const { youtubeApiKey } = require('./env.js');
    return String(youtubeApiKey() || '').trim();
  } catch {
    return '';
  }
}

function hasKey() {
  return Boolean(apiKey());
}

function youtubeError(code, message, extra) {
  const error = new Error(message || code);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function resetBudgetForNewDay() {
  const today = dayKey();
  if (budget.day !== today) budget = { day: today, used: 0 };
}

/** 当前配额 / 限流状态（供曲库管理页与 Worker API 展示） */
function quota() {
  resetBudgetForNewDay();
  const cooling = cooldown.until > Date.now();
  return {
    day: budget.day,
    used: budget.used,
    budget: DAILY_UNIT_BUDGET,
    searches: searchCache.size,
    cachedVideos: videosCache.size,
    rateLimited: cooling,
    // exhausted = 今天的搜索配额用完了（要等到明天）；否则只是短时冷却
    exhausted: cooling && Boolean(cooldown.exhausted),
    cooldownUntil: cooling ? new Date(cooldown.until).toISOString() : null,
    cooldownRemainingSec: cooling ? Math.ceil((cooldown.until - Date.now()) / 1000) : 0,
  };
}

function spend(units) {
  resetBudgetForNewDay();
  budget.used += units;
}

/**
 * 手动清除限流冷却（管理员在前端点「强行重试」时调用）。
 *
 * 冷却是我们自己加的刹车：被 429 之后一段时间内不再发 search，免得把 Key 的限流
 * 越撞越久。但管理员明确要重试时就得放行——万一 Google 那边已经恢复了，
 * 我们不该用昨天的判断一直挡着。清掉之后下一次 search 会真的发出去，
 * 如果还是 429，冷却会重新按规则设上（见 search() 的 catch）。
 */
function clearCooldown() {
  const had = cooldown.until > Date.now();
  saveCooldown({ until: 0, since: 0 });
  cooldown = { until: 0, since: 0 };
  if (had) console.log('[youtube] 管理员强行重试：已清除限流冷却，官方 API 会再试一次');
  return { cleared: had };
}

/** 测试用：清空缓存与预算统计 */
function resetForTests() {
  searchCache.clear();
  videosCache.clear();
  budget = { day: dayKey(), used: 0 };
  saveCooldown({ until: 0, since: 0 });
  cooldown = { until: 0, since: 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带重试的 GET。
 *
 * YouTube 在短时间内连发多个 search（一次 MV 匹配就是 3 个查询）时经常回 **429**
 * （rate limit），以前直接抛错 → 这首歌的 MV 就变成"没匹配到"，
 * 视频模式只能一直用模糊封面（实测 STAY / Houdini 都栽在这）。
 * 现在 429 / 5xx / 网络错误按指数退避重试（1s、2s），最多 3 次。
 */
async function getJson(url) {
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      lastError = youtubeError('YOUTUBE_NETWORK', `YouTube 请求失败：${error.message}`);
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw lastError;
    }
    if (response.status !== 429 && response.status < 500) break;
    // 429 / 5xx：等一下再试
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    if (attempt < 2) {
      await sleep(retryAfter ? Math.min(retryAfter * 1000, 8000) : 1000 * (attempt + 1));
      continue;
    }
    break;
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    // 403 + quotaExceeded = Key 当天的配额用完了（不是我们的预算刹车）
    const reason = data?.error?.errors?.[0]?.reason || '';
    if (response.status === 403 && /quota/i.test(reason)) {
      throw youtubeError('YOUTUBE_QUOTA_EXCEEDED', `YouTube API 配额已用完（${reason}）`);
    }
    if (response.status === 400 && data?.error?.message) {
      throw youtubeError('YOUTUBE_BAD_REQUEST', `YouTube 请求无效：${data.error.message}`);
    }
    // 429 单独一个码：这是"暂时被限流"，不是"没有这个视频"，
    // 调用方（Resolver / 后台任务）应当稍后重试，而不是把歌标成 not_found。
    if (response.status === 429) {
      const googleMessage = String(data?.error?.message || '');
      // detail 保留 Google 原文：用来区分"每日配额用完"和"短时限流"
      throw youtubeError('YOUTUBE_RATE_LIMITED',
        googleMessage ? `YouTube 限流（429）：${googleMessage.slice(0, 200)}` : 'YouTube 限流（429），请稍后再试',
        { status: 429, detail: googleMessage });
    }
    throw youtubeError('YOUTUBE_HTTP_ERROR', `YouTube 返回 ${response.status}`, { status: response.status });
  }
  return data || {};
}

/** ISO 8601 时长（PT4M13S）→ 秒。解析不了返回 null。 */
function parseDurationSeconds(iso) {
  const match = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;
  const [, d, h, m, s] = match;
  if (!d && !h && !m && !s) return null;
  return Math.round(Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0));
}

function snippetToItem(item, extra = {}) {
  const snippet = item?.snippet || {};
  return {
    videoId: item?.id?.videoId || item?.id || extra.videoId || null,
    title: decodeEntities(snippet.title || ''),
    channelTitle: decodeEntities(snippet.channelTitle || ''),
    channelId: snippet.channelId || null,
    description: decodeEntities(snippet.description || '').slice(0, 600),
    publishedAt: snippet.publishedAt || null,
    thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
    ...extra,
  };
}

/**
 * YouTube 返回的标题里会有 `&amp;` `&#39;` 这类实体，直接拿去跟 Spotify 的歌名比对
 * 会算错相似度（"Rock &amp; Roll" vs "Rock & Roll"），所以这里解码一次。
 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (whole, body) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (named[body]) return named[body];
      const code = body[0] === '#' ? (body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)) : NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    });
}

/**
 * search.list。返回被**搜索层**过滤掉的候选（按 videoEmbeddable / type 由 API 完成）。
 *
 * @param {{q: string, maxResults?: number, videoEmbeddable?: boolean, order?: string, channelId?: string}} opts
 * @returns {Promise<Array>} 候选（不含时长与 embeddable 状态，需要的话再调 videos()）
 */
async function search(opts = {}) {
  const q = String(opts.q || '').trim();
  if (!q) return [];
  if (!hasKey()) throw youtubeError('YOUTUBE_NO_KEY', '没有配置 YouTube API Key');
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 10, 25));
  const videoEmbeddable = opts.videoEmbeddable !== false;
  const order = String(opts.order || 'relevance');
  const cacheKey = [q, maxResults, videoEmbeddable ? 'e' : 'any', order, opts.channelId || ''].join('|');

  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    return cached.items.map((item) => ({ ...item, cached: true }));
  }

  // 限流冷却期：被 YouTube 429 过就在一段时间内直接拒绝，
  // 避免"每点一首歌都去撞一次 429"（那会让 Key 的限流越来越久）。
  if (cooldown.until > Date.now()) {
    throw youtubeError('YOUTUBE_RATE_LIMITED',
      `YouTube 限流中，${Math.ceil((cooldown.until - Date.now()) / 1000)}s 后自动重试`);
  }

  resetBudgetForNewDay();
  if (budget.used + SEARCH_COST > DAILY_UNIT_BUDGET) {
    throw youtubeError('YOUTUBE_QUOTA_GUARD', `YouTube 配额预算已用 ${budget.used}/${DAILY_UNIT_BUDGET}，今天不再搜索`);
  }

  const url = new URL(`${API_ROOT}/search`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('q', q);
  url.searchParams.set('order', order);
  if (videoEmbeddable) url.searchParams.set('videoEmbeddable', 'true');
  if (opts.channelId) url.searchParams.set('channelId', String(opts.channelId));
  url.searchParams.set('key', apiKey());

  spend(SEARCH_COST);
  let data;
  try {
    data = await getJson(url);
  } catch (error) {
    if (error && error.code === 'YOUTUBE_RATE_LIMITED') {
      const exhausted = isDailySearchQuotaExhausted(error);
      if (exhausted) {
        // **每日搜索配额用完了**（Search Queries per day）：今天再怎么试都不会成功。
        // 直接停到明天（按太平洋时间跨天），而不是每 10 分钟再撞一次。
        saveCooldown({ until: nextPacificMidnight(), since: Date.now(), exhausted: true });
        console.warn(`[youtube] 今日 YouTube 搜索配额已用完（Search Queries per day），MV 搜索暂停到明天；已匹配的不受影响`);
      } else {
        saveCooldown({ until: Date.now() + RATE_LIMIT_COOLDOWN_MS, since: Date.now() });
        console.warn(`[youtube] search.list 被限流（429），${Math.round(RATE_LIMIT_COOLDOWN_MS / 60000)} 分钟内暂停搜索，之后自动恢复`);
      }
    }
    throw error;
  }
  const items = (data.items || [])
    .filter((item) => item?.id?.videoId)
    .map((item) => snippetToItem(item));
  searchCache.set(cacheKey, { at: Date.now(), items });
  return items.map((item) => ({ ...item, cached: false }));
}

/**
 * videos.list："snippet,contentDetails,status"，一次最多 50 个 id（只花 1 个单位）。
 *
 * @returns {Promise<Map<string, object>>} videoId → { videoId, title, channelTitle, channelId,
 *   description, durationSeconds, embeddable, privacyStatus, liveBroadcastContent, regionRestriction, thumbnailUrl }
 *   不存在的 id 不会出现在返回的 Map 里。
 */
async function videos(ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))];
  const out = new Map();
  const missing = [];
  for (const id of wanted) {
    const hit = videosCache.get(id);
    if (hit && Date.now() - hit.at < VIDEOS_TTL_MS) out.set(id, { ...hit.item, cached: true });
    else missing.push(id);
  }
  if (!missing.length) return out;
  if (!hasKey()) throw youtubeError('YOUTUBE_NO_KEY', '没有配置 YouTube API Key');

  resetBudgetForNewDay();
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    const url = new URL(`${API_ROOT}/videos`);
    url.searchParams.set('part', 'snippet,contentDetails,status');
    url.searchParams.set('id', chunk.join(','));
    url.searchParams.set('key', apiKey());
    spend(VIDEOS_COST);
    const data = await getJson(url);
    for (const item of data.items || []) {
      const snippet = item?.snippet || {};
      const status = item?.status || {};
      const restriction = (item?.contentDetails?.regionRestriction || {});
      const normalized = {
        videoId: item.id,
        title: decodeEntities(snippet.title || ''),
        channelTitle: decodeEntities(snippet.channelTitle || ''),
        channelId: snippet.channelId || null,
        description: decodeEntities(snippet.description || '').slice(0, 600),
        publishedAt: snippet.publishedAt || null,
        thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
        durationSeconds: parseDurationSeconds(item?.contentDetails?.duration),
        // status.embeddable 是权威值：false = 不允许嵌入（IFrame 里只会显示 Song Unavailable）
        embeddable: status.embeddable !== false,
        privacyStatus: status.privacyStatus || null,
        uploadStatus: status.uploadStatus || null,
        liveBroadcastContent: snippet.liveBroadcastContent || 'none',
        // 有 blocked 列表 = 在部分国家/地区不可播；YouTube 不允许直接在 embed 里报错，
        // 所以这里只记录，由评分/播放端决定是否回退。
        regionBlocked: Array.isArray(restriction.blocked) ? restriction.blocked.length : 0,
        regionAllowed: Array.isArray(restriction.allowed) ? restriction.allowed.length : null,
      };
      videosCache.set(item.id, { at: Date.now(), item: normalized });
      out.set(item.id, normalized);
    }
  }
  return out;
}

module.exports = {
  search,
  videos,
  quota,
  hasKey,
  clearCooldown,
  parseDurationSeconds,
  decodeEntities,
  resetForTests,
  API_ROOT,
  SEARCH_COST,
  VIDEOS_COST,
};
