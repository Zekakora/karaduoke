'use strict';
/**
 * 歌词覆盖表（DJ 手动重新匹配的结果）。
 *
 * 为什么需要：
 *   曲库里的歌词是流水线自动匹配的，有时匹配不到或匹配错歌。
 *   DJ 在「曲库管理」里改歌名/歌手重新搜到正确歌词后，需要立刻生效，
 *   而且**重启后仍然有效**。
 *
 * 为什么不用数据库：
 *   SQLite 由 Python 侧写入，Node 侧只读。为了写一条歌词就起个 python 子进程
 *   太重，所以单独存一个 JSON。查询时优先读它。
 *
 * 键用 songKey：本地曲目 = spotifyId，YouTube = videoId。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.env.LYRICS_OVERRIDES
  ? path.resolve(process.env.LYRICS_OVERRIDES)
  : path.join(ROOT, 'data', 'lyrics-overrides.json');

/** @type {Map<string, {key:string, payload:object, songTitle?:string, artist?:string, at:string}>} */
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  let text = null;
  try {
    text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return cache;
  }
  try {
    const data = JSON.parse(text);
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      if (item && item.key && item.payload) cache.set(String(item.key), item);
    }
  } catch {
    // 损坏不静默重建：备份后从空开始（与 state.json 的处理一致）
    try { fs.copyFileSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    console.error('[lyrics-overrides] 解析失败，已备份后从空开始');
  }
  return cache;
}

function persist() {
  const items = [...load().values()];
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, FILE);
}

function get(key) {
  if (!key) return null;
  return load().get(String(key)) || null;
}

function set(key, payload, extra = {}) {
  if (!key || !payload) return null;
  const entry = {
    key: String(key),
    payload,
    songTitle: extra.songTitle || null,
    artist: extra.artist || null,
    at: new Date().toISOString(),
  };
  load().set(entry.key, entry);
  persist();
  return entry;
}

function remove(key) {
  if (!key) return false;
  const ok = load().delete(String(key));
  if (ok) persist();
  return ok;
}

function list() {
  return [...load().values()];
}

module.exports = { get, set, remove, list, file: FILE };
