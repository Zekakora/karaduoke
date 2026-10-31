'use strict';
/**
 * 后台制作队列并发测试（不依赖 Python / 真实曲库）。
 *
 * 用法：node tests\prepare-queue.test.js
 *
 * 覆盖：
 * - 默认并发 3（可配置），排队任务按 FIFO 启动
 * - 一个任务结束/取消后立刻补位
 * - 多首同时运行、各自独立的行缓冲与子进程句柄
 * - 取消只杀对应那一个子进程
 * - 重启后 running 任务恢复成 queued 并重新并发启动
 *
 * 注：这里用假的 spawnImpl 模拟子进程（真实 spawn 要开管道，
 * 在受限沙箱里会 EPERM；队列的 spawn 参数在 server 运行时早已验证过）。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { PrepareQueue, DEFAULT_CONCURRENCY, normalizeConcurrency } = require('../lib/prepare-queue.js');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.stack || e.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jobIds = () => ['a', 'b', 'c', 'd', 'e'].map((x) => `song-${x}`);

function makeQueue(dir, opts = {}) {
  return new PrepareQueue({
    jobsFile: path.join(dir, 'jobs.json'),
    logDir: path.join(dir, 'logs'),
    disableSpawn: true,
    ...opts,
  });
}

/** 假子进程工厂：记录 spawn/kill，按需在 stdout 上发数据并 close。 */
function makeFakeSpawn({ sleepMs = 300, splitId = null } = {}) {
  const registry = { children: [], killed: [], spawnArgs: [] };
  let seq = 0;
  function spawnImpl(_exe, args, _opts) {
    const id = args[args.indexOf('--spotify-id') + 1];
    const child = new EventEmitter();
    child.pid = 10000 + (++seq);
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (registry.killed.includes(child.pid)) return;
      registry.killed.push(child.pid);
      child.stdout.end();
      child.emit('close', null, 'SIGTERM');
    };
    registry.children.push(child);
    registry.spawnArgs.push({ id, pid: child.pid });
    setTimeout(() => {
      if (id === splitId) {
        child.stdout.write('[i] 并行：下载音');
        child.stdout.write('频 + 匹配歌词\n');
      } else {
        child.stdout.write('[i] 并行：下载音频 + 匹配歌词\n');
      }
    }, 10);
    const timer = setTimeout(() => {
      child.stdout.write('[+] 分离完成 device=xpu rtf=0.1\n');
      child.stdout.end();
      child.emit('close', 0, null);
    }, sleepMs);
    child.on('close', () => clearTimeout(timer));
    return child;
  }
  return { spawnImpl, registry };
}

