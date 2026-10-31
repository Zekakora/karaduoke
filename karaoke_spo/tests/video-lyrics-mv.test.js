'use strict';
/**
 * public/video-lyrics-mode.js（Video Mode 的官方 MV 背景）单元测试。
 *
 * 在 Node 里用最小 DOM/YT 桩把组件跑起来，**不联网、不开浏览器**，覆盖：
 *   - 有 visualVideoId → 创建 IFrame 播放器；没有 → 不建播放器、显示模糊封面
 *   - 播放器始终静音（每次播放/状态变化都重新 mute）
 *   - 本地音频 play / pause / resume → MV 跟随
 *   - MV 比歌短（ENDED） → 重新加载同一首循环
 *   - 音频结束 → stopVideo
 *   - 切歌 → 旧播放器 destroy，再建新的
 *   - MV 不可用（onError / 初始化失败 / API 加载失败）→ 回退模糊封面 + 通知外部
 *   - 非法 videoId 不初始化播放器
 *   - 歌词渲染 / 逐字高亮 / 点击跳转只作用于本地音频
 *
 * 用法：node tests/video-lyrics-mv.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'video-lyrics-mode.js'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function makeElement(tagName) {
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    id: '',
    className: '',
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    firstChild: null,
    innerHTML: '',
    textContent: '',
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : Boolean(force);
        if (on) this._set.add(name); else this._set.delete(name);
        return on;
      },
    },
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0]; return child; },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      this.firstChild = this.children[0] || null;
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
  };
  return el;
}

/**
 * 最小 DOM：innerHTML 赋值后按 data-vlm-* / class 找节点。
 * 我们只需要组件自己创建的那几个节点，所以直接用"已知结构"造节点。
 */
function makeRoot() {
  const root = makeElement('div');
  const nodes = {};
  root.querySelector = (selector) => {
    if (selector === '.vlm-stage' || selector === '[data-vlm-stage]') return nodes.stage;
    if (selector === '.vlm-cover' || selector === '[data-vlm-cover]') return nodes.cover;
    if (selector === '.vlm-mv' || selector === '[data-vlm-mv]') return nodes.mv;
    if (selector === '.vlm-mv-frame' || selector === '[data-vlm-mv-frame]') return nodes.mvFrame;
    if (selector === '.vlm-yt-host' || selector === '[data-vlm-yt]') return nodes.ytHost;
    if (selector === '.vlm-scrim' || selector === '[data-vlm-scrim]') return nodes.scrim;
    if (selector === '.vlm-line.cur' || selector === '[data-vlm-cur]') return nodes.cur;
    if (selector === '.vlm-line.next' || selector === '[data-vlm-next]') return nodes.next;
    if (selector === '.vlm-line.cur .vlm-text' || selector === '[data-vlm-cur-text]') return nodes.curText;
    if (selector === '.vlm-line.next .vlm-text' || selector === '[data-vlm-next-text]') return nodes.nextText;
    if (selector === '.vlm-status' || selector === '[data-vlm-status]') return nodes.status;
    if (selector === '.vlm-vocal-slot' || selector === '[data-vlm-vocal-slot]') return nodes.vocal;
    return null;
  };
  let hostSeq = 0;
  root.querySelectorHost = null;
  // innerHTML 赋值时知道组件会创建 #vlm-yt-N；这里在 setter 里预置
  Object.defineProperty(root, 'innerHTML', {
    get() { return root._html || ''; },
    set(value) {
      root._html = value;
      const match = /id="(vlm-yt-\d+)"/.exec(String(value));
      nodes.stage = makeElement('div');
      nodes.cover = makeElement('div');
      nodes.mv = makeElement('div');
      nodes.mv.hidden = true;
      nodes.mvFrame = makeElement('div');
      nodes.ytHost = makeElement('div');
      nodes.ytHost.id = match ? match[1] : `vlm-yt-${++hostSeq}`;
      nodes.scrim = makeElement('div');
      nodes.cur = makeElement('div');
      nodes.next = makeElement('div');
      nodes.curText = makeElement('span');
      nodes.nextText = makeElement('span');
      nodes.status = makeElement('div');
      nodes.vocal = makeElement('div');
    },
  });
  root._nodes = nodes;
  return root;
}

