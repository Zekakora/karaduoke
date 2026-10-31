'use strict';
/**
 * 曲库残留文件清理测试。
 *
 * 用法：node tests\orphan-cleanup.test.js
 *
 * 与 library-mode.test.js 不同，这个测试**完全不动真实数据**：
 * 建一套临时目录当 assets/ 与 data/，临时库里只放自己造的曲目，
 * 跑完整个目录删掉。server.js 在模块加载时就解析这些路径，
 * 所以环境变量必须在 require 之前设好。
 */
process.env.PORT = process.env.PORT || '3817';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = process.env.DJ_PASSWORD || 'test-dj-password';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const tmpParent = path.join(ROOT, '.tmp');
fs.mkdirSync(tmpParent, { recursive: true });
const TMP = fs.mkdtempSync(path.join(tmpParent, 'orphan-'));
const ASSETS = path.join(TMP, 'assets');
const DATA = path.join(TMP, 'data');
const DB_FILE = path.join(DATA, 'library.db');

process.env.LIBRARY_DB = DB_FILE;
process.env.MEDIA_ROOT = ASSETS;
process.env.KARAOKE_DATA_DIR = DATA;
process.env.LYRICS_OVERRIDES = path.join(DATA, 'lyrics-overrides.json');

// ---------------------------------------------------------------- 建临时曲库
fs.mkdirSync(DATA, { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_FILE);
db.exec(fs.readFileSync(path.join(ROOT, 'python', 'schema.sql'), 'utf8'));

const KEEP_A = '3n3Ppam7vgaVa1iaRUc9Lp';   // 曲库里还在，产物必须保留
const KEEP_B = '1p80LdxRV74UKvL8gnD7ky';   // 同上，但没有 source_video_id
const GONE = '7ouMYWpwJ422jRcDASZB7P';     // 已删除的歌 → 产物都是孤儿
const VID_A = 'dQw4w9WgXcQ';               // KEEP_A 的 YouTube 源
const VID_GONE = 'kJQP7kiw5Fk';            // 已删除歌的源

db.prepare(
  `INSERT INTO tracks (spotify_id, title, artists, status, source_video_id, album_art_path, audio_path)
   VALUES (?,?,?,?,?,?,?)`,
).run(KEEP_A, 'Mr. Brightside', '["The Killers"]', 'separated', VID_A,
  path.join(ASSETS, 'covers', `${KEEP_A}.jpg`),
  path.join(DATA, 'library', `${VID_A}.wav`));
db.prepare(
  `INSERT INTO tracks (spotify_id, title, artists, status, source_video_id, album_art_path, audio_path)
   VALUES (?,?,?,?,?,?,?)`,
).run(KEEP_B, 'Despacito', '["Luis Fonsi"]', 'separated', null,
  path.join(ASSETS, 'covers', `${KEEP_B}.jpg`), null);
db.close();

// ---------------------------------------------------------------- 造资产
const OUT = path.join(ASSETS, 'output', 'library');
const COVERS = path.join(ASSETS, 'covers');
const LYRICS = path.join(ASSETS, 'lyrics');
const UPSTREAM = path.join(DATA, 'library');
const MP3S = ['accompaniment.mp3', 'vocals.mp3', 'guide.mp3', 'original.mp3'];

function write(file, size = 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
}

// 在库的两首歌 —— 清理时一个字节都不能少
for (const id of [KEEP_A, KEEP_B]) for (const mp3 of MP3S) write(path.join(OUT, id, mp3), 2048);
for (const id of [KEEP_A, KEEP_B]) write(path.join(COVERS, `${id}.jpg`), 512);
write(path.join(LYRICS, `${KEEP_A}.lrc`), 256);
write(path.join(UPSTREAM, `${VID_A}.wav`), 4096);
write(path.join(UPSTREAM, `${VID_A}.match.json`), 128);

// 已删除的歌 —— 全部应该被识别为孤儿
for (const mp3 of MP3S) write(path.join(OUT, GONE, mp3), 2048);
write(path.join(COVERS, `${GONE}.jpg`), 512);
write(path.join(LYRICS, `${GONE}.yrc`), 256);
write(path.join(UPSTREAM, `${VID_GONE}.wav`), 4096);
write(path.join(UPSTREAM, `${VID_GONE}.match.json`), 128);

// 名字不像曲目 id 的目录/文件 —— 必须跳过，不能当成孤儿
write(path.join(OUT, 'probe-loopback', 'x.wav'), 64);
write(path.join(COVERS, 'not-a-track-id.jpg'), 64);
write(path.join(LYRICS, 'README.md'), 16);

// 歌词覆盖表：一条还在用，一条指向已删除的曲目
fs.writeFileSync(path.join(DATA, 'lyrics-overrides.json'), JSON.stringify({
  version: 1,
  items: [
    { key: `local:${KEEP_A}`, payload: { provider: 'qq', lines: [] }, at: '2026-10-01T00:00:00Z' },
    { key: `local:${GONE}`, payload: { provider: 'qq', lines: [] }, at: '2026-10-01T00:00:00Z' },
  ],
}, null, 2), 'utf8');

// ---------------------------------------------------------------- 起服务
const app = require(path.join(ROOT, 'server.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let passed = 0; let failed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const json = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  const server = app.start();
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));

  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };

  let scanned = null;

  try {
    await test('未授权不能扫描残留', async () => {
      const r = await json(`${BASE}/api/library/admin/orphans`);
      assert.strictEqual(r.status, 401);
    });

    await test('未授权不能清理残留', async () => {
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [] }),
      });
      assert.strictEqual(r.status, 401);
    });

    await test('扫描可用，且识别出全部 5 类残留', async () => {
      const { status, body } = await json(`${BASE}/api/library/admin/orphans`, { headers: H });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.available, true, `曲库不可用：${body.reason}`);
      scanned = body;

      const byKey = Object.fromEntries(body.groups.map((g) => [g.key, g]));
      for (const key of ['output', 'covers', 'lyrics', 'upstream', 'overrides']) {
        assert.ok(byKey[key], `缺少分组 ${key}`);
        assert.ok(byKey[key].items.length > 0, `分组 ${key} 没有识别出残留`);
      }
      // 已删除那首歌的产物：4 个 MP3 + 封面 + 歌词 + 原始 WAV + match.json + 覆盖表
      assert.strictEqual(byKey.output.items.length, 1, `output 应为 1 项，实际 ${byKey.output.items.length}`);
      assert.strictEqual(byKey.output.items[0].id, GONE);
      assert.strictEqual(byKey.upstream.items.length, 2, 'upstream 应为 wav + match.json 两项');
      assert.strictEqual(byKey.overrides.items.length, 1);
      assert.strictEqual(byKey.overrides.items[0].key, `local:${GONE}`);
    });

    await test('在库的曲目产物不会被当成残留', async () => {
      const byKey = Object.fromEntries(scanned.groups.map((g) => [g.key, g]));
      const ids = [...byKey.output.items, ...byKey.covers.items, ...byKey.lyrics.items].map((i) => i.id);
      assert.ok(!ids.includes(KEEP_A), 'KEEP_A 的产物被误判成残留');
      assert.ok(!ids.includes(KEEP_B), 'KEEP_B 的产物被误判成残留');
      const upstreamIds = byKey.upstream.items.map((i) => i.id);
      assert.ok(!upstreamIds.includes(VID_A), '在库曲目的原始 WAV 被误判成残留');
    });

    await test('名字不是曲目 id 的目录/文件被跳过，不进残留清单', async () => {
      const skippedNames = scanned.skipped.map((s) => path.basename(s.path));
      assert.ok(skippedNames.includes('probe-loopback'), 'probe-loopback 未被跳过');
      assert.ok(skippedNames.includes('not-a-track-id.jpg'), 'not-a-track-id.jpg 未被跳过');
      assert.ok(skippedNames.includes('README.md'), 'README.md 未被跳过');
    });

    await test('统计的大小与数量自洽', async () => {
      const sum = scanned.groups.reduce((n, g) => n + g.totalBytes, 0);
      const count = scanned.groups.reduce((n, g) => n + g.items.length, 0);
      assert.strictEqual(scanned.totalBytes, sum);
      assert.strictEqual(scanned.totalCount, count);
      // 4×2048 + 512 + 256 + 4096 + 128 = 13184
      assert.strictEqual(sum, 13184, `残留总大小应为 13184，实际 ${sum}`);
    });

    await test('拒绝删除受管目录之外的路径', async () => {
      const outside = path.join(TMP, 'elsewhere', GONE);
      write(outside, 32);
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths: [outside] }),
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.files.removed.length, 0, '越界路径被删掉了');
      assert.strictEqual(r.body.files.rejected[0].reason, 'outside-roots');
      assert.ok(fs.existsSync(outside), '越界文件被删掉了');
    });

    await test('拒绝删除受管目录的孙级路径（只能删直属子项）', async () => {
      const deep = path.join(OUT, GONE, 'vocals.mp3');
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths: [deep] }),
      });
      assert.strictEqual(r.body.files.removed.length, 0, '孙级路径被删掉了');
      assert.strictEqual(r.body.files.rejected[0].reason, 'not-managed-dir');
      assert.ok(fs.existsSync(deep), '孙级文件被删掉了');
    });

    await test('拒绝删除受管目录本身', async () => {
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths: [COVERS, path.join(ASSETS, 'output')] }),
      });
      assert.strictEqual(r.body.files.removed.length, 0, '受管目录被删掉了');
      assert.ok(fs.existsSync(COVERS), 'covers 目录被删掉了');
    });

    await test('拒绝删除仍在库的曲目产物（扫描后被重新点回来的场景）', async () => {
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths: [path.join(COVERS, `${KEEP_A}.jpg`)] }),
      });
      assert.strictEqual(r.body.files.removed.length, 0);
      assert.strictEqual(r.body.files.rejected[0].reason, 'track-exists');
      assert.ok(fs.existsSync(path.join(COVERS, `${KEEP_A}.jpg`)), '在库曲目的封面被删掉了');
    });

    await test('清理残留：目标消失、在库文件完好、落盘清单', async () => {
      const paths = [];
      for (const group of scanned.groups) {
        if (group.key === 'overrides') continue;
        for (const item of group.items) paths.push(item.path);
      }
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths, overrideKeys: [`local:${GONE}`] }),
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.files.failed.length, 0, `删除失败：${JSON.stringify(r.body.files.failed)}`);
      assert.strictEqual(r.body.files.removed.length, paths.length, '有残留没删掉');
      assert.strictEqual(r.body.overrides.removed.length, 1, '歌词覆盖条目没删掉');

      // 已删除歌的产物全部消失
      assert.ok(!fs.existsSync(path.join(OUT, GONE)), '孤儿输出目录还在');
      assert.ok(!fs.existsSync(path.join(COVERS, `${GONE}.jpg`)), '孤儿封面还在');
      assert.ok(!fs.existsSync(path.join(LYRICS, `${GONE}.yrc`)), '孤儿歌词还在');
      assert.ok(!fs.existsSync(path.join(UPSTREAM, `${VID_GONE}.wav`)), '孤儿原始 WAV 还在');
      assert.ok(!fs.existsSync(path.join(UPSTREAM, `${VID_GONE}.match.json`)), '孤儿 match.json 还在');

      // 在库的两首歌一个字节都不能少
      for (const id of [KEEP_A, KEEP_B]) {
        for (const mp3 of MP3S) assert.ok(fs.existsSync(path.join(OUT, id, mp3)), `${id}/${mp3} 被误删`);
        assert.ok(fs.existsSync(path.join(COVERS, `${id}.jpg`)), `${id} 封面被误删`);
      }
      assert.ok(fs.existsSync(path.join(LYRICS, `${KEEP_A}.lrc`)), 'KEEP_A 歌词被误删');
      assert.ok(fs.existsSync(path.join(UPSTREAM, `${VID_A}.wav`)), 'KEEP_A 原始 WAV 被误删');

      // 名字不合规的目录必须还在
      assert.ok(fs.existsSync(path.join(OUT, 'probe-loopback', 'x.wav')), 'probe-loopback 被误删');
      assert.ok(fs.existsSync(path.join(LYRICS, 'README.md')), 'README.md 被误删');

      // 清理清单落盘了
      const manifest = r.body.files.manifest;
      assert.ok(manifest && typeof manifest === 'string', `清单没落盘：${JSON.stringify(manifest)}`);
      const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.strictEqual(saved.removed.length, paths.length);
      assert.strictEqual(saved.freedBytes, 13184);

      // 覆盖表里在用的那条要留下
      const kept = JSON.parse(fs.readFileSync(path.join(DATA, 'lyrics-overrides.json'), 'utf8'));
      const keys = kept.items.map((i) => i.key);
      assert.ok(keys.includes(`local:${KEEP_A}`), '在用的歌词覆盖被误删');
      assert.ok(!keys.includes(`local:${GONE}`), '孤儿歌词覆盖还在');
    });

    await test('清理完再扫描应当是干净的', async () => {
      const { body } = await json(`${BASE}/api/library/admin/orphans`, { headers: H });
      assert.strictEqual(body.totalCount, 0, `仍有残留：${JSON.stringify(body.groups.map((g) => [g.key, g.items.length]))}`);
    });

    await test('空请求返回 400', async () => {
      const r = await json(`${BASE}/api/library/admin/orphans/purge`, {
        method: 'POST', headers: H, body: JSON.stringify({ paths: [], overrideKeys: [] }),
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'NOTHING_TO_PURGE');
    });
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`  - ${f.name}\n    ${f.e.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
  process.exit(failed ? 1 : 0);
})();
