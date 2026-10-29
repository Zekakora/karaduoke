'use strict';
/**
 * 歌词滚动居中测试（不依赖浏览器）
 *
 * 覆盖两个真实修过的毛病：
 *   1. 落点不准 —— 旧实现先按"当前几何"算一个固定目标，动画跑完时字号过渡
 *      还在进行、布局已变，落点就偏了，只能事后微调（看起来"跳完再抖一下"）。
 *      现在目标每帧重算，t=1 时落点 == 当时的理想中线。
 *   2. 激活时重新换行 —— 旧实现改 font-size 会触发排版，
 *      一行歌词放大过程中突然折成两行，动画很怪。现在布局字号恒定、只用 transform 缩放。
 *
 * 用法：node tests\lyrics-centering.test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'lyrics-view.js'), 'utf8');

function extractMethod(name) {
  const marker = `LyricsView.prototype.${name} = function`;
  const i = SRC.indexOf(marker);
  if (i < 0) throw new Error(`找不到 ${name}`);
  let k = SRC.indexOf('{', i);
  let depth = 0;
  for (; k < SRC.length; k += 1) {
    if (SRC[k] === '{') depth += 1;
    else if (SRC[k] === '}') { depth -= 1; if (depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error(`括号不配对：${name}`);
}

/** 假时钟 + 手动驱动的 rAF */
function makeRaf() {
  let clock = 0;
  const pending = new Map();
  let nextId = 1;
  return {
    now: () => clock,
    advance: (ms) => { clock += ms; },
    raf: (fn) => { const id = nextId++; pending.set(id, fn); return id; },
    cancel: (id) => { pending.delete(id); },
    /** 跑一帧（按当前时钟） */
    tick() {
      const batch = [...pending.entries()];
      pending.clear();
      for (const [, fn] of batch) fn(clock);
      return batch.length;
    },
  };
}

let passed = 0; let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 造一个 LyricsView 实例（只带滚动相关的最小状态） */
function makeInstance({ lines, clientHeight = 600, scrollTop = 0 }) {
  const raf = makeRaf();
  const sandbox = {
    console, Math, Number, Object, Array,
    performance: { now: raf.now },
    requestAnimationFrame: raf.raf,
    cancelAnimationFrame: raf.cancel,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `function LyricsView(){}\n${extractMethod('centerNode')}\n${extractMethod('scrollToActive')}`,
    sandbox
  );
  const inst = new sandbox.LyricsView();
  inst.state = { following: true, activeIndex: 1, sungIndex: 1, scrollRaf: 0 };
  inst.scroller = { clientHeight, scrollTop };
  inst.track = { querySelectorAll: () => lines };
  return { inst, raf };
}

const idealCenter = (line, clientHeight) => line.offsetTop + line.offsetHeight / 2 - clientHeight / 2;

// ---------------------------------------------------------------------------
test('稳定布局：动画结束后精确停在中线', () => {
  const lines = [
    { offsetTop: 0, offsetHeight: 58 },
    { offsetTop: 84, offsetHeight: 58 },
    { offsetTop: 168, offsetHeight: 58 },
  ];
  const { inst, raf } = makeInstance({ lines, clientHeight: 600 });
  inst.scrollToActive();
  for (let i = 0; i < 60 && raf.tick(); i += 1) raf.advance(16);
  const want = idealCenter(lines[1], 600);
  assert(Math.abs(inst.scroller.scrollTop - want) < 0.5,
    `期望 ${want}，实际 ${inst.scroller.scrollTop}`);
});

test('行高在动画期间变大：落点跟着走，不用事后补正', () => {
  // 模拟"激活行从 1 行变 2 行"：动画过程中 offsetHeight/后续行 offsetTop 都在变
  const lines = [
    { offsetTop: 0, offsetHeight: 58 },
    { offsetTop: 84, offsetHeight: 58 },
    { offsetTop: 168, offsetHeight: 58 },
  ];
  const { inst, raf } = makeInstance({ lines, clientHeight: 600 });
  inst.scrollToActive();
  let frames = 0;
  while (frames < 60) {
    // 每帧让激活行长得更高（相当于字号过渡），并把它后面的行往下推
    const grow = Math.min(58, frames * 3);
    lines[1].offsetHeight = 58 + grow;
    lines[2].offsetTop = 84 + 58 + grow;
    if (!raf.tick()) break;
    raf.advance(16);
    frames += 1;
  }
  const want = idealCenter(lines[1], 600);
  assert(Math.abs(inst.scroller.scrollTop - want) < 0.5,
    `期望 ${want}，实际 ${inst.scroller.scrollTop}（差 ${(inst.scroller.scrollTop - want).toFixed(2)}）`);
});

