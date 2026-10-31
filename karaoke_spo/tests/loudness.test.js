'use strict';
/**
 * 伴奏响度均衡单元测试。
 *
 * 覆盖：
 *   - lib/karaoke-mixer.js 的 Mixer.computeLoudnessGain（核心增益计算，纯函数）
 *   - Mixer.prototype.setLoudness（把测量值 + 配置套进 normGain 节点，不抛错）
 *   - lib/loudness.js 的 enabled()/status() 返回形状（不崩溃、字段齐全）
 *
 * 不联网、不起 ffmpeg：增益计算是纯数学，浏览器文件的 DOM 依赖用最小桩顶掉。
 *
 * 用法：node tests/loudness.test.js
 */
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';

const assert = require('node:assert');
const path = require('node:path');

// ----------------------------------------------------------------- 浏览器环境壳
// karaoke-mixer.js 末尾是 IIFE(window)，getContext 内部读 global.AudioContext，
// 用最小桩顶掉，让文件能被 Node require、Mixer 能被实例化。
class FakeParam {
  constructor(v) { this.value = v; }
  cancelScheduledValues() {}
  setTargetAtTime() {}
  setValueAtTime() {}
}
class FakeNode {
  constructor() { this.gain = new FakeParam(1); this.buffer = null; }
  connect() {} disconnect() {} start() {} stop() {}
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  createGain() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
}
global.AudioContext = FakeCtx;
global.window = global;

require(path.join(__dirname, '..', 'public', 'karaoke-mixer.js'));
const Mixer = global.KaraokeMixer;
const loudness = require(path.join(__dirname, '..', 'lib', 'loudness.js'));

