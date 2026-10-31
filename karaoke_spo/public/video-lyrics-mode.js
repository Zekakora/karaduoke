/**
 * 视频 + 两行歌词（模式 B 的 'video' 画面）
 *
 * 画面两层：
 *   1. 背景：**YouTube 官方 MV**（IFrame Player API，**永远静音**），铺满播放区；
 *      没有 MV / 匹配中 / 视频不可用 → 自动回退成模糊的专辑封面。
 *   2. 歌词：底部固定两行（复用 lyrics-view.css 的逐字高亮方案）
 *        - 当前行：大字、白色、逐字高亮
 *        - 下一行：小字、半透明
 *
 * 关键约束（见 docs/playback-dual-mode.md）：
 *   * MV **永远静音**，本地 KaraokeMixer 是唯一的音频来源（模式 B 的核心是"人声强度可调"，
 *     只有走 MP3 混音才做得到）。
 *   * **不做严格时间轴同步**：MV 只是背景视觉，不跟着 mixer 的 currentTime seek，
 *     也不持续校正。只跟随播放/暂停/停止（见下面的表格）。
 *   * YouTube **不允许**隐藏播放器或伪造交互去规避限制：播放器是正常尺寸的官方
 *     播放器（带 controls），只是被容器裁剪放大后铺满画面。
 *
 * 本地音频状态 → MV 的行为：
 *
 *   | 本地音频 | YouTube MV |
 *   | --- | --- |
 *   | Play   | Play   |
 *   | Pause  | Pause  |
 *   | Resume | Resume |
 *   | Stop   | Stop   |
 *   | 切歌   | 销毁旧播放器，加载新歌的 MV |
 *   | 歌曲结束 | Stop |
 *   | MV 比歌短 | MV 循环播放（onStateChange=ENDED 时重新 loadVideoById） |
 *   | MV 比歌长 | 随歌结束停止（外部在 onEnded 里 setPlaying(false)） |
 *
 * 失败回退：任何一步出错（没有 videoId / IFrame 初始化失败 / onError / 网络错误 /
 *   播放中被删除或转私密）都只是"不再有 MV"：立刻铺模糊封面，歌词和本地音频完全不受影响。
 *   同时通过 onVideoError 通知外部把匹配状态写成 unavailable，避免下次再加载同一个坏视频。
 */
