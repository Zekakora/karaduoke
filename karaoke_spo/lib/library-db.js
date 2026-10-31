'use strict';
/**
 * 本地曲库只读访问（模式 B）。
 *
 * 用 Node 内置 node:sqlite（Node 22+），不引入依赖。
 * **只读打开** —— 写入全部由 Python 侧（python/library.py）负责，
 * 双方通过 WAL 模式可以并发读写（Python 写、Node 读）。
 *
 * 曲库位置可配置：环境变量 LIBRARY_DB，默认 <项目根>/data/library.db
 */

const fs = require('fs');
const path = require('path');

// 本文件在 <项目根>/lib/ 下，所以项目根是上一级（不是两级）
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'library.db');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let db = null;
let dbPath = null;
let dbMtime = 0;

function resolvePath() {
  return process.env.LIBRARY_DB ? path.resolve(process.env.LIBRARY_DB) : DEFAULT_DB;
}

/**
 * 写操作单独开一个连接 —— 播放用的连接是 readOnly 的，不能删行。
 * Python 侧用 WAL 写入，这里也开 WAL + busy_timeout，避免刚好撞上流水线写入。
 */
function openWritable() {
  if (!DatabaseSync) return null;
  const target = resolvePath();
  if (!fs.existsSync(target)) return null;
  try {
    const conn = new DatabaseSync(target);
    conn.exec('PRAGMA busy_timeout = 5000');
    conn.exec('PRAGMA foreign_keys = ON');
    return conn;
  } catch {
    return null;
  }
}

/**
 * 从曲库删除一首歌的数据库记录（tracks / stems / lyrics / jobs）。
 * 媒体文件由 server.js 负责删除；这里只返回数据库里记录的文件路径，
 * 供调用方判断是否在项目资产目录内再删。
 *
 * @returns {{ok:boolean, reason?:string, trackId?:number, audioPath?:string|null, albumArtPath?:string|null}}
 */