let passed = 0;
let failed = 0;
const failures = [];
function record(name, error) {
  if (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
  else { passed += 1; console.log(`  ✓ ${name}`); }
}
function test(name, fn) { try { fn(); record(name, null); } catch (error) { record(name, error); } }
async function testAsync(name, fn) { try { await fn(); record(name, null); } catch (error) { record(name, error); } }

const CFG = { enabled: true, targetLufs: -18, truePeakCeiling: -1, maxGainDb: 12, maxCutDb: 12 };

(async () => {
  try {
    // ------------------------------------------------------------ 自动均衡关闭
    await testAsync('关闭自动均衡 → 增益 0（不动原始电平）', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -12 }, { ...CFG, enabled: false });
      assert.strictEqual(r.gainDb, 0);
      assert.strictEqual(r.gain, 1);
      assert.strictEqual(r.limitedBy, null);
      assert.ok(/未启用/.test(r.reason));
    });

    // ------------------------------------------------------------ 没有测量数据
    await testAsync('没有响度数据（measured 为 null）→ 增益 0', () => {
      const r = Mixer.computeLoudnessGain(null, { ...CFG });
      assert.strictEqual(r.gainDb, 0);
      assert.strictEqual(r.gain, 1);
      assert.ok(/没有响度数据/.test(r.reason));
    });

    await testAsync('有对象但 lufs 非数字 → 增益 0', () => {
      const r = Mixer.computeLoudnessGain({ lufs: 'n/a' }, { ...CFG });
      assert.strictEqual(r.gainDb, 0);
      assert.strictEqual(r.gain, 1);
    });

    // ------------------------------------------------------------ 响度对齐
    await testAsync('测量值偏高（−12 vs 目标 −18）→ 压低 6dB', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -12 }, { ...CFG });
      assert.strictEqual(r.gainDb, -6);
      assert.ok(Math.abs(r.gain - Math.pow(10, -6 / 20)) < 1e-6);
      assert.strictEqual(r.limitedBy, null);
    });

    await testAsync('测量值偏低（−24 vs 目标 −18）→ 提升 6dB', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -24 }, { ...CFG });
      assert.strictEqual(r.gainDb, 6);
      assert.ok(Math.abs(r.gain - Math.pow(10, 6 / 20)) < 1e-6);
      assert.strictEqual(r.limitedBy, null);
    });

    await testAsync('无真峰值字段时不触发真峰值保护', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -24 }, { ...CFG });
      assert.strictEqual(r.limitedBy, null);
      assert.strictEqual(r.gainDb, 6);
    });

    // ------------------------------------------------------------ 真峰值保护
    await testAsync('补增益会顶破真峰值上限 → 被压回（true-peak）', () => {
      // 测出 −24 LUFS，但真峰值已经 −3 dBFS；目标峰值上限 −1 → 最多只能 +2dB
      const r = Mixer.computeLoudnessGain({ lufs: -24, truePeakDbfs: -3 }, { ...CFG });
      assert.strictEqual(r.gainDb, 2);
      assert.strictEqual(r.limitedBy, 'true-peak');
      assert.ok(Math.abs(r.gain - Math.pow(10, 2 / 20)) < 1e-6);
    });

    // ------------------------------------------------------------ 范围钳制
    await testAsync('非常安静的歌 → 被最大增益钳住（max-gain）', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -40 }, { ...CFG });
      assert.strictEqual(r.gainDb, 12);
      assert.strictEqual(r.limitedBy, 'max-gain');
    });

    await testAsync('非常响的歌 → 被最大衰减钳住（max-cut）', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -5 }, { ...CFG });
      assert.strictEqual(r.gainDb, -12);
      assert.strictEqual(r.limitedBy, 'max-cut');
    });

    // ------------------------------------------------------------ 配置兜底
    await testAsync('缺省 targetLufs → 回退 −18', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -12 }, { enabled: true });
      assert.strictEqual(r.gainDb, -6);
    });

    await testAsync('缺省 truePeakCeiling → 回退 −1，不影响真峰值计算', () => {
      const r = Mixer.computeLoudnessGain({ lufs: -24, truePeakDbfs: -3 }, { enabled: true, targetLufs: -18, maxGainDb: 12, maxCutDb: 12 });
      assert.strictEqual(r.gainDb, 2);
    });

    // ------------------------------------------------------------ setLoudness 包装
    await testAsync('setLoudness 作用在 normGain（播放中可调用，不抛错）', () => {
      const m = new Mixer();
      const r = m.setLoudness({ lufs: -12, truePeakDbfs: -6 }, { ...CFG });
      assert.strictEqual(r.gainDb, -6);
      assert.strictEqual(m.loudnessApplied, true);
      assert.strictEqual(m.loudnessGainDb, -6);
      // 关闭时回到原始电平
      const off = m.setLoudness({ lufs: -12 }, { ...CFG, enabled: false });
      assert.strictEqual(off.gainDb, 0);
      assert.strictEqual(m.loudnessApplied, false);
      m.destroy();
    });

    // ------------------------------------------------------------ lib/loudness 可用状态
    await testAsync('loudness.status() 返回完整形状且字段类型正确', () => {
      const s = loudness.status();
      assert.strictEqual(typeof s.available, 'boolean');
      assert.strictEqual(typeof s.pythonExists, 'boolean');
      assert.strictEqual(typeof s.scriptExists, 'boolean');
      assert.strictEqual(typeof s.cooling, 'boolean');
      assert.strictEqual(typeof s.cooldownRemainingSec, 'number');
      // 没有错误时 lastError 为 null，出错时为字符串
      assert.ok(s.lastError === null || typeof s.lastError === 'string');
    });

    await testAsync('loudness.enabled() 返回布尔', () => {
      assert.strictEqual(typeof loudness.enabled(), 'boolean');
    });

    await testAsync('loudness.measure 失败也返回对象、不抛异常', async () => {
      // 用一个根本不在曲库里的 id：python 跑完只会说 NO_ACCOMPANIMENT，
      // 属于"这首歌没法测"，不应让测量器整体冷却。
      const out = await loudness.measure('ZZZZZZZZZZZZZZZZZZZZZZ', { force: false });
      assert.strictEqual(typeof out, 'object');
      assert.strictEqual(out.ok, false);
      assert.ok(out.code, '应该有错误码');
    });

  } catch (error) {
    console.error('测试运行异常：', error);
    failed += 1;
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) { process.exitCode = 1; }
  }
})();
