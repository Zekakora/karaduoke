'use strict';
/**
 * 大屏「MV 一直显示正在加载」+「逐字切换无效果」回归测试（隔离运行）。
 *
 * 两个线上 bug：
 *   1. `publicSong()` 只读队列项上的 `song.visualVideoId`，而老歌（先 ready、后补 MV）
 *      队列项上永远是 null → 大屏拿到 null，卡在「正在加载官方 MV…」。
 *      修法：以曲库为准（`resolveQueueVisualId`），并缓存到队列项上。
 *   2. `_paint()` 只在"行号变化"时重写 HTML，切换逐字/逐行时行号没变 → 画面不变。
 *      修法：`_forceRepaint` 强制重绘（见 video-lyrics-mv.test.js 的前端断言）。
 *
 * 用法：node tests/display-visual-queue.test.js
 */
process.env.PORT = '3823';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = 'vis-pass';
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.YOUTUBE_API_KEY = '';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(path.join(__dirname, '..', '.tmp'), 'visual-queue-'));
const DATA = path.join(TMP, 'data');
const DB = path.join(TMP, 'library.db');
Object.assign(process.env, {
  KARAOKE_DATA_DIR: DATA,
  LIBRARY_DB: DB,
  MEDIA_ROOT: path.join(TMP, 'assets'),
  LYRICS_OVERRIDES: path.join(TMP, 'lyrics-overrides.json'),
});

const ROOT = path.join(__dirname, '..');
const { DatabaseSync } = require('node:sqlite');
fs.mkdirSync(DATA, { recursive: true });
const seed = new DatabaseSync(DB);
seed.exec(fs.readFileSync(path.join(ROOT, 'python', 'schema.sql'), 'utf8'));
const WITH_MV = 'AAAAAAAAAAAAAAAAAAAAAA';
const WITH_MV_MANUAL = 'BBBBBBBBBBBBBBBBBBBBBB';
const NO_MV = 'CCCCCCCCCCCCCCCCCCCCCC';
const BAD_STATUS = 'DDDDDDDDDDDDDDDDDDDDDD';
const rows = [
  [WITH_MV, 'Has Auto MV', 'dQw4w9WgXcQ', 'auto_matched'],
  [WITH_MV_MANUAL, 'Has Manual MV', 'kJQP7kiw5Fk', 'manually_confirmed'],
  [NO_MV, 'No MV Yet', null, 'pending'],
  [BAD_STATUS, 'Unavailable MV', null, 'unavailable'],
];
rows.forEach(([sid, title, vid, status], index) => {
  seed.prepare("INSERT INTO tracks (spotify_id,title,artists,duration_ms,status,visual_video_id,visual_match_status) VALUES (?,?,?,?,'separated',?,?)")
    .run(sid, title, '["Singer"]', 200000, vid, status);
  seed.prepare("INSERT INTO stems (track_id,model,out_dir,vocals_path,no_vocals_path) VALUES (?,?,'x','/v.mp3','/a.mp3')")
    .run(index + 1, 'htdemucs');
});
seed.close();

const app = require(path.join(ROOT, 'server.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const json = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${error.message}`); }
}

(async () => {
  const server = app.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const auth = await json(`${BASE}/api/admin/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.DJ_PASSWORD }) });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body.token };
  const newGuest = async (name) => {
    const r = await json(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
    return { 'Content-Type': 'application/json', 'x-session-token': r.body.token };
  };

  try {
    await test('队列项的 visualVideoId 来自曲库（老歌补的 MV 也能用）', async () => {
      const g = await newGuest('g1-' + Date.now().toString(36));
      await json(`${BASE}/api/queue`, { method: 'POST', headers: g, body: JSON.stringify({ source: 'local', spotifyId: WITH_MV, title: 'Has Auto MV' }) });
      const st = await json(`${BASE}/api/state`);
      assert.strictEqual(st.body.current.spotifyId, WITH_MV);
      assert.strictEqual(st.body.current.visualVideoId, 'dQw4w9WgXcQ', '大屏拿不到 visualVideoId → 会一直"正在加载 MV"');
    });

    await test('manually_confirmed 的 MV 同样会带下去', async () => {
      const g = await newGuest('g2-' + Date.now().toString(36));
      await json(`${BASE}/api/queue`, { method: 'POST', headers: g, body: JSON.stringify({ source: 'local', spotifyId: WITH_MV_MANUAL, title: 'Has Manual MV' }) });
      const st = await json(`${BASE}/api/state`);
      const entry = [st.body.current, ...st.body.queue].filter(Boolean).find((s) => s.spotifyId === WITH_MV_MANUAL);
      assert.ok(entry, '找不到刚点的歌');
      assert.strictEqual(entry.visualVideoId, 'kJQP7kiw5Fk');
    });

    await test('没有 MV / 状态 unavailable → null（前端回退模糊封面）', async () => {
      const g = await newGuest('g3-' + Date.now().toString(36));
      await json(`${BASE}/api/queue`, { method: 'POST', headers: g, body: JSON.stringify({ source: 'local', spotifyId: NO_MV, title: 'No MV Yet' }) });
      const st = await json(`${BASE}/api/state`);
      const entry = [st.body.current, ...st.body.queue].filter(Boolean).find((s) => s.spotifyId === NO_MV);
      assert.ok(entry, '找不到刚点的歌');
      assert.strictEqual(entry.visualVideoId, null);
    });

    await test('管理员改 MV 后，正在队列/正在播的歌立即用新 MV', async () => {
      // 先让 NO_MV 这首歌在队列里（上面已加过）
      const r = await json(`${BASE}/api/library/admin/tracks/${NO_MV}/mv`, {
        method: 'POST', headers: H, body: JSON.stringify({ action: 'confirm', videoId: 'fJ9rUzIMcZQ' }),
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const st = await json(`${BASE}/api/state`);
      const entry = [st.body.current, ...st.body.queue].filter(Boolean).find((s) => s.spotifyId === NO_MV);
      assert.strictEqual(entry && entry.visualVideoId, 'fJ9rUzIMcZQ', '改完 MV 后队列项没有跟着更新');
    });

    await test('管理员清除 MV → 队列项立刻变回 null', async () => {
      const r = await json(`${BASE}/api/library/admin/tracks/${NO_MV}/mv`, {
        method: 'POST', headers: H, body: JSON.stringify({ action: 'clear' }),
      });
      assert.strictEqual(r.status, 200);
      const st = await json(`${BASE}/api/state`);
      const entry = [st.body.current, ...st.body.queue].filter(Boolean).find((s) => s.spotifyId === NO_MV);
      assert.strictEqual(entry && entry.visualVideoId, null);
    });

    await test('display 详情接口也带 visual（挂载时若先拿到详情也能用）', async () => {
      const r = await json(`${BASE}/api/library/tracks/${WITH_MV}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.visual.visualVideoId, 'dQw4w9WgXcQ');
      assert.strictEqual(r.body.visualVideoId, 'dQw4w9WgXcQ');
    });
  } finally {
    await new Promise((r) => { try { server.closeAllConnections?.(); } catch { /* ignore */ } server.close(r); });
    try { require(path.join(ROOT, 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