test('动画结束后不需要再滚动一次（旧的 trackCenter 微调应该无事可做）', () => {
  const lines = [
    { offsetTop: 0, offsetHeight: 58 },
    { offsetTop: 84, offsetHeight: 58 },
    { offsetTop: 168, offsetHeight: 58 },
  ];
  const { inst, raf } = makeInstance({ lines, clientHeight: 600 });
  inst.scrollToActive();
  while (raf.tick()) raf.advance(16);
  const settled = inst.scroller.scrollTop;
  // 再算一次理想位置，差值必须极小
  const want = idealCenter(lines[1], 600);
  assert(Math.abs(settled - want) < 0.5, `收尾后偏离 ${(settled - want).toFixed(2)}px`);
});

test('滚动过程方向一致（不出现"先过冲再回弹"）', () => {
  const lines = [
    { offsetTop: 0, offsetHeight: 58 },
    { offsetTop: 84, offsetHeight: 58 },
    { offsetTop: 168, offsetHeight: 58 },
  ];
  const { inst, raf } = makeInstance({ lines, clientHeight: 600, scrollTop: 0 });
  inst.scrollToActive();
  const path = [];
  while (raf.tick()) { path.push(inst.scroller.scrollTop); raf.advance(16); }
  // 方向可能为正也可能为负（取决于目标在当前位置的上方还是下方），
  // 所以只要求所有步进同号 —— 出现反向步进就是"过冲再回弹"。
  let dir = 0;
  for (let i = 1; i < path.length; i += 1) {
    const d = path[i] - path[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    if (dir === 0) dir = Math.sign(d);
    else assert(Math.sign(d) === dir,
      `第 ${i} 步反向：${path[i - 1].toFixed(1)} → ${path[i].toFixed(1)}`);
  }
});

test('用户手动滚动（following=false）时动画立即放弃', () => {
  const lines = [
    { offsetTop: 0, offsetHeight: 58 },
    { offsetTop: 84, offsetHeight: 58 },
    { offsetTop: 168, offsetHeight: 58 },
  ];
  const { inst, raf } = makeInstance({ lines, clientHeight: 600 });
  inst.scrollToActive();
  raf.tick(); raf.advance(16);
  inst.state.following = false;
  const frozen = inst.scroller.scrollTop;
  while (raf.tick()) raf.advance(16);
  assert(Math.abs(inst.scroller.scrollTop - frozen) < 0.5, '被打断后仍在滚动');
});

// ---------------------------------------------------------------------------
// CSS 层：验证「布局字号恒定 + transform 缩放」
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'lyrics-view.css'), 'utf8');

test('CSS：.lv-line 基础态用 transform 缩小，不改字号', () => {
  assert(/\.lv-line \{[^}]*transform: scale\(\.72\)/.test(CSS), '.lv-line 没有 transform: scale(.72)');
});

test('CSS：激活态不改 font-size（只有 transform 变）', () => {
  // 移动端的媒体查询里可以有另一个字号，那对两种状态一视同仁，不影响布局稳定性。
  // 真正要防的是「.lv-line.active .lv-text 改字号」。
  assert(!/\.lv-line\.active\s+\.lv-text\s*\{[^}]*font-size/.test(CSS),
    '.lv-line.active .lv-text 仍然改 font-size，会在放大过程中重新换行');
});

test('CSS：激活态恢复到 scale(1)', () => {
  assert(/\.lv-line\.active \{[^}]*transform: scale\(1\)/.test(CSS), '.lv-line.active 没有 transform: scale(1)');
});

test('CSS：不再有 font-size 过渡（否则仍会重新排版）', () => {
  assert(!/transition:[^;]*font-size/.test(CSS), '仍有 font-size 过渡，会导致换行点变化');
});

console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
if (failed) {
  process.exitCode = 1;
  for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
}