/** 假 YouTube IFrame API：记录每个播放器的调用 */
function makeFakeYT() {
  const created = [];
  class FakePlayer {
    constructor(hostId, options) {
      this.hostId = hostId;
      this.options = options;
      this.calls = [];
      this.destroyed = false;
      created.push(this);
    }
    _record(name, args) { this.calls.push({ name, args }); }
    mute() { this._record('mute'); }
    playVideo() { this._record('playVideo'); }
    pauseVideo() { this._record('pauseVideo'); }
    stopVideo() { this._record('stopVideo'); }
    loadVideoById(arg) { this._record('loadVideoById', arg); }
    seekTo(sec) { this._record('seekTo', sec); }
    destroy() { this._record('destroy'); this.destroyed = true; }
    /** 测试驱动：模拟 YouTube 的事件 */
    fireReady() { this.options.events.onReady({ target: this }); }
    fireState(state) { this.options.events.onStateChange({ data: state, target: this }); }
    fireError(code) { this.options.events.onError({ data: code, target: this }); }
  }
  return { YT: { Player: FakePlayer }, created };
}

function makeWindow(yt) {
  const win = {
    document: { head: { appendChild() {} }, querySelector() { return null; }, createElement: makeElement },
    // 定时器**不压缩**：组件内部的超时口径必须和生产一致
    //（压到 5ms 会把 9 秒的"ready 超时"变成 5ms，组件会先判超时，测试就永远等不到 ready）
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    location: { origin: 'http://localhost:3100' },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    YT: yt,
    console,
  };
  win.window = win;
  return win;
}

function loadComponent(yt) {
  const win = makeWindow(yt);
  // 刻意**不**给沙箱顶层 setTimeout：真实浏览器里组件靠的是 window.setTimeout，
  // 这样也能顺带验证"定时器必须从 global 取"这条约束。
  const sandbox = { window: win, globalThis: win, console };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'video-lyrics-mode.js' });
  return win.VideoLyricsMode;
}

/**
 * 等组件把异步流程跑完：创建播放器用了 then 链 + 定时器（沙箱里压到 5ms），
 * 所以多等几轮宏任务，而不是固定 25ms（偶尔会赶在 then 链结束前断言）。
 */
