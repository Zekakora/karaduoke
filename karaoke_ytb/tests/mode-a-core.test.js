'use strict';
/**
 * 模式 A（YouTube 在线）核心回归测试（同进程，不 spawn）
 *
 * 覆盖：
 *   - 迁移期误加、今已移除的功能确实不再暴露：
 *       playbackMode（歌词画面）、sourceMode（音源模式）、/api/lyrics/lookup、
 *       /api/library/*（模式 B 本地曲库）
 *   - 点歌台搜索固定走 YouTube，前端不再按 sourceMode 分流
 *   - YouTube 搜索接口用 API key 正常返回（key 未传时只回落 demo 列表）
 *
 * 用法：node tests/mode-a-core.test.js
 */
process.env.PORT = process.env.PORT || '3814';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = process.env.DJ_PASSWORD || 'test-dj-password';

const assert = require('node:assert');
const path = require('node:path');

const app = require(path.join(__dirname, '..', 'server.js'));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

const json = (url, options) => fetch(url, options).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

(async () => {
  const server = app.start();
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  try {
    await test('/api/config 不再暴露 playbackMode / sourceMode', async () => {
      const { status, body } = await json(`${BASE}/api/config`);
      assert.strictEqual(status, 200);
      assert.ok(!('playbackMode' in body), '不应再有 playbackMode');
      assert.ok(!('sourceMode' in body), '不应再有 sourceMode');
    });

    await test('/api/state 的 settings 不再带这两个字段', async () => {
      const { body } = await json(`${BASE}/api/state`);
      assert.ok(!('playbackMode' in body.settings), 'state.settings 不应再有 playbackMode');
      assert.ok(!('sourceMode' in body.settings), 'state.settings 不应再有 sourceMode');
    });

    await test('PATCH 这两个字段不生效、也不写入脏值', async () => {
      const auth = await json(`${BASE}/api/admin/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
      });
      const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };
      const patched = await json(`${BASE}/api/admin/settings`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ playbackMode: 'lyrics', sourceMode: 'local' }),
      });
      assert.strictEqual(patched.status, 200);
      const state = await json(`${BASE}/api/state`);
      assert.ok(!('sourceMode' in state.body.settings), 'PATCH 后仍不应出现 sourceMode');
    });

    await test('歌词接口 /api/lyrics/lookup 已移除（404）', async () => {
      const { status } = await json(`${BASE}/api/lyrics/lookup?videoId=x&title=y`);
      assert.strictEqual(status, 404);
    });

    await test('模式 B 本地曲库接口已移除（404）', async () => {
      for (const p of ['/api/library/summary', '/api/library/tracks']) {
        const { status } = await json(`${BASE}${p}`);
        assert.strictEqual(status, 404, `${p} 应 404`);
      }
    });

    await test('YouTube 搜索接口可用', async () => {
      const { status, body } = await json(`${BASE}/api/youtube/search?q=queen`);
      assert.strictEqual(status, 200);
      assert.ok(Array.isArray(body.items), 'items 应为数组');
    });

    await test('点歌台只走 YouTube，不再按 sourceMode 分流', async () => {
      const code = await (await fetch(`${BASE}/app.js`)).text();
      assert.ok(code.includes('/api/youtube/search'), '应调用 YouTube 搜索');
      assert.ok(!code.includes('/api/library/tracks'), '不应再调用本地曲库');
      assert.ok(!code.includes('sourceMode'), '不应再判断 sourceMode');
    });

    await test('控制台界面设置里没有这两个下拉', async () => {
      const code = await (await fetch(`${BASE}/app.js`)).text();
      assert.ok(!code.includes('admin-playback-mode'), '不应有播放画面下拉');
      assert.ok(!code.includes('admin-source-mode'), '不应有音源模式下拉');
    });

    await test('大屏恢复纯 YouTube 视频挂载，无歌词容器', async () => {
      const code = await (await fetch(`${BASE}/app.js`)).text();
      assert.ok(code.includes('new YT.Player'), '应挂载 YouTube 播放器');
      assert.ok(!code.includes('lyrics-host'), '不应再有歌词容器');
      assert.ok(!code.includes('yt-audio-only'), '不应再有隐藏音频容器');
    });

    await test('页面不再引入歌词视图资源', async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      assert.ok(!html.includes('/lyrics-view.js'), '不应引入 lyrics-view.js');
      assert.ok(!html.includes('/lyrics-view.css'), '不应引入 lyrics-view.css');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
