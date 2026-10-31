'use strict';
/**
 * 曲库删除回归测试（隔离运行，不动现场 data/assets）。
 *
 * 之前前端调用 DELETE /api/library/admin/tracks/:id，但服务端没有这个路由，
 * 所以删除时提示「接口不存在」。这里验证：
 *   - 路由存在且需要 DJ 权限；
 *   - 删掉 tracks/stems/lyrics/jobs 记录；
 *   - 删掉成品目录、封面、歌词、原始 WAV；
 *   - 不存在的 id 返回 TRACK_NOT_FOUND。
 *
 * 用法：node tests/library-delete.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-lib-delete-'));
const DATA_DIR = path.join(TMP, 'data');
const MEDIA_ROOT = path.join(TMP, 'assets');
const DB_PATH = path.join(TMP, 'library.db');
const SPOTIFY_ID = 'DDDDDDDDDDDDDDDDDDDDDD';
const UNKNOWN_ID = 'EEEEEEEEEEEEEEEEEEEEEE';

process.env.PORT = '3819';
process.env.HOST = '127.0.0.1';
process.env.KARAOKE_DATA_DIR = DATA_DIR;
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.LIBRARY_DB = DB_PATH;
process.env.MEDIA_ROOT = MEDIA_ROOT;
process.env.LYRICS_OVERRIDES = path.join(TMP, 'lyrics-overrides.json');
process.env.DJ_PASSWORD = 'test-dj-password';

const files = {
  audio: path.join(DATA_DIR, 'library', 'source.wav'),
  cover: path.join(MEDIA_ROOT, 'covers', `${SPOTIFY_ID}.jpg`),
  lyrics: path.join(MEDIA_ROOT, 'lyrics', `${SPOTIFY_ID}.lrc`),
  outputDir: path.join(MEDIA_ROOT, 'output', 'library', SPOTIFY_ID),
};

function createFixtures() {
  for (const dir of [path.join(DATA_DIR, 'library'), path.dirname(files.cover), path.dirname(files.lyrics), files.outputDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spotify_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artists TEXT NOT NULL,
      album TEXT, album_art TEXT, album_art_path TEXT,
      release_date TEXT, popularity INTEGER, match_score REAL,
      status TEXT, source_video_id TEXT, duration_ms INTEGER,
      audio_path TEXT, updated_at TEXT
    );
    CREATE TABLE stems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      vocals_path TEXT, no_vocals_path TEXT,
      UNIQUE(track_id, model)
    );
    CREATE TABLE lyrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      format TEXT, content TEXT, plain TEXT, fetched_at TEXT
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER, kind TEXT, status TEXT, message TEXT, duration_ms INTEGER, at TEXT
    );
  `);
  db.prepare('INSERT INTO tracks (spotify_id, title, artists, status, duration_ms, audio_path, album_art_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(SPOTIFY_ID, 'Delete Me', '["Test Artist"]', 'separated', 180000, files.audio, files.cover);
  const track = db.prepare('SELECT id FROM tracks WHERE spotify_id = ?').get(SPOTIFY_ID);
  db.prepare('INSERT INTO stems (track_id, model, vocals_path, no_vocals_path) VALUES (?, ?, ?, ?)')
    .run(track.id, 'htdemucs', path.join(files.outputDir, 'vocals.mp3'), path.join(files.outputDir, 'accompaniment.mp3'));
  db.prepare('INSERT INTO lyrics (track_id, provider, synced, format, content) VALUES (?, ?, ?, ?, ?)')
    .run(track.id, 'netease', 1, 'yrc', '[0,1000](0,500,0)Hi');
  db.prepare('INSERT INTO jobs (track_id, kind, status) VALUES (?, ?, ?)').run(track.id, 'separate', 'ok');
  db.close();

  fs.writeFileSync(files.audio, 'wav');
  fs.writeFileSync(files.cover, 'jpg');
  fs.writeFileSync(files.lyrics, '[00:01.00]Hi');
  for (const name of ['accompaniment.mp3', 'vocals.mp3', 'guide.mp3', 'original.mp3', 'video.mp4']) {
    fs.writeFileSync(path.join(files.outputDir, name), 'media');
  }
}

createFixtures();

const app = require(path.join(__dirname, '..', 'server.js'));
const BASE = 'http://127.0.0.1:3819';
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
  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };

  try {
    await test('未授权不能删曲库', async () => {
      const r = await json(`${BASE}/api/library/admin/tracks/${SPOTIFY_ID}`, { method: 'DELETE' });
      assert.strictEqual(r.status, 401);
    });

    await test('不存在的歌曲返回 TRACK_NOT_FOUND', async () => {
      const r = await json(`${BASE}/api/library/admin/tracks/${UNKNOWN_ID}`, { method: 'DELETE', headers: H });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(r.body.code, 'TRACK_NOT_FOUND');
    });

    await test('删除歌曲：DB 四张表清掉，媒体文件也删掉', async () => {
      const beforeDb = new DatabaseSync(DB_PATH, { readOnly: true });
      const trackId = beforeDb.prepare('SELECT id FROM tracks WHERE spotify_id = ?').get(SPOTIFY_ID).id;
      beforeDb.close();

      const r = await json(`${BASE}/api/library/admin/tracks/${SPOTIFY_ID}`, { method: 'DELETE', headers: H });
      assert.strictEqual(r.status, 200, `删除失败：${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.ok, true);

      const db = new DatabaseSync(DB_PATH, { readOnly: true });
      for (const table of ['stems', 'lyrics', 'jobs']) {
        const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE track_id = ?`).get(trackId);
        assert.strictEqual(count.n, 0, `${table} 还有残留`);
      }
      assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE spotify_id = ?').get(SPOTIFY_ID).n, 0);
      db.close();

      for (const file of [files.audio, files.cover, files.lyrics, files.outputDir]) {
        assert.strictEqual(fs.existsSync(file), false, `文件仍在：${file}`);
      }
    });
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => server.close(r));
    try { require(path.join(__dirname, '..', 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
})();
