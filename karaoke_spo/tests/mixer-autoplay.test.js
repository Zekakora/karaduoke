'use strict';
/**
 * 大屏自动播放解锁测试（不依赖浏览器）。
 *
 * 回归的问题：
 *   Chrome/Edge 在页面还没有用户手势时，AudioContext.resume() 返回的 Promise
 *   可能一直 pending（不是 reject）。旧实现直接 await，调用方永远卡住，
 *   大屏表现为「处理完了但不自动播放」，也不会显示「点击开始播放」的提示。
 *
 * 用法：node tests/mixer-autoplay.test.js
 */

const assert = require('node:assert');

global.window = globalThis;

class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
  }
  resume() { return new Promise(() => {}); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() {
    return {
      gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {} },
      connect() {},
    };
  }
  createDynamicsCompressor() {
    return {
      threshold: {}, knee: {}, ratio: {}, attack: {}, release: {},
      connect() {},
    };
  }
  createBufferSource() {
    return { buffer: null, onended: null, connect() {}, start() {}, stop() {}, disconnect() {} };
  }
}
window.AudioContext = FakeAudioContext;
require(require('node:path').join(__dirname, '..', 'public', 'karaoke-mixer.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${error.message}`); }
}

(async () => {
  await test('AudioContext 卡在 suspended 时 play() 会在 1.2s 内抛 AUTOPLAY_BLOCKED', async () => {
    const mixer = new window.KaraokeMixer({});
    mixer._ensureContext();
    mixer.accBuffer = {};
    mixer.vocBuffer = {};
    mixer.duration = 10;

    const started = Date.now();
    let error = null;
    try { await mixer.play(); } catch (e) { error = e; }
    const elapsed = Date.now() - started;

    assert.ok(error, 'play() 应该失败而不是永远挂起');
    assert.strictEqual(error.code, 'AUTOPLAY_BLOCKED');
    assert.ok(elapsed >= 1000 && elapsed < 3000, `耗时 ${elapsed}ms，不在 1.2s 超时附近`);
    mixer.destroy();
  });

  await test('AudioContext 已 running 时正常开始播放', async () => {
    const mixer = new window.KaraokeMixer({});
    mixer._ensureContext();
    mixer.ctx.state = 'running';
    mixer.accBuffer = {};
    mixer.vocBuffer = {};
    mixer.duration = 10;

    await mixer.play();
    assert.strictEqual(mixer.playing, true);
    mixer.destroy();
  });

  await test('切歌 destroy 不关闭共享 AudioContext，下一首复用它', async () => {
    const first = new window.KaraokeMixer({});
    first._ensureContext();
    const ctx = first.ctx;
    ctx.state = 'running';
    first.destroy();
    assert.notStrictEqual(ctx.state, 'closed', 'destroy() 不应该 close 共享 context');

    const second = new window.KaraokeMixer({});
    second._ensureContext();
    assert.strictEqual(second.ctx, ctx, '下一首歌应该复用同一个 AudioContext');
    second.destroy();
  });

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
})();
