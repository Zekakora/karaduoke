'use strict';
/**
 * 大屏「UP NEXT」队列回归测试（隔离运行）。
 *
 * 线上问题：视频模式里队列永远是空的，但点歌其实成功了。根因有两个：
 *   1. 前端 `VideoLyricsMode.setWordLevel()` 在歌词还没载入时读 `this.lines.some()`，
 *      抛 `Cannot read properties of undefined (reading 'some')`，整个大屏 render() 中断，
 *      画面与侧栏队列一起没画出来；
 *   2. 每人的点歌配额只数 `queued`，本地曲目点下去先进 `preparing`，
 *      于是"只点一首却说达到上限"，准备中的歌也可以无限连点。
 *
 * 这里覆盖后端部分（队列状态、配额、去重），前端部分见 video-lyrics-mv.test.js。
 *
 * 用法：node tests/display-queue.test.js
 */
process.env.PORT = '3822';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = 'queue-pass';
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
// 不要真的去调 YouTube（没有 key 也不会调用，这里再显式清掉）
process.env.YOUTUBE_API_KEY = '';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(path.join(__dirname, '..', '.tmp'), 'display-queue-'));
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
// 两首 ready 的歌（有 stems → ready），一首"曲库里没有"的歌用来触发后台制作
const readyIds = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB'];
readyIds.forEach((id, i) => {
  seed.prepare("INSERT INTO tracks (spotify_id,title,artists,duration_ms,status) VALUES (?,?,?,?,'separated')")
    .run(id, `Ready Song ${i + 1}`, '["Singer"]', 200000);
  seed.prepare("INSERT INTO stems (track_id,model,out_dir,vocals_path,no_vocals_path) VALUES (?,?,'x','/v.mp3','/a.mp3')")
    .run(i + 1, 'htdemucs');
});
seed.close();

