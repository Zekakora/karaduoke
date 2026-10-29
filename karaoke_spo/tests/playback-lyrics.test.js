'use strict';
/**
 * 歌词播放模式集成测试（同进程，不 spawn）
 *
 * 覆盖：
 *   - playbackMode 默认值与暴露（/api/config、/api/state）
 *   - PATCH 切换、非法值回落、未授权拒绝
 *   - /api/lyrics/lookup 参数校验、形状、降级行为
 *   - 歌词视图静态资源与 display 页引用
 *
 * 注意：本测试会改动真实的 data/state.json 中的 playbackMode，
 * 结束时在 finally 里恢复为原值。
 *
 * 用法：node tests/playback-lyrics.test.js
 */
process.env.PORT = process.env.PORT || '3812';
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

  // 记录原始模式，结束时恢复
  const initial = await json(`${BASE}/api/state`);
  const originalMode = initial.body?.settings?.playbackMode || 'video';

  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const token = auth.body?.token;
  const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-token': token };
  const patch = (body) => json(`${BASE}/api/admin/settings`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify(body) });

  try {
    await test('鉴权：正确密码返回 token', () => {
      assert.strictEqual(auth.status, 200);
      assert.ok(token && token.includes('.'), 'token 应存在');
    });

    await test('/api/config 暴露 playbackMode', async () => {
      const { status, body } = await json(`${BASE}/api/config`);
      assert.strictEqual(status, 200);
      assert.ok(['video', 'lyrics'].includes(body.playbackMode), `playbackMode 非法: ${body.playbackMode}`);
    });

    await test('/api/state 的 settings 带 playbackMode', async () => {
      const { body } = await json(`${BASE}/api/state`);
      assert.ok(['video', 'lyrics'].includes(body.settings.playbackMode));
    });

    await test('未授权 PATCH → 401', async () => {
      const { status } = await json(`${BASE}/api/admin/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playbackMode: 'lyrics' }),
      });
      assert.strictEqual(status, 401);
    });

    await test('切换到 lyrics → state 与 config 同步', async () => {
      const { status } = await patch({ playbackMode: 'lyrics' });
      assert.strictEqual(status, 200);
      const state = await json(`${BASE}/api/state`);
      assert.strictEqual(state.body.settings.playbackMode, 'lyrics');
      const config = await json(`${BASE}/api/config`);
      assert.strictEqual(config.body.playbackMode, 'lyrics');
    });

    await test('切回 video → state 同步', async () => {
      await patch({ playbackMode: 'video' });
      const state = await json(`${BASE}/api/state`);
      assert.strictEqual(state.body.settings.playbackMode, 'video');
    });

    await test('非法 playbackMode 回落为 video（不报错、不写入脏值）', async () => {
      const { status } = await patch({ playbackMode: 'bogus-mode' });
      assert.strictEqual(status, 200);
      const state = await json(`${BASE}/api/state`);
      assert.strictEqual(state.body.settings.playbackMode, 'video');
    });

    await test('其它设置项不受 playbackMode 影响', async () => {
      const before = await json(`${BASE}/api/state`);
      await patch({ playbackMode: 'lyrics' });
      const after = await json(`${BASE}/api/state`);
      assert.strictEqual(after.body.settings.roomName, before.body.settings.roomName);
      assert.strictEqual(after.body.settings.interfaceLanguage, before.body.settings.interfaceLanguage);
      await patch({ playbackMode: 'video' });
    });

    await test('歌词查询：缺参数 → 400', async () => {
      const { status, body } = await json(`${BASE}/api/lyrics/lookup`);
      assert.strictEqual(status, 400);
      assert.strictEqual(body.code, 'MISSING_QUERY');
    });

    await test('歌词查询：正常标题 → 解析出歌手与歌名', async () => {
      const qs = new URLSearchParams({ videoId: 'fJ9rUzIMcZQ', title: 'Queen - Bohemian Rhapsody (Official Video Remastered)' });
      const { status, body } = await json(`${BASE}/api/lyrics/lookup?${qs}`);
      assert.strictEqual(status, 200);
      assert.ok(body.parsed, '应返回 parsed');
      assert.strictEqual(body.parsed.artist, 'Queen');
      assert.ok(/Bohemian Rhapsody/i.test(body.parsed.title), `解析歌名错误: ${body.parsed.title}`);
      // 有网络时应命中；无网络时允许降级，但形状必须正确
      if (body.found) {
        assert.ok(Array.isArray(body.lines) && body.lines.length > 0, 'found=true 时必须有歌词行');
        assert.ok(body.lines[0].startMs != null, '同步歌词首行应有 startMs');
        assert.ok(body.lines[0].endMs > body.lines[0].startMs, 'endMs 应大于 startMs');
      } else {
        assert.deepStrictEqual(body.lines, [], 'found=false 时 lines 必须为空数组，不能造假');
      }
    });

    await test('歌词查询：中文标题走通解析', async () => {
      const qs = new URLSearchParams({ videoId: 'zh-test', title: '周杰伦 - 晴天' });
      const { status, body } = await json(`${BASE}/api/lyrics/lookup?${qs}`);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.parsed.artist, '周杰伦');
      assert.strictEqual(body.parsed.title, '晴天');
    });

    await test('歌词查询：同一 videoId 第二次走缓存（结果一致）', async () => {
      const qs = new URLSearchParams({ videoId: 'cache-test', title: 'Queen - Bohemian Rhapsody' });
      const first = await json(`${BASE}/api/lyrics/lookup?${qs}`);
      const second = await json(`${BASE}/api/lyrics/lookup?${qs}`);
      assert.deepStrictEqual(second.body, first.body);
    });

    await test('静态资源：歌词视图 JS/CSS 可访问', async () => {
      for (const asset of ['/lyrics-view.js', '/lyrics-view.css']) {
        const res = await fetch(`${BASE}${asset}`);
        assert.strictEqual(res.status, 200, `${asset} 应 200`);
        const text = await res.text();
        assert.ok(text.length > 500, `${asset} 内容过短`);
      }
    });

    await test('display 页引入了歌词视图资源', async () => {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      assert.ok(html.includes('/lyrics-view.js'), '应引入 lyrics-view.js');
      assert.ok(html.includes('/lyrics-view.css'), '应引入 lyrics-view.css');
      // 顺序：lyrics-view.js 必须在 app.js 之前
      assert.ok(html.indexOf('/lyrics-view.js') < html.indexOf('/app.js'), 'lyrics-view.js 应先于 app.js 加载');
    });

    await test('前端代码包含歌词模式的挂载与隐藏音频容器', async () => {
      const res = await fetch(`${BASE}/app.js`);
      const code = await res.text();
      assert.ok(code.includes('lyrics-host'), '应挂载 lyrics-host');
      assert.ok(code.includes('yt-audio-only'), 'YouTube 应使用隐藏容器');
      assert.ok(code.includes("playbackMode === 'lyrics'"), '应判断 playbackMode');
      assert.ok(code.includes('admin-playback-mode'), '控制台应有切换项');
    });
  } finally {
    // 恢复用户原本的播放模式
    try { await patch({ playbackMode: originalMode }); } catch { /* 忽略 */ }
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
