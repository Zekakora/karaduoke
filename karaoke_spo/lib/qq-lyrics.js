'use strict';
// QQ 音乐歌词提供者：
//   搜索: musicu.fcg, comm.ct=6（网页身份；ct=24 桌面身份会被过滤成 0 结果）
//   歌词: GetPlayLyricInfo
//         qrc=0 → 行级 LRC 明文（base64）
//         qrc=1 + crypt=1 → 逐字 QRC（hex → 魔改 3DES → zlib → QRC XML）
// 逐字歌词已可用，见 lib/qrc-decrypt.js 与 parseQrc()。
// 命中率波动：搜索偶发返回空（风控），重试 3 次内基本能拿到。
// 用途：作为 lrclib 之外的中文歌词补充源。参数与全局串行队列共用。

const { decryptQrc } = require('./qrc-decrypt');

// QQ 对频次非常敏感。实测连续请求几次就会返回 code=2001（限流），
// 之后要等几分钟才恢复。所以间隔给足，并且命中限流时指数退避。
const MIN_INTERVAL_MS = 3500;
let queue = Promise.resolve();
let lastCall = 0;
let penaltyUntil = 0; // 命中 2001 后的冷却截止时间

function rateLimited(fn) {
  const run = async () => {
    const now = Date.now();
    // 冷却期内直接拒绝，避免把限流拖得更久
    const backoff = Math.max(0, penaltyUntil - now);
    const spacing = Math.max(0, MIN_INTERVAL_MS - (now - lastCall));
    const wait = Math.max(backoff, spacing);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** 命中 QQ 限流（code=2001）时调用，退避 N 秒内的后续请求 */
function noteRateLimited(seconds = 90) {
  penaltyUntil = Math.max(penaltyUntil, Date.now() + seconds * 1000);
}

function isRateLimitedResponse(body) {
  const code = body && body.req_1 && body.req_1.code;
  return code === 2001;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

async function call(body) {
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`musicu.fcg HTTP ${res.status}`);
  return res.json();
}

/**
 * 搜索歌曲。
 *
 * ⚠️ 2026-10 实测：musicu.fcg 的 DoSearchForQQMusicDesktop（还有 comm.ct=19 的变体）
 * 对未登录请求一律返回 code=2001，也就是被风控挡了 —— 之前"QQ 总是没结果、
 * 每次都落到网易云"就是这个原因。而**歌词接口 GetPlayLyricInfo 仍然正常**。
 *
 * 所以搜索改走经典接口 c.y.qq.com/soso/fcgi-bin/client_search_cp（无需登录），
 * 拿到 songmid/songid 后再用 musicu.fcg 取加密 QRC。
 *
 * 返回结构统一为 [{ mid, id, name, singers[], album, intervalS }]，interval 单位是**秒**。
 */
async function searchSongs(query, limit = 8) {
  const qs = new URLSearchParams({
    w: query,
    format: 'json',
    n: String(limit),
    p: '1',
    cr: '1',
    t: '0',
    aggr: '1',
    lossless: '0',
    flag_qc: '0',
  });
  const res = await rateLimited(() => fetch(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${qs}`, {
    headers: { Referer: 'https://y.qq.com/', 'User-Agent': HEADERS['User-Agent'] },
  }));
  if (!res.ok) throw new Error(`client_search_cp HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  return list.map((s) => ({
    mid: s.songmid || s.mid || '',
    id: Number(s.songid || s.id || 0) || 0,
    name: String(s.songname || s.name || '').trim(),
    singers: (s.singer || []).map((x) => x && x.name).filter(Boolean),
    album: String(s.albumname || (s.album && s.album.name) || '').trim(),
    // soso 的 interval 是秒；musicu 是毫秒，这里统一成秒
    intervalS: Number(s.interval || 0) || 0,
  })).filter((s) => s.mid && s.name);
}

/** 搜索并做时长匹配，返回最佳候选（或 null）。 */
async function findBestMatch(title, artists, durationS) {
  const query = [title, ...(artists || [])].filter(Boolean).join(' ').trim();
  if (!query) return null;
  let list = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      list = await searchSongs(query, 8);
      if (list.length) break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!list.length) return null;

  const cleanTitle = String(title || '').replace(/\s*\(.*\)\s*/g, '').trim();
  const scored = list.map((s) => {
    const nameHit = cleanTitle && (s.name === cleanTitle || s.name.includes(cleanTitle) || cleanTitle.includes(s.name));
    const durDiff = durationS && s.intervalS ? Math.abs(s.intervalS - durationS) : null;
    const artistHit = (s.singers || []).some((n) => (artists || []).some((a) => a && (n.includes(a) || a.includes(n))));
    let score = 0;
    if (s.name === cleanTitle) score += 55;
    else if (nameHit) score += 40;
    if (artistHit) score += 20;
    if (durDiff != null) score += durDiff <= 5 ? 30 : durDiff <= 15 ? 15 : -20;
    return { song: s, score, durDiff };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 40) return null;
  // 兼容旧字段名（下游用到 song.mid / song.id / song.name / song.interval）
  return { ...best.song, interval: best.song.intervalS };
}

/** 拉取行级 LRC（明文）。qrc=1 的逐字版是加密的，暂不使用。 */
async function fetchLyricsLrc(songMid, songId) {
  const body = {
    comm: { ct: 6, cv: 0 },
    req_1: {
      method: 'GetPlayLyricInfo',
      module: 'music.musichallSong.PlayLyricInfo',
      param: { songMid, songID: songId, qrc: 0, trans: 1, roma: 0 },
    },
  };
  const j = await rateLimited(() => call(body));
  const d = j?.req_1?.data;
  if (!d || !d.lyric) return null;
  const text = Buffer.from(d.lyric, 'base64').toString('utf8');
  let trans = null;
  if (d.trans) {
    try { trans = Buffer.from(d.trans, 'base64').toString('utf8'); } catch {}
  }
  return {
    provider: 'qqmusic',
    synced: text.includes('['),
    format: 'lrc',
    content: text,
    translation: trans,
  };
}

/**
 * 请求逐字 QRC。
 * 关键：必须带 `crypt: 1`。否则 qrc=1 会返回另一种（更长、非 8 字节倍数）的形态，
 * 用 QRC 密钥解不开。crypt:1 时 data.lyric 是 hex 编码的 3DES+zlib 密文。
 */
async function fetchQrcRaw(songMid, songId) {
  const body = {
    comm: {
      ct: 24, cv: 4747474, platform: 'yqq.json', chid: '0', g_tk: 5381,
      format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, need_new_code: 1,
    },
    req_1: {
      method: 'GetPlayLyricInfo',
      module: 'music.musichallSong.PlayLyricInfo',
      param: {
        crypt: 1, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 0, roma_t: 0,
        trans: 1, trans_t: 0, needSingingAnnotations: false, type: 1,
        songMid, songID: songId,
      },
    },
  };
  const j = await rateLimited(() => call(body));
  const d = j?.req_1?.data;
  if (!d || !d.lyric) return null;
  const qrcXml = decryptQrc(d.lyric);
  let trans = null;
  if (d.trans) {
    try {
      // 翻译字段同样是 hex+3DES+zlib；解不开就当没有
      trans = d.trans.includes('<') ? d.trans : decryptQrc(d.trans);
      if (trans && !trans.includes('[') && Buffer.from(d.trans, 'base64').toString('utf8').includes('[')) {
        trans = Buffer.from(d.trans, 'base64').toString('utf8');
      }
    } catch {
      try { trans = Buffer.from(d.trans, 'base64').toString('utf8'); } catch {}
    }
  }
  return { qrcXml, trans };
}

/**
 * 解析 QRC XML → { lines, plainText }。
 * 行格式：`[行始ms,行时长ms](字始ms,字时长ms,?)字(字始ms,字时长ms,?)字…`
 * 逐字的第三个字段（可选）是 QtRC 标记/音量，当前忽略。
 */
function parseQrc(xml) {
  // 统一走 lib/qrc-parse.js：那边修过「文字在时间戳之前」的错位问题，
  // 并且会过滤 QQ 塞进正文的制作信息行。这里保留同名导出供旧调用方使用。
  const { lines, plainText } = require('./qrc-parse.js').parseQrcXml(xml);
  return { lines, plainText };
}

/** 拉取逐字歌词（QRC）。失败返回 null，调用方可退回 fetchLyricsLrc。 */
async function fetchLyricsQrc(songMid, songId) {
  try {
    const raw = await fetchQrcRaw(songMid, songId);
    if (!raw) return null;
    const { lines, plainText } = parseQrc(raw.qrcXml);
    if (!lines.length) return null;
    return {
      provider: 'qqmusic',
      synced: true,
      format: 'qrc',
      content: raw.qrcXml,
      plainText,
      lines,
      translation: raw.trans,
      charCount: lines.reduce((n, l) => n + l.chars.length, 0),
    };
  } catch {
    return null;
  }
}

/** 一步到位：标题+歌手+时长 → QRC 逐字歌词（失败退回行级 LRC）。 */
async function fetchLyrics(title, artists, durationS) {
  const song = await findBestMatch(title, artists, durationS);
  if (!song) return null;
  const qrc = await fetchLyricsQrc(song.mid, song.id);
  const result = qrc || (await fetchLyricsLrc(song.mid, song.id));
  if (!result) return null;
  result.match = { songMid: song.mid, songId: song.id, songName: song.name, interval: song.interval };
  return result;
}

module.exports = {
  fetchLyrics, fetchLyricsLrc, fetchLyricsQrc, parseQrc, fetchQrcRaw,
  findBestMatch, searchSongs, rateLimited,
};

if (require.main === module) {
  // CLI：给 Python 流水线用（fetch_lyrics.py 通过 node 调这里）。
  //   node lib/qq-lyrics.js --title "晴天" --artist "周杰伦" --duration 269
  // 输出一行 JSON：{ ok, provider, format, lines, charCount, lrc, ... }
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const title = arg('title');
  const artistArg = arg('artist');
  const duration = Number(arg('duration')) || null;
  if (!title) {
    // 没有参数就跑自检（保持原有行为，方便手工排查）
    (async () => {
      const r = await fetchLyrics('晴天', ['周杰伦'], 269);
      if (!r) { console.log('no lyrics'); process.exit(2); }
      console.log('provider:', r.provider, '| format:', r.format, '| match:', JSON.stringify(r.match));
      if (r.format === 'qrc') {
        const timed = r.lines.filter((l) => l.chars.length >= 5).slice(10, 13);
        for (const l of timed) {
          console.log(`[${l.startMs}ms] ${l.text}`);
          console.log('   ' + l.chars.map((c) => `(${c.startMs},${c.endMs - c.startMs})${c.text}`).join(' '));
        }
        console.log(`字级时间戳总数: ${r.charCount}`);
      } else {
        console.log(String(r.content).slice(0, 400));
      }
    })();
    return;
  }
  (async () => {
    const artists = artistArg ? artistArg.split(/[,，;；/]/).map((s) => s.trim()).filter(Boolean) : [];
    let r = null;
    try { r = await fetchLyrics(title, artists, duration); } catch (e) { r = null; }
    if (!r) {
      console.log(JSON.stringify({ ok: false, reason: 'no-match' }));
      process.exit(0);
    }
    // 给 Python 存库用：有逐字就带上行数据，否则给明文 LRC
    console.log(JSON.stringify({
      ok: true,
      provider: r.provider,
      format: r.format,
      synced: Boolean(r.synced),
      charCount: r.charCount || 0,
      lineCount: (r.lines || []).length,
      lines: r.lines || [],
      // qrc 时 content 就是 QRC XML，存库后服务端可以直接解析（不用再联网）
      qrcXml: r.format === 'qrc' ? (r.content || '') : null,
      lrc: r.format === 'qrc' ? (r.plainText || '') : (r.content || ''),
      translation: r.translation || null,
      match: r.match || null,
    }));
  })();
}