function deleteTrack(spotifyId) {
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return { ok: false, reason: 'bad-id' };
  const conn = openWritable();
  if (!conn) return { ok: false, reason: 'no-db' };
  try {
    const row = conn.prepare('SELECT id, audio_path, album_art_path FROM tracks WHERE spotify_id = ?').get(id);
    if (!row) return { ok: false, reason: 'not-found' };
    conn.exec('BEGIN IMMEDIATE');
    try {
      // 显式删子表，兼容没有开启 foreign_keys 的旧库
      conn.prepare('DELETE FROM jobs WHERE track_id = ?').run(row.id);
      conn.prepare('DELETE FROM lyrics WHERE track_id = ?').run(row.id);
      conn.prepare('DELETE FROM stems WHERE track_id = ?').run(row.id);
      conn.prepare('DELETE FROM tracks WHERE id = ?').run(row.id);
      conn.exec('COMMIT');
    } catch (error) {
      try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
      return { ok: false, reason: 'db-error', error: error.message };
    }
    // 原始 WAV / 封面可能被别的曲目复用（同一个 YouTube 源、同一张专辑），
    // 还有引用就留给调用方跳过删除。
    const stillUsed = (column, value) => {
      if (!value) return false;
      try { return conn.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${column} = ?`).get(value).n > 0; }
      catch { return true; }
    };
    return {
      ok: true,
      trackId: row.id,
      audioPath: stillUsed('audio_path', row.audio_path) ? null : (row.audio_path || null),
      albumArtPath: stillUsed('album_art_path', row.album_art_path) ? null : (row.album_art_path || null),
    };
  } catch (error) {
    return { ok: false, reason: 'db-error', error: error.message };
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

/** 打开（或复用）只读连接。数据库被 Python 重建时自动重开。 */
function open() {
  if (!DatabaseSync) return null;
  const target = resolvePath();
  if (!fs.existsSync(target)) return null;

  const mtime = fs.statSync(target).mtimeMs;
  if (db && dbPath === target && mtime === dbMtime) return db;

  try {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    db = new DatabaseSync(target, { readOnly: true });
    dbPath = target;
    dbMtime = mtime;
    return db;
  } catch {
    db = null;
    return null;
  }
}

/**
 * 关闭只读连接（测试清理用；服务运行期间一般不需要）。
 * Windows 上只要还有打开的 SQLite 句柄，临时目录就删不掉。
 */
function close() {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
  dbPath = null;
  dbMtime = 0;
}

function parseArtists(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [String(v)];
  } catch {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function pickCover(track) {
  // album_art_path 是本地绝对路径，转成 /media/covers/<id>.jpg
  if (track.album_art_path) {
    const base = path.basename(track.album_art_path);
    return `/media/covers/${base}`;
  }
  return track.album_art || null;
}

/** 曲库是否已经迁出伴奏响度的列（老库可能在服务运行期间被 Python 侧补上） */
function hasLoudnessColumns(conn = open()) {
  if (!conn) return false;
  try {
    const cols = conn.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    return cols.includes('acc_lufs');
  } catch {
    return false;
  }
}

/** 响度列 → 前端形状。没测过时返回 null（前端据此显示"—"并跳过自动均衡）。 */
function loudnessFromRow(row) {
  const lufs = row.acc_lufs;
  if (lufs === null || lufs === undefined || !Number.isFinite(Number(lufs))) return null;
  const peak = row.acc_true_peak_dbfs;
  const lra = row.acc_lra;
  return {
    lufs: Number(lufs),
    truePeakDbfs: Number.isFinite(Number(peak)) ? Number(peak) : null,
    lra: Number.isFinite(Number(lra)) ? Number(lra) : null,
    measuredAt: row.acc_loudness_measured_at || null,
    version: Number.isFinite(Number(row.acc_loudness_version)) ? Number(row.acc_loudness_version) : null,
    source: row.acc_loudness_source || null,
  };
}

function toPublic(row) {
  return {
    spotifyId: row.spotify_id,
    // 同一首歌的合并键：等于自己 = 主记录；否则指向主记录
    canonicalId: row.canonical_id || row.spotify_id,
    title: row.title,
    artists: parseArtists(row.artists),
    album: row.album || null,
    durationMs: row.duration_ms || null,
    cover: pickCover(row),
    releaseDate: row.release_date || null,
    popularity: row.popularity,
    matchScore: row.match_score,
    status: row.status,
    hasVocals: Boolean(row.has_vocals),
    hasAccompaniment: Boolean(row.has_accompaniment),
    ready: Boolean(row.has_vocals && row.has_accompaniment),
    // 音频处理用的 YouTube 源（fetch_audio 下载 MP4 → 提取音频 → Demucs），与画面无关
    sourceVideoId: row.source_video_id || null,
    // 官方 MV（视频模式的背景画面，YouTube IFrame 静音播放，不下载）。
    // 老库没有这一列时调用方会拿到 undefined → 走 pending 兜底。
    visualVideoId: row.visual_video_id || null,
    visualMatchStatus: row.visual_match_status || 'pending',
    // 伴奏响度（ffmpeg 测得，只测不改音频）。老库/没测过 → null，前端跳过自动均衡。
    loudness: loudnessFromRow(row),
  };
}

/** 曲库是否已经迁移出官方 MV 的列（老库可能在服务运行期间被 Python 侧补上） */
function hasVisualColumns(conn = open()) {
  if (!conn) return false;
  try {
    const cols = conn.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    return cols.includes('visual_video_id');
  } catch {
    return false;
  }
}

/**
 * 列出曲库中可播放的曲目（已分离出人声+伴奏的）。
 * @param {{q?: string, limit?: number, includeUnready?: boolean}} opts
 */
function listTracks(opts = {}) {
  const conn = open();
  if (!conn) return { available: false, tracks: [], reason: DatabaseSync ? 'no-db' : 'sqlite-unavailable' };

  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), 500);
  const q = String(opts.q || '').trim();

  // stems 表按 (track_id, model) 唯一；取最新一条判断是否有人声/伴奏。
  // visual_* 是新列：老库还没迁移时用空值代替，避免整张列表 500。
  const visualCols = hasVisualColumns(conn)
    ? 't.visual_video_id, t.visual_match_status'
    : "NULL AS visual_video_id, 'pending' AS visual_match_status";
  const loudCols = hasLoudnessColumns(conn)
    ? 't.acc_lufs, t.acc_true_peak_dbfs, t.acc_lra, t.acc_loudness_measured_at, t.acc_loudness_version, t.acc_loudness_source'
    : 'NULL AS acc_lufs, NULL AS acc_true_peak_dbfs, NULL AS acc_lra, NULL AS acc_loudness_measured_at, NULL AS acc_loudness_version, NULL AS acc_loudness_source';
  const canonicalCols = hasCanonicalColumns(conn)
    ? 't.canonical_id'
    : 'NULL AS canonical_id';
  const sql = `
    SELECT t.spotify_id, t.title, t.artists, t.album, t.duration_ms, t.album_art,
           t.album_art_path, t.release_date, t.popularity, t.match_score, t.status,
           ${canonicalCols},
           ${visualCols},
           ${loudCols},
           s.vocals_path IS NOT NULL AND s.vocals_path <> '' AS has_vocals,
           s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '' AS has_accompaniment
      FROM tracks t
      LEFT JOIN stems s ON s.track_id = t.id
     WHERE (? = '' OR t.title LIKE ? OR t.artists LIKE ?)
     ORDER BY t.id DESC
     LIMIT ?`;
  const like = `%${q}%`;
  let rows;
  try {
    rows = conn.prepare(sql).all(q, like, like, limit);
  } catch {
    return { available: false, tracks: [], reason: 'query-failed' };
  }

  // 同一首歌（EP 版 / 专辑版）只返回一条：点歌台列表不该出现两首一模一样的歌
  const tracks = collapseSameSongs(rows.map(toPublic));
  return {
    available: true,
    dbPath: dbPath,
    total: tracks.length,
    rawTotal: rows.length,
    tracks: opts.includeUnready ? tracks : tracks.filter((t) => t.ready),
  };
}

/** 某一行的 stems 是否齐（人声 + 伴奏），给 canonical 主记录兜底用。 */
function stemFlags(conn, spotifyId) {
  try {
    return conn.prepare(`
      SELECT s.vocals_path IS NOT NULL AND s.vocals_path <> '' AS has_vocals,
             s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '' AS has_accompaniment
        FROM tracks t LEFT JOIN stems s ON s.track_id = t.id
       WHERE t.spotify_id = ?`).get(String(spotifyId || ''));
  } catch {
    return null;
  }
}

/** 单曲详情（含歌词/stems 元信息） */
function getTrack(spotifyId) {
  const conn = open();
  if (!conn) return null;
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
  const visualCols = hasVisualColumns(conn)
    ? 't.visual_video_id, t.visual_match_status'
    : "NULL AS visual_video_id, 'pending' AS visual_match_status";
  // 大屏播放要用响度做实时增益补偿，所以单曲详情必须带这几列
  const loudCols = hasLoudnessColumns(conn)
    ? 't.acc_lufs, t.acc_true_peak_dbfs, t.acc_lra, t.acc_loudness_measured_at, t.acc_loudness_version, t.acc_loudness_source'
    : 'NULL AS acc_lufs, NULL AS acc_true_peak_dbfs, NULL AS acc_lra, NULL AS acc_loudness_measured_at, NULL AS acc_loudness_version, NULL AS acc_loudness_source';
  const canonicalCol = hasCanonicalColumns(conn) ? 't.canonical_id' : 'NULL AS canonical_id';
  let row;
  try {
    row = conn.prepare(`
      SELECT t.spotify_id, t.title, t.artists, t.album, t.duration_ms, t.album_art,
             t.album_art_path, t.release_date, t.popularity, t.match_score, t.status,
             ${canonicalCol}, t.source_video_id, ${visualCols}, ${loudCols},
             s.vocals_path IS NOT NULL AND s.vocals_path <> '' AS has_vocals,
             s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '' AS has_accompaniment
        FROM tracks t LEFT JOIN stems s ON s.track_id = t.id
       WHERE t.spotify_id = ?`).get(id);
  } catch {
    return null;
  }
  if (!row) return null;
  const out = toPublic(row);
  // 同一首歌（EP 版 / 专辑版）合并后，成品文件只落在主记录那一行上。
  // 这里必须顺着 canonical_id 去主记录把 stems 状态拿回来，否则：
  //   * 大屏打开非主记录的 id → ready=false → 永远显示「准备中」；
  //   * isLocalTrackReadyForPlayback() 判未就绪 → 点歌又触发一次下载（重复制作）。
  // 媒体本身仍用本 id 的 URL（serveMedia 会兜底到主记录目录，硬链接也已补上）。
  if (!out.ready && out.canonicalId && out.canonicalId !== id) {
    const flags = stemFlags(conn, out.canonicalId);
    if (flags && flags.has_vocals && flags.has_accompaniment) {
      out.hasVocals = true;
      out.hasAccompaniment = true;
      out.ready = true;
    }
  }
  // 只暴露伴奏 + 人声两条轨：原唱/伴奏/人声导唱三种模式由前端实时混音，不落盘。
  out.audio = out.ready ? {
    accompaniment: `/media/output/library/${id}/accompaniment.mp3`,
    vocals: `/media/output/library/${id}/vocals.mp3`,
  } : null;
  // 官方 MV 的完整元数据（画面来源，与 sourceVideoId 无关）
  out.visual = getVisual(id) || visualFallback();
  return out;
}

/** 没有 visual 记录时的兜底形状（老库 / 还没跑过匹配） */
function visualFallback() {
  return {
    visualVideoId: null,
    visualMatchStatus: 'pending',
    visualMatchScore: null,
    visualVideoTitle: null,
    visualChannelTitle: null,
    visualDuration: null,
    visualMatchReason: null,
    visualMatchedAt: null,
    candidates: [],
  };
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * 读一首歌的官方 MV 记录（**原始行为**，candidates 已解析为数组）。
 * 没有记录 / 老库没有这些列 → null。
 */
function getVisualRow(spotifyId) {
  const conn = open();
  if (!conn) return null;
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
  if (!hasVisualColumns(conn)) return null;
  try {
    const row = conn.prepare(`
      SELECT t.spotify_id, t.title, t.artists, t.album, t.duration_ms, t.release_date,
             t.visual_video_id, t.visual_match_status, t.visual_match_score, t.visual_video_title,
             t.visual_channel_title, t.visual_duration, t.visual_match_reason, t.visual_matched_at,
             t.visual_candidates
        FROM tracks t WHERE t.spotify_id = ?`).get(id);
    if (!row) return null;
    return {
      spotifyId: row.spotify_id,
      title: row.title,
      artists: parseArtists(row.artists),
      album: row.album || null,
      durationMs: row.duration_ms || null,
      releaseDate: row.release_date || null,
      visual_video_id: row.visual_video_id || null,
      visual_match_status: row.visual_match_status || 'pending',
      visual_match_score: row.visual_match_score ?? null,
      visual_video_title: row.visual_video_title || null,
      visual_channel_title: row.visual_channel_title || null,
      visual_duration: row.visual_duration ?? null,
      visual_match_reason: row.visual_match_reason || null,
      visual_matched_at: row.visual_matched_at || null,
      visual_candidates: row.visual_candidates || null,
    };
  } catch {
    return null;
  }
}

/**
 * 读一首歌的官方 MV（前端形状）。没有记录时返回 null —— 调用方用 visualFallback() 兜底。
 */
function getVisual(spotifyId) {
  const conn = open();
  const row = getVisualRow(spotifyId);
  if (!row || !conn) return null;
  return {
    visualVideoId: row.visual_video_id,
    visualMatchStatus: row.visual_match_status,
    visualMatchScore: row.visual_match_score,
    visualVideoTitle: row.visual_video_title,
    visualChannelTitle: row.visual_channel_title,
    visualDuration: row.visual_duration,
    visualMatchReason: row.visual_match_reason,
    visualMatchedAt: row.visual_matched_at,
    candidates: parseJsonArray(row.visual_candidates),
  };
}

const VISUAL_STATUSES = ['pending', 'auto_matched', 'manually_confirmed', 'not_found', 'unavailable', 'cover_only'];

// ---------------------------------------------------------------- 同一首歌（点歌即复用）
//
// 同一首歌在 Spotify 上可能有多个 track_id：EP 版 / 专辑版 / 精选集版，专辑不同但其实是同一首。
// 按用户要求以 **Spotify 源数据** 为准：同一歌手 + 同一歌名 + 时长差 ≤ 容差（默认 8 秒）
// → 同一首歌，直接复用曲库里已有的那份产物，不再下载/分离。
//
// 分组键由 Python 侧（python/library.py 的 canonical_key）写入 tracks.canonical_key，
// 这里的规范化必须与它完全一致，否则两边算出来的组对不上：
//   NFKC → 引号/连字符归一 → 小写 → 空白折叠；歌手排序去重后以 "|" 连接。
const SAME_SONG_TOLERANCE_MS = Number(process.env.KARAOKE_SAME_SONG_TOLERANCE_S || 8) * 1000;

const QUOTE_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2032': "'", '\u2033': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u3000': ' ',
};

function normalizeText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u2032\u2033\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u3000]/g, (ch) => QUOTE_MAP[ch] || ch)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function canonicalKey(title, artists) {
  const name = normalizeText(title);
  if (!name) return '';
  const list = (Array.isArray(artists) ? artists : parseArtists(artists)).map(normalizeText).filter(Boolean);
  const names = [...new Set(list)].sort();
  if (!names.length) return '';
  return `${name}\u0000${names.join('|')}`;
}

/** 时长统一成毫秒（库里是 duration_ms；Spotify 搜索结果也可能是毫秒）。 */
function toMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number > 1000 ? number : number * 1000;
}

/** 曲库是否已经有 canonical 列（老库还没跑过 Python 侧迁移时为 false）。 */
function hasCanonicalColumns(conn = open()) {
  if (!conn) return false;
  try {
    const cols = conn.prepare('PRAGMA table_info(tracks)').all().map((c) => c.name);
    return cols.includes('canonical_key');
  } catch {
    return false;
  }
}

/**
 * 这首歌曲库记录对应的"主记录" spotifyId（EP 版 / 专辑版合并后真正存文件的那条）。
 *
 * 播放端做硬链接后，每个 spotifyId 目录本身都有文件，这里主要给"目录还没建"的
 * 边缘情况（刚合并、还没补链）兜底；查不到就返回原 id。
 */
function getPrimaryTrackId(spotifyId) {
  const conn = open();
  const id = String(spotifyId || '');
  if (!conn || !/^[A-Za-z0-9]{22}$/.test(id)) return id;
  try {
    if (!hasCanonicalColumns(conn)) return id;
    const row = conn.prepare('SELECT canonical_id FROM tracks WHERE spotify_id = ?').get(id);
    const canonical = row && row.canonical_id;
    return canonical && canonical !== id ? String(canonical) : id;
  } catch {
    return id;
  }
}

/**
 * 找曲库里已有的"同一首歌"（同名 + 同歌手 + 时长接近），返回可直接播放的那一条。
 *
 * 命中就复用（点歌时**不该**重新下载/分离）；找不到返回 null，调用方再走后台制作。
 * @param {{title: string, artists: string[]|string, durationMs?: number|null}} spotifyTrack Spotify 搜索结果
 */
function findExistingSong(spotifyTrack = {}) {
  const conn = open();
  if (!conn) return null;
  const key = canonicalKey(spotifyTrack.title, spotifyTrack.artists);
  if (!key) return null;
  const target = toMs(spotifyTrack.durationMs ?? spotifyTrack.duration);
  let rows = [];
  try {
    if (hasCanonicalColumns(conn)) {
      rows = conn.prepare('SELECT spotify_id, title, artists, duration_ms FROM tracks WHERE canonical_key = ?').all(key);
    } else {
      rows = conn.prepare('SELECT spotify_id, title, artists, duration_ms FROM tracks').all()
        .filter((row) => canonicalKey(row.title, row.artists) === key);
    }
  } catch {
    return null;
  }
  const ranked = rows.map((row) => {
    const id = String(row.spotify_id);
    const other = toMs(row.duration_ms);
    const diff = target != null && other != null ? Math.abs(other - target) : Number.POSITIVE_INFINITY;
    const track = getTrack(id);
    return {
      id,
      diff,
      track,
      ready: Boolean(track && track.ready),
      // 主记录（canonical 指向自己）优先：队列/缓存 key 统一到它，播放和去重才稳定
      primary: Boolean(track && (track.canonicalId || id) === id),
    };
  }).filter((item) => item.diff <= SAME_SONG_TOLERANCE_MS || target == null);
  if (!ranked.length) return null;
  // 先挑可播放的，再挑主记录，最后才是时长最接近的
  // （同名但时长差很大的是另一首歌，已被上面的容差过滤）
  ranked.sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.diff !== b.diff) return a.diff - b.diff;
    return a.id.localeCompare(b.id);
  });
  const chosen = ranked[0];
  if (!chosen.track) return null;
  return {
    ...chosen.track,
    // 复用来源：告诉前端/日志"这首歌是库里已有的，没有重新处理"
    reusedFrom: chosen.ready ? chosen.id : null,
    sameSongOf: ranked.slice(1).map((item) => item.id),
  };
}

/**
 * 写官方 MV 记录（Node 侧写，与 deleteTrack 一样用独立短连接）。
 *
 * 并发约定与 Python 侧（python/library.py update_visual）保持一致：
 *   - 默认不覆盖 manually_confirmed（管理员确认过的不许被自动匹配改动）；
 *   - status='unavailable' 总是允许写（视频挂了必须记下来，否则每次播放都重试它）；
 *   - force=true 是管理员主动操作，覆盖一切。
 *
 * @param {string} spotifyId
 * @param {{status?: string, videoId?: string|null, videoTitle?: string|null, channelTitle?: string|null,
 *          duration?: number|null, score?: number|null, reason?: string|null, candidates?: Array|null,
 *          force?: boolean, clear?: boolean}} patch
 * @returns {{ok: boolean, reason?: string, visual?: object}}
 */
function updateVisual(spotifyId, patch = {}) {
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return { ok: false, reason: 'BAD_SPOTIFY_ID' };
  if (patch.status !== undefined && patch.status !== null && !VISUAL_STATUSES.includes(patch.status)) {
    return { ok: false, reason: 'BAD_STATUS' };
  }
  if (patch.videoId != null && patch.videoId !== '' && !/^[A-Za-z0-9_-]{11}$/.test(String(patch.videoId))) {
    return { ok: false, reason: 'BAD_VIDEO_ID' };
  }
  const conn = openWritable();
  if (!conn) return { ok: false, reason: 'no-db' };
  try {
    if (!hasVisualColumns(conn)) return { ok: false, reason: 'NO_VISUAL_COLUMNS' };
    const row = conn.prepare('SELECT id, visual_match_status FROM tracks WHERE spotify_id = ?').get(id);
    if (!row) return { ok: false, reason: 'TRACK_NOT_FOUND' };
    const current = row.visual_match_status || 'pending';
    const force = Boolean(patch.force);
    if (!force && patch.status !== 'unavailable' && current === 'manually_confirmed') {
      // 管理员已确认：自动结果不覆盖，如实返回现状
      return { ok: true, visual: getVisual(id) || visualFallback(), unchanged: true };
    }

    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (patch.clear) {
      conn.prepare(`UPDATE tracks SET visual_video_id = NULL, visual_match_status = 'pending',
        visual_match_score = NULL, visual_video_title = NULL, visual_channel_title = NULL,
        visual_duration = NULL, visual_match_reason = NULL, visual_matched_at = NULL,
        visual_candidates = NULL, updated_at = datetime('now') WHERE id = ?`).run(row.id);
      return { ok: true, visual: getVisual(id) || visualFallback() };
    }

    const sets = [];
    const params = [];
    const put = (column, value) => { sets.push(`${column} = ?`); params.push(value); };
    // 同时接受驼峰（videoId / videoTitle…）和数据库列名（video_id / video_title…）两种写法：
    // lib/official-mv.js 用的是列名风格，这里统一取第一个存在的键（曾因只认驼峰导致 videoId 被静默丢弃）。
    const pick = (...keys) => keys.find((key) => patch[key] !== undefined);
    const keyVideo = pick('videoId', 'video_id');
    if (keyVideo) put('visual_video_id', patch[keyVideo] ? String(patch[keyVideo]) : null);
    const keyTitle = pick('videoTitle', 'video_title');
    if (keyTitle) put('visual_video_title', patch[keyTitle] || null);
    const keyChannel = pick('channelTitle', 'channel_title');
    if (keyChannel) put('visual_channel_title', patch[keyChannel] || null);
    const keyDuration = pick('duration', 'visualDuration');
    if (keyDuration) put('visual_duration', patch[keyDuration] == null ? null : Number(patch[keyDuration]));
    const keyScore = pick('score', 'visualMatchScore');
    if (keyScore) put('visual_match_score', patch[keyScore] == null ? null : Math.round(Number(patch[keyScore]) * 100) / 100);
    const keyReason = pick('reason', 'visualMatchReason');
    if (keyReason) put('visual_match_reason', patch[keyReason] || null);
    if (patch.candidates !== undefined) put('visual_candidates', JSON.stringify(patch.candidates || []).slice(0, 200000));
    if (patch.status) {
      put('visual_match_status', patch.status);
      put('visual_matched_at', stamp);
    }
    // 明确"没有可用的 MW 了"（播放端报错且没有 videoId）：把 id 清空，
    // 否则下次播放还会自动加载同一个坏视频。
    // cover_only = 管理员主动选择「用模糊封面」，同样要清空 id（否则还会去播放）。
    if ((patch.status === 'unavailable' || patch.status === 'cover_only') && !keyVideo) {
      put('visual_video_id', null);
      if (!keyReason && patch.reason) put('visual_match_reason', patch.reason);
    }
    if (!sets.length) return { ok: true, visual: getVisual(id) || visualFallback() };
    sets.push("updated_at = datetime('now')");
    params.push(row.id);
    conn.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { ok: true, visual: getVisual(id) || visualFallback() };
  } catch (error) {
    return { ok: false, reason: 'db-error', error: error.message };
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

/** 曲目处理状态（DB 里的 tracks.status）→ 中文/英文展示文案 */
const STATUS_TEXT = {
  new: '待处理',
  resolving: '匹配中',
  resolved: '待下载',
  downloading: '下载中',
  downloaded: '待分离',
  separating: '分离中',
  separated: '已处理',
  failed: '处理失败',
};

/**
 * DJ 控制台「曲库管理」用：曲库全部曲目 + 处理状态 + 耗时/大小/匹配分/失败原因。
 *
 * 只读。正在后台跑的任务由调用方（server）用 prepare-jobs 的内存状态覆盖
 * status/progress/error —— 这里只给"落盘的"那一份事实。
 */
function adminTracks(opts = {}) {
  const conn = open();
  if (!conn) return { available: false, tracks: [], reason: DatabaseSync ? 'no-db' : 'sqlite-unavailable' };
  const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 1000);
  const q = String(opts.q || '').trim();
  const like = `%${q}%`;
  const visualCols = hasVisualColumns(conn)
    ? `t.visual_video_id, t.visual_match_status, t.visual_match_score, t.visual_video_title,
       t.visual_channel_title, t.visual_duration, t.visual_match_reason, t.visual_matched_at`
    : `NULL AS visual_video_id, 'pending' AS visual_match_status, NULL AS visual_match_score,
       NULL AS visual_video_title, NULL AS visual_channel_title, NULL AS visual_duration,
       NULL AS visual_match_reason, NULL AS visual_matched_at`;
  // 曲库页要显示"响度 / 补偿增益"，所以管理列表也带上
  const loudCols = hasLoudnessColumns(conn)
    ? 't.acc_lufs, t.acc_true_peak_dbfs, t.acc_lra, t.acc_loudness_measured_at, t.acc_loudness_version, t.acc_loudness_source'
    : 'NULL AS acc_lufs, NULL AS acc_true_peak_dbfs, NULL AS acc_lra, NULL AS acc_loudness_measured_at, NULL AS acc_loudness_version, NULL AS acc_loudness_source';
  // 同一首歌的合并键（老库还没跑迁移时为空，走 spotify_id 兜底）
  const canonicalCols = hasCanonicalColumns(conn)
    ? 't.canonical_id'
    : 'NULL AS canonical_id';
  let rows;
  try {
    // 每首歌：tracks 行 + 最新 stems 行 + 最后一次失败原因（jobs 表）+ 歌词情况 + 官方 MV
    rows = conn.prepare(`
      SELECT t.spotify_id, t.title, t.artists, t.album, t.album_art, t.album_art_path,
             ${canonicalCols},
             t.release_date, t.popularity, t.match_score, t.status, t.error,
             t.duration_ms, t.audio_bytes, t.audio_path,
             t.source_video_id, t.source_url, t.source_title, t.created_at, t.updated_at,
             ${visualCols},
             ${loudCols},
             s.model, s.device, s.rtf, s.processing_s, s.input_duration_s, s.out_dir,
             s.vocals_path, s.no_vocals_path,
             s.vocals_path IS NOT NULL AND s.vocals_path <> '' AS has_vocals,
             s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '' AS has_accompaniment,
             (SELECT COUNT(*) FROM lyrics l WHERE l.track_id = t.id) AS lyrics_count,
             (SELECT l.provider FROM lyrics l WHERE l.track_id = t.id ORDER BY l.id DESC LIMIT 1) AS lyrics_provider,
             (SELECT l.synced FROM lyrics l WHERE l.track_id = t.id ORDER BY l.id DESC LIMIT 1) AS lyrics_synced,
             (SELECT l.format FROM lyrics l WHERE l.track_id = t.id ORDER BY l.id DESC LIMIT 1) AS lyrics_format,
             (SELECT LENGTH(l.content) FROM lyrics l WHERE l.track_id = t.id ORDER BY l.id DESC LIMIT 1) AS lyrics_chars,
             (SELECT j.duration_ms FROM jobs j WHERE j.track_id = t.id AND j.status = 'ok'
                ORDER BY j.id DESC LIMIT 1) AS last_ok_ms,
             (SELECT j.message FROM jobs j WHERE j.track_id = t.id AND j.status = 'failed'
                ORDER BY j.id DESC LIMIT 1) AS last_job_error
        FROM tracks t
        LEFT JOIN stems s ON s.track_id = t.id
       WHERE (? = '' OR t.title LIKE ? OR t.artists LIKE ? OR t.album LIKE ?)
       ORDER BY t.id DESC
       LIMIT ?`).all(q, like, like, like, limit);
  } catch {
    return { available: false, tracks: [], reason: 'query-failed' };
  }

  const tracks = rows.map((row) => {
    const status = STATUS_TEXT[row.status] ? row.status : 'new';
    const ready = Boolean(row.has_vocals && row.has_accompaniment);
    const started = row.created_at ? new Date(`${row.created_at}Z`).getTime() : null;
    const updated = row.updated_at ? new Date(`${row.updated_at}Z`).getTime() : null;
    return {
      spotifyId: row.spotify_id,
      // 同一首歌的合并键：等于自己 = 主记录；否则指向主记录（列表会按它去重）
      canonicalId: row.canonical_id || row.spotify_id,
      title: row.title,
      artists: parseArtists(row.artists),
      album: row.album || null,
      cover: pickCover(row),
      durationMs: row.duration_ms || null,
      releaseDate: row.release_date || null,
      popularity: row.popularity ?? null,
      status,
      statusText: STATUS_TEXT[status],
      ready,
      // 正在处理的曲目 progress 由 server 用内存任务状态补上，这里给 null
      progress: null,
      error: row.status === 'failed' ? (row.error || row.last_job_error || null) : (row.last_job_error || null),
      // DB 内记录的音频大小（分离前的原始 WAV）；成品 mp3 大小由 server 补
      audioBytes: row.audio_bytes || null,
      audioPath: row.audio_path || null,
      matchScore: row.match_score ?? null,
      model: row.model || null,
      device: row.device || null,
      rtf: row.rtf ?? null,
      processingS: row.processing_s ?? null,
      inputDurationS: row.input_duration_s ?? null,
      // 处理耗时：分离耗时优先，其次最后一次成功 job 的耗时，再次 created→updated 的跨度
      elapsedMs: row.processing_s ? Math.round(row.processing_s * 1000)
        : (row.last_ok_ms ?? (started && updated ? Math.max(0, updated - started) : null)),
      hasVocals: Boolean(row.has_vocals),
      hasAccompaniment: Boolean(row.has_accompaniment),
      lyricsCount: row.lyrics_count || 0,
      lyricsProvider: row.lyrics_provider || null,
      lyricsSynced: row.lyrics_synced == null ? null : Boolean(row.lyrics_synced),
      lyricsFormat: row.lyrics_format || null,
      lyricsChars: row.lyrics_chars || 0,
      sourceVideoId: row.source_video_id || null,
      sourceUrl: row.source_url || null,
      sourceTitle: row.source_title || null,
      // 官方 MV（画面来源）：状态/评分/标题/频道/时长，供曲库页「MV」列与弹窗显示
      visualVideoId: row.visual_video_id || null,
      visualMatchStatus: row.visual_match_status || 'pending',
      visualMatchScore: row.visual_match_score ?? null,
      visualVideoTitle: row.visual_video_title || null,
      visualChannelTitle: row.visual_channel_title || null,
      visualDuration: row.visual_duration ?? null,
      visualMatchReason: row.visual_match_reason || null,
      visualMatchedAt: row.visual_matched_at || null,
      // 伴奏响度（LUFS / 真峰值），曲库页「响度」列与前端实时均衡都用它
      loudness: loudnessFromRow(row),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  });

  const counts = tracks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const visualCounts = tracks.reduce((acc, t) => { acc[t.visualMatchStatus] = (acc[t.visualMatchStatus] || 0) + 1; return acc; }, {});
  // 同一首歌（EP 版 / 专辑版）只显示一条：保留最该展示的那条，其余版本挂到 versions 里
  const deduped = collapseSameSongs(tracks);
  const dedupedCounts = deduped.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const dedupedVisualCounts = deduped.reduce((acc, t) => { acc[t.visualMatchStatus] = (acc[t.visualMatchStatus] || 0) + 1; return acc; }, {});
  return {
    available: true, dbPath,
    total: deduped.length,
    counts: dedupedCounts,
    visualCounts: dedupedVisualCounts,
    // 原始行数（含同歌不同版本），排查用
    rawTotal: tracks.length,
    statusText: STATUS_TEXT,
    tracks: deduped,
  };
}

/**
 * 把"同一首歌"的多条记录收拢成一条。
 *
 * 曲库页对用户来说一首歌就是一行：EP 版和专辑版没必要各占一行。
 * group 的键是 canonical_id（Python 侧按"同名 + 同歌手 + 时长接近"算出来）；
 * 主记录优先，没有主记录时取最完整的那条。其余版本放进 `versions`，
 * 前端可以显示"另有 2 个版本"或直接忽略。
 */
function collapseSameSongs(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return [];
  const byKey = new Map();
  for (const track of tracks) {
    const key = track.canonicalId || track.spotifyId;
    const list = byKey.get(key);
    if (list) list.push(track); else byKey.set(key, [track]);
  }
  const rank = (track) => {
    // **可播放优先**，其次主记录，再次状态靠后（已处理），再次 id 小。
    // 顺序不能反：如果主记录还没分离（例如只有 downloaded），把不可播的那条排在前面，
    // 整组显示成"未就绪"，用户再点一次就重复下载 —— 而组里其实有能播的版本。
    const isPrimary = !track.canonicalId || track.canonicalId === track.spotifyId;
    const statusRank = { separated: 3, processing: 2, failed: 1 }[track.status] || 0;
    return [track.ready ? 1 : 0, isPrimary ? 1 : 0, statusRank];
  };
  const out = [];
  for (const list of byKey.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const sorted = [...list].sort((a, b) => {
      const ra = rank(a); const rb = rank(b);
      for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return rb[i] - ra[i];
      return String(a.spotifyId).localeCompare(String(b.spotifyId));
    });
    const [primary, ...rest] = sorted;
    out.push({
      ...primary,
      // 展示用的这条如果不是主记录，也按它的真实状态展示；
      // 但点歌/播放仍会通过 findExistingSong 映射到库里可播的那条。
      versions: rest.map((v) => ({ spotifyId: v.spotifyId, album: v.album, durationMs: v.durationMs, status: v.status, ready: v.ready })),
      versionCount: rest.length + 1,
    });
  }
  return out;
}

/**
 * 读曲库里已存的歌词（流水线抓的）。
 *
 * 播放时优先用这份，避免每次都联网查——QQ 有严格限流，
 * 每切一次歌都去请求很快就 code=2001 了。
 * 返回 { provider, format, synced, content } 或 null。
 */
function getLyrics(spotifyId) {
  const conn = open();
  if (!conn) return null;
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
  try {
    const row = conn.prepare(`
      SELECT l.provider, l.format, l.synced, l.content, l.plain
        FROM lyrics l JOIN tracks t ON t.id = l.track_id
       WHERE t.spotify_id = ?
       ORDER BY l.synced DESC, l.id DESC LIMIT 1`).get(id);
    if (!row || !row.content) return null;
    return {
      provider: row.provider || null,
      format: row.format || null,
      synced: Boolean(row.synced),
      content: row.content,
      plain: row.plain || '',
    };
  } catch {
    return null;
  }
}

function summary() {
  const conn = open();
  if (!conn) return { available: false };
  try {
    // 统计按"同一首歌"分组去重：EP 版 / 专辑版合并后只算一首
    const n = countSongs(conn);
    const ready = countSongs(conn, true);
    return { available: true, total: n, ready, dbPath };
  } catch {
    return { available: false };
  }
}

/**
 * 曲库"歌曲数"（按同一首歌去重）。
 *
 * tracks 表里同名同歌手不同专辑可能是多行（EP 版 / 专辑版），对用户来说只是同一首，
 * 所以统计时用 canonical_id 归并：每组只算一次。
 * @param {boolean} [readyOnly] 只数已就绪的
 */
function countSongs(conn, readyOnly = false) {
  if (!conn) return 0;
  if (!hasCanonicalColumns(conn)) {
    const row = readyOnly
      ? conn.prepare(`SELECT COUNT(*) AS n FROM tracks t JOIN stems s ON s.track_id = t.id
                       WHERE s.vocals_path IS NOT NULL AND s.no_vocals_path IS NOT NULL`).get()
      : conn.prepare('SELECT COUNT(*) AS n FROM tracks').get();
    return row.n;
  }
  const row = conn.prepare(`
    SELECT COUNT(DISTINCT COALESCE(t.canonical_id, t.spotify_id)) AS n
      FROM tracks t ${readyOnly ? 'JOIN stems s ON s.track_id = t.id' : ''}
     ${readyOnly ? 'WHERE s.vocals_path IS NOT NULL AND s.no_vocals_path IS NOT NULL' : ''}`).get();
  return row.n;
}

// ---------------------------------------------------------------- 残留文件清理
// 曲库里的歌被删掉后，产物文件有时会留在磁盘上（早期清理逻辑不完整，或文件
// 被别的流程写回来）。这里负责**只读扫描**：列出"磁盘上有、数据库里已经没有
// 对应记录"的文件；真正删除由 purgeFiles() 做，且必须先过白名单。
//
// 目录位置由调用方传入（server.js 的 MEDIA_ROOT / DATA_DIR），
// 这样测试可以指向临时目录，不用动真实的 assets/。

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LYRICS_EXTS = ['.lrc', '.yrc', '.qrc'];

/** 扫描目标。key 是清理接口的定位标识，root 由调用方给的根目录推导。 */
const ORPHAN_TARGETS = [
  { key: 'output', label: '成品音频', hint: 'assets/output/library/<spotifyId>/', mode: 'dir', under: ['output', 'library'] },
  { key: 'covers', label: '封面', hint: 'assets/covers/<spotifyId>.jpg', mode: 'file', under: ['covers'], exts: ['.jpg'] },
  { key: 'lyrics', label: '歌词文件', hint: `assets/lyrics/<spotifyId>${LYRICS_EXTS.join(' / ')}`, mode: 'file', under: ['lyrics'], exts: LYRICS_EXTS },
];

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }
}

/** 目录递归求大小；文件直接取 size。都异常安全。 */
function sizeOf(target) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const entry of listDir(p) || []) walk(path.join(p, entry.name));
      return;
    }
    total += st.size;
  };
  walk(target);
  return total;
}

function statEntry(target) {
  try {
    const st = fs.statSync(target);
    return { bytes: st.isDirectory() ? sizeOf(target) : st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * 只读扫描残留文件。
 *
 * @param {{assetsRoot?: string, dataRoot?: string, overrideKeys?: string[]}} opts
 *   overrideKeys —— lyrics-overrides.json 里的键（`local:<spotifyId>`）。
 *   它存在 JSON 里而不是磁盘文件上，所以由调用方读出来传进来比对。
 * @returns 分组清单；目录不存在时返回空组（新装环境没有 assets/，不该报错）
 */
function scanOrphans(opts = {}) {
  const conn = open();
  if (!conn) {
    return { available: false, groups: [], totalBytes: 0, totalCount: 0, reason: DatabaseSync ? 'no-db' : 'sqlite-unavailable' };
  }

  const assetsRoot = path.resolve(opts.assetsRoot || path.join(ROOT, 'assets'));
  const dataRoot = path.resolve(opts.dataRoot || path.join(ROOT, 'data'));

  // 已知 ID：spotify_id 用于 assets/ 下的三棵树，source_video_id 用于 data/library/
  const spotifyIds = new Set();
  const videoIds = new Set();
  try {
    for (const row of conn.prepare('SELECT spotify_id, source_video_id FROM tracks').all()) {
      if (row.spotify_id) spotifyIds.add(String(row.spotify_id));
      if (row.source_video_id) videoIds.add(String(row.source_video_id));
    }
  } catch {
    return { available: false, groups: [], totalBytes: 0, totalCount: 0, reason: 'query-failed' };
  }

  const groups = [];
  const skipped = [];
  const makeGroup = (key, label, hint, root) => {
    const group = { key, label, hint, root, items: [], totalBytes: 0 };
    groups.push(group);
    return group;
  };
  const push = (group, id, entryPath, kind) => {
    const info = statEntry(entryPath);
    if (!info) return;
    group.items.push({ id, path: entryPath, name: path.basename(entryPath), kind, bytes: info.bytes, mtime: info.mtime });
    group.totalBytes += info.bytes;
  };

  // (1) assets/{output/library, covers, lyrics} —— 按 spotifyId 命名
  for (const spec of ORPHAN_TARGETS) {
    const root = path.join(assetsRoot, ...spec.under);
    const group = makeGroup(spec.key, spec.label, spec.hint, root);
    for (const entry of listDir(root) || []) {
      const entryPath = path.join(root, entry.name);
      if (spec.mode === 'dir') {
        if (!entry.isDirectory()) continue;
      } else if (!entry.isFile()) continue;

      // 名字不像 spotifyId 的一律跳过：probe-loopback、.tmp-final 之类不是曲目产物
      const stem = spec.mode === 'dir' ? entry.name : path.basename(entry.name, path.extname(entry.name));
      if (!SPOTIFY_ID_RE.test(stem)) {
        skipped.push({ path: entryPath, reason: 'not-a-track-id' });
        continue;
      }
      if (spec.exts && !spec.exts.includes(path.extname(entry.name).toLowerCase())) {
        skipped.push({ path: entryPath, reason: 'extension-not-managed' });
        continue;
      }
      if (spotifyIds.has(stem)) continue; // 曲库里还有这首歌 → 不是残留
      push(group, stem, entryPath, spec.mode);
    }
  }

  // (2) data/library/<videoId>.wav + <videoId>.match.json —— 原始下载，按 YouTube videoId 命名
  const upstreamRoot = path.join(dataRoot, 'library');
  const upstream = makeGroup('upstream', '原始下载', 'data/library/<videoId>.wav · .match.json', upstreamRoot);
  for (const entry of listDir(upstreamRoot) || []) {
    if (!entry.isFile()) continue;
    const entryPath = path.join(upstreamRoot, entry.name);
    let videoId = null;
    if (entry.name.endsWith('.match.json')) videoId = entry.name.slice(0, -'.match.json'.length);
    else if (entry.name.toLowerCase().endsWith('.wav')) videoId = entry.name.slice(0, -4);
    if (!videoId || !VIDEO_ID_RE.test(videoId)) {
      skipped.push({ path: entryPath, reason: 'not-a-video-id' });
      continue;
    }
    if (videoIds.has(videoId)) continue;
    push(upstream, videoId, entryPath, 'file');
  }

  // (3) 歌词覆盖表：DJ 手动重搜的结果，曲目删掉后这些条目就没人引用了。
  //     不是磁盘文件，所以这里只登记，删除由 server 侧调 lyricsOverrides.remove()。
  if (Array.isArray(opts.overrideKeys) && opts.overrideKeys.length) {
    const g = makeGroup('overrides', '歌词覆盖', 'data/lyrics-overrides.json', path.join(dataRoot, 'lyrics-overrides.json'));
    for (const key of opts.overrideKeys) {
      const m = /^local:(.+)$/.exec(String(key));
      if (!m || spotifyIds.has(m[1])) continue;
      g.items.push({ id: m[1], key: String(key), path: null, name: String(key), kind: 'entry', bytes: 0, mtime: null });
    }
  }

  const items = groups.reduce((n, g) => n + g.items.length, 0);
  return {
    available: true,
    dbPath,
    scannedAt: new Date().toISOString(),
    roots: { assets: assetsRoot, data: dataRoot },
    counts: { tracks: spotifyIds.size, videos: videoIds.size },
    groups,
    skipped,
    totalCount: items,
    totalBytes: groups.reduce((n, g) => n + g.totalBytes, 0),
  };
}

/**
 * 删除扫描出来的残留文件。
 *
 * 安全边界（任何一条不满足就跳过该文件）：
 *   1. 路径必须在 assetsRoot / dataRoot 之内；
 *   2. 且必须是某个受管目录（output/library、covers、lyrics、data/library）的**直接子项**，
 *      防止传入根目录本身或越界的深层路径；
 *   3. 名字必须能解析出合法的 spotifyId / videoId；
 *   4. 该 id 不在 blockedIds 里（正在后台制作的歌，其产物不能删）；
 *   5. 该 id 在**当前** tracks 表里仍然不存在 —— 扫描与清理之间可能有几秒到几分钟，
 *      期间这首歌可能又被点回曲库了，删掉就会把正在用的产物抹掉。
 *
 * @param {string[]} paths 绝对路径
 * @param {{assetsRoot?: string, dataRoot?: string, blockedIds?: Iterable<string>, manifestFile?: string}} opts
 */
function purgeFiles(paths, opts = {}) {
  const assetsRoot = path.resolve(opts.assetsRoot || path.join(ROOT, 'assets'));
  const dataRoot = path.resolve(opts.dataRoot || path.join(ROOT, 'data'));
  const blocked = new Set(opts.blockedIds || []);

  // 第 5 条边界需要现场查一次库。查不了就一刀切拒绝 —— 没有依据判断"是不是孤儿"，
  // 宁可不删也不能删错。
  const conn = open();
  const live = new Set();
  if (!conn) {
    return {
      ok: false,
      removed: [], rejected: paths.map((p) => ({ path: String(p), reason: 'db-unavailable' })),
      failed: [], freedBytes: 0, manifest: null,
    };
  }
  try {
    for (const row of conn.prepare('SELECT spotify_id, source_video_id FROM tracks').all()) {
      if (row.spotify_id) live.add(String(row.spotify_id));
      if (row.source_video_id) live.add(String(row.source_video_id));
    }
  } catch {
    return {
      ok: false,
      removed: [], rejected: paths.map((p) => ({ path: String(p), reason: 'db-unavailable' })),
      failed: [], freedBytes: 0, manifest: null,
    };
  }

  // 受管目录 → 允许删除的直属子项。路径必须落在其中一个目录下。
  const managed = [
    { root: path.join(assetsRoot, 'output', 'library'), pattern: SPOTIFY_ID_RE },
    { root: path.join(assetsRoot, 'covers'), pattern: SPOTIFY_ID_RE },
    { root: path.join(assetsRoot, 'lyrics'), pattern: SPOTIFY_ID_RE },
    { root: path.join(dataRoot, 'library'), pattern: VIDEO_ID_RE },
  ];
  const allowedRoots = [assetsRoot + path.sep, dataRoot + path.sep];

  const removed = [];
  const rejected = [];
  const failed = [];

  for (const raw of paths) {
    const target = path.resolve(String(raw || ''));
    const reject = (reason) => rejected.push({ path: target, reason });

    if (!allowedRoots.some((root) => target.startsWith(root))) { reject('outside-roots'); continue; }

    const parent = path.dirname(target);
    const scope = managed.find((m) => parent === m.root);
    if (!scope) { reject('not-managed-dir'); continue; }

    const name = path.basename(target);
    // 与扫描时同样的 id 解析：<videoId>.match.json / <videoId>.wav / <spotifyId>[.ext]
    let id = name;
    for (const suffix of ['.match.json']) {
      if (id.endsWith(suffix)) { id = id.slice(0, -suffix.length); break; }
    }
    if (id === name) id = path.basename(name, path.extname(name));
    if (!scope.pattern.test(id)) { reject('bad-id'); continue; }

    if (blocked.has(id)) { reject('job-active'); continue; }
    if (live.has(id)) { reject('track-exists'); continue; }
    if (!fs.existsSync(target)) { reject('already-gone'); continue; }

    const bytes = sizeOf(target);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push({ path: target, id, bytes });
    } catch (error) {
      failed.push({ path: target, id, error: error.message });
    }
  }

  // 删之前先落一份清单：文件是真删（不进回收站），有清单至少能查删过什么
  let manifest = null;
  if (opts.manifestFile && removed.length) {
    manifest = opts.manifestFile;
    try {
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, JSON.stringify({
        at: new Date().toISOString(),
        roots: { assets: assetsRoot, data: dataRoot },
        freedBytes: removed.reduce((n, item) => n + item.bytes, 0),
        removed,
      }, null, 2), 'utf8');
    } catch (error) {
      manifest = { path: manifest, error: error.message };
    }
  }

  return {
    ok: failed.length === 0,
    removed,
    rejected,
    failed,
    freedBytes: removed.reduce((n, item) => n + item.bytes, 0),
    manifest,
  };
}

module.exports = {
  open, close, deleteTrack, listTracks, getTrack, getLyrics, summary, adminTracks, scanOrphans, purgeFiles,
  // 官方 MV（visualVideoId）：读写与状态常量，见 lib/official-mv.js
  getVisual, getVisualRow, updateVisual, hasVisualColumns, visualFallback, VISUAL_STATUSES,
  // 伴奏响度（ffmpeg 测得；播放端用它算实时增益）
  hasLoudnessColumns, loudnessFromRow,
  // 同一首歌（歌名 + 歌手 + 时长容差）：搜索与点歌复用已有曲库
  canonicalKey, findExistingSong, hasCanonicalColumns, SAME_SONG_TOLERANCE_MS, getPrimaryTrackId,
  // 同一首歌在列表/统计里的合并（EP 版 / 专辑版只算一首）
  collapseSameSongs, countSongs,
  STATUS_TEXT, resolvePath, songKeySupported: true,
};
