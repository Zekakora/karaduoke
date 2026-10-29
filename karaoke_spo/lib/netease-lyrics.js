'use strict';
/**
 * 网易云音乐歌词源（兜底 QQ 逐字）。
 *
 * 为什么加它：QQ 的逐字最好，但限流极凶（code=2001），一被限就整首歌拿不到歌词。
 * 网易云覆盖中文歌很全，虽然只有行级时间轴，但比 lrclib 命中率高得多。
 *
 * 接口（2026-10 实测可用）：
 *   搜索  GET /api/cloudsearch/pc?s=&type=1&limit=&offset=0
 *         ⚠️ 老的 /api/search/get/web 现在返回 0 条，/api/search/pc 返回 code=-462。
 *   歌词  GET /api/song/lyric?id=&lv=1&kv=1&tv=-1
 *         lv=1 原文，tv=-1 翻译（tlyric）
 * 两个都要带 Referer: https://music.163.com/
 *
 * 生产环境的频次节制和 QQ 一样：串行 + 最小间隔。
 */

const crypto = require('node:crypto');
const { isCreditLine } = require('./qrc-parse.js');

const BASE = 'https://music.163.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_INTERVAL_MS = 1500;

let queue = Promise.resolve();
let lastCall = 0;

function rateLimited(fn) {
  const run = async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function getJson(pathAndQuery, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathAndQuery, {
      headers: { Referer: `${BASE}/`, 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSong(raw) {
  const artists = (raw.ar || raw.artists || []).map((a) => a && a.name).filter(Boolean);
  const durationMs = Number(raw.dt || raw.duration || 0) || null;
  return {
    id: Number(raw.id),
    name: String(raw.name || '').trim(),
    artists,
    album: (raw.al && raw.al.name) || (raw.album && raw.album.name) || null,
    durationMs,
  };
}

/** 搜索歌曲。返回 [{ id, name, artists, album, durationMs }] */
async function searchSongs(title, artist = '', limit = 10) {
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return [];
  const qs = new URLSearchParams({ s: q, type: '1', limit: String(limit), offset: '0' });
  const body = await rateLimited(() => getJson(`/api/cloudsearch/pc?${qs}`));
  const songs = (body && body.result && body.result.songs) || [];
  return songs.map(normalizeSong).filter((s) => s.id && s.name);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_/\\()（）[\]【】,.，。!！?？'"“”‘’·:：]/g, '');
}

/**
 * 挑最像的那首。
 * 判据：歌名包含（强）+ 歌手命中 + 时长接近。时长是防"remix/翻唱/钢琴版"的关键。
 *
 * 注：未登录的 cloudsearch 对部分歌曲只返回翻唱/钢琴版（原版可能地区受限），
 * 所以这里对「明显是改编版」的歌名降权，优先选最朴素的条目。
 */
const DERIVED = /钢琴|纯音乐|伴奏|remix|dj|铃声|片段|live|现场|抖音|女声|男声|深情版|史诗版|萨克斯|beat/i;

function scoreCandidate(cand, title, artists, durationS) {
  const t = norm(title);
  const n = norm(cand.name);
  let score = 0;
  if (t && n) {
    if (n === t) score += 60;
    else if (n.includes(t) || t.includes(n)) score += 40;
  }
  const wantArtist = (artists || []).map(norm).filter(Boolean);
  const gotArtist = (cand.artists || []).map(norm);
  if (wantArtist.length && gotArtist.length) {
    if (wantArtist.some((a) => gotArtist.some((g) => g.includes(a) || a.includes(g)))) score += 25;
  }
  if (durationS && cand.durationMs) {
    const diff = Math.abs(cand.durationMs / 1000 - durationS);
    score += diff <= 3 ? 30 : diff <= 8 ? 18 : diff <= 20 ? 6 : -25;
  }
  if (DERIVED.test(String(cand.name || ''))) score -= 15;
  return score;
}

async function findBestMatch(title, artists, durationS, limit = 10) {
  const list = await searchSongs(title, (artists || []).join(' '), limit);
  if (!list.length) return null;
  const scored = list
    .map((cand) => ({ cand, score: scoreCandidate(cand, title, artists, durationS) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  // 阈值：至少歌名要像（40 分）
  if (!best || best.score < 40) return null;
  return best.cand;
}

/** 取 LRC。返回 { lrc, translation } 或 null */
async function fetchLyricsLrc(songId) {
  const body = await rateLimited(() => getJson(`/api/song/lyric?id=${Number(songId)}&lv=1&kv=1&tv=-1`));
  if (!body || body.code !== 200) return null;
  const lrc = (body.lrc && body.lrc.lyric) || '';
  if (!lrc.trim()) return null;
  const translation = (body.tlyric && body.tlyric.lyric) || '';
  return { lrc, translation };
}

/**
 * 一步到位：标题 + 歌手 + 时长 → 行级歌词。
 *
 * 关键：**逐个候选尝试**，拿到歌词才算成功。
 * 实测网易云搜索首位经常是翻唱/钢琴版（还没歌词），只试第一个会直接失败。
 */
async function fetchLyrics(title, artists, durationS) {
  const list = await searchSongs(title, (artists || []).join(' '), 10);
  if (!list.length) return null;
  const ranked = list
    .map((cand) => ({ cand, score: scoreCandidate(cand, title, artists, durationS) }))
    .filter((x) => x.score >= 40)          // 歌名得先像
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);                          // 最多试 4 个，别把接口打爆
  const pick = (cand, score, extra) => ({
    provider: 'netease',
    synced: true,
    ...extra,
    match: {
      songId: cand.id,
      songName: cand.name,
      artists: cand.artists,
      durationMs: cand.durationMs,
      score,
    },
  });

  // 第一轮：在所有候选里找逐字（YRC）。
  // 不能"同一个候选没 YRC 就直接回行级" —— 搜索首位常是翻唱/钢琴版，
  // 它们往往没有逐字，但后面的原版有。先横扫一遍逐字，命中率差别很大。
  for (const { cand, score } of ranked.slice(0, 3)) {
    const yrc = await fetchYrc(cand.id);
    if (yrc && yrc.lines.length) {
      const lrc = await fetchLyricsLrc(cand.id);
      return pick(cand, score, {
        format: 'yrc',
        // content 存原始 YRC 文本：解析器能再次还原逐字，存库后不必联网
        content: yrc.raw,
        plainText: yrc.lines.map((l) => l.text).join('\n'),
        lines: yrc.lines,
        wordLevel: true,
        charCount: yrc.charCount,
        translation: lrc ? lrc.translation : null,
      });
    }
  }

  // 第二轮：都没有逐字，退而求其次拿行级 LRC
  for (const { cand, score } of ranked) {
    const got = await fetchLyricsLrc(cand.id);
    if (got) {
      return pick(cand, score, {
        format: 'lrc',
        content: got.lrc,
        plainText: got.lrc,
        lines: [],
        wordLevel: false,
        translation: got.translation || null,
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------- YRC（逐字）
/**
 * 网易云 YRC：逐字歌词。格式和 QQ 的 QRC 相似但**方向相反**：
 *
 *   QRC:  [0,2250]晴(0,160)天(160,160)      ← 文字在时间戳**前面**
 *   YRC:  [7490,2490](7490,210,0)I (7700,240,0)know   ← 文字在时间戳**后面**
 *
 * 另外时间戳是**三段式** (start, dur, 未知)，每行的头是 [start, dur]。
 * 开头几行常常是 JSON 形式的署名（{"t":0,"c":[{"tx":"作词: "},...]}），要过滤掉。
 */
const YRC_TIMESTAMP = /\((\d+),(\d+)(?:,-?\d+)?\)/g;

function parseYrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // JSON 行：通常是署名/元信息
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        const joined = (obj.c || []).map((seg) => (seg && seg.tx) || '').join('').trim();
        if (!joined || isCreditLine(joined)) continue;
        // 有正文但没逐字信息：按行级保留
        lines.push({ startMs: Number(obj.t) || 0, endMs: null, text: joined, chars: [] });
      } catch { /* 解析不了就跳过 */ }
      continue;
    }

    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    const startMs = Number(head[1]);
    const rest = line.slice(head[0].length);
    const tokens = [...rest.matchAll(YRC_TIMESTAMP)];
    if (!tokens.length) continue;

    const chars = [];
    let plain = '';
    let lastEnd = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      const from = t.index + t[0].length;
      const to = i + 1 < tokens.length ? tokens[i + 1].index : rest.length;
      const ch = rest.slice(from, to);
      const s = Number(t[1]);
      const d = Number(t[2]);
      if (!ch) continue;
      chars.push({ text: ch, startMs: s, endMs: s + d });
      plain += ch;
      lastEnd = Math.max(lastEnd, s + d);
    }
    const body = plain.trim();
    if (!body || isCreditLine(body)) continue;
    lines.push({
      startMs,
      endMs: lastEnd || startMs + Number(head[2]),
      text: plain,
      chars,
    });
  }
  return lines;
}

// eapi 请求签名：AES-128-ECB + MD5 摘要。参考 ESLyric-LyricsSource 的做法，
// 只用 Node 自带的 crypto，不引第三方依赖。
const EAPI_KEY = 'e82ckenh8dichen8';
// 匿名 token：YRC 只对这个 token 开放。上游项目里是写死的，可能随网易云更新失效。
const ANON_TOKEN = 'bf8bfeabb1aa84f9c8c3906c04a04fb864322804c83f5d607e91a04eae463c9436bd1a17ec353cf780b396507a3f7464e8a60f4bbc019437993166e004087dd32d1490298caf655c2353e58daa0bc13cc7d5c198250968580b12c1b8817e3f5c807e650dd04abd3fb8130b7ae43fcc5b';

function eapiEncrypt(url, payload) {
  const text = JSON.stringify(payload);
  const digest = crypto.createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex');
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(data, 'utf8')), cipher.final()]).toString('hex').toUpperCase();
}

/** 用 eapi 拉 YRC（逐字）。失败返回 null，调用方回退到行级 LRC。 */
async function fetchYrc(songId) {
  const apiPath = '/api/song/lyric/v1';
  let params;
  try {
    params = eapiEncrypt(apiPath, { id: Number(songId), cp: false, lv: 0, kv: 0, tv: 0, rv: 0, yv: 0, ytv: 0, yrv: 0 });
  } catch { return null; }

  const body = await rateLimited(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch('https://interface3.music.163.com/eapi/song/lyric/v1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Referer: BASE,
          Cookie: `MUSIC_A=${ANON_TOKEN}; os=pc; appver=8.9.70; channel=netease`,
        },
        body: `params=${params}`,
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  if (!body || body.code !== 200) return null;
  const yrc = (body.yrc && body.yrc.lyric) || '';
  if (!yrc.trim()) return null;
  const lines = parseYrc(yrc);
  if (!lines.length) return null;
  return {
    lines,
    raw: yrc,
    charCount: lines.reduce((n, l) => n + (l.chars || []).length, 0),
  };
}

module.exports = { searchSongs, findBestMatch, fetchLyricsLrc, fetchLyrics, fetchYrc, parseYrc };

// ---------------------------------------------------------------- CLI
// 给 Python 流水线用（fetch_lyrics.py 通过 node 调这里）：
//   node lib/netease-lyrics.js --title "晴天" --artist "周杰伦" --duration 269
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const title = arg('title');
  const artistArg = arg('artist');
  const duration = Number(arg('duration')) || null;
  if (!title) {
    console.log(JSON.stringify({ ok: false, reason: 'usage: --title <name> [--artist <a>] [--duration <s>]' }));
    process.exit(0);
  }
  (async () => {
    const artists = artistArg ? artistArg.split(/[,，;；/]/).map((s) => s.trim()).filter(Boolean) : [];
    let r = null;
    try { r = await fetchLyrics(title, artists, duration); } catch { r = null; }
    if (!r) {
      console.log(JSON.stringify({ ok: false, reason: 'no-match' }));
      process.exit(0);
    }
    console.log(JSON.stringify({
      ok: true,
      provider: r.provider,
      format: r.format,
      synced: Boolean(r.synced),
      lineCount: String(r.content || '').split(/\r?\n/).filter((l) => l.trim()).length,
      // 兼容旧调用方：lrc 字段一直是「原始 content」，YRC 时也是 YRC 文本
      lrc: r.content || '',
      content: r.content || '',
      plainText: r.plainText || '',
      translation: r.translation || null,
      match: r.match || null,
    }));
  })();
}
