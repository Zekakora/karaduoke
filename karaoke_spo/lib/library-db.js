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

function toPublic(row) {
  return {
    spotifyId: row.spotify_id,
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
    // 源 YouTube 视频（模式 B 的 video.mp4 就是从它截的；也用于歌词查询按 videoId 命中）
    sourceVideoId: row.source_video_id || null,
  };
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

  // stems 表按 (track_id, model) 唯一；取最新一条判断是否有人声/伴奏
  const sql = `
    SELECT t.spotify_id, t.title, t.artists, t.album, t.duration_ms, t.album_art,
           t.album_art_path, t.release_date, t.popularity, t.match_score, t.status,
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

  const tracks = rows.map(toPublic);
  return {
    available: true,
    dbPath: dbPath,
    total: tracks.length,
    tracks: opts.includeUnready ? tracks : tracks.filter((t) => t.ready),
  };
}

/** 单曲详情（含歌词/stems 元信息） */
function getTrack(spotifyId) {
  const conn = open();
  if (!conn) return null;
  const id = String(spotifyId || '');
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
  let row;
  try {
    row = conn.prepare(`
      SELECT t.spotify_id, t.title, t.artists, t.album, t.duration_ms, t.album_art,
             t.album_art_path, t.release_date, t.popularity, t.match_score, t.status,
             t.source_video_id,
             s.vocals_path IS NOT NULL AND s.vocals_path <> '' AS has_vocals,
             s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '' AS has_accompaniment
        FROM tracks t LEFT JOIN stems s ON s.track_id = t.id
       WHERE t.spotify_id = ?`).get(id);
  } catch {
    return null;
  }
  if (!row) return null;
  const out = toPublic(row);
  out.audio = out.ready ? {
    accompaniment: `/media/output/library/${id}/accompaniment.mp3`,
    vocals: `/media/output/library/${id}/vocals.mp3`,
    guide: `/media/output/library/${id}/guide.mp3`,
    original: `/media/output/library/${id}/original.mp3`,
  } : null;
  return out;
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
  let rows;
  try {
    // 每首歌：tracks 行 + 最新 stems 行 + 最后一次失败原因（jobs 表）+ 歌词情况
    rows = conn.prepare(`
      SELECT t.spotify_id, t.title, t.artists, t.album, t.album_art, t.album_art_path,
             t.release_date, t.popularity, t.match_score, t.status, t.error,
             t.duration_ms, t.audio_bytes, t.audio_path,
             t.source_video_id, t.source_url, t.source_title, t.created_at, t.updated_at,
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
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  });

  const counts = tracks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  return { available: true, dbPath, total: tracks.length, counts, statusText: STATUS_TEXT, tracks };
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
    const n = conn.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    const ready = conn.prepare(`
      SELECT COUNT(*) AS n FROM tracks t JOIN stems s ON s.track_id = t.id
       WHERE s.vocals_path IS NOT NULL AND s.no_vocals_path IS NOT NULL`).get().n;
    return { available: true, total: n, ready, dbPath };
  } catch {
    return { available: false };
  }
}

module.exports = { open, close, deleteTrack, listTracks, getTrack, getLyrics, summary, adminTracks, STATUS_TEXT, resolvePath, songKeySupported: true };
