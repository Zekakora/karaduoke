# 人声混合强度（Vocal Mix）

> 让用户连续调节原唱/伴奏比例，用于 KTV 带唱、学歌、纯伴奏演唱等场景。

## 为什么必须用 Web Audio

**错误做法**：两个 `<audio>` 元素，一个放伴奏一个放人声，各自调 `volume`。

问题：即使把 `currentTime` 对齐，两个媒体元素走的是**不同的解码时钟**，
播放几分钟后会漂移几十毫秒。叠加后产生**梳状滤波** —— 听感是"人声像被闷住"、
"声音发虚"、"有时响有时轻"。

**正确做法**：`AudioBufferSourceNode` 全部从**同一个 `AudioContext`** 派生：

```js
const when = ctx.currentTime + 0.02;   // 同一调度时刻
acc.start(when, offset);
voc.start(when, offset);               // → 采样级精确同步
```

两者共享 `ctx.currentTime` 这一个时钟源，无论播多久都不会相对漂移。

## 实现：`karaoke-hub/public/karaoke-mixer.js`

### 信号链

```
accompaniment BufferSource ──────────────────┐
                                             ├──→ masterGain ──→ DynamicsCompressor ──→ destination
vocals BufferSource ──→ vocGain ─────────────┘
                          ↑
                    人声强度滑块 0..1
```

`DynamicsCompressor` 参数（当限幅器用）：
```js
threshold = -2      // 只在接近满幅时动作
knee = 0            // 硬拐点
ratio = 20          // 接近限幅
attack = 0.003
release = 0.12
```

### API

| 方法 | 说明 |
| --- | --- |
| `new KaraokeMixer({ accompanimentUrl, vocalsUrl, onTimeUpdate, onEnded })` | 构造 |
| `await load()` | 拉取并解码两条轨；可重复调用 |
| `await play()` / `pause()` / `await toggle()` | 播放控制 |
| `seek(sec)` | 播放中会重建 source；暂停时只记位置 |
| `getCurrentTime()` | 秒，语义等同 `<audio>.currentTime`，可直接喂歌词视图 |
| `setVocalLevel(0..1)` | 人声强度，内部用 `setTargetAtTime(…, 0.03)` 平滑，避免拖动时"咔哒"声 |
| `setVolume(0..1)` | 总音量 |
| `setMuted(bool)` | 静音（不丢失 `vocalLevel` 记忆值） |
| `destroy()` | 释放 AudioContext |

### 几个实现细节

**1. 不用重建 source 来做暂停**
`BufferSource` 是一次性的，暂停后无法 restart。所以暂停记 `pausedAt`，
恢复时 `_startSources(pausedAt)` 重新创建 —— 但两条轨仍然**同时 start**。

**2. 调度余量 20ms**
```js
const when = ctx.currentTime + 0.02;
```
不留余量会触发浏览器 "start() called after it has already passed" 警告，
表现为开头一小段被跳过。

**3. `decodeAudioData` 需要传副本**
```js
ctx.decodeAudioData(raw.slice(0))
```
某些浏览器实现会 **detach** 传入的 ArrayBuffer，直接传会导致后续复用时出错。

**4. 两轨长度校验**
```js
this.duration = Math.min(acc.duration, voc.duration);
```
不等长时取短，避免尾部出现"只有伴奏、没有人声"的单边段。

## 实测验证

脚本：`scripts/verify_mixer_alignment.js`

```
=== 1) 长度对齐 ===
  伴奏样本数: 15851567  (359.446s)
  人声样本数: 15851567  (359.446s)
  原曲样本数: 15851567  (359.446s)
  伴奏 vs 人声 差: 0 样本 = 0.00 ms  ✅ 完全一致

=== 2) 混音数学正确性 ===
  能量预测 √(acc²+voc²) = 0.16645
  相对误差 = 4.51%
  峰值 acc=0.9107 voc=0.8676 orig=0.8980

=== 4) 人声增益对峰值的影响 ===
  vocal=  0%  混音峰值=0.9107  ✅ 安全
  vocal= 25%  混音峰值=0.9048  ✅ 安全
  vocal= 50%  混音峰值=0.9525  ✅ 安全
  vocal= 75%  混音峰值=1.0089  ⚠️ 超 1.0 需限幅
  vocal=100%  混音峰值=1.0742  ⚠️ 超 1.0 需限幅

=== 结论 ===
  两轨等长:        ✅
  混音对应关系:    ✅（能量误差 4.51%）
  Web Audio 可用:  ✅ 同时 start 即可，无需额外对齐
```