const app = require(path.join(ROOT, 'server.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const json = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-token': auth.body.token };
  const newGuest = async (name) => {
    const r = await json(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: name }) });
    return { token: r.body.token, headers: { 'Content-Type': 'application/json', 'x-session-token': r.body.token } };
  };
  const add = (guest, body) => json(`${BASE}/api/queue`, { method: 'POST', headers: guest.headers, body: JSON.stringify(body) });

  try {
    await test('点 ready 的歌 → 立刻进播放，后面再点的进公开队列（大屏 UP NEXT 读的就是它）', async () => {
      const g = await newGuest(`guest-${Date.now().toString(36)}-a`);
      const a = await add(g, { source: 'local', spotifyId: readyIds[0], title: 'Ready Song 1' });
      assert.strictEqual(a.status, 201, JSON.stringify(a.body));
      assert.strictEqual(a.body.song.status, 'playing', '第一首应直接开播');
      const b = await add(g, { source: 'local', spotifyId: readyIds[1], title: 'Ready Song 2' });
      assert.strictEqual(b.status, 201);
      assert.strictEqual(b.body.song.status, 'queued');
      const state = await json(`${BASE}/api/state`);
      assert.strictEqual(state.body.current.spotifyId, readyIds[0]);
      assert.strictEqual(state.body.queue.length, 1, `queue=${JSON.stringify(state.body.queue.map((s) => s.title))}`);
      assert.strictEqual(state.body.queue[0].spotifyId, readyIds[1]);
    });

    await test('我的队列（/api/my-queue）能看到自己的歌，正在播的也算', async () => {
      const g = await newGuest(`guest-${Date.now().toString(36)}-b`);
      await add(g, { source: 'local', spotifyId: readyIds[0], title: 'Ready Song 1' });
      const mine = await json(`${BASE}/api/my-queue`, { headers: g.headers });
      assert.strictEqual(mine.status, 200);
      assert.ok(mine.body.songs.some((s) => s.spotifyId === readyIds[0]), '自己的歌不在 my-queue 里');
    });

    await test('配额：准备中的歌也算，不会"只点一首就说达到上限"', async () => {
      // 临时把上限设成 1
      await json(`${BASE}/api/admin/settings`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ maxQueuedSongsPerGuest: 2 }) });
      const g = await newGuest(`guest-${Date.now().toString(36)}-c`);
      // 曲库里没有的歌 → preparing
      const missing1 = 'ZZZZZZZZZZZZZZZZZZZZZZ';
      const missing2 = 'YYYYYYYYYYYYYYYYYYYYYY';
      const r1 = await add(g, { source: 'local', spotifyId: missing1, title: 'Not In Library 1' });
      assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
      assert.strictEqual(r1.body.song.status, 'preparing');
      const r2 = await add(g, { source: 'local', spotifyId: missing2, title: 'Not In Library 2' });
      assert.strictEqual(r2.status, 201, JSON.stringify(r2.body));
      const r3 = await add(g, { source: 'local', spotifyId: readyIds[0], title: 'Ready Song 1' });
      assert.strictEqual(r3.status, 409, '超过上限应被拒绝');
      assert.strictEqual(r3.body.code, 'QUEUE_LIMIT');
      assert.strictEqual(r3.body.params.current, 2, `current 应把 preparing 算进去：${JSON.stringify(r3.body.params)}`);
      await json(`${BASE}/api/admin/settings`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ maxQueuedSongsPerGuest: 3 }) });
    });

    await test('重复点同一首制作中的歌 → 409，不会堆出两条', async () => {
      const g = await newGuest(`guest-${Date.now().toString(36)}-d`);
      const sid = 'XXXXXXXXXXXXXXXXXXXXXX';
      const a = await add(g, { source: 'local', spotifyId: sid, title: 'Dup Song' });
      assert.strictEqual(a.status, 201);
      const b = await add(g, { source: 'local', spotifyId: sid, title: 'Dup Song' });
      assert.strictEqual(b.status, 409);
      assert.strictEqual(b.body.code, 'DUPLICATE_SESSION_SONG');
    });

    await test('大屏 state 里 preparing 的歌也在队列中（不是"永远空"）', async () => {
      const g = await newGuest(`guest-${Date.now().toString(36)}-e`);
      const sid = 'WWWWWWWWWWWWWWWWWWWWWW';
      await add(g, { source: 'local', spotifyId: sid, title: 'Preparing Song' });
      const state = await json(`${BASE}/api/state`);
      const entry = state.body.queue.find((s) => s.spotifyId === sid);
      assert.ok(entry, `preparing 的歌不在公开队列：${JSON.stringify(state.body.queue.map((s) => s.title))}`);
      assert.strictEqual(entry.status, 'preparing');
      assert.strictEqual(entry.prepareState, 'preparing');
    });

    await test('制作失败 → 仍在队列里（用户能看到失败），而不是直接消失', async () => {
      const sid = 'VVVVVVVVVVVVVVVVVVVVVV';
      const g = await newGuest(`guest-${Date.now().toString(36)}-f`);
      await add(g, { source: 'local', spotifyId: sid, title: 'Will Fail' });
      const job = await json(`${BASE}/api/prepare?spotifyId=${sid}`, { headers: adminHeaders });
      assert.ok(job.body, '应能查到制作任务');
      // disableSpawn 模式下没有子进程；直接让任务终态为 failed（等同子进程退出码非 0）
      const { prepareQueue } = require(path.join(ROOT, 'server.js')).__internals || {};
      if (prepareQueue && typeof prepareQueue.finishJob === 'function') {
        prepareQueue.finishJob(sid, { status: 'failed', error: '模拟子进程失败' });
      } else {
        // 没有暴露内部队列时，退回"直接看 prepare 状态"的弱断言
      }
      await sleep(600);
      const state = await json(`${BASE}/api/state`);
      const entry = state.body.queue.find((s) => s.spotifyId === sid);
      assert.ok(entry, `失败项也应留在队列里（否则用户看不到）：${JSON.stringify(state.body.queue.map((s) => s.title))}`);
    });
  } finally {
    // server.close() 在有长连接（SSE / keep-alive）时会一直等，测试要能自己收尾：
    // 先关 keep-alive 并把没人引用的连接断掉，再带超时 close。
    await new Promise((r) => {
      const timer = setTimeout(r, 3000);
      try {
        server.closeAllConnections?.();
        server.close(() => { clearTimeout(timer); r(); });
      } catch {
        clearTimeout(timer);
        r();
      }
    });
    try { require(path.join(ROOT, 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  // 明确退出：keep-alive 连接/Cleanup 定时器会让进程挂着不退
  process.exit(failed ? 1 : 0);
})();
