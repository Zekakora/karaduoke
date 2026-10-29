'use strict';
/**
 * 第一批整合测试：sourceMode + 本地曲库 + songKey 去重 + 原子写 state。
 *
 * 用法：node tests\library-mode.test.js
 *
 * 注意：会临时改动真实 data/state.json 的 settings，结束时恢复；
 * 测试产生的队列/会话会清掉。
 */
process.env.PORT = process.env.PORT || '3813';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = process.env.DJ_PASSWORD || 'test-dj-password';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = require(path.join(__dirname, '..', 'server.js'));
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

  const before = await json(`${BASE}/api/state`);
  const origSource = before.body?.settings?.sourceMode || 'youtube';
  const origKaraoke = Boolean(before.body?.settings?.onlyKaraokeSongs);

  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };
  const patch = (b) => json(`${BASE}/api/admin/settings`, { method: 'PATCH', headers: H, body: JSON.stringify(b) });

  try {
    await test('sourceMode 固定在 local 且 /api/config 暴露', async () => {
      const { body } = await json(`${BASE}/api/config`);
      assert.strictEqual(body.sourceMode, 'local', `期望 local，实际 ${body.sourceMode}`);
    });

    await test('sourceMode 无法通过 API 改成 youtube（模式由启动器决定）', async () => {
      const r = await patch({ sourceMode: 'youtube' });
      assert.strictEqual(r.status, 200);
      const c = await json(`${BASE}/api/config`);
      assert.strictEqual(c.body.sourceMode, 'local', `被改成了 ${c.body.sourceMode}`);
    });

    await test('未授权不能改设置', async () => {
      const r = await json(`${BASE}/api/admin/settings`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceMode: 'local' }),
      });
      assert.strictEqual(r.status, 401);
    });

    await test('曲库 summary 可用且 ready 数正确', async () => {
      const { status, body } = await json(`${BASE}/api/library/summary`);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.available, true, '曲库不可用');
      assert.ok(body.ready >= 4, `ready=${body.ready}`);
    });

    await test('曲库列表含封面与音频路径', async () => {
      const { body } = await json(`${BASE}/api/library/tracks`);
      assert.ok(body.tracks.length >= 4);
      const t = body.tracks[0];
      assert.ok(t.cover && t.cover.startsWith('/media/covers/'), `cover=${t.cover}`);
      assert.strictEqual(t.ready, true);
    });

    await test('曲库搜索按标题过滤', async () => {
      const { body } = await json(`${BASE}/api/library/tracks?q=bohemian`);
      assert.strictEqual(body.tracks.length, 1);
      assert.ok(/bohemian/i.test(body.tracks[0].title));
    });

    await test('单曲详情返回 4 个音轨', async () => {
      const { status, body } = await json(`${BASE}/api/library/tracks/2JiDi0qAXsPwhPqA2qaKGt`);
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(Object.keys(body.audio).sort(), ['accompaniment', 'guide', 'original', 'vocals']);
    });

    await test('非法 spotifyId → 404', async () => {
      const { status } = await json(`${BASE}/api/library/tracks/not-an-id`);
      assert.strictEqual(status, 404);
    });

    await test('onlyKaraokeSongs 不拦截本地曲目', async () => {
      await patch({ onlyKaraokeSongs: true });
      const sess = await json(`${BASE}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'lib-' + Date.now().toString(36) }),
      });
      const token = sess.body?.token || sess.body?.session?.token;
      assert.ok(token, '会话建立失败');
      const SH = { 'Content-Type': 'application/json', 'x-session-token': token };
      const add = (b) => json(`${BASE}/api/queue`, { method: 'POST', headers: SH, body: JSON.stringify(b) });
      // 标题不含 karaoke，若被过滤则是 SONG_NOT_KARAOKE
      const a = await add({ source: 'local', spotifyId: '2JiDi0qAXsPwhPqA2qaKGt', title: 'Bohemian Rhapsody' });
      assert.notStrictEqual(a.body?.code, 'SONG_NOT_KARAOKE', '本地曲目被 onlyKaraokeSongs 拦截');
      assert.strictEqual(a.status, 201);
    });

    await test('songKey：多个本地曲目互不判重（videoId 均为 null）', async () => {
      const sess = await json(`${BASE}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'key-' + Date.now().toString(36) }),
      });
      const token = sess.body?.token || sess.body?.session?.token;
      const SH = { 'Content-Type': 'application/json', 'x-session-token': token };
      const add = (b) => json(`${BASE}/api/queue`, { method: 'POST', headers: SH, body: JSON.stringify(b) });
      const ids = ['7qiZfU4dY1lWllzX7mPBI3', '3n3Ppam7vgaVa1iaRUc9Lp', '60nZcImufyMA1MKQY3dcCH'];
      for (const id of ids) {
        const r = await add({ source: 'local', spotifyId: id, title: 'T-' + id });
        assert.strictEqual(r.status, 201, `${id} 被误判重复: ${r.body?.code}`);
      }
    });

    await test('songKey：同一 queued 曲目重复点 → 409', async () => {
      const sess = await json(`${BASE}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'dup-' + Date.now().toString(36) }),
      });
      const token = sess.body?.token || sess.body?.session?.token;
      const SH = { 'Content-Type': 'application/json', 'x-session-token': token };
      const add = (b) => json(`${BASE}/api/queue`, { method: 'POST', headers: SH, body: JSON.stringify(b) });
      const payload = { source: 'youtube', videoId: 'dupe2-' + Date.now().toString(36), title: 'Dupe Song karaoke' };
      const a = await add(payload);
      assert.strictEqual(a.status, 201);
      const b = await add(payload);
      assert.strictEqual(b.status, 409, `第二次应为 409，实际 ${b.status}`);
    });

    await test('本地曲目缺 spotifyId → 400', async () => {
      const sess = await json(`${BASE}/api/sessions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'miss-' + Date.now().toString(36) }),
      });
      const token = sess.body?.token || sess.body?.session?.token;
      const r = await json(`${BASE}/api/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        body: JSON.stringify({ source: 'local', title: 'No Id' }),
      });
      assert.strictEqual(r.status, 400);
    });
  } finally {
    try { await patch({ sourceMode: origSource, onlyKaraokeSongs: origKaraoke }); } catch { /* ignore */ }
    // 清掉本测试产生的队列与会话
    try {
      const p = path.join(__dirname, '..', 'data', 'state.json');
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      s.songs = [];
      s.playback.status = 'idle';
      s.playback.currentRequestId = null;
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
    } catch { /* ignore */ }
    await new Promise((r) => server.close(r));
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) { process.exitCode = 1; for (const f of failures) console.log(`\n[${f.name}]\n${f.e.stack}`); }
})();