**结论解读**：
- 两轨**逐样本完全等长**（差 0 样本），所以同时 start 就够了，不需要任何对齐补偿
- 能量误差 4.51% 来自 MP3 有损编码 + Demucs 四轨近似正交，属正常范围
- **人声超过 ~70% 时混音峰值会破 1.0** —— 所以主输出必须有 limiter，这不是可选项

## 顺带修的一个真实缺陷：伴奏削波

做这个功能时验证峰值，发现 `accompaniment.mp3` 峰值是 **1.3700** ——
**已经削波了**，听起来会失真。

原因是 `finalize_track.py` 的旧逻辑：

```python
# version 1（错误）
guide, guide_peak = safe(guide)
original, original_peak = safe(original)
# accompaniment 和 vocals 保持原样 —— 但三轨相加早就超 1.0 了
```

`drums + bass + other` 相加峰值 1.37，直接写进 MP3 就是削波。

**更严重的是**：只压 `guide`/`original` 会让**轨间电平关系错乱**。
播放时 `acc*g + voc*g` 不再对应 `original`，混音滑块的听感就是错的。

**修复**（version 2）：用**统一增益**缩放所有轨，保持相对比例：

```python
TARGET_PEAK = 0.89          # -1dBFS，给 MP3 过冲留余量
raw_peak = float(np.abs(original).max())
unity_gain = (TARGET_PEAK / raw_peak) if raw_peak > TARGET_PEAK else 1.0

accompaniment *= unity_gain
vocals *= unity_gain
original *= unity_gain
guide = accompaniment + vocals * db_to_linear(guide_db)   # 用缩放后的值重算
```

为什么目标值是 0.89 而不是 0.99：**MP3 是有损压缩，解码后会有过冲**
（实测 PCM 0.99 解码后约 1.03~1.05）。留 1dB 余量才安全。

修复后：
```
[i] 统一增益 0.8791（原始峰值 1.0124）
     accompaniment  peak=0.9018
     vocals         peak=0.8704
     guide          peak=0.8900
     original       peak=0.8900
```

## 算法版本守卫

改了混音算法后遇到一个问题：**重跑 `finalize` 时被幂等逻辑跳过，产物还是旧的削波版本**。

根因：`finalize` 的幂等条件是"4 个 MP3 已存在就跳过"，它不知道算法变了。

修复：`manifest.json` 记录 `algorithmVersion`：

```python
ALGORITHM_VERSION = 2   # 1 = 旧削波版，2 = 统一增益
```

- 版本不匹配 → 拒绝跳过，提示"请重跑 separate 步骤"（因为中间 WAV 已清理）
- 同时 `pipeline.py` 加了 `--force-separate` 参数

**教训**：任何"产物已存在就跳过"的幂等逻辑，都必须把**算法版本**纳入判断。
否则代码改了，产物还是旧行为，而且从输出上看不出任何异常。

## 一个测量陷阱

验证峰值时如果图省事用 `ffmpeg -ac 1`（下混单声道）会得到**虚高的峰值**：

```
立体声解码:  accompaniment peak = 0.9107
下混单声道:  accompaniment peak = 1.2347   ← 假的
```

原因：`-ac 1` 做的是 `(L+R)/2`，当两个声道存在相位差时，
相减的部分被保留、相加的部分被抵消，**峰值反而升高**。

**必须用 `-ac 2` 保留立体声测峰值。**

同理，验证"original ≈ accompaniment + vocals"也不能用逐样本差的绝对值最大值 ——
如果对两轨分别取了"两声道中较大的那个"，前者可能来自左声道、后者来自右声道，
相加结果与 original 的声道最大值不对应，误差会被放大到 1.15（实际只有 4.51%）。
正确做法是比**能量（RMS）关系**：`√(acc² + voc²) ≈ RMS(original)`。
