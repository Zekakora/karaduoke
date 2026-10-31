'use strict';
/**
 * 模式 B：库里有行级歌词时，歌词接口必须立刻返回，不能在请求里等 QQ 升级逐字。
 *
 * 回归的问题：
 *   新处理的歌大多是网易云/ lrclib 行级 LRC。大屏请求 wordLevel=1 时，
 *   旧实现会 await lookupLyrics() 去 QQ 升级；QQ 有 3.5s 串行间隔 + 重试，
 *   冷启动一次要 40s 左右，这期间大屏一行歌词都没有。
 *
 * 用法：node tests/lyrics-library.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-lyrics-'));
process.env.PORT = '3816';
process.env.HOST = '127.0.0.1';
process.env.KARAOKE_DATA_DIR = TMP;
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.LIBRARY_DB = path.join(TMP, 'library.db');
process.env.LYRICS_OVERRIDES = path.join(TMP, 'lyrics-overrides.json');
process.env.DJ_PASSWORD = 'test-dj-password';

const SPOTIFY_ID = 'ZZZZZZZZZZZZZZZZZZZZZZ';
// 模拟老数据：content 是 YRC（逐字），但 format 被流水线错标成 'lrc'
const YRC_ID = 'YYYYYYYYYYYYYYYYYYYYYY';

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
    CREATE TABLE lyrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0,
      format TEXT,
      content TEXT,
      plain TEXT,
      fetched_at TEXT
    );
  `);
  db.prepare('INSERT INTO tracks (spotify_id, title, artists, status, duration_ms) VALUES (?, ?, ?, ?, ?)')
    .run(SPOTIFY_ID, 'Test Ballad', '["Test Artist"]', 'separated', 180000);
  const track = db.prepare('SELECT id FROM tracks WHERE spotify_id = ?').get(SPOTIFY_ID);
  db.prepare('INSERT INTO stems (track_id, model, vocals_path, no_vocals_path) VALUES (?, ?, ?, ?)')
    .run(track.id, 'htdemucs', '/tmp/vocals.mp3', '/tmp/accompaniment.mp3');
  const lines = Array.from({ length: 12 }, (_, i) => `[00:${String(i + 1).padStart(2, '0')}.000]Test lyric line ${i + 1}`).join('\n');
  db.prepare('INSERT INTO lyrics (track_id, provider, synced, format, content, plain, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(track.id, 'netease', 1, 'lrc', lines, lines, new Date().toISOString());

  // 第二条：YRC 原文 + 错标 format='lrc'（真实库里 Umbrella 等就是这样）
  db.prepare('INSERT INTO tracks (spotify_id, title, artists, status, duration_ms) VALUES (?, ?, ?, ?, ?)')
    .run(YRC_ID, 'Yrc Ballad', '["Test Artist"]', 'separated', 180000);
  const yrcTrack = db.prepare('SELECT id FROM tracks WHERE spotify_id = ?').get(YRC_ID);
  db.prepare('INSERT INTO stems (track_id, model, vocals_path, no_vocals_path) VALUES (?, ?, ?, ?)')
    .run(yrcTrack.id, 'htdemucs', '/tmp/vocals.mp3', '/tmp/accompaniment.mp3');
  const yrc = Array.from({ length: 10 }, (_, i) => {
    const start = i * 2000;
    return `[${start},2000](${start},500,0)Yrc (${start + 500},500,0)line (${start + 1000},500,0)${i + 1}`;
  }).join('\n');
  db.prepare('INSERT INTO lyrics (track_id, provider, synced, format, content, plain, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(yrcTrack.id, 'netease', 1, 'lrc', yrc, '', new Date().toISOString());
  db.close();
}

// 把外部网络全部拒掉，只放行本机测试服务：后台升级会快速失败，但绝不能拖住请求。
const realFetch = global.fetch;
let externalCalls = 0;
global.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  if (url.startsWith('http://127.0.0.1:3816')) return realFetch(input, init);
  externalCalls += 1;
  return Promise.reject(new Error('external network disabled in test'));
};

createTempLibrary();
const app = require(path.join(__dirname, '..', 'server.js'));
const BASE = 'http://127.0.0.1:3816';

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
}

(async () => {
  const server = app.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

  try {
    await test('库里有行级歌词时立即返回，不阻塞等待逐字升级', async () => {
      const qs = new URLSearchParams({
        videoId: `local:${SPOTIFY_ID}`,
        wordLevel: '1',
        songTitle: 'Test Ballad',
        artist: 'Test Artist',
        duration: '180',
      });
      const started = Date.now();
      const res = await fetch(`${BASE}/api/lyrics/lookup?${qs}`);
      const elapsed = Date.now() - started;
      const body = await res.json();

      assert.ok(elapsed < 1500, `请求耗时 ${elapsed}ms，说明还在同步等联网升级`);
      assert.strictEqual(body.found, true);
      assert.strictEqual(body.fromLibrary, true);
      assert.strictEqual(body.wordLevel, false);
      assert.ok((body.lines || []).length >= 12, `歌词行数 ${(body.lines || []).length}`);

      // 后台升级应该已经启动（不要求完成）
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(externalCalls > 0, '后台升级没有发起联网尝试');
    });

    await test('YRC 被错标成 format=lrc 时也能从库里直接解析（不再等联网）', async () => {
      const qs = new URLSearchParams({
        videoId: `local:${YRC_ID}`,
        wordLevel: '1',
        songTitle: 'Yrc Ballad',
        artist: 'Test Artist',
        duration: '180',
      });
      const started = Date.now();
      const res = await fetch(`${BASE}/api/lyrics/lookup?${qs}`);
      const elapsed = Date.now() - started;
      const body = await res.json();

      assert.ok(elapsed < 1500, `请求耗时 ${elapsed}ms，说明没识别出 YRC、又落到联网查询`);
      assert.strictEqual(body.found, true);
      assert.strictEqual(body.fromLibrary, true);
      assert.strictEqual(body.format, 'yrc');
      assert.strictEqual(body.wordLevel, true);
      assert.ok((body.lines || []).length >= 10, `歌词行数 ${(body.lines || []).length}`);
      assert.ok((body.lines[0].chars || []).length > 1, '逐字 chars 没解析出来');
    });
  } finally {
    // 等启动时排的 prepare 同步定时器（250ms）先跑完，避免它写已删除的临时目录
    await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => server.close(r));
    global.fetch = realFetch;
    try { require(path.join(__dirname, '..', 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