(function (global) {
  'use strict';

  /** MV 自然播完 → 重新加载同一首（单视频循环）。延迟是为了让 YouTube 重置状态。 */
  const LOOP_RESTART_MS = 250;
  /** IFrame API 脚本加载超时（毫秒）。超时按"播放器初始化失败"处理。 */
  const API_LOAD_TIMEOUT_MS = 12000;
  /** 播放器 ready 超时：API 加载了但迟迟不 ready（被拦截/网络断）也要回退。 */
  const PLAYER_READY_TIMEOUT_MS = 9000;
  /**
   * MV 真正开始播放后，再等这么久才让模糊封面淡出（露出视频）。
   * 刚 buffering / 播广告 / 只出了首帧时，画面往往是黑的；
   * 先让封面顶住，几秒后视频稳定了再淡入，不会看到黑屏。
   */
  // MV 一进入 PLAYING（真正出画面）就立刻开始淡入，不再额外等待（=0）。
  // 想要"等几秒再淡入"就把这里调大（单位毫秒）。
  const MV_REVEAL_DELAY_MS = 0;
  /**
   * 首播兜底：MV ready + 要求播放后，这么久还没等到 PLAYING，就重试 play / 重建播放器。
   * 见 _armPlayWatchdog()。
   */
  const PLAY_WATCHDOG_MS = 2500;
  /** 重建播放器之后的第二段等待（慢网缓冲留余量）。 */
  const PLAY_WATCHDOG_RETRY_MS = 6000;

  const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /** YouTube videoId 只允许 11 位 base64url；不合法就当"没有 MV" */
  function validVideoId(value) {
    const text = String(value == null ? '' : value).trim();
    return /^[A-Za-z0-9_-]{11}$/.test(text) ? text : null;
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

  /**
   * 加载 YouTube IFrame API（全页只加载一次）。
   * 失败/超时 resolve(null) —— 调用方按"播放器初始化失败"回退封面。
   */
  let ytApiPromise = null;
  function loadYouTubeApi(timeoutMs) {
    if (global.YT && typeof global.YT.Player === 'function') return Promise.resolve(global.YT);
    if (ytApiPromise) return ytApiPromise;
    const timerMs = Math.max(3000, Number(timeoutMs) || API_LOAD_TIMEOUT_MS);
    ytApiPromise = new Promise((resolve) => {
      if (typeof global.document === 'undefined' || !global.document) {
        resolve(null); // 没有 DOM 就没有 YouTube（测试/降级环境）
        return;
      }
      const previous = global.onYouTubeIframeAPIReady;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      };
      global.onYouTubeIframeAPIReady = function onReady() {
        try { if (typeof previous === 'function') previous(); } catch { /* ignore */ }
        finish(global.YT && typeof global.YT.Player === 'function' ? global.YT : null);
      };
      const timer = setTimer(() => finish(null), timerMs);
      try {
        const script = global.document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.ytIframeApi = '1';
        script.onerror = () => finish(null);
        global.document.head.appendChild(script);
      } catch {
        finish(null);
      }
    });
    return ytApiPromise;
  }

  /**
   * 定时器只从 `global` 取（window / globalThis）。组件里不要直接写 `setTimeout(...)` ——
   * 在 vm 沙箱、部分嵌入式 WebView 里它可能不是全局函数，
   * 抛出的 ReferenceError 会让播放器初始化整段失败（看起来就是"MV 永远加载不出来"）。
   */
  function setTimer(fn, ms) {
    try {
      if (typeof global.setTimeout === 'function') return global.setTimeout(fn, ms);
    } catch { /* fall through */ }
    // 兜底：宿主既没有 window.setTimeout 也没有全局 setTimeout（沙箱/受限 WebView）
    return null;
  }
  function clearTimer(id) {
    if (id == null) return;
    try {
      if (typeof global.clearTimeout === 'function') global.clearTimeout(id);
      else if (typeof clearTimeout === 'function') clearTimeout(id); // eslint-disable-line no-undef
    } catch { /* ignore */ }
  }

  function VideoLyricsMode(root, options) {
    const opts = options || {};
    this.root = root;
    this.options = opts;
    // 文案注入：外部传 t(key, fallback) 就能跟随界面语言；不传则用中文兜底。
    this.t = typeof this.options.t === 'function' ? this.options.t : (key, fallback) => fallback;
    this.onSeek = typeof opts.onSeek === 'function' ? opts.onSeek : null;
    // 视频不可用时通知外部（写回 visualMatchStatus=unavailable），参数 {videoId, reason, code}
    this.onVideoError = typeof opts.onVideoError === 'function' ? opts.onVideoError : null;
    this.coverUrl = opts.coverUrl || '';
    this.visualVideoId = validVideoId(opts.visualVideoId || opts.videoId);

    this.stage = null;
    this.mvWrap = null;
    this.mvFrame = null;
    this.mvHost = null;
    this.coverEl = null;
    this.scrimEl = null;
    this.curEl = null;
    this.nextEl = null;
    this.curText = null;
    this.nextText = null;
    this.statusEl = null;
    this.vocalHost = null;

    this.yt = null;          // YT.Player 实例
    this.ytReady = false;
    this.ytFailed = false;   // 这一首的 MV 已经判定为"放不出来"
    this.playerToken = 0;    // 每次重建播放器 +1，丢弃旧实例的迟到事件
    this.playing = false;    // 本地音频是否在播（MV 要跟随）
    this.readyTimer = null;
    this.loopTimer = null;
    // 交叉淡化：MV 先在封面下面播，稳定几秒后才淡入（避免看到黑屏/缓冲画面）
    this.videoRevealed = false;
    this.revealTimer = null;
    // 首播兜底（见 _armPlayWatchdog）：没等到 PLAYING 时的重试次数与计时器
    this.playWatchdog = null;
    this.playRetries = 0;

    this.curIndex = null;   // 当前行号（含间隙期：保持为最后唱过的那行）
    // 上一次播放过"切行入场动画"的行号：同一行不重复播（切换逐字/逐行时尤其重要）
    this._lastAnimatedIndex = -1;
    // 下一行淡入同理：记录上一次播过动画的"下一行"索引
    this._lastNextAnimatedIndex = -1;
    this._litLine = -1;     // 逐字点亮缓存
    this._litCount = -1;
    this.sungIndex = -1;
    this.wordMode = false;  // 歌词是否真的按逐字亮
    this.wordLevelEnabled = true;   // DJ 的「逐字/逐行」开关（true=逐字）
    this.lyricsVisible = true;      // DJ 的「视频歌词开/关」
    this.lastTime = 0;              // 最近一次 update 的时间，切换模式时重画用
    this.playerInstanceId = 0;
    this.listeners = [];
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
    // 结构：cover（最底）< MV iframe < scrim < lyrics < status < vocal slot
    this.playerInstanceId += 1;
    const hostId = `vlm-yt-${this.playerInstanceId}`;
    this.root.innerHTML = `
      <div class="vlm-stage" data-vlm-stage>
        <div class="vlm-cover" data-vlm-cover></div>
        <div class="vlm-mv" data-vlm-mv hidden>
          <div class="vlm-mv-frame" data-vlm-mv-frame>
            <div id="${hostId}" class="vlm-yt-host" data-vlm-yt></div>
          </div>
        </div>
        <div class="vlm-scrim" data-vlm-scrim></div>
        <div class="vlm-lyrics" data-vlm-lyrics>
          <div class="vlm-line cur" data-vlm-cur><span id="vlm-cur-text" class="vlm-text" data-vlm-cur-text></span></div>
          <div class="vlm-line next" data-vlm-next><span id="vlm-next-text" class="vlm-text" data-vlm-next-text></span></div>
        </div>
        <div class="vlm-status" data-vlm-status></div>
        <div class="vlm-vocal-slot" data-vlm-vocal-slot></div>
      </div>`;

    const q = (selector) => this.root.querySelector(selector) || this.root.querySelector(selector.replace(/^\[([^\]]+)\]$/, '#$1'));
    this.stage = q('.vlm-stage');
    this.coverEl = q('.vlm-cover');
    this.mvWrap = q('.vlm-mv');
    this.mvFrame = q('.vlm-mv-frame');
    this.mvHost = q('.vlm-yt-host') || this.root.querySelector(`#${hostId}`);
    this.scrimEl = q('.vlm-scrim');
    this.curEl = q('.vlm-line.cur');
    this.nextEl = q('.vlm-line.next');
    this.curText = q('.vlm-line.cur .vlm-text');
    this.nextText = q('.vlm-line.next .vlm-text');
    this.statusEl = q('.vlm-status');
    this.vocalHost = q('.vlm-vocal-slot');

    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    // 先铺模糊封面：MV 加载好之前就有画面，不会出现黑屏
    this._applyBlurredCover();
    if (this.visualVideoId) this.setVisualVideoId(this.visualVideoId);
    return this;
  };

  // ------------------------------------------------------------ 背景：模糊封面

  /** 把封面铺成模糊背景（没有 MV 时的画面） */
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

  /** 封面地址：没有 MV 时用它铺底部模糊背景 */
  VideoLyricsMode.prototype.setCover = function setCover(url) {
    this.coverUrl = url || '';
    // MV 没在放 / 正在加载时立刻把模糊封面换上去（换歌时封面要先于 MV 就位）
    if (!this.isVideoPlaying()) this._applyBlurredCover();
  };

  /** MV 是否已经在画面上（ready 且没有被判定失败） */
  VideoLyricsMode.prototype.isVideoPlaying = function isVideoPlaying() {
    return Boolean(this.ytReady && !this.ytFailed && this.mvWrap && !this.mvWrap.hidden);
  };

  // ------------------------------------------------------------ 背景：官方 MV（静音）

  /**
   * 设置/切换官方 MV。传 null / 非法 id / 和当前相同 → 不重建播放器。
   * 切换时**先销毁旧播放器**（YouTube 配额与内存），再按新 id 初始化。
   */
  VideoLyricsMode.prototype.setVisualVideoId = function setVisualVideoId(videoId) {
    const next = validVideoId(videoId);
    const same = next === this.visualVideoId && (next ? Boolean(this.yt) : !this.yt);
    if (same) return this;
    this.visualVideoId = next;
    this._destroyPlayer();
    this.ytFailed = false;
    this.playRetries = 0;   // 换歌/换 id：重试预算重新给
    if (!next) {
      // 没有 MV：直接回退模糊封面（不创建播放器，避免空 iframe 白屏/黑屏）
      this._hideMvLayer();
      this._applyBlurredCover();
      return this;
    }
    this._applyBlurredCover(); // 加载期间先有画面
    this._createPlayer(next);
    return this;
  };

  /** 兼容旧调用：以前传的是本地 video.mp4 的 URL；现在一律当作"官方 MV 的 videoId" */
  VideoLyricsMode.prototype.setVideo = function setVideo(urlOrId) {
    return this.setVisualVideoId(urlOrId || null);
  };

  VideoLyricsMode.prototype._hideMvLayer = function _hideMvLayer() {
    if (this.mvWrap) this.mvWrap.hidden = true;
    this._unrevealVideo();
  };

  /**
   * MV 层"已就绪但还没露出来"：iframe 照常播放（YouTube 需要在真正播放后才稳定给出画面），
   * 但视觉上被模糊封面盖住。
   */
  VideoLyricsMode.prototype._revealVideo = function _revealVideo() {
    if (!this.mvWrap || this.videoRevealed) return;
    clearTimer(this.revealTimer);
    this.revealTimer = null;
    // 已经露出来了，首播兜底就没必要再跑
    clearTimer(this.playWatchdog);
    this.playWatchdog = null;
    this.videoRevealed = true;
    this.mvWrap.hidden = false;
    // CSS 过渡负责"慢慢淡化"：给 stage 加 vlm-mv-on，封面 opacity → 0，MV opacity 0 → 1。
    //
    // **必须放到下一帧再加 class**：从 `hidden` 切到可见的同一个样式计算里，
    // 浏览器会把它和其它变化合并成"直接显示"，transition 不触发 → MV 硬切出来。
    // 先让浏览器算一次"可见 + opacity:0"，下一帧再改 opacity，过渡才会跑。
    const apply = () => { if (this.stage) this.stage.classList.add('vlm-mv-on'); };
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(() => global.requestAnimationFrame(apply));
    } else {
      setTimer(apply, 32);
    }
  };

  /** 收起 MV（切歌 / 失败 / 停止）→ 重新显示模糊封面 */
  VideoLyricsMode.prototype._unrevealVideo = function _unrevealVideo() {
    clearTimer(this.revealTimer);
    this.revealTimer = null;
    this.videoRevealed = false;
    if (this.stage) this.stage.classList.remove('vlm-mv-on');
  };

  /**
   * 视频真正开始播放后再等几秒才露出来：
   *   * 刚加载时画面可能是黑的/广告/缓冲（用户看到的"黑屏"就是这个），
   *   * 先让模糊封面顶着，等 MV 稳定播放 MV_REVEAL_DELAY_MS 后再淡入，
   *     观感上不会闪黑。
   */
  VideoLyricsMode.prototype._scheduleReveal = function _scheduleReveal() {
    if (this.videoRevealed) return;
    clearTimer(this.revealTimer);
    this.revealTimer = setTimer(() => {
      this.revealTimer = null;
      if (this.ytFailed || !this.ytReady) return;
      this._revealVideo();
    }, MV_REVEAL_DELAY_MS);
  };

  VideoLyricsMode.prototype._createPlayer = function _createPlayer(videoId) {
    if (!this.mvHost) return;
    // 只在"异步加载期间"用它判断有没有被切歌；播放器创建完成后就交给 playerToken，
    // 否则这里的 token 会一直等于旧值，把之后所有 onReady / onError 全过滤掉。
    const token = ++this.playerToken;
    this._setStatus(this.t('mvLoading', '正在加载官方 MV…'));
    loadYouTubeApi(API_LOAD_TIMEOUT_MS).then((YT) => {
      if (token !== this.playerToken) return;            // 已经切歌/销毁
      if (!YT) { this._failVideo('IFrame API 加载失败'); return; }
      let player = null;
      try {
        player = new YT.Player(this.mvHost.id, {
          videoId,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            autoplay: 0,          // 由本地音频状态驱动，不自己 autoplay
            controls: 1,          // 显示 YouTube 原生控件（不隐藏播放器）
            rel: 0,
            playsinline: 1,
            mute: 1,             // 必须静音：音轨由 KaraokeMixer 提供
            loop: 0,             // 单视频 loop 参数不可靠，用 onStateChange=ENDED 自己重载
            fs: 0,               // 大屏本身可以全屏，避免 YouTube 全屏按钮抢焦点
            disablekb: 1,
            modestbranding: 1,
            origin: global.location ? global.location.origin : undefined,
          },
          events: {
            onReady: (event) => {
              if (player !== this.yt) return; // 已被切歌/销毁
              this.ytReady = true;
              this._clearReadyTimer();
              this._applyMute(event.target);
              // 注意：这里**先不露出 MV**。玩家看到的仍是模糊封面，
              // 等真正进入 PLAYING 且稳定几秒后再淡入（见 _scheduleReveal）。
              this._setStatus('');
              // 跟随当前本地音频状态（不要自作主张 autoplay）
              if (this.playing) {
                this._playVideo();
                // 首播兜底：ready 后如果迟迟等不到 PLAYING，重试/重建（见 _armPlayWatchdog）
                this._armPlayWatchdog();
              } else {
                this._pauseVideo();
              }
            },
            onStateChange: (event) => {
              if (player !== this.yt) return;
              if (event.data === YT_STATE.ENDED) {
                // MV 比歌短 → 重新加载同一首，从 0 开始循环
                if (this.playing) this._restartLoop(videoId, token);
                else this._setStatus(this.t('mvEnded', 'MV 已结束，本地音频继续'));
              } else if (event.data === YT_STATE.PLAYING) {
                this._clearReadyTimer();
                this._applyMute(event.target); // 播放中再确认一次静音
                // 真的开始播了 → 过几秒淡出封面，露出视频
                this._scheduleReveal();
              } else if (event.data === YT_STATE.BUFFERING) {
                // 缓冲期间不露出（否则会看到黑屏/转圈）；已经露出的保持原样
                if (!this.videoRevealed) clearTimer(this.revealTimer);
              }
            },
            onError: (event) => {
              if (player !== this.yt) return; // 旧播放器迟到的错误事件
              const codes = {
                2: '视频 ID 无效',
                5: 'HTML5 播放器错误',
                100: '视频不存在或已删除',
                101: '视频不允许嵌入',
                150: '视频不允许嵌入',
              };
              this._failVideo(codes[event.data] || `YouTube 播放错误 ${event.data}`, event.data);
            },
          },
        });
      } catch (error) {
        this._failVideo(`IFrame 初始化失败：${error && error.message ? error.message : error}`);
        return;
      }
      this.yt = player;
      // ready 迟迟不来（被扩展/网络拦截）也要回退，不能无限 Loading。
      // 注意：一挂完超时计时器就**立即释放 token**（见 _scheduleReadyTimeout）——
      // 这里的 token 只负责"这一轮创建"，之后的事件靠 playerToken 判定。
      // ready 迟迟不来（被扩展/网络拦截）也要回退，不能无限 Loading。
      // 注意顺序：先登记超时，再做收尾；任何一步抛错都不能让 this.yt 已经建好却没挂上超时。
      try {
        this._scheduleReadyTimeout();
      } catch (timerError) {
        // 没有可用的定时器不算失败：onReady/onError 仍然会正常回调，只是少了超时兜底
        if (global.console && global.console.warn) global.console.warn('[mv] 定时器不可用：', timerError && timerError.message);
      }
    }).catch((error) => {
      if (token !== this.playerToken) return;
      this._failVideo(`IFrame 初始化失败：${error && error.message ? error.message : error}`);
    });
  };

  /** ready 超时看门狗：超时未 ready → 判定 MV 不可用并回退封面 */
  VideoLyricsMode.prototype._scheduleReadyTimeout = function _scheduleReadyTimeout() {
    this._clearReadyTimer();
    this.readyTimer = setTimer(() => {
      this.readyTimer = null;
      if (this.ytReady || this.ytFailed) return;
      this._failVideo('YouTube 播放器初始化超时');
    }, PLAYER_READY_TIMEOUT_MS);
  };

  /** 静音是硬性要求：属性 + 方法双保险，每次播放/状态变化都再确认一次 */
  VideoLyricsMode.prototype._applyMute = function _applyMute(player) {
    const p = player || this.yt;
    if (!p || typeof p.mute !== 'function') return;
    try { p.mute(); } catch { /* ignore */ }
  };

  VideoLyricsMode.prototype._playVideo = function _playVideo() {
    if (!this.yt || !this.ytReady || this.ytFailed) return;
    try {
      this._applyMute();
      if (typeof this.yt.playVideo === 'function') this.yt.playVideo();
    } catch { /* ignore */ }
  };

  VideoLyricsMode.prototype._pauseVideo = function _pauseVideo() {
    if (!this.yt || !this.ytReady || this.ytFailed) return;
    try { if (typeof this.yt.pauseVideo === 'function') this.yt.pauseVideo(); } catch { /* ignore */ }
  };

  VideoLyricsMode.prototype._stopVideo = function _stopVideo() {
    if (!this.yt || !this.ytReady || this.ytFailed) return;
    try { if (typeof this.yt.stopVideo === 'function') this.yt.stopVideo(); } catch { /* ignore */ }
  };

  /** 单视频循环：重新 loadVideoById({videoId, startSeconds:0})，不用 seekTo 反复校正 */
  VideoLyricsMode.prototype._restartLoop = function _restartLoop(videoId, token) {
    if (!this.yt || !this.ytReady || this.ytFailed) return;
    clearTimer(this.loopTimer);
    this.loopTimer = setTimer(() => {
      this.loopTimer = null;
      if (token !== this.playerToken || !this.yt || this.ytFailed) return;
      try {
        this._applyMute();
        if (typeof this.yt.loadVideoById === 'function') this.yt.loadVideoById({ videoId, startSeconds: 0 });
      } catch { /* ignore */ }
    }, LOOP_RESTART_MS);
  };

  VideoLyricsMode.prototype._clearReadyTimer = function _clearReadyTimer() {
    clearTimer(this.readyTimer);
    this.readyTimer = null;
  };

  /**
   * MV 判定为"放不出来"：销毁播放器、回退模糊封面、通知外部记录 unavailable。
   * 不抛错、不影响歌词与本地音频。
   */
  VideoLyricsMode.prototype._failVideo = function _failVideo(reason, code) {
    if (this.ytFailed) return;
    this.ytFailed = true;
    this.ytReady = false;
    const failedId = this.visualVideoId;
    this._destroyPlayer();
    this._hideMvLayer();
    this._applyBlurredCover();
    this._setStatus(this.t('mvUnavailable', '官方 MV 不可用，已切换到专辑封面'));
    if (failedId && typeof this.onVideoError === 'function') {
      try { this.onVideoError({ videoId: failedId, reason: String(reason || ''), code: code == null ? null : code }); } catch { /* ignore */ }
    }
  };

  VideoLyricsMode.prototype._destroyPlayer = function _destroyPlayer() {
    this.playerToken += 1;
    this._clearReadyTimer();
    clearTimer(this.playWatchdog);
    this.playWatchdog = null;
    clearTimer(this.loopTimer);
    this.loopTimer = null;
    this._unrevealVideo(); // 切歌/销毁时把封面放回来，避免闪黑
    const player = this.yt;
    this.yt = null;
    this.ytReady = false;
    if (player) {
      try { if (typeof player.pauseVideo === 'function') player.pauseVideo(); } catch { /* ignore */ }
      try { if (typeof player.destroy === 'function') player.destroy(); } catch { /* ignore */ }
    }
    // YT.Player.destroy() 会移除它创建的 iframe；宿主容器本身留着给下一个播放器用
    if (this.mvHost) {
      try { while (this.mvHost.firstChild) this.mvHost.removeChild(this.mvHost.firstChild); } catch { /* ignore */ }
    }
  };

  /** 人声强度滑块挂到这里（叠在 MV 上方，位置由 CSS 决定） */
  VideoLyricsMode.prototype.vocalSlot = function vocalSlot() {
    return this.vocalHost || null;
  };

  /**
   * 跟随本地音频：play / pause / resume。
   * playing=false 时只是暂停（不销毁播放器），下次播放继续。
   */
  VideoLyricsMode.prototype.setPlaying = function setPlaying(playing) {
    this.playing = Boolean(playing);
    if (!this.yt || !this.ytReady || this.ytFailed) {
      // 还没 ready：记住意图即可，onReady 里会按 this.playing 补一次 play
      return;
    }
    if (this.playing) {
      this._playVideo();
      this._armPlayWatchdog();
    } else {
      this._pauseVideo();
    }
  };

  /**
   * 播放看门狗：**首播专属的兜底**。
   *
   * 实测现象：新歌第一次播放时，MV iframe 已经建好、id 也对，`playVideo()` 也调了，
   * 但 YouTube 迟迟不发 PLAYING 事件 → `_scheduleReveal` 永远不触发 →
   * 模糊封面一直盖着，看起来就是"没有 MV"；同一首重播时却 2 秒就出来了。
   *
   * 这里兜三层：等一会儿重试 play → 还不行就重建一次播放器 → 最后才判失败回退封面。
   * 每一层都比"永远盖着封面、也不报错"好。
   */
  VideoLyricsMode.prototype._armPlayWatchdog = function _armPlayWatchdog() {
    if (this.playWatchdog) return;
    if (this.ytFailed || !this.playing || !this.ytReady || this.videoRevealed) return;
    // 重建过播放器之后再给更长的等待：慢网下 MV 缓冲就是会久一点，
    // 不能因为"比别人慢"就把这首歌判成没有 MV。
    const delay = this.playRetries < 1 ? PLAY_WATCHDOG_MS : PLAY_WATCHDOG_RETRY_MS;
    this.playWatchdog = setTimer(() => {
      this.playWatchdog = null;
      if (this.ytFailed || !this.playing || !this.ytReady || this.videoRevealed) return;
      // 第一层：可能只是一次 play 没生效，重试一次
      this._playVideo();
      if (this.playRetries < 1) {
        // 第二层：重建播放器（只重建一次），旧实例可能已经"哑"了
        this.playRetries += 1;
        const videoId = this.visualVideoId;
        this._destroyPlayer();
        if (videoId) this._createPlayer(videoId);
        return;
      }
      // 第三层：确实没放出来。**只在本机回退封面**，不写曲库 ——
      // 慢网/临时抽风不等于"这个 MV 不可用"，写 unavailable 会让它以后都不再加载。
      this._abandonVideo('MV 播放器无响应');
    }, delay);
  };

  /**
   * 放弃这一首 MV 的播放（本地回退封面），但**不**上报"不可用"。
   *
   * 与 _failVideo 的区别：_failVideo 用于 YouTube 明确报错（101/150 等，
   * 这个视频确实放不出来，要写回曲库免得下次再加载）；这里用于"没等到画面"
   * 这种说不清的临时状态，只在本次播放回退到模糊封面。
   */
  VideoLyricsMode.prototype._abandonVideo = function _abandonVideo(reason) {
    if (this.ytFailed) return;
    this.ytFailed = true;
    this.ytReady = false;
    this._destroyPlayer();
    this._hideMvLayer();
    this._applyBlurredCover();
    this._setStatus(this.t('mvUnavailable', '官方 MV 不可用，已切换到专辑封面'));
    if (global.console && global.console.warn) global.console.warn('[mv] 放弃本次 MV 播放：' + String(reason || ''));
  };

  /** 音频结束 / 切歌前：停止 MV（不销毁，销毁由 destroy() 或 setVisualVideoId 负责） */
  VideoLyricsMode.prototype.stopVideo = function stopVideo() {
    this.playing = false;
    clearTimer(this.playWatchdog);
    this.playWatchdog = null;
    this._stopVideo();
  };

  /**
   * 行内 HTML。
   * **只有逐字模式（wordMode）才把字拆成 span**；逐行模式输出纯文本。
   * 以前不看 wordMode，一律拆字 → 切到"逐行"后 DOM 里仍是一堆 .lv-ch，
   * 视觉上看不出任何变化（用户反馈"点了没反应"）。
   */
  VideoLyricsMode.prototype._renderLineHTML = function _renderLineHTML(line) {
    if (!line) return '';
    if (hasWordChars(line) && this.wordMode) {
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
    this._lastAnimatedIndex = -1;       // 换歌/换歌词：允许第一行播一次入场动画
    this._lastNextAnimatedIndex = -1;   // 下一行也允许播一次淡入
    this.sungIndex = -1;
    this._litLine = -1;
    this._litCount = -1;
    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    if (!this.lines.length) {
      if (this.curText) this.curText.innerHTML = `<span class="vlm-empty">${this.t('lyricsNone', '这首歌暂时没有歌词')}</span>`;
      if (this.nextText) this.nextText.textContent = '';
      if (this.curEl) this.curEl.classList.remove('has-word');
      // 不要用"没有歌词"覆盖"MV 加载失败"的提示（后者更重要）
      if (raw.length && !this.ytFailed) this._setStatus(this.t('lyricsUntimed', '这份歌词没有时间轴，无法跟唱'));
      return;
    }
    this._paint(-1, -1, 0);
    return this;
  };

  /** DJ 切换逐字/逐行（true=逐字）。改动立即重画。
   *
   * 注意：app.js 在 mount() 之后、setLyrics() 之前就会调这里（挂载时就应用 DJ 的开关），
   * 那时 `this.lines` 刚在 mount 里被重置。**不能直接读 this.lines.some()** ——
   * 之前就是这个 bug 让整个大屏 render() 抛
   * `Cannot read properties of undefined (reading 'some')`，
   * 画面和右侧队列一起变成空白（表现为"队列永远是空的"）。
   */
  VideoLyricsMode.prototype.setWordLevel = function setWordLevel(on) {
    this.wordLevelEnabled = Boolean(on);
    const lines = Array.isArray(this.lines) ? this.lines : [];
    const hasWord = lines.some(hasWordChars);
    // wordMode 表示"实际按字逐个点亮"。没有逐字数据时只能整行，但**也要把
    // 当前的显示方式告诉管理员**，否则点了看起来完全没反应（用户反馈的问题）。
    this.wordMode = this.wordLevelEnabled && hasWord;
    if (this.stage) this.stage.classList.toggle('vlm-wordmode', this.wordMode);
    this.curIndex = null;        // 强制重画
    this._forceRepaint = true;   // 即使还在同一行，也要用新的渲染方式重写 HTML
    try { this.update(this.lastTime); } catch { /* ignore */ }
    if (!this.ytReady || this.ytFailed) {
      // MV 还没出来（或已失败），状态条归 MV 提示管，这里不要覆盖
    } else if (this.wordLevelEnabled && this.lines.length && !hasWord) {
      this._setStatus(this.t('wordLevelUnavailable',
        '这首歌的歌词没有逐字数据（只有行级时间轴），已按整行显示'));
      // 3 秒后自动收起提示，不要一直挡着画面
      clearTimer(this.wordHintTimer);
      this.wordHintTimer = setTimer(() => {
        if (!this.ytFailed) this._setStatus('');
      }, 3000);
    } else if (!this.ytFailed && !this.ytReady) {
      // 切换成功且歌词有逐字：清掉"没有逐字数据"的提示（MV 加载中的提示留着）
    } else if (!this.ytFailed) {
      this._setStatus('');
    }
    return this.wordMode;
  };

  /** DJ 切换视频模式下是否显示歌词 */
  VideoLyricsMode.prototype.setLyricsVisible = function setLyricsVisible(visible) {
    this.lyricsVisible = Boolean(visible);
    if (this.stage) this.stage.classList.toggle('vlm-no-lyrics', !this.lyricsVisible);
  };

  /**
   * 切行动画：当前行从下方升起 + 淡入（.vlm-enter → @keyframes vlm-rise）。
   *
   * 为什么要"摘掉 → 强制回流 → 再加回"：
   *   浏览器只有在 class 真正"新增"时才会重播 animation。同一帧里 remove + add
   *   会被合并成"本来就是有的"，动画不重播；另外 `.vlm-line` 上有 transform 的
   *   transition，和 animation 争同一个属性，必须用一次强制 reflow 把它清干净。
   */
  VideoLyricsMode.prototype._playEnterAnimation = function _playEnterAnimation() {
    const el = this.curEl;
    if (!el || !el.classList) return;
    el.classList.remove('vlm-enter');
    // 强制一次样式计算（读 offsetWidth 会触发 reflow），让 remove 生效
    try { void el.offsetWidth; } catch { /* ignore */ }
    const add = () => { try { el.classList.add('vlm-enter'); } catch { /* ignore */ } };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(add);
    else setTimer(add, 16);
  };

  /**
   * 下一行的轻微淡入（8% 上浮 + 淡入，.36s）。
   *
   * 它比当前行的"升起"更轻：让"即将唱的那句"出现时不突兀，但不抢主角。
   * 和当前行一样，靠 remove → 强制 reflow → 下一帧 add 来保证动画能重播
   * （同一元素 class 不"新增"的话浏览器不会重播）。
   */
  VideoLyricsMode.prototype._playNextEnterAnimation = function _playNextEnterAnimation() {
    const el = this.nextEl;
    if (!el || !el.classList) return;
    el.classList.remove('vlm-next-enter');
    try { void el.offsetWidth; } catch { /* ignore */ }
    const add = () => { try { el.classList.add('vlm-next-enter'); } catch { /* ignore */ } };
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(add);
    else setTimer(add, 16);
  };

  /**
   * 把当前状态画到 DOM 上。只在"行"变化时重写文字（避免每 50ms 重建 DOM）。
   */
  VideoLyricsMode.prototype._paint = function _paint(baseIndex, _activeIndex, tMs) {
    const lines = this.lines;
    if (!lines.length) return;
    // 强制重画标记：切换逐字/逐行时调用方把 curIndex 置空，
    // 但"同一行"的 baseIndex 可能和上一次相同 → 单纯比较 baseIndex 会漏掉重画，
    // 表现为"点了切换，画面没变化"（实测：同一个字 span 数量不变）。
    const forced = this._forceRepaint === true;
    this._forceRepaint = false;
    const changed = forced || baseIndex !== this.curIndex;
    this.curIndex = baseIndex;
    const curLine = baseIndex >= 0 ? lines[baseIndex] : null;
    const nextLine = baseIndex + 1 < lines.length ? lines[baseIndex + 1] : null;

    if (changed) {
      if (this.curText) this.curText.innerHTML = this._renderLineHTML(curLine);
      if (this.nextText) this.nextText.innerHTML = this._renderLineHTML(nextLine);
      if (this.curEl) this.curEl.classList.toggle('has-word', hasWordChars(curLine));
      if (this.nextEl) this.nextEl.classList.toggle('has-word', hasWordChars(nextLine) && !this.wordMode);
      // 切行动画**只在真的换行时**播放；切换逐字/逐行（forced 重画）不播，
      // 否则每点一次开关，当前行都会重新"升起来"一次，看着像在乱动。
      if (!forced && baseIndex >= 0 && baseIndex !== this._lastAnimatedIndex) {
        this._lastAnimatedIndex = baseIndex;
        this._playEnterAnimation();
      }
      // 下一行换了内容 → 轻微淡入（同样只在真换行时播，切换逐字/逐行不动）
      const nextIdx = baseIndex + 1;
      if (!forced && nextLine && nextIdx !== this._lastNextAnimatedIndex) {
        this._lastNextAnimatedIndex = nextIdx;
        this._playNextEnterAnimation();
      }
    }

    // 逐字亮度：每个字按「自己唱到百分之几」算一个不透明度，从灰推到纯白。
    // ── 歌词点亮：两种模式含义不同，必须分开处理 ──
    //   逐字（wordMode=true）：当前行拆成 .lv-ch，**按每个字自己的发音时间**逐个变白，
    //                          唱到哪个字哪个字变亮（从左往右扫）。
    //   逐行（wordMode=false）：当前行整行一起变亮（行级时间轴），不拆字。
    if (this.wordMode && hasWordChars(curLine) && this.curText) {
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
    // 逐行模式：整行"已唱 / 未唱"由 CSS 的 .is-sung class 控制（整行一起变亮）。
    if (this.curEl) {
      // activeIndex 是"本行还没结束"时的行号；-1 表示这一行已经唱完了（间隙期）
      const lineSung = !this.wordMode && baseIndex >= 0 && _activeIndex === baseIndex;
      this.curEl.classList.toggle('is-sung', lineSung);
      this.curEl.classList.toggle('is-word', this.wordMode);
    }
  };

  /**
   * 由 mixer.onTimeUpdate 驱动（每 50ms 一次）。**只驱动歌词**：
   * MV 不跟随时间轴（不对 timeupdate 做 seek），避免频繁 seek 与平台限制问题。
   */
  VideoLyricsMode.prototype.update = function update(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) return;
    this.lastTime = t;
    this.duration = Number.isFinite(this.duration) ? this.duration : (this.options.duration || 0);
    const tMs = t * 1000;
    if (!Array.isArray(this.lines) || !this.lines.length) return; // 没有歌词时只要不报错

    const sung = findSungIndex(this.lines, tMs);
    const active = findIndex(this.lines, tMs);
    const baseIndex = sung;
    if (this.lines.length) {
      const curLine = baseIndex >= 0 ? this.lines[baseIndex] : null;
      if (baseIndex !== this.curIndex) this.sungIndex = sung;
      if (baseIndex !== this.curIndex || hasWordChars(curLine)) this._paint(baseIndex, active, tMs);
      if (this.stage) this.stage.classList.toggle('vlm-gap', sung >= 0 && active < 0);
    }
  };

  /**
   * 点击画面跳转：只动本地音频（mixer），MV 保持自己的进度。
   * @returns {boolean} 是否真的触发了跳转
   */
  VideoLyricsMode.prototype.seek = function seek(tSec) {
    const t = Number(tSec);
    if (!Number.isFinite(t)) return false;
    if (typeof this.onSeek === 'function') {
      try { this.onSeek(t); } catch { /* ignore */ }
    }
    this.update(t);
    return true;
  };

  VideoLyricsMode.prototype.destroy = function destroy() {
    for (const [el, type, fn] of this.listeners) {
      try { el.removeEventListener(type, fn); } catch { /* ignore */ }
    }
    this.listeners = [];
    this._destroyPlayer();
    this.mvWrap = null;
    this.mvFrame = null;
    this.mvHost = null;
    if (this.root) this.root.innerHTML = '';
    this.stage = null;
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
    // 兼容旧调用：以前返回本地 video 元素；现在视频是 YouTube iframe 宿主，没有就返回 null
    get() { return this.yt ? this.mvHost : null; },
  });

  global.VideoLyricsMode = VideoLyricsMode;
  global.VideoLyricsModeHelpers = {
    esc,
    validVideoId,
    findSungIndex,
    findIndex,
    wordProgress,
    loadYouTubeApi,
    YT_STATE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
