'use strict';
// QQ 音乐歌词全链路探测：搜索(ct=6) → GetPlayLyricInfo → base64 解码 → 判断是行级 LRC 还是 QRC 逐字
(async () => {
  const H = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://y.qq.com/',
    'Content-Type': 'application/json',
  };
  const call = async (body) => {
    const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', headers: H, body: JSON.stringify(body),
    });
    return r.json();
  };

  // 1) 搜索：comm.ct=6（网页版身份），ct=24 会被过滤成 0 结果
  const s = await call({
    comm: { ct: 6, cv: 0 },
    req_1: {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: { query: '晴天 周杰伦', num_per_page: 3, page_num: 1, search_type: 0 },
    },
  });
  const songs = (s.req_1?.data?.body?.song?.list) || [];
  console.log('搜索: 周杰伦 晴天 =>', songs.length, '首');
  songs.forEach((x) => console.log('  ', x.mid, x.id, x.name, '|', (x.singer || []).map((v) => v.name).join('/'), '| dur', x.interval));
  if (!songs.length) return;
  const song = songs[0];

  // 2) 歌词
  const l = await call({
    comm: { ct: 6, cv: 0 },
    req_1: {
      method: 'GetPlayLyricInfo',
      module: 'music.musichallSong.PlayLyricInfo',
      param: { songMid: song.mid, songID: song.id, qrc: 1, trans: 1, roma: 1 },
    },
  });
  const d = l.req_1?.data;
  if (!d) { console.log('lyric RAW:', JSON.stringify(l).slice(0, 600)); return; }
  console.log('\n歌词字段:');
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (typeof v === 'string' && v.length > 0) console.log(`  ${k}: len=${v.length}`);
    else if (v !== null && v !== undefined && typeof v !== 'object') console.log(`  ${k}:`, v);
  }
  // 常见: lyric(行级LRC b64), qrc(逐字 b64), trans(翻译), roma(罗马音)
  const dump = (label, b64) => {
    if (!b64) return;
    try {
      const dec = Buffer.from(b64, 'base64').toString('utf8');
      console.log(`\n[${label} 解码后前 500 字]`);
      console.log(dec.slice(0, 500));
      return dec;
    } catch (e) {
      console.log(`[${label}] 解码失败: ${e.message}`);
    }
  };
  dump('lyric(行级)', d.lyric);
  dump('qrc(逐字)', d.qrc || d.qrc_t || d.lyric_t);
  dump('trans(翻译)', d.trans);
})();
