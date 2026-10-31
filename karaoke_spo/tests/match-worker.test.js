'use strict';
/**
 * 一键匹配（lib/match-worker.js）的测试：串行、低并发、可取消、失败不阻断。
 *
 * 用法：node tests/match-worker.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const { MatchWorker } = require(path.join(__dirname, '..', 'lib', 'match-worker.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${error.message}`); }
}

const items = [
  { spotifyId: 'AAAAAAAAAAAAAAAAAAAAAA', title: 'Song A' },
  { spotifyId: 'BBBBBBBBBBBBBBBBBBBBBB', title: 'Song B' },
  { spotifyId: 'CCCCCCCCCCCCCCCCCCCCCC', title: 'Song C' },
];

(async () => {
  await test('串行处理：同一时刻最多 1 首，且每首之间留间隔', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const worker = new MatchWorker({
      options: { gapMs: 30 },
      runMv: async (item) => {
        active += 1; maxActive = Math.max(maxActive, active);
        order.push(item.spotifyId);
        await sleep(20);
        active -= 1;
        return { status: 'auto_matched', visualVideoId: 'dQw4w9WgXcQ' };
      },
      runLyrics: async () => ({ status: 'already-present' }),
    });
    const started = worker.start(items);
    assert.ok(started.ok, JSON.stringify(started));
    const t0 = Date.now();
    while (worker.running && Date.now() - t0 < 5000) await sleep(20);
    assert.strictEqual(maxActive, 1, `并发度应为 1，实际 ${maxActive}`);
    assert.deepStrictEqual(order, items.map((i) => i.spotifyId), '应按顺序处理');
    const job = worker.toPublic();
    assert.strictEqual(job.state, 'done');
    assert.strictEqual(job.counts.done, 3);
    assert.strictEqual(job.counts.remaining, 0);
  });

  await test('单首失败不影响后续（记 failed，继续下一首）', async () => {
    const seen = [];
    const worker = new MatchWorker({
      options: { gapMs: 0 },
      runMv: async (item) => {
        seen.push(item.spotifyId);
        if (item.spotifyId === items[1].spotifyId) throw new Error('boom');
        return { status: 'auto_matched' };
      },
      runLyrics: async () => ({}),
    });
    worker.start(items);
    // 等它把最后一首也处理完（state 变 done 那一刻 counts 可能还没刷新，多给一轮）
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (!worker.running) { await sleep(30); break; }
      await sleep(10);
    }
    assert.deepStrictEqual(seen, items.map((i) => i.spotifyId), '失败后应继续后面的');
    const job = worker.toPublic();
    assert.strictEqual(job.counts.failed, 1);
    assert.strictEqual(job.counts.done, 2);
    assert.ok(job.errors.length >= 1, JSON.stringify(job.errors));
  });

  await test('YouTube 限流：该首跳过，连续多次则整批提前结束', async () => {
    const worker = new MatchWorker({
      options: { gapMs: 0, maxRateLimitHits: 2 },
      runMv: async () => ({ rateLimited: true, reason: 'YOUTUBE_RATE_LIMITED' }),
      runLyrics: async () => ({}),
    });
    worker.start(items);
    const t0 = Date.now();
    while (worker.running && Date.now() - t0 < 5000) await sleep(10);
    const job = worker.toPublic();
    assert.strictEqual(job.state, 'done');
    assert.ok(job.counts.skipped >= 2, JSON.stringify(job.counts));
    assert.ok(job.errors.some((e) => /限流/.test(e)), JSON.stringify(job.errors));
  });

  await test('重复点击不会开第二个队列', async () => {
    const worker = new MatchWorker({
      options: { gapMs: 50 },
      runMv: async () => { await sleep(80); return {}; },
      runLyrics: async () => ({}),
    });
    assert.ok(worker.start(items).ok);
    const second = worker.start(items);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, 'already-running');
    worker.cancel();
  });

  await test('取消：未处理的标 skipped，状态变 cancelled', async () => {
    const worker = new MatchWorker({
      options: { gapMs: 0 },
      runMv: async () => { await sleep(60); return {}; },
      runLyrics: async () => ({}),
    });
    worker.start(items);
    await sleep(20);
    const res = worker.cancel();
    assert.ok(res.ok);
    const job = worker.toPublic();
    assert.strictEqual(job.state, 'cancelled');
    assert.ok(job.counts.skipped >= 2, JSON.stringify(job.counts));
  });

  await test('只处理有效的 spotifyId；没有待办时不启动', async () => {
    const worker = new MatchWorker({ options: { gapMs: 0 }, runMv: async () => ({}), runLyrics: async () => ({}) });
    const bad = worker.start([{ spotifyId: 'bad', title: 'x' }]);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'empty');
    const good = worker.start([{ spotifyId: 'DDDDDDDDDDDDDDDDDDDDDD', title: 'ok' }]);
    assert.ok(good.ok);
    const t0 = Date.now();
    while (worker.running && Date.now() - t0 < 3000) await sleep(10);
    assert.strictEqual(worker.toPublic().counts.total, 1);
  });

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
})();
