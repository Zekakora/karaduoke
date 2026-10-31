'use strict';
/**
 * 模式 B 队列顺序回归测试（隔离运行，不动现场 data）。
 *
 * 复现的问题：
 *   1. 第一首歌还在后台 preparing 时，再点一首曲库里已 ready 的歌，
 *      新歌会立刻开播，把正在准备的歌挤掉（插队）。
 *   2. 正在播的歌切掉后，队首还在 preparing，后面的 ready 歌会越过它开播。
 *
 * 期望：preparing 的歌按入队顺序占位，后面的歌必须等它，不能插队。
 *
 * 用法：node tests/queue-order.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-order-'));
process.env.PORT = process.env.PORT || '3814';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = process.env.DJ_PASSWORD || 'test-dj-password';
// 关键：状态、制作任务、曲库全部指向临时目录，绝不碰 karaoke_spo/data
process.env.KARAOKE_DATA_DIR = TMP;
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.LIBRARY_DB = path.join(TMP, 'library.db');

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const queueOrder = require(path.join(__dirname, '..', 'lib', 'queue-order.js'));

// ---- 临时曲库：两首 ready 的本地歌（真正点歌时 needsPrepare=false）----
const READY_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const READY_B = 'CCCCCCCCCCCCCCCCCCCCCC';
const NOT_READY = 'BBBBBBBBBBBBBBBBBBBBBB';

function createTempLibrary() {
  const db = new DatabaseSync(process.env.LIBRARY_DB);
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spotify_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artists TEXT NOT NULL,
      album TEXT,
      album_art TEXT,
      album_art_path TEXT,
      release_date TEXT,
      popularity INTEGER,
      match_score REAL,
      status TEXT,
      source_video_id TEXT,
      duration_ms INTEGER
    );
    CREATE TABLE stems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      vocals_path TEXT,
      no_vocals_path TEXT,
      UNIQUE(track_id, model)
    );
  `);
  const insertTrack = db.prepare('INSERT INTO tracks (spotify_id, title, artists, status, duration_ms) VALUES (?, ?, ?, ?, ?)');
  const insertStems = db.prepare('INSERT INTO stems (track_id, model, vocals_path, no_vocals_path) VALUES (?, ?, ?, ?)');
  for (const [spotifyId, title] of [[READY_A, 'Ready Song A'], [READY_B, 'Ready Song C']]) {
    insertTrack.run(spotifyId, title, '["Test Artist"]', 'separated', 180000);
    const row = db.prepare('SELECT id FROM tracks WHERE spotify_id = ?').get(spotifyId);
    insertStems.run(row.id, 'htdemucs', '/tmp/vocals.mp3', '/tmp/accompaniment.mp3');
  }
  db.close();
}

const app = require(path.join(__dirname, '..', 'server.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
}

const json = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  createTempLibrary();
  const server = app.start();
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };

  let session = null;
  const newGuest = async (name) => {
    const r = await json(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }),
    });
    assert.strictEqual(r.status, 201, `建立会话失败：${JSON.stringify(r.body)}`);
    session = r.body.token;
    return { 'Content-Type': 'application/json', 'x-session-token': session };
  };
  const reset = async () => {
    const r = await json(`${BASE}/api/admin/new-session`, { method: 'POST', headers: H });
    assert.strictEqual(r.status, 200, `重置现场失败：${JSON.stringify(r.body)}`);
  };
  const add = (headers, payload) => json(`${BASE}/api/queue`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const state = () => json(`${BASE}/api/state`).then((r) => r.body);

  try {
    await test('纯逻辑：preparing 挡住后面的 queued；prepare_failed 不挡路', async () => {
      const songs = [
        { id: 'prep', status: 'preparing', isPinned: false, queuePosition: 0, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'ready', status: 'queued', isPinned: false, queuePosition: 1, createdAt: '2026-01-01T00:00:01Z' },
      ];
      let picked = queueOrder.chooseNextSong(songs);
      assert.strictEqual(picked.next, null);
      assert.strictEqual(picked.blockedBy.id, 'prep');

      const withFailed = [
        { id: 'failed', status: 'prepare_failed', isPinned: false, queuePosition: 0, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'ready', status: 'queued', isPinned: false, queuePosition: 1, createdAt: '2026-01-01T00:00:01Z' },
      ];
      picked = queueOrder.chooseNextSong(withFailed);
      assert.strictEqual(picked.next.id, 'ready');
    });

    await test('纯逻辑：位置归一包含 preparing，后加的歌不会排到它前面', async () => {
      const songs = [
        { id: 'old-history', status: 'skipped', isPinned: false, queuePosition: 0, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'prep', status: 'preparing', isPinned: false, queuePosition: 9, createdAt: '2026-01-01T00:01:00Z' },
      ];
      const nextPos = queueOrder.nextQueuePosition(songs);
      songs.push({ id: 'new', status: 'queued', isPinned: false, queuePosition: nextPos, createdAt: '2026-01-01T00:02:00Z' });
      queueOrder.normalizePositions(songs);
      assert.deepStrictEqual(
        queueOrder.activeSongs(songs).map((song) => song.id),
        ['prep', 'new'],
      );
    });

    await test('正在准备的歌占住队首：后点的 ready 歌不会被直接播放', async () => {
      await reset();
      const SH = await newGuest('prep-first');

      const a = await add(SH, { source: 'local', spotifyId: NOT_READY, title: 'Preparing Song' });
      assert.strictEqual(a.status, 201, `点歌失败：${JSON.stringify(a.body)}`);
      assert.strictEqual(a.body.song.status, 'preparing');
      const before = await state();
      assert.strictEqual(before.current, null, '制作中的歌不应该被当成 current 播放');

      const b = await add(SH, { source: 'local', spotifyId: READY_A, title: 'Ready Song A' });
      assert.strictEqual(b.status, 201, `点歌失败：${JSON.stringify(b.body)}`);
      assert.strictEqual(b.body.song.status, 'queued');

      const after = await state();
      assert.strictEqual(after.current, null, '前面的歌还在准备，后点的 ready 歌不能插队开播');
      assert.strictEqual(after.playback.status, 'idle');
      assert.deepStrictEqual(after.queue.map((s) => s.title), ['Preparing Song', 'Ready Song A']);
      assert.strictEqual(after.queue[0].status, 'preparing');
      assert.strictEqual(after.queue[1].status, 'queued');
    });

    await test('正在播的歌切掉后，下一首还在准备 → 保持待机，后面的 ready 歌不越位', async () => {
      await reset();
      const SH = await newGuest('skip-blocked');

      // 第一首 ready，立刻开播
      const first = await add(SH, { source: 'local', spotifyId: READY_A, title: 'Ready Song A' });
      assert.strictEqual(first.status, 201);
      let s = await state();
      assert.strictEqual(s.current?.title, 'Ready Song A');

      // 下一首还在制作
      const preparing = await add(SH, { source: 'local', spotifyId: NOT_READY, title: 'Preparing Song' });
      assert.strictEqual(preparing.status, 201);
      assert.strictEqual(preparing.body.song.status, 'preparing');

      // 再点一首 ready，排在准备中的歌后面
      const third = await add(SH, { source: 'local', spotifyId: READY_B, title: 'Ready Song C' });
      assert.strictEqual(third.status, 201);

      // DJ 切歌：下一首还是 preparing，必须停住等它
      const skip = await json(`${BASE}/api/admin/playback`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'skip' }) });
      assert.strictEqual(skip.status, 200);

      s = await state();
      assert.strictEqual(s.current, null, '队首还在制作，不能直接播后面的 ready 歌');
      assert.strictEqual(s.playback.status, 'idle');
      assert.deepStrictEqual(s.queue.map((x) => x.title), ['Preparing Song', 'Ready Song C']);
      assert.strictEqual(s.queue[0].status, 'preparing');
    });

    await test('准备中也能切歌：跳过正在制作的队首，下一首接着播', async () => {
      await reset();
      const SH = await newGuest('skip-preparing');

      const prep = await add(SH, { source: 'local', spotifyId: NOT_READY, title: 'Preparing Song' });
      assert.strictEqual(prep.body.song.status, 'preparing');
      const ready = await add(SH, { source: 'local', spotifyId: READY_A, title: 'Ready Song A' });
      assert.strictEqual(ready.body.song.status, 'queued');

      let s = await state();
      assert.strictEqual(s.current, null);

      // 此时按切歌：应该跳过正在制作的队首，而不是毫无反应
      const skip = await json(`${BASE}/api/admin/playback`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'skip' }) });
      assert.strictEqual(skip.status, 200);

      s = await state();
      assert.strictEqual(s.current?.title, 'Ready Song A', '跳过制作中的歌后，后面的 ready 歌应该开播');
      assert.deepStrictEqual(s.queue, []);

      const admin = await json(`${BASE}/api/admin/state`, { headers: H });
      const skipped = admin.body.history.find((song) => song.title === 'Preparing Song' && song.status === 'skipped');
      assert.ok(skipped, '制作中的歌应被标记为 skipped');
    });

    await test('上移/下移支持准备中的歌：ready 移到前面会立刻开播', async () => {
      await reset();
      const SH = await newGuest('move-status');

      const prep = await add(SH, { source: 'local', spotifyId: NOT_READY, title: 'Preparing Song' });
      const ready = await add(SH, { source: 'local', spotifyId: READY_A, title: 'Ready Song A' });
      const second = await add(SH, { source: 'local', spotifyId: READY_B, title: 'Ready Song C' });
      assert.strictEqual(prep.body.song.status, 'preparing');
      assert.strictEqual(ready.body.song.status, 'queued');
      assert.strictEqual(second.body.song.status, 'queued');

      let s = await state();
      assert.strictEqual(s.current, null);
      assert.deepStrictEqual(s.queue.map((song) => song.title), ['Preparing Song', 'Ready Song A', 'Ready Song C']);

      // 把 ready 的歌移到准备中的歌前面：以前这里 404（还误报成服务端版本旧）
      const up = await json(`${BASE}/api/queue/order`, {
        method: 'PATCH', headers: SH,
        body: JSON.stringify({ firstId: ready.body.song.id, secondId: prep.body.song.id }),
      });
      assert.strictEqual(up.status, 200, `调序失败：${JSON.stringify(up.body)}`);

      s = await state();
      assert.strictEqual(s.current?.title, 'Ready Song A', '移到队首的 ready 歌应该立刻开播');
      assert.deepStrictEqual(s.queue.map((song) => song.title), ['Preparing Song', 'Ready Song C']);

      // 真正的旧服务端（或非法 id）仍然返回这个 code，客户端据此区分
      const bad = await json(`${BASE}/api/queue/order`, {
        method: 'PATCH', headers: SH,
        body: JSON.stringify({ firstId: 'song_missing', secondId: 'song_missing_2' }),
      });
      assert.strictEqual(bad.status, 404);
      assert.strictEqual(bad.body.code, 'SONG_NOT_QUEUED');
    });

    await test('ready 歌排在前面时正常开播，不被后面的 preparing 拖住', async () => {
      await reset();
      const SH = await newGuest('ready-first');

      const a = await add(SH, { source: 'local', spotifyId: READY_A, title: 'Ready Song A' });
      assert.strictEqual(a.status, 201);
      const prep = await add(SH, { source: 'local', spotifyId: NOT_READY, title: 'Preparing Song' });
      assert.strictEqual(prep.body.song.status, 'preparing');

      const s = await state();
      assert.strictEqual(s.current?.title, 'Ready Song A', '前面的 ready 歌应该立刻开播');
      assert.deepStrictEqual(s.queue.map((x) => x.title), ['Preparing Song']);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Windows 上 SQLite 句柄不关掉，临时目录删不干净
    try { require(path.join(__dirname, '..', 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
