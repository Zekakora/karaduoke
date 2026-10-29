/**
 * Web Audio 双源混音器 —— 人声强度连续可调
 *
 * 为什么要自己写而不是用两个 <audio>：
 *   两个独立 <audio> 即使 currentTime 对齐，几分钟后会漂移几十毫秒，
 *   叠加后产生梳状滤波（听感"发虚"、人声像被闷住）。
 *   AudioBufferSourceNode 全部从同一个 AudioContext 时钟派生，
 *   start(0, offset) 在同一时刻调用 → **采样级同步，永不漂移**。
 *
 * 设计要点：
 *   1. 伴奏与人声解码为 AudioBuffer，共享同一个 offset 启动
 *   2. 人声走 GainNode，滑块 0~1 直接映射到 gain（0 = 纯伴奏，1 = 纯人声）
 *      注意 gain=1 时人声与伴奏同为原始电平，相加可能超过 1.0 → 主输出加限幅
 *   3. 暂停/恢复不重建 source（重建会有 seek 延迟），而是 stop 后按 offset 重开
 *   4. 提供 getCurrentTime()，与 <audio>.currentTime 语义一致，便于歌词视图对接
 */
(function (global) {
  'use strict';

  /**
   * 整个页面只用一个 AudioContext。
   *
   * 以前每切一首歌都 close() 再 new 一个：浏览器会在新上下文上重新执行自动播放
   * 策略，即使刚点过页面、甚至加了 --autoplay-policy 参数，也经常又变 suspended，
   * 表现就是「从没播放到播放必须再点一下」。
   * 复用同一个已解锁的 context 后，一次手势解锁对后续所有歌曲都有效；
   * 即使浏览器策略把首次上下文挂起，也只需要在页面加载后点一次。
   */
  let sharedContext = null;

  function getSharedContext() {
    if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not supported in this browser');
    sharedContext = new AC({ latencyHint: 'playback' });
    return sharedContext;
  }

  function Mixer(options) {
    const opts = options || {};
    this.accompanimentUrl = opts.accompanimentUrl || null;
    this.vocalsUrl = opts.vocalsUrl || null;
    this.onEnded = opts.onEnded || null;
    this.onTimeUpdate = opts.onTimeUpdate || null;

    this.ctx = null;
    this.accBuffer = null;
    this.vocBuffer = null;

    this.accSource = null;
    this.vocSource = null;
    this.vocGain = null;
    this.masterGain = null;
    this.limiter = null;

    this.vocalLevel = 1.0;      // 0..1
    this.muted = false;         // 静音（不影响 vocalLevel 的记忆值）
    this.playing = false;
    this.startedAtCtxTime = 0;  // ctx.currentTime 时刻开始的
    this.offsetAtStart = 0;     // 那一时刻对应的曲目内秒数
    this.pausedAt = 0;          // 暂停时停在的曲目内秒数
    this.duration = 0;

    this._timer = null;
  }

  Mixer.prototype._ensureContext = function _ensureContext() {
    if (this.ctx) return this.ctx;
    this.ctx = getSharedContext();

    // 人声增益
    this.vocGain = this.ctx.createGain();
    this.vocGain.gain.value = this.vocalLevel;

    // 主输出 + 限幅（防止伴奏+人声相加削波）
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -2;
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;

    this.vocGain.connect(this.masterGain);
    this.masterGain.connect(comp);
    comp.connect(this.ctx.destination);
    this.limiter = comp;
    return this.ctx;
  };

  Mixer.prototype._fetchArrayBuffer = async function _fetchArrayBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load (${res.status}): ${url}`);
    return res.arrayBuffer();
  };

  /** 加载并解码两条轨；可重复调用（已加载则跳过） */
  Mixer.prototype.load = async function load() {
    const ctx = this._ensureContext();
    if (this.accBuffer && this.vocBuffer) return this;

    const [accRaw, vocRaw] = await Promise.all([
      this._fetchArrayBuffer(this.accompanimentUrl),
      this._fetchArrayBuffer(this.vocalsUrl),
    ]);

    // decodeAudioData 会改变 ArrayBuffer，需传副本（某些浏览器实现差异）
    const [acc, voc] = await Promise.all([
      ctx.decodeAudioData(accRaw.slice(0)),
      ctx.decodeAudioData(vocRaw.slice(0)),
    ]);

    this.accBuffer = acc;
    this.vocBuffer = voc;
    // 两轨应严格等长；不等长取短，避免尾部出现单边声
    this.duration = Math.min(acc.duration, voc.duration);
    if (Math.abs(acc.duration - voc.duration) > 0.05) {
      console.warn(
        `[Mixer] 两轨时长不一致 acc=${acc.duration.toFixed(3)}s voc=${voc.duration.toFixed(3)}s，` +
        `按 ${this.duration.toFixed(3)}s 处理`
      );
    }
    return this;
  };

  Mixer.prototype._startSources = function _startSources(offsetSec) {
    const ctx = this.ctx;
    const offset = Math.max(0, Math.min(offsetSec, this.duration));

    this._stopSources();

    const acc = ctx.createBufferSource();
    acc.buffer = this.accBuffer;
    acc.connect(this.masterGain);

    const voc = ctx.createBufferSource();
    voc.buffer = this.vocBuffer;
    voc.connect(this.vocGain);

    // 同一个 start 时刻 —— 这是采样级同步的关键
    const when = ctx.currentTime + 0.02; // 留 20ms 调度余量，避免"已经过期"警告
    acc.start(when, offset);
    voc.start(when, offset);

    this.accSource = acc;
    this.vocSource = voc;
    this.startedAtCtxTime = when;
    this.offsetAtStart = offset;
    this.playing = true;

    acc.onended = () => {
      // 只有自然播完才触发（手动 stop 时我们已把 playing 置 false）
      if (!this.playing) return;
      this.playing = false;
      this.pausedAt = this.duration;
      this._stopTimer();
      if (typeof this.onEnded === 'function') this.onEnded();
    };

    this._startTimer();
  };

  Mixer.prototype._stopSources = function _stopSources() {
    for (const src of [this.accSource, this.vocSource]) {
      if (!src) continue;
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* 已停止 */
      }
      try { src.disconnect(); } catch { /* ignore */ }
    }
    this.accSource = null;
    this.vocSource = null;
  };

  Mixer.prototype._startTimer = function _startTimer() {
    this._stopTimer();
    // 50ms 一次：给进度条和歌词视图用，足够平滑
    this._timer = setInterval(() => {
      if (typeof this.onTimeUpdate === 'function') {
        this.onTimeUpdate(this.getCurrentTime(), this.duration);
      }
    }, 50);
  };

  Mixer.prototype._stopTimer = function _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  };

  /** 当前播放位置（秒）。与 <audio>.currentTime 语义一致，可直接喂给歌词视图。 */
  Mixer.prototype.getCurrentTime = function getCurrentTime() {
    if (!this.ctx) return 0;
    if (!this.playing) return this.pausedAt;
    const elapsed = this.ctx.currentTime - this.startedAtCtxTime;
    return Math.min(this.offsetAtStart + Math.max(0, elapsed), this.duration);
  };

  Mixer.prototype.play = async function play() {
    if (!this.accBuffer || !this.vocBuffer) await this.load();
    if (this.ctx.state === 'suspended') {
      // 浏览器自动播放策略：页面还没有任何用户手势时，resume() 可能一直
      // pending（不是 reject），直接 await 会让调用方永远卡住 —— 大屏看起来
      // 就是「处理完了但不播」，连「点击开始播放」的提示都不会出现。
      // 这里最多等 1.2s，没解锁就抛 AUTOPLAY_BLOCKED，交给 UI 显示提示。
      const resumed = await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        const timer = setTimeout(() => finish(false), 1200);
        this.ctx.resume()
          .then(() => { clearTimeout(timer); finish(this.ctx.state === 'running'); })
          .catch(() => { clearTimeout(timer); finish(false); });
      });
      if (!resumed) {
        const error = new Error('Autoplay is blocked until the user interacts with the page');
        error.code = 'AUTOPLAY_BLOCKED';
        throw error;
      }
    }
    if (this.playing) return;
    const from = this.pausedAt >= this.duration ? 0 : this.pausedAt;
    this._startSources(from);
  };

  Mixer.prototype.pause = function pause() {
    if (!this.playing) return;
    this.pausedAt = this.getCurrentTime();
    this.playing = false;
    this._stopSources();
    this._stopTimer();
    if (typeof this.onTimeUpdate === 'function') {
      this.onTimeUpdate(this.pausedAt, this.duration);
    }
  };

  Mixer.prototype.toggle = async function toggle() {
    if (this.playing) this.pause();
    else await this.play();
    return this.playing;
  };

  Mixer.prototype.seek = function seek(sec) {
    const target = Math.max(0, Math.min(Number(sec) || 0, this.duration));
    if (this.playing) {
      this._startSources(target);
    } else {
      this.pausedAt = target;
      if (typeof this.onTimeUpdate === 'function') this.onTimeUpdate(target, this.duration);
    }
  };

  /**
   * 设置人声强度 0..1。
   * 用 setTargetAtTime 做 30ms 平滑，避免拖动滑块时的"咔哒"声。
   */
  Mixer.prototype.setVocalLevel = function setVocalLevel(level) {
    const v = Math.max(0, Math.min(1, Number(level)));
    this.vocalLevel = v;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const gain = this.muted ? 0 : v;
    this.vocGain.gain.cancelScheduledValues(now);
    this.vocGain.gain.setTargetAtTime(gain, now, 0.03);
  };

  Mixer.prototype.setMuted = function setMuted(muted) {
    this.muted = Boolean(muted);
    this.setVocalLevel(this.vocalLevel);
  };

  Mixer.prototype.setVolume = function setVolume(level) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1, Number(level))), now, 0.03);
  };

  Mixer.prototype.destroy = function destroy() {
    this._stopTimer();
    this._stopSources();
    // 不 close 共享 AudioContext：下首歌还要继续用。close() 后新建的 context
    // 会重新触发浏览器自动播放策略，导致每次切歌都要再点一下。
    for (const node of [this.vocGain, this.masterGain, this.limiter]) {
      try { node?.disconnect(); } catch { /* ignore */ }
    }
    this.vocGain = null;
    this.masterGain = null;
    this.limiter = null;
    this.ctx = null;
    this.accBuffer = null;
    this.vocBuffer = null;
  };

  /** 页面加载时预先创建共享 AudioContext，首个用户手势可以直接解锁它。 */
  Mixer.preloadContext = function preloadContext() {
    try { return getSharedContext(); } catch { return null; }
  };

  /** 任意用户手势时调用：把还没解锁的共享 context 恢复。 */
  Mixer.unlock = function unlock() {
    try {
      if (sharedContext && sharedContext.state === 'suspended') {
        return sharedContext.resume().catch(() => {});
      }
    } catch { /* ignore */ }
    return Promise.resolve();
  };

  global.KaraokeMixer = Mixer;
})(window);
