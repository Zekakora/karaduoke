/**
 * 视频 + 两行歌词（模式 B 的 'video' 画面）
 *
 * 画面：YouTube 720p 视频铺满播放区（object-fit: cover），底部固定两行歌词
 *   - 当前行：大字、白色、逐字高亮（复用 lyrics-view.css 的 --lv-progress 方案）
 *   - 下一行：小字、半透明
 *
 * 关键约束（见 docs/playback-dual-mode.md）：
 *   <video> **永远静音**，音轨完全不用。音频由 KaraokeMixer 播放伴奏 + 人声
 *   （模式 B 的核心功能是"人声强度可调"，只有走 MP3 混音才做得到）。
 *   因此时间轴以 mixer 为准：外部在 mixer.onTimeUpdate 里调 update(tSec)，
 *   本类只在漂移 > 0.3s 时才 seek 视频 —— 小于这个阈值肉眼看不出来，
 *   频繁 seek 反而卡顿。
 *
 * 降级：video.mp4 不存在（404 / decode 失败）时，退回封面图作背景，
 *   两行歌词照常工作，不抛错、不崩溃。
 *
 * 歌词间隙期（行与行之间）当前行**保持显示**（和 Apple Music 模式不同，
 *   两行模式中途清空会闪）。
 */
(function (global) {
  'use strict';

  /** 视频与 mixer 的时间漂移容忍度（秒）。超过才 seek。 */
  const DRIFT_TOLERANCE = 0.3;
  /** 视频还不可 seek 时，连续 seek 的最小间隔（毫秒），避免拖动进度条时刷爆 seek */
  const SEEK_RETRY_MS = 120;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /**
   * 最后一个 startMs <= tMs 的行（不考虑 endMs）。
   * 二分查找，与 lyrics-view.js 的 findSungIndex 同算法。
   */
  function findSungIndex(lines, tMs) {
    if (!lines.length) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].startMs <= tMs) { result = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return result;
  }

  /**
   * 当前**应该高亮**的行：已过本行 endMs 且未到下一行 → -1（间隙期）。
   * 间隙期只影响"是否逐字推进 / 切行动画"，当前行文字仍保持显示。
   */
  function findIndex(lines, tMs) {
    const sung = findSungIndex(lines, tMs);
    if (sung < 0) return -1;
    const line = lines[sung];
    if (line.endMs != null && tMs >= line.endMs) return -1;
    return sung;
  }

  /**
   * 逐字进度（0..1）：已完成整字 + 进行中字的按比例部分。
   * 没开始唱（t < 第一个字）→ 0；唱过最后一个字 → 1（避免末字结束前一帧停在 0.8）。
   */
  function wordProgress(chars, tMs) {
    if (!chars || !chars.length) return 0;
    if (tMs >= chars[chars.length - 1].endMs) return 1;
    let done = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const c = chars[i];
      if (tMs >= c.endMs) { done = i + 1; continue; }
      if (tMs > c.startMs) {
        const ratio = (tMs - c.startMs) / Math.max(1, c.endMs - c.startMs);
        done = i + ratio;
      }
      break;
    }
    return Math.max(0, Math.min(1, done / chars.length));
  }

  function hasWordChars(line) {
    return Boolean(line && line.chars && line.chars.length && line.text);
  }

  function VideoLyricsMode(root, options) {
    const opts = options || {};
    this.root = root;
    this.options = opts;
    // 文案注入：外部传 t(key, fallback) 就能跟随界面语言；不传则用中文兜底。
    this.t = typeof this.options.t === 'function' ? this.options.t : (key, fallback) => fallback;
    this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
    this.coverUrl = opts.coverUrl || '';
    this.lines = [];
    this.videoUrl = opts.videoUrl || null;

    this.stage = null;
    this.videoEl = null;
    this.scrimEl = null;
    this.curEl = null;
    this.nextEl = null;
    this.curText = null;
    this.nextText = null;
    this.coverEl = null;
    this.statusEl = null;
    this.vocalHost = null;

    this.curIndex = null;   // 当前行号（含间隙期：保持为最后唱过的那行）
    this._litLine = -1;     // 逐字点亮缓存：上一帧是哪一行
    this._litCount = -1;    //                       点亮到第几个字
    this.sungIndex = -1;
    this.wordMode = false;  // 歌词是否真的按逐字亮
    this.wordLevelEnabled = true;   // DJ 的「逐字/逐行」开关（true=逐字）
    this.lyricsVisible = true;      // DJ 的「视频歌词开/关」
    this.lastTime = 0;              // 最近一次 update 的时间，切换模式时重画用
    this.videoOk = false;   // video.mp4 是否真的能播
    this.playing = false;
    this.lastPlainText = null;
    this.listeners = [];
    this.lastSeekAt = 0;
  }

  /** 给 stage 上的事件加监听，destroy() 时统一摘掉 */
  VideoLyricsMode.prototype._on = function _on(el, type, fn) {
    if (!el || !el.addEventListener) return;
    el.addEventListener(type, fn);
    this.listeners.push([el, type, fn]);
  };

  VideoLyricsMode.prototype._setStatus = function _setStatus(message) {
    if (!this.statusEl) return;
    this.statusEl.textContent = message || '';
    this.statusEl.classList.toggle('visible', Boolean(message));
  };

  VideoLyricsMode.prototype.mount = function mount() {
    if (!this.root) throw new Error('VideoLyricsMode: root 缺少容器');
    // 不拿封面当画面：有视频就放视频，没视频就是纯黑。
    // 这样所有歌的观感一致，不会出现"有的封面、有的视频"。
    const coverStyle = '';
    this.root.innerHTML = `
      <div class="vlm-stage" data-vlm-stage>
        <div class="vlm-cover" data-vlm-cover${coverStyle}></div>
        <video id="vlm-video" class="vlm-video" data-vlm-video muted playsinline preload="metadata"${this.videoUrl ? ` src="${esc(this.videoUrl)}"` : ' style="display:none"'}></video>
        <div class="vlm-scrim" data-vlm-scrim></div>
        <div class="vlm-lyrics" data-vlm-lyrics>
          <div class="vlm-line cur" data-vlm-cur><span id="vlm-cur-text" class="vlm-text" data-vlm-cur-text></span></div>
          <div class="vlm-line next" data-vlm-next><span id="vlm-next-text" class="vlm-text" data-vlm-next-text></span></div>
        </div>
        <div class="vlm-status" data-vlm-status></div>
        <div class="vlm-vocal-slot" data-vlm-vocal-slot></div>
      </div>`;

    // 用 id 取节点：即使 <video> 被替换（如代理/扩展），也不会拿错元素
    const q = (selector) => this.root.querySelector(selector) || this.root.querySelector(selector.replace(/^\[([^\]]+)\]$/, '#$1'));
    this.stage = q('.vlm-stage');
    this.coverEl = q('.vlm-cover');
    this.videoEl = q('.vlm-video');
    this.scrimEl = q('.vlm-scrim');
    this.curEl = q('.vlm-line.cur');
    this.nextEl = q('.vlm-line.next');
    this.curText = q('.vlm-line.cur .vlm-text');
    this.nextText = q('.vlm-line.next .vlm-text');
    this.statusEl = q('.vlm-status');
    this.vocalHost = q('.vlm-vocal-slot');

    // 视频是纯视觉层：任何时候都必须静音（属性 + JS 双保险）
    if (this.videoEl) {
      this.videoEl.muted = true;
      this.videoEl.defaultMuted = true;
      this.videoEl.volume = 0;
      this.videoEl.setAttribute('muted', '');
      // 监听器一律用 this.videoEl 实时取值：宿主或测试可能替换掉这个元素
      this._on(this.videoEl, 'error', () => { if (!this.videoEl || !this.videoEl.error) return; this._markVideoUnavailable(); });
      this._on(this.videoEl, 'loadeddata', () => {
        if (this.videoEl && !this.videoEl.error) {
          this.videoOk = true;
          this._setStatus('');
        }
      });
      // 点击视频画面**不做**跳转：现场常会误点画面导致突然切歌，进度只由 DJ / 歌词点击控制。
    }

    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    if (this.videoUrl) this.setVideo(this.videoUrl);
    // 没有 video.mp4 的歌：直接铺模糊封面（否则会一直停在黑屏）
    else { this.videoOk = false; this._applyBlurredCover(); }
    return this;
  };

  /** 视频不可用（404 / 解码失败）→ 封面兜底，歌词照常 */
  VideoLyricsMode.prototype._markVideoUnavailable = function _markVideoUnavailable() {
    this.videoOk = false;
    this.videoFailed = true;
    if (this.videoEl) {
      this.videoEl.style.display = 'none';
      // 清掉 src，避免浏览器反复重试 404
      try { this.videoEl.removeAttribute('src'); this.videoEl.load?.(); } catch { /* ignore */ }
    }
    // 没有视频：用高斯模糊、拉伸铺满的专辑封面当画面。
    // 纯黑会让大屏显得"宕机了"，模糊封面既填补画面又不会抢歌词的注意力。
    this._applyBlurredCover();
    this._setStatus('');
  };

  /** 把封面铺成模糊背景（没有视频时的画面） */
  VideoLyricsMode.prototype._applyBlurredCover = function _applyBlurredCover() {
    if (!this.coverEl) return;
    const url = this.coverUrl || '';
    if (!url) {
      this.coverEl.style.backgroundImage = '';
      this.coverEl.classList.remove('is-blurred');
      return;
    }
    const safe = String(url).replace(/["'\\\n\r]/g, '');
    this.coverEl.style.backgroundImage = `url("${safe}")`;
    this.coverEl.classList.add('is-blurred');
  };

  VideoLyricsMode.prototype.setVideo = function setVideo(url) {
    this.videoUrl = url || null;
    this.videoOk = false;
    if (!this.videoEl) return;
    if (!url) { this._markVideoUnavailable(); return; }
    this.videoEl.style.display = '';
    this.videoEl.muted = true;
    this.videoEl.defaultMuted = true;
    this.videoEl.volume = 0;
    this.videoEl.src = url;
    // 视频首帧到达之前先铺模糊封面：加载期间不会是黑屏，加载好之后视频会盖住它
    this._applyBlurredCover();
    try { this.videoEl.load?.(); } catch { /* ignore */ }
  };

  /** 封面地址：没有视频时用它铺底部模糊背景 */
  VideoLyricsMode.prototype.setCover = function setCover(url) {
    this.coverUrl = url || '';
    // 视频不可用时立刻把模糊封面换上去（换歌时封面要先于视频就位）
    if (!this.videoOk) this._applyBlurredCover();
  };

  /** 人声强度滑块挂到这里（叠在视频上方，位置由 CSS 决定） */
  VideoLyricsMode.prototype.vocalSlot = function vocalSlot() {
    return this.vocalHost || null;
  };

  VideoLyricsMode.prototype.setPlaying = function setPlaying(playing) {
    this.playing = Boolean(playing);
    if (!this.videoEl || !this.videoOk) return;
    try {
      if (this.playing) {
        const p = this.videoEl.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => { /* 自动播放被拒绝：等下一次用户手势 */ });
      } else {
        this.videoEl.pause?.();
      }
    } catch { /* ignore */ }
  };

  /** 行内 HTML：有 chars 就逐字包 span，否则纯文本 */
  /**
   * 单行歌词的 HTML。
   *
   * 逐字行每个字单独包一层 .lv-ch —— 逐字高亮靠给每个字算亮度，
   * 只有这样才能按**阅读顺序**扫过（换行后第二行接着第一行）。
   * 试过遮罩方案：mask 是一条横向渐变，作用在整个元素盒子上，
   * 换行后的第二行会在同一个横向位置被照亮，看起来是"两行同时滚"。
   */
  VideoLyricsMode.prototype._renderLineHTML = function _renderLineHTML(line) {
    if (!line) return '';
    if (hasWordChars(line)) {
      const inner = line.chars.map((c) => `<span class="lv-ch">${esc(c.text)}</span>`).join('');
      return `<span class="lv-chars" style="--lv-progress:0">${inner}</span>`;
    }
    if (line.text) return esc(line.text);
    return '<span class="lv-dots">•••</span>';
  };

  /**
   * 载入歌词。payload 来自 GET /api/lyrics/lookup。
   * 只有带时间轴（startMs）的歌词才能跟唱；否则提示。
   */
  VideoLyricsMode.prototype.setLyrics = function setLyrics(payload) {
    const raw = (payload && payload.lines) || [];
    const timed = raw.length > 0 && raw.every((l) => l && l.startMs != null);
    this.lines = timed ? raw.slice().sort((a, b) => a.startMs - b.startMs) : [];
    // wordMode 由「DJ 的歌词显示方式」决定：关掉逐字时即使有 chars 也按整行亮
    this.wordMode = this.wordLevelEnabled !== false && this.lines.some(hasWordChars);
    this.curIndex = null;
    this.sungIndex = -1;
    this._litLine = -1;
    this._litCount = -1;
    this.lastPlainText = null;
    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    if (!this.lines.length) {
      if (this.curText) this.curText.innerHTML = `<span class="vlm-empty">${this.t('lyricsNone', '这首歌暂时没有歌词')}</span>`;
      if (this.nextText) this.nextText.textContent = '';
      if (this.curEl) this.curEl.classList.remove('has-word');
      if (raw.length) this._setStatus(this.t('lyricsUntimed', '这份歌词没有时间轴，无法跟唱'));
      return;
    }
    this._paint(-1, -1, 0);
    return this;
  };

  /** DJ 切换逐字/逐行（true=逐字）。改动立即重画。 */
  VideoLyricsMode.prototype.setWordLevel = function setWordLevel(on) {
    this.wordLevelEnabled = Boolean(on);
    const hasWord = this.lines.some(hasWordChars);
    this.wordMode = this.wordLevelEnabled && hasWord;
    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    this.curIndex = null; // 强制重画
    try { this.update(this.lastTime); } catch { /* ignore */ }
    return this.wordMode;
  };

  /** DJ 切换视频模式下是否显示歌词 */
  VideoLyricsMode.prototype.setLyricsVisible = function setLyricsVisible(visible) {
    this.lyricsVisible = Boolean(visible);
    if (this.stage) this.stage.classList.toggle('vlm-no-lyrics', !this.lyricsVisible);
  };


  /**
   * 把当前状态画到 DOM 上。只在"行"变化时重写文字（避免每 50ms 重建 DOM）。
   * @param {number} baseIndex 当前行号（间隙期保持为最后唱过的行）
   */
  VideoLyricsMode.prototype._paint = function _paint(baseIndex, _activeIndex, tMs) {
    const lines = this.lines;
    if (!lines.length) return;
    const changed = baseIndex !== this.curIndex;
    this.curIndex = baseIndex;
    const curLine = baseIndex >= 0 ? lines[baseIndex] : null;
    const nextLine = baseIndex + 1 < lines.length ? lines[baseIndex + 1] : null;

    if (changed) {
      if (this.curText) this.curText.innerHTML = this._renderLineHTML(curLine);
      if (this.nextText) this.nextText.innerHTML = this._renderLineHTML(nextLine);
      if (this.curEl) {
        this.curEl.classList.toggle('has-word', hasWordChars(curLine));
        // 触发切行动画：先摘掉再下次帧加回（浏览器同帧 class 抖动不会播动画）
        if (baseIndex >= 0) {
          this.curEl.classList.remove('vlm-enter');
          if (typeof global.requestAnimationFrame === 'function') {
            global.requestAnimationFrame(() => this.curEl?.classList.add('vlm-enter'));
          } else {
            this.curEl.classList.add('vlm-enter');
          }
        }
      }
      if (this.nextEl) this.nextEl.classList.toggle('has-word', hasWordChars(nextLine) && !this.wordMode);
    }

    // 逐字亮度：每个字按「自己唱到百分之几」算一个不透明度，从灰推到纯白。
    // 为什么不用遮罩：mask 的渐变是横向的，作用在整个行盒上，
    // 一行折成两行时第二行会在同一个横向位置被照亮（看起来"两行同步滚"）。
    // 逐字计算天然按阅读顺序推进，折行也能接着往下扫。
    //   0.32 = 未唱（灰），1.00 = 已唱（纯白）
    //   用 color 而不是透明填充，所以白字是实心描绘的，不会发虚。
    if (hasWordChars(curLine) && this.curText) {
      const ratio = wordProgress(curLine.chars, tMs);
      const node = this.curText.querySelector('.lv-chars');
      if (node) node.style.setProperty('--lv-progress', String(ratio));
      const spans = this.curText.querySelectorAll('.lv-ch');
      const chars = curLine.chars;
      const count = Math.min(spans.length, chars.length);
      for (let k = 0; k < count; k += 1) {
        const ch = chars[k];
        let frac = 0;
        if (tMs >= ch.endMs) frac = 1;
        else if (tMs > ch.startMs) frac = (tMs - ch.startMs) / Math.max(1, ch.endMs - ch.startMs);
        // 0–100 档，够细；量化只是为了少写 DOM
        const step = Math.round(frac * 100);
        const span = spans[k];
        if (span.dataset && span.dataset.litStep === String(step)) continue;
        if (span.dataset) span.dataset.litStep = String(step);
        const alpha = 0.32 + 0.68 * (step / 100);
        if (span.style) span.style.color = step >= 100 ? '#fff' : `rgba(255,255,255,${alpha.toFixed(2)})`;
        if (span.classList) span.classList.toggle('is-sung', step >= 100);
      }
    }
  };

  /**
   * 由 mixer.onTimeUpdate 驱动（每 50ms 一次）。
   * @param {number} tSec 曲目内秒数；不传则用内部记录的时间
   * @returns {number|undefined} 实际使用的曲目内秒数（视频校正后可覆盖）
   */
  VideoLyricsMode.prototype.update = function update(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) return;
    this.lastTime = t;
    this.duration = Number.isFinite(this.duration) ? this.duration : (this.options.duration || 0);
    const tMs = t * 1000;

    // 1) 歌词：间隙期保留上一句（findIndex 只为区分"是否在唱"）
    const sung = findSungIndex(this.lines, tMs);
    const active = findIndex(this.lines, tMs);
    // baseIndex：当前行。intro / 间隙期取"最后唱过的那句"并保持显示，不清空
    const baseIndex = sung;
    if (this.lines.length) {
      const curLine = baseIndex >= 0 ? this.lines[baseIndex] : null;
      if (baseIndex !== this.curIndex) this.sungIndex = sung;
      if (baseIndex !== this.curIndex || hasWordChars(curLine)) this._paint(baseIndex, active, tMs);
      if (this.stage) this.stage.classList.toggle('vlm-gap', sung >= 0 && active < 0);
    }

    // 2) 视频：只在漂移超过阈值时校正
    this.syncVideo(t);
  };

  /**
   * 视频跟随 mixer。
   * @returns {boolean} 本次是否发生了 seek
   */
  VideoLyricsMode.prototype.syncVideo = function syncVideo(tSec) {
    const video = this.videoEl;
    const t = Number(tSec);
    if (!video || !this.videoOk || !Number.isFinite(t)) return false;
    const current = Number(video.currentTime) || 0;
    const drift = Math.abs(current - t);
    if (drift <= DRIFT_TOLERANCE) return false;
    try { video.currentTime = t; } catch { /* metadata 未就绪时赋值会被忽略，下一轮再试 */ }
    return true;
  };

  /**
   * seek 后立即校正视频（不等 50ms 的下一次 onTimeUpdate）。
   * 视频还没 metadata 时，限频重试几次，免得播放器卡在旧画面上。
   */
  VideoLyricsMode.prototype.seek = function seek(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) return;
    this.update(t);
    const retry = () => {
      if (!this.videoEl || !this.videoOk) return;
      if (Math.abs((Number(this.videoEl.currentTime) || 0) - t) > DRIFT_TOLERANCE) {
        try { this.videoEl.currentTime = t; } catch { /* ignore */ }
      }
    };
    this.lastSeekAt = Date.now();
    if (typeof global.setTimeout === 'function') {
      global.setTimeout(retry, SEEK_RETRY_MS);
      global.setTimeout(retry, SEEK_RETRY_MS * 3);
    }
  };

  VideoLyricsMode.prototype.destroy = function destroy() {
    for (const [el, type, fn] of this.listeners) {
      try { el.removeEventListener(type, fn); } catch { /* ignore */ }
    }
    this.listeners = [];
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch { /* ignore */ }
      try { this.videoEl.removeAttribute('src'); this.videoEl.load?.(); } catch { /* ignore */ }
    }
    if (this.root) this.root.innerHTML = '';
    this.stage = null;
    this.videoEl = null;
    this.coverEl = null;
    this.scrimEl = null;
    this.curEl = null;
    this.nextEl = null;
    this.curText = null;
    this.nextText = null;
    this.statusEl = null;
    this.vocalHost = null;
    this.lines = [];
    this.curIndex = null;
  };

  Object.defineProperty(VideoLyricsMode.prototype, 'videoElRef', {
    get() { return this.videoEl; },
  });

  global.VideoLyricsMode = VideoLyricsMode;
  global.VideoLyricsModeHelpers = {
    esc,
    findSungIndex,
    findIndex,
    wordProgress,
    DRIFT_TOLERANCE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