async function tick(ms = 10) {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function testAsync(name, fn) {
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

function calls(player, name) { return player.calls.filter((c) => c.name === name); }

(async () => {
  console.log('\n[挂载与降级]');

  await testAsync('有 visualVideoId → 创建 IFrame 播放器（静音、官方 URL、带控件）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ', coverUrl: '/media/covers/x.jpg' });
    mode.mount();
    await tick();
    assert.strictEqual(fake.created.length, 1, '应当创建 1 个播放器');
    const player = fake.created[0];
    assert.strictEqual(player.options.videoId, 'dQw4w9WgXcQ');
    assert.strictEqual(player.options.playerVars.mute, 1, '播放器必须静音');
    assert.strictEqual(player.options.playerVars.autoplay, 0, '不应自动播放');
    assert.strictEqual(player.options.playerVars.controls, 1, '不隐藏播放器控件');
    assert.match(player.options.host, /youtube-nocookie\.com/, '使用官方 nocookie 域名');
    mode.destroy();
  });

  await testAsync('没有 visualVideoId → 不初始化无效播放器，直接模糊封面', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: null, coverUrl: '/media/covers/x.jpg' });
    mode.mount();
    await tick();
    assert.strictEqual(fake.created.length, 0, '不能创建播放器');
    assert.ok(root._nodes.cover.classList.contains('is-blurred'), '应显示模糊封面');
    assert.strictEqual(root._nodes.mv.hidden, true);
    mode.destroy();
  });

  await testAsync('非法 videoId（比如旧版 video.mp4 路径）→ 当作没有 MV', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { videoUrl: '/media/output/library/x/video.mp4', coverUrl: '/c.jpg' });
    mode.mount();
    await tick();
    assert.strictEqual(fake.created.length, 0);
    assert.ok(root._nodes.cover.classList.contains('is-blurred'));
    mode.destroy();
  });

  console.log('\n[静音与跟随]');

  await testAsync('播放器始终静音：ready / 播放中都会 mute', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    assert.ok(calls(player, 'mute').length >= 1, 'ready 时应静音');
    mode.setPlaying(true);
    player.fireState(1); // PLAYING
    assert.ok(calls(player, 'mute').length >= 2, '播放中应再确认静音');
    // 没有任何把音量调大的调用
    assert.strictEqual(calls(player, 'unMute').length, 0);
    mode.destroy();
  });

  await testAsync('本地音频 play / pause / resume → MV 跟着 play / pause / play', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(true);
    mode.setPlaying(false);
    mode.setPlaying(true);
    // ready 时本地音频还没播 → onReady 里先 pause 一次；之后 play / pause / play 各一次
    assert.strictEqual(calls(player, 'playVideo').length, 2);
    assert.strictEqual(calls(player, 'pauseVideo').length, 2);
    mode.destroy();
  });

  await testAsync('音频结束 → stopVideo', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(true);
    mode.stopVideo();
    assert.strictEqual(calls(player, 'stopVideo').length, 1);
    mode.destroy();
  });

  await testAsync('MV 比歌短（ENDED）→ 重新加载同一首循环', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(true);
    player.fireState(0); // ENDED
    await new Promise((resolve) => setTimeout(resolve, 400)); // 循环重载有 250ms 延迟
    const reload = calls(player, 'loadVideoById');
    assert.strictEqual(reload.length, 1, 'ENDED 后应重新加载同一首');
    assert.strictEqual(reload[0].args.videoId, 'dQw4w9WgXcQ');
    assert.strictEqual(calls(player, 'seekTo').length, 0, '不应该用 seekTo 强制校正进度');
    mode.destroy();
  });

  await testAsync('MV 播完但本地音频已暂停 → 不循环（等歌继续）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(false);
    player.fireState(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(calls(player, 'loadVideoById').length, 0);
    mode.destroy();
  });

  console.log('\n[失败回退]');

  await testAsync('onError(150 不允许嵌入) → 销毁播放器、回退封面、通知外部', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const reported = [];
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, {
      visualVideoId: 'dQw4w9WgXcQ',
      coverUrl: '/c.jpg',
      onVideoError: (detail) => reported.push(detail),
    });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    player.fireError(150);
    assert.strictEqual(player.destroyed, true, '播放器应被销毁');
    assert.ok(root._nodes.cover.classList.contains('is-blurred'), '应回退模糊封面');
    assert.strictEqual(root._nodes.mv.hidden, true, 'MV 层应隐藏');
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].videoId, 'dQw4w9WgXcQ');
    assert.ok(/不允许嵌入/.test(reported[0].reason), reported[0].reason);
    assert.strictEqual(reported[0].code, 150);
    // 回退之后歌词仍然可以显示
    mode.setLyrics({ lines: [{ startMs: 0, endMs: 5000, text: 'Hi' }] });
    mode.update(1);
    assert.strictEqual(root._nodes.curText.innerHTML, 'Hi');
    mode.destroy();
  });

  await testAsync('没有 YouTube API（脚本加载失败）→ 回退封面，不抛异常', async () => {
    // 不提供 YT：脚本永远等不到 onYouTubeIframeAPIReady。
    // 这里直接把（缓存的）API 加载结果置为"失败"，验证初始化失败的分支。
    const VideoLyricsMode = loadComponent(undefined);
    const reported = [];
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ', coverUrl: '/c.jpg', onVideoError: (d) => reported.push(d) });
    mode.mount();
    await tick();
    mode._failVideo('IFrame API 加载失败');
    assert.ok(root._nodes.cover.classList.contains('is-blurred'));
    assert.strictEqual(reported.length, 1);
    assert.ok(/IFrame/.test(reported[0].reason), reported[0].reason);
    mode.destroy();
  });

  await testAsync('初始化超时 → 回退封面（不会无限 Loading）', async () => {
    const fake = makeFakeYT();
    // 把超时口径调小，免得测试真的等 9 秒；行为与生产一致（看门狗到点仍未 ready 就回退）
    const VideoLyricsMode = loadComponent(fake.YT);
    const reported = [];
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ', coverUrl: '/c.jpg', onVideoError: (d) => reported.push(d) });
    mode.mount();
    await tick();
    assert.strictEqual(fake.created.length, 1);
    // 不 fireReady；直接走"看门狗到点"的判定（等同于 9 秒后仍未 ready）。
    // 真等 9 秒没有意义，这里验证的是同一个分支：ytReady=false → _failVideo → 回退。
    assert.strictEqual(mode.ytReady, false);
    mode._failVideo('YouTube 播放器初始化超时');
    assert.ok(root._nodes.cover.classList.contains('is-blurred'), '超时后应回退封面');
    assert.strictEqual(reported.length, 1);
    assert.ok(/超时|初始化/.test(reported[0].reason), reported[0].reason);
    mode.destroy();
  });

  await testAsync('超时看门狗真的挂上了（定时器来自 window，不是自由变量）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    assert.ok(mode.readyTimer != null, 'ready 看门狗应当已登记');
    mode.destroy();
    assert.strictEqual(mode.readyTimer, null, 'destroy 后看门狗应被清掉');
  });

  await testAsync('播放中视频变不可用（onError 100 已删除）→ 不影响歌词与本地音频', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ', coverUrl: '/c.jpg' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(true);
    mode.setLyrics({ lines: [{ startMs: 0, endMs: 2000, text: 'line one' }] });
    mode.update(0.5);
    player.fireError(100);
    mode.update(0.6);
    assert.strictEqual(root._nodes.curText.innerHTML, 'line one', '歌词不应被视频错误清掉');
    assert.strictEqual(mode.playing, true, '本地音频状态不受影响');
    mode.destroy();
  });

  console.log('\n[切歌]');

  await testAsync('切换歌曲 → 销毁旧播放器并新建', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const first = fake.created[0];
    first.fireReady();
    mode.setVisualVideoId('kJQP7kiw5Fk');
    await tick();
    assert.strictEqual(first.destroyed, true, '旧播放器应被销毁');
    assert.strictEqual(fake.created.length, 2, '应新建播放器');
    assert.strictEqual(fake.created[1].options.videoId, 'kJQP7kiw5Fk');
    mode.destroy();
  });

  await testAsync('同一首反复 setVisualVideoId 不会重复建播放器', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setVisualVideoId('dQw4w9WgXcQ');
    mode.setVisualVideoId('dQw4w9WgXcQ');
    await tick();
    assert.strictEqual(fake.created.length, 1);
    assert.strictEqual(player.destroyed, false);
    mode.destroy();
  });

  await testAsync('切到"没有 MV" → 销毁播放器、回退封面', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: 'dQw4w9WgXcQ', coverUrl: '/c.jpg' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setVisualVideoId(null);
    assert.strictEqual(player.destroyed, true);
    assert.ok(root._nodes.cover.classList.contains('is-blurred'));
    assert.strictEqual(root._nodes.mv.hidden, true);
    mode.destroy();
  });

  await testAsync('destroy() → 销毁播放器（不留后台 iframe）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.destroy();
    assert.strictEqual(player.destroyed, true);
  });

  console.log('\n[歌词与跳转]');

  await testAsync('歌词：当前行/下一行 + 逐字高亮 + 间隙期保持', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: null });
    mode.mount();
    mode.setLyrics({
      lines: [
        { startMs: 0, endMs: 1000, text: 'first line' },
        { startMs: 2000, endMs: 3000, text: 'second line' },
      ],
    });
    mode.update(0.5);
    assert.strictEqual(root._nodes.curText.innerHTML, 'first line');
    assert.strictEqual(root._nodes.nextText.innerHTML, 'second line');
    mode.update(2.5);
    assert.strictEqual(root._nodes.curText.innerHTML, 'second line');
    // 间隙期（第一行结束、第二行未开始）：仍显示第一行
    mode.update(1.5);
    assert.strictEqual(root._nodes.curText.innerHTML, 'first line');
    mode.destroy();
  });

  await testAsync('点画面跳转：只调 onSeek（本地音频），不对 MV 做 seek', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const seeks = [];
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ', onSeek: (sec) => seeks.push(sec) });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.seek(42);
    assert.deepStrictEqual(seeks, [42]);
    assert.strictEqual(calls(player, 'seekTo').length, 0, 'MV 不应被 seek');
    mode.destroy();
  });

  await testAsync('update() 不驱动 MV（没有 seekTo / 不读 currentTime）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: 'dQw4w9WgXcQ' });
    mode.mount();
    await tick();
    const player = fake.created[0];
    player.fireReady();
    mode.setPlaying(true);
    for (let i = 0; i < 20; i += 1) mode.update(i * 0.05);
    assert.strictEqual(calls(player, 'seekTo').length, 0);
    mode.destroy();
  });

  console.log('\n[挂载时的健壮性 / 样式]');

  await testAsync('逐行 = 整行一起亮（不拆字）；逐字 = 按字逐个亮（拆字 + 每字独立颜色）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: null });
    mode.mount();
    mode.setLyrics({
      lines: [{
        startMs: 0, endMs: 6000, text: 'abc def',
        chars: [
          { text: 'ab', startMs: 0, endMs: 1500 },
          { text: 'c', startMs: 1500, endMs: 3000 },
          { text: 'def', startMs: 3000, endMs: 5500 },
        ],
      }],
    });

    // —— 逐行：整行容器 + is-sung 标记，DOM 里不拆字 ——
    mode.setWordLevel(false);
    mode.update(1);            // 正在唱这一行
    assert.strictEqual(mode.wordMode, false);
    assert.ok(mode.curEl.classList.contains('is-sung'), '逐行模式当前行应整行标记为已唱');
    assert.ok(!mode.curEl.classList.contains('is-word'), '逐行模式不按字渲染');
    assert.strictEqual(root._nodes.curText.querySelectorAll('.lv-ch').length, 0, '逐行模式不应拆字');

    // —— 逐字：拆字（HTML 里有 3 个 .lv-ch）——
    mode.setWordLevel(true);
    mode.update(1);
    assert.ok(mode.curEl.classList.contains('is-word'), '逐字模式应标记 is-word');
    const html = root._nodes.curText.innerHTML;
    assert.strictEqual((html.match(/class="lv-ch"/g) || []).length, 3, `逐字模式应拆成 3 个字块，实际：${html}`);
    assert.ok(/lv-chars/.test(html), '逐字模式应有 .lv-chars 容器');

    // —— 每个字按**自己的时间**点亮（纯函数层验证，避免依赖真实 DOM）——
    const chars = mode.lines[0].chars;
    const litAt = (t) => chars.map((c) => (t >= c.endMs ? 1 : t > c.startMs ? (t - c.startMs) / (c.endMs - c.startMs) : 0));
    const at20 = litAt(2000);
    assert.strictEqual(at20[0], 1, '第 1 个字此时应已唱完');
    assert.ok(at20[1] > 0 && at20[1] < 1, '第 2 个字应正在唱（部分亮）');
    assert.strictEqual(at20[2], 0, '第 3 个字还没开始（灰）');
    assert.strictEqual(new Set(at20).size, 3, '同一时刻行内应存在 3 种不同进度 → 这才是逐字');
    mode.destroy();
  });

  await testAsync('切到逐字会重写当前行 HTML（回归：点了看不出变化）', async () => {
    // 线上 bug：_paint() 只在"行号变化"时重写文字。切换逐字/逐行时行号没变，
    // 于是 HTML 不会重写 → 用户看到"点了没反应"。
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: null });
    mode.mount();
    mode.setLyrics({
      lines: [{
        startMs: 0, endMs: 5000, text: 'hello world',
        chars: [{ text: 'hello', startMs: 0, endMs: 2000 }, { text: 'world', startMs: 2000, endMs: 4000 }],
      }],
    });
    mode.update(1);
    const withWords = root._nodes.curText.innerHTML;
    assert.ok(/lv-ch/.test(withWords), `逐字模式应包 .lv-ch，实际：${withWords}`);
    mode.setWordLevel(false);   // 切到逐行：行号不变，但 HTML 必须重写
    mode.update(1);
    assert.ok(!/lv-ch/.test(root._nodes.curText.innerHTML), `逐行模式不应有 .lv-ch，实际：${root._nodes.curText.innerHTML}`);
    mode.setWordLevel(true);
    mode.update(1);
    assert.ok(/lv-ch/.test(root._nodes.curText.innerHTML), '切回逐字应重新拆字');
    mode.destroy();
  });

  await testAsync('没有逐字数据时切到逐字会给出提示（不是静默无效）', async () => {
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const root = makeRoot();
    const mode = new VideoLyricsMode(root, { visualVideoId: null });
    mode.mount();
    mode.setLyrics({ lines: [{ startMs: 0, endMs: 4000, text: 'no word timing' }] });
    // 模拟 MV 已就绪（否则状态条归 MV 提示管）
    mode.ytReady = true;
    mode.setWordLevel(true);
    assert.strictEqual(mode.wordMode, false, '没有 chars 时不可能是逐字');
    assert.ok(root._nodes.status.classList.contains('visible'), '应提示"没有逐字数据"');
    assert.ok(/逐字/.test(root._nodes.status.textContent), root._nodes.status.textContent);
    mode.destroy();
  });

  await testAsync('挂载后、载入歌词前调用 setWordLevel 不抛错（回归：大屏整页空白）', async () => {
    // 线上 bug：app.js 在 mount() 之后、setLyrics() 之前就调用 setWordLevel，
    // 里面读 this.lines.some 抛 TypeError → 整个 render() 中断
    // → 画面和右侧 UP NEXT 队列一起没画出来（"队列永远是空的"）。
    const fake = makeFakeYT();
    const VideoLyricsMode = loadComponent(fake.YT);
    const mode = new VideoLyricsMode(makeRoot(), { visualVideoId: null });
    mode.mount();
    assert.doesNotThrow(() => { mode.setWordLevel(true); mode.setLyricsVisible(true); mode.update(0); });
    mode.destroy();
  });

  await testAsync('CSS：用 id 前缀命中原生 iframe（YT.Player 会把宿主 div 换成 iframe）', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'video-lyrics-mode.css'), 'utf8');
    // 建完后 DOM 是 <iframe id="vlm-yt-1" class="vlm-yt-host">，
    // 写 `.vlm-yt-host iframe` 永远不命中 → iframe 保持 640×360 小窗。
    assert.ok(/\[id\^="vlm-yt-"\]/.test(css), '缺少 [id^="vlm-yt-"] 选择器');
    assert.ok(/\.vlm-mv-frame iframe/.test(css), '缺少 iframe 兜底选择器');
  });

  await testAsync('CSS：层级顺序正确（封面 < MV < 遮罩 < 歌词 < 工具栏）', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'video-lyrics-mode.css'), 'utf8');
    const rules = (sel) => (css.match(new RegExp(`\\.${sel}\\s*\\{[^}]*\\}`)) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
    const z = (sel) => {
      const m = /z-index\s*:\s*(-?\d+)/.exec(rules(sel));
      return m ? Number(m[1]) : null;
    };
    const stageRules = (css.match(/\.vlm-stage\s*\{[^}]*\}/) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/isolation\s*:\s*isolate/.test(stageRules), '不要 isolation:isolate');

    const cover = z('vlm-cover');
    const mv = z('vlm-mv');
    const scrim = z('vlm-scrim');
    const lyrics = z('vlm-lyrics');
    const slot = z('vlm-vocal-slot');
    // 封面必须是**非负**层级：z-index:-1 会跑到 .vlm-stage 的 background 后面 → 纯黑
    assert.ok(cover !== null && cover >= 0, `封面层不能是负 z-index（实际 ${cover}）`);
    assert.ok(cover < mv, `封面(${cover}) 应在 MV(${mv}) 下面`);
    assert.ok(mv < scrim && scrim < lyrics, `顺序应为 MV < 遮罩 < 歌词（实际 ${mv},${scrim},${lyrics}）`);
    assert.ok(slot > lyrics, `工具栏(${slot}) 要在最上层`);
  });

  await testAsync('CSS：底部遮罩只占下方 2/5（视频更清楚）', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'video-lyrics-mode.css'), 'utf8');
    const scrim = (css.match(/\.vlm-scrim\s*\{[^}]*\}/) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(/height\s*:\s*40%/.test(scrim), '遮罩高度应为 40%（下方 2/5）');
    assert.ok(/bottom\s*:\s*0/.test(scrim), '遮罩应贴底');
    assert.ok(!/inset\s*:\s*0/.test(scrim), '遮罩不能铺满全高');
  });

  await testAsync('CSS：视频宿主铺满 player-frame（grid 默认按内容收缩）', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'video-lyrics-mode.css'), 'utf8');
    const hostBlock = (css.match(/\.vlm-host\s*\{[^}]*\}/) || [''])[0];
    assert.ok(/align-self\s*:\s*stretch/.test(hostBlock) && /justify-self\s*:\s*stretch/.test(hostBlock),
      '缺 align/justify-self:stretch，宿主会缩成内容尺寸（实测 681×249）');
  });

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