(function main() {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-prepare-'));
    try {
      await test('默认并发 3，异常值被夹到 1..4', async () => {
        assert.strictEqual(DEFAULT_CONCURRENCY, 3);
        assert.strictEqual(normalizeConcurrency(undefined), 3);
        assert.strictEqual(normalizeConcurrency('0'), 1);
        assert.strictEqual(normalizeConcurrency('9'), 4);
        assert.strictEqual(normalizeConcurrency('2'), 2);
      });

      await test('入队 5 个 → 3 个 running、2 个排队，全部走 FIFO', async () => {
        const dir = path.join(root, 'fifo');
        fs.mkdirSync(dir, { recursive: true });
        const q = makeQueue(dir);
        for (const id of jobIds()) q.enqueue({ spotifyId: id, title: id });
        await sleep(30);
        const s = q.summary();
        assert.strictEqual(s.runningCount, 3);
        assert.strictEqual(s.pending, 2);
        assert.deepStrictEqual(s.runningJobs.map((j) => j.spotifyId), ['song-a', 'song-b', 'song-c']);
        assert.deepStrictEqual(q.pending, ['song-d', 'song-e']);
        q.stop();
      });

      await test('完成一个 → 排队中的下一个立刻补位', async () => {
        const dir = path.join(root, 'refill');
        fs.mkdirSync(dir, { recursive: true });
        const q = makeQueue(dir);
        for (const id of jobIds()) q.enqueue({ spotifyId: id, title: id });
        await sleep(30);
        q.finishJob('song-a', { status: 'ready' });
        await sleep(30);
        assert.strictEqual(q.summary().runningCount, 3);
        assert.strictEqual(q.getStatus('song-a').status, 'ready');
        assert.ok(q.getStatus('song-d').status === 'running' || q.getStatus('song-e').status === 'running');
        q.stop();
      });

      await test('取消一个 running → 只标 canceled，并立刻补下一个', async () => {
        const dir = path.join(root, 'cancel');
        fs.mkdirSync(dir, { recursive: true });
        const q = makeQueue(dir);
        for (const id of jobIds()) q.enqueue({ spotifyId: id, title: id });
        await sleep(30);
        const res = q.cancel('song-b');
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.job.status, 'canceled');
        await sleep(40);
        const s = q.summary();
        assert.strictEqual(s.runningCount, 3, '释放的槽位应被 song-d 补上');
        assert.deepStrictEqual(s.runningJobs.map((j) => j.spotifyId), ['song-a', 'song-c', 'song-d']);
        assert.strictEqual(q.getStatus('song-b').status, 'canceled');
        q.stop();
      });

      await test('子进程路径：3 个任务同时 spawn（不是串行）', async () => {
        const dir = path.join(root, 'spawn');
        fs.mkdirSync(dir, { recursive: true });
        const { spawnImpl, registry } = makeFakeSpawn({ sleepMs: 250 });
        const q = new PrepareQueue({
          jobsFile: path.join(dir, 'jobs.json'),
          logDir: path.join(dir, 'logs'),
          projectRoot: dir,
          pythonExe: process.execPath,
          concurrency: 3,
          spawnImpl,
        });
        for (const id of ['song-a', 'song-b', 'song-c']) q.enqueue({ spotifyId: id, title: id });
        await sleep(80);
        assert.strictEqual(registry.spawnArgs.length, 3, '应同时拉起 3 个子进程');
        assert.strictEqual(q.summary().runningCount, 3);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && q.list().some((j) => j.status !== 'ready')) await sleep(30);
        assert.deepStrictEqual(q.list().map((j) => j.status), ['ready', 'ready', 'ready']);
        q.stop();
      });

      await test('每首的 stdout 行缓冲互相独立（半行不会串台）', async () => {
        const dir = path.join(root, 'buffers');
        fs.mkdirSync(dir, { recursive: true });
        const { spawnImpl } = makeFakeSpawn({ sleepMs: 250, splitId: 'song-b' });
        const q = new PrepareQueue({
          jobsFile: path.join(dir, 'jobs.json'),
          logDir: path.join(dir, 'logs'),
          projectRoot: dir,
          pythonExe: process.execPath,
          concurrency: 3,
          spawnImpl,
        });
        for (const id of ['song-a', 'song-b', 'song-c']) q.enqueue({ spotifyId: id, title: id });
        await sleep(120);
        assert.strictEqual(q.getStatus('song-b').progress.stage, 'download',
          `song-b stage=${JSON.stringify(q.getStatus('song-b').progress)}`);
        q.stop();
      });

      await test('取消中间那个只杀对应子进程，另外两个照常完成', async () => {
        const dir = path.join(root, 'spawn-cancel');
        fs.mkdirSync(dir, { recursive: true });
        const { spawnImpl, registry } = makeFakeSpawn({ sleepMs: 400 });
        const q = new PrepareQueue({
          jobsFile: path.join(dir, 'jobs.json'),
          logDir: path.join(dir, 'logs'),
          projectRoot: dir,
          pythonExe: process.execPath,
          concurrency: 3,
          spawnImpl,
        });
        for (const id of ['song-a', 'song-b', 'song-c']) q.enqueue({ spotifyId: id, title: id });
        await sleep(100);
        assert.strictEqual(q.summary().runningCount, 3);
        const pidB = registry.spawnArgs.find((x) => x.id === 'song-b').pid;
        q.cancel('song-b');
        await sleep(20);
        assert.deepStrictEqual(registry.killed, [pidB], '只应 kill song-b 的进程');
        assert.strictEqual(q.getStatus('song-a').status, 'running');
        assert.strictEqual(q.getStatus('song-c').status, 'running');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && q.list().some((j) => j.status === 'running')) await sleep(30);
        assert.strictEqual(q.getStatus('song-a').status, 'ready');
        assert.strictEqual(q.getStatus('song-b').status, 'canceled');
        assert.strictEqual(q.getStatus('song-c').status, 'ready');
        q.stop();
      });

      await test('模拟崩溃后重启：running 全部恢复成 queued 并重新并发启动', async () => {
        const dir = path.join(root, 'restore');
        fs.mkdirSync(dir, { recursive: true });
        const jobsFile = path.join(dir, 'jobs.json');
        const q1 = makeQueue(dir);
        for (const id of jobIds()) q1.enqueue({ spotifyId: id, title: id });
        await sleep(30);
        q1.stop({ simulateCrash: true });

        const saved = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
        assert.strictEqual(saved.runningJobs.length, 3);
        assert.strictEqual(saved.running, 'song-a');

        const q2 = makeQueue(dir);
        const { restored } = q2.load();
        assert.strictEqual(restored, 5);
        await sleep(40);
        assert.strictEqual(q2.summary().runningCount, 3);
        for (const id of ['song-a', 'song-b', 'song-c']) {
          assert.strictEqual(q2.getStatus(id).restarts, 1, `${id} restarts`);
        }
        q2.stop();
      });
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) {
      for (const f of failures) console.error(`FAILED: ${f.name}\n${f.e.stack || f.e.message}`);
      process.exitCode = 1;
    }
  })();
})();
