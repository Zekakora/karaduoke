/**
 * 歌词播放视图（仿 Apple Music / Lyricify）
 *
 * 视觉规格见 docs/player-ui-spec.md：
 *   - 左列只有专辑封面，水平+垂直居中
 *   - 右列滚动歌词，当前行加粗白字、前后行淡化
 *   - 背景 = 封面模糊放大压暗
 *   - 每行下方可带翻译
 *
 * 与 YouTube 播放器的关系：
 *   本视图只负责"画面"，音频仍由隐藏的 YouTube iframe 提供。
 *   时间用 player 实例（YT.Player）的 getCurrentTime()，不另建时钟，
 *   因此**不存在网络漂移**。
 */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /** YouTube 封面：优先 maxres，失败回落 hqdefault。 */
  function artworkFor(videoId, fallbackUrl) {
    if (videoId) return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`;
    return fallbackUrl || '';
  }

  function LyricsView(root, options) {
    this.root = root;
    this.options = options || {};
    // 文案注入：外部传 t(key, fallback) 就能跟随界面语言；不传则用中文兜底。
    this.t = typeof this.options.t === 'function' ? this.options.t : (key, fallback) => fallback;
    this.state = {
      lines: [],
      activeIndex: -1,
      sungIndex: -1,
      offsetMs: 0,
      following: true,
      unfollowTimer: null,
      lastRenderAt: 0,
      provider: null,
      found: false,
      loading: false,
      error: null,
      currentKey: null,
      wordLevel: false,
    };
    this.raf = null;
    this.stage = null;
    this.onSeek = null;
    this.state.scrollRaf = 0;
  }

  LyricsView.prototype.mount = function mount() {
    this.root.innerHTML = `
      <div class="lv-stage" data-lv-stage>
        <div class="lv-bg" data-lv-bg></div>
        <div class="lv-scrim"></div>
        <div class="lv-grid">
          <div class="lv-art-col"><div class="lv-art"><img data-lv-art alt=""></div></div>
          <div class="lv-lyrics-col">
            <div class="lv-scroller" data-lv-scroller>
              <div class="lv-track" data-lv-track></div>
            </div>
          </div>
        </div>
        <div class="lv-status" data-lv-status></div>
      </div>`;
    this.stage = this.root.querySelector('[data-lv-stage]');
    this.bg = this.root.querySelector('[data-lv-bg]');
    this.art = this.root.querySelector('[data-lv-art]');
    this.scroller = this.root.querySelector('[data-lv-scroller]');
    this.track = this.root.querySelector('[data-lv-track]');
    this.statusEl = this.root.querySelector('[data-lv-status]');

    // 手动滚动 → 暂停自动跟随 3 秒
    this.scroller.addEventListener('wheel', () => this.pauseFollow(), { passive: true });
    this.scroller.addEventListener('touchmove', () => this.pauseFollow(), { passive: true });
    this.scroller.addEventListener('pointerdown', () => this.pauseFollow());

    this.startLoop();
  };

  /**
   * 用户手动滚了歌词 → 暂停自动跟随。
   *
   * **不设超时自动恢复**：手滚之后画面就停在用户看的位置，
   * 直到下一句歌词开始（那时自动复位到垂直居中，见 update()）。
   */
  LyricsView.prototype.pauseFollow = function pauseFollow() {
    this.state.following = false;
    if (this.state.scrollRaf) { cancelAnimationFrame(this.state.scrollRaf); this.state.scrollRaf = 0; }
  };

  LyricsView.prototype.setArtwork = function setArtwork(url) {
    if (!url) return;
    if (this.art.dataset.src === url) return;
    this.art.dataset.src = url;
    this.art.src = url;
    this.bg.style.backgroundImage = `url("${url}")`;
  };

  LyricsView.prototype.setLoading = function setLoading(loading) {
    this.state.loading = loading;
    this.renderStatus(loading ? this.t('lyricsSearching', '正在查找歌词…') : null);
  };

  LyricsView.prototype.renderStatus = function renderStatus(message) {
    this.statusEl.textContent = message || '';
    this.statusEl.classList.toggle('visible', Boolean(message));
  };

  /**
   * 载入歌词。payload 来自 GET /api/lyrics/lookup。
   * 只有纯文本（无时间轴）时降级为静态展示并提示。
   */
  LyricsView.prototype.setLyrics = function setLyrics(payload) {
    const lines = (payload && payload.lines) || [];
    const timed = lines.length && lines[0].startMs != null;
    this.state.lines = timed ? lines : [];
    this.state.provider = payload?.provider || null;
    this.state.found = Boolean(payload?.found);
    this.state.activeIndex = -1;

    if (!lines.length) {
      this.track.innerHTML = `<div class="lv-empty">${this.t('lyricsNone', '这首歌暂时没有歌词')}</div>`;
      this.renderStatus(null);
      return;
    }
    if (!timed) {
      // 无时间轴：静态显示，不做滚动
      this.track.innerHTML = lines.map((l) => `<div class="lv-line"><div class="lv-text">${esc(l.text)}</div></div>`).join('');
      this.renderStatus(this.t('lyricsUntimed', '这份歌词没有时间轴，无法跟唱'));
      return;
    }
    this.renderStatus(null);
    this.track.innerHTML = lines.map((line, index) => {
      const translation = line.translation ? `<div class="lv-trans">${esc(line.translation)}</div>` : '';
      let text;
      if (line.text && line.chars && line.chars.length) {
        // 逐字：每个字包一层 span，靠 CSS 变量 --lv-progress 控制点亮范围
        const inner = line.chars.map((c) => `<span class="lv-ch">${esc(c.text)}</span>`).join('');
        text = `<span class="lv-chars">${inner}</span>`;
      } else if (line.text) {
        text = esc(line.text);
      } else {
        text = '<span class="lv-dots">•••</span>';
      }
      return `<div class="lv-line" data-index="${index}"><div class="lv-text">${text}</div>${translation}</div>`;
    }).join('');

    this.track.classList.toggle('lv-wordmode', Boolean(this.state.wordLevel));

    this.track.querySelectorAll('.lv-line').forEach((el) => {
      el.addEventListener('click', () => {
        const index = Number(el.dataset.index);
        const line = this.state.lines[index];
        if (line && typeof this.onSeek === 'function') this.onSeek(line.startMs / 1000);
      });
    });
  };

  LyricsView.prototype.setOffset = function setOffset(ms) {
    this.state.offsetMs = Number(ms) || 0;
    this.state.activeIndex = -1;
  };

  /** 逐字模式开关。开启后当前行按 chars 逐字点亮。 */
  /** 是否显示歌词翻译（DJ 在设置里控制） */
  LyricsView.prototype.setShowTranslation = function setShowTranslation(on) {
    this.state.showTranslation = on !== false;
    if (this.track) this.track.classList.toggle('lv-no-translation', !this.state.showTranslation);
  };

  LyricsView.prototype.setWordLevel = function setWordLevel(on) {
    this.state.wordLevel = Boolean(on);
    if (this.track) {
      this.track.classList.toggle('lv-wordmode', this.state.wordLevel);
      // 关掉时清掉残留的逐字进度
      if (!this.state.wordLevel) {
        this.track.querySelectorAll('.lv-chars').forEach((el) => {
          el.style.setProperty('--lv-progress', '0');
        });
      }
    }
    this.state.activeIndex = -1; // 强制重绘
  };

  /**
   * 更新当前行的逐字进度。
   * @param {number} index 行号
   * @param {number} tMs   当前时间
   */
  LyricsView.prototype.updateWordProgress = function updateWordProgress(index, tMs) {
    const node = this.track.querySelector(`.lv-line[data-index="${index}"] .lv-chars`);
    if (!node) return;
    const chars = this.state.lines[index] && this.state.lines[index].chars;
    if (!chars || !chars.length) return;

    // 找到当前应该亮到第几个字
    let done = 0;
    for (let i = 0; i < chars.length; i += 1) {
      const c = chars[i];
      if (tMs >= c.endMs) { done = i + 1; continue; }
      if (tMs > c.startMs) {
        // 正在进行中的字：按比例部分点亮
        const ratio = (tMs - c.startMs) / Math.max(1, c.endMs - c.startMs);
        done = i + ratio;
      }
      break;
    }
    const progress = done / chars.length;
    node.style.setProperty('--lv-progress', String(Math.max(0, Math.min(1, progress))));
  };

  /** 最后一个 startMs <= t 的行（不考虑 endMs）。用于标记"唱过"。 */
  LyricsView.prototype.findSungIndex = function findSungIndex(t) {
    const lines = this.state.lines;
    if (!lines.length) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].startMs <= t) { result = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return result;
  };

  /**
   * 当前**应该高亮**的行。
   *
   * 与 findSungIndex 的区别：若已过本行 endMs 且未到下一行，
   * 说明处在两句之间的间隙（intro / bridge / 间奏），返回 -1
   * —— 此时不该有任何行高亮，否则上一句会一直亮着。
   */
  LyricsView.prototype.findIndex = function findIndex(t) {
    const sung = this.findSungIndex(t);
    if (sung < 0) return -1;
    const line = this.state.lines[sung];
    if (line.endMs != null && t >= line.endMs) return -1;
    return sung;
  };

  LyricsView.prototype.startLoop = function startLoop() {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - this.state.lastRenderAt < 40) return; // 约 25fps，足够且省电
      this.state.lastRenderAt = now;
      this.update();
    };
    this.raf = requestAnimationFrame(tick);
  };

  LyricsView.prototype.update = function update() {
    if (!this.state.lines.length) return;
    const getTime = this.options.getCurrentTime;
    const tSec = typeof getTime === 'function' ? getTime() : null;
    if (tSec == null) return;
    const tMs = tSec * 1000 + this.state.offsetMs;
    const index = this.findIndex(tMs);
    const sung = this.findSungIndex(tMs);
    const activeChanged = index !== this.state.activeIndex;
    // 用户手动滚过歌词：保留他看的位置，但**下一句开始时复位**到垂直居中。
    if (!this.state.following && activeChanged && index >= 0) {
      this.state.following = true;
    }
    // 无论行号是否变化，都持续把当前行往垂直中线拉。
    // 原因：切行时字号有 0.62s 过渡，行高在动画过程中一直在变，
    // 只在"行号变化"那一刻滚一次，等字号到位后中线就偏了。
    this.trackCenter();
    if (!activeChanged && sung === this.state.sungIndex) {
      // 行没变，但逐字模式需要持续推进当前行的进度
      if (this.state.wordLevel && index >= 0) this.updateWordProgress(index, tMs);
      return;
    }
    this.state.activeIndex = index;
    this.state.sungIndex = sung;
    this.highlight(index, sung, activeChanged);
    if (this.state.wordLevel && index >= 0) this.updateWordProgress(index, tMs);
  };

  /** 当前应该居中的行：优先高亮行，间隙期用"最后唱过的那行"（画面不会突然跳） */
  LyricsView.prototype.centerNode = function centerNode() {
    const nodes = this.track.querySelectorAll('.lv-line');
    if (!nodes.length) return null;
    const idx = this.state.activeIndex >= 0 ? this.state.activeIndex : this.state.sungIndex;
    return idx >= 0 ? nodes[idx] || null : null;
  };

  /**
   * 把当前行的中心拉到歌词列垂直中线。
   * 每帧做一次小幅跟随（30%），比一次性动画更稳 ——
   * 字号过渡期间行高变化也能被追上。
   */
  LyricsView.prototype.trackCenter = function trackCenter() {
    if (!this.state.following) return;
    const node = this.centerNode();
    if (!node) return;
    const el = this.scroller;
    const ideal = node.offsetTop + node.offsetHeight / 2 - el.clientHeight / 2;
    const diff = ideal - el.scrollTop;
    // 死区 2px，避免像素抖动
    if (Math.abs(diff) <= 2) return;
    // 正在做切行动画时让动画主导，避免两个循环互相拽
    if (this.state.scrollRaf) return;
    el.scrollTop += diff * 0.3;
  };

  /**
   * 滚动到当前行，让它精确停在垂直中线。
   *
   * 关键点：**目标位置每帧重算**，不是算一次然后跑过去。
   *
   * 旧写法的毛病：先按"当前"几何算一个固定目标，动画跑完时字号过渡还在进行、
   * 布局已经变了，落点就偏了，只能靠 trackCenter 事后微调 —— 肉眼看就是
   * "跳完了再抖一下"。
   *
   * 现在把目标写成活的：`from + (liveTarget - from) * easeOutExpo(t)`。
   * t=1 时 easeOutExpo=1，落点 = 当时的 liveTarget，天然精确；中途字号在变也一直被跟住。
   */
  LyricsView.prototype.scrollToActive = function scrollToActive() {
    const el = this.scroller;
    if (!this.state.following) return;
    const node = this.centerNode();
    if (!node) return;
    // 每帧现算：当前行中心 - 半屏高
    const liveTarget = () => {
      const n = this.centerNode();
      return n ? n.offsetTop + n.offsetHeight / 2 - el.clientHeight / 2 : el.scrollTop;
    };
    const from = el.scrollTop;
    const initial = liveTarget();
    if (Math.abs(initial - from) < 1) return;

    // 和 CSS 的 .62s 字号/缩放过渡同步
    const duration = 620;
    const start = performance.now();
    const state = this.state;
    const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
    cancelAnimationFrame(state.scrollRaf);

    const step = (now) => {
      if (!state.following) { state.scrollRaf = 0; return; }
      const t = Math.min(1, (now - start) / duration);
      const target = liveTarget();
      el.scrollTop = from + (target - from) * easeOutExpo(t);
      if (t < 1) {
        state.scrollRaf = requestAnimationFrame(step);
      } else {
        // 收尾再对一次：保证最终帧就是中线
        el.scrollTop = liveTarget();
        state.scrollRaf = 0;
      }
    };
    state.scrollRaf = requestAnimationFrame(step);
  };

  /**
   * @param {number} index 要高亮的行；-1 = 间隙期/开头，谁都不亮
   * @param {number} sung  最后一个开始过的行；用于 .past 淡化
   * @param {boolean} activeChanged 高亮行是否真的变了（变了才滚动，避免抖动）
   */
  LyricsView.prototype.highlight = function highlight(index, sung, activeChanged) {
    const nodes = this.track.querySelectorAll('.lv-line');
    nodes.forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.classList.toggle('past', sung >= 0 && i <= sung && i !== index);
    });
    if (index < 0 || !this.state.following || !activeChanged) return;
    // 让当前行落在歌词列垂直中线（落点每帧重算，见 scrollToActive）
    this.scrollToActive();
  };

  LyricsView.prototype.destroy = function destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    clearTimeout(this.state.unfollowTimer);
    this.root.innerHTML = '';
  };

  global.LyricsView = LyricsView;
  global.LyricsViewHelpers = { esc, artworkFor };
})(window);
