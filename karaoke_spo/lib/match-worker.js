'use strict';
/**
 * 批量补齐任务（曲库管理页的「一键匹配 MV / 歌词」）。
 *
 * 设计目标：**低并发、可观察、可取消**，绝不和现场播放抢资源。
 *
 *   * 一个全局队列，**同时只跑 1 个任务**（串行）。YouTube Data API 短时间连发
 *     search 会 429，所以每首歌之间还要 sleep（默认 1.5s）。
 *   * 只做三件事：
 *       mv       —— Official MV 匹配（只调 YouTube / YouTube Music，不下载）
 *       lyrics   —— 歌词匹配：先在曲库里找，没有就调 fetch_lyrics.py（lrclib），
 *                   失败再交给现有 Node 歌词源（QQ / 网易云），结果写进覆盖表
 *       loudness —— 伴奏响度测量（ffmpeg 分析 LUFS / True Peak，写回曲库，不改音频）
 *   * 进度存在内存里，并通过 onChange 回调让 server 走现有的 SSE 广播，
 *     曲库页能看到「正在处理 3/28 · 歌名」。
 *   * 失败不阻塞后续：单首失败记为 failed，继续下一首。
 *   * 可取消（DJ 点"停止"）。
 *
 * 本模块不依赖 server.js，便于单测。
 */

const DEFAULTS = {
  // 每首歌处理完等多久（毫秒）。YouTube 限流很敏感，串行 + 间隔最稳。
  gapMs: Number(process.env.KARAOKE_MATCH_GAP_MS || 1500),
  // 单首最多处理多久（避免某首歌卡死整个队列）
  itemTimeoutMs: Number(process.env.KARAOKE_MATCH_ITEM_TIMEOUT_MS || 120000),
  // 连续多少次"限流"就暂停整批（等冷却结束再继续）
  maxRateLimitHits: 3,
};

/** 支持的任务类型。加类型时只要在这里加一项 + 构造函数里加对应 runner。 */
const KIND_RUNNERS = ['mv', 'lyrics', 'loudness'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nowIso() { return new Date().toISOString(); }

class MatchWorker {
  /**
   * @param {object} opts
   * @param {() => void} [opts.onChange] 状态变化回调（server 用来 persist+broadcast）
   * @param {(item: object) => Promise<object>} [opts.runMv] 单首 MV 处理
   * @param {(item: object) => Promise<object>} [opts.runLyrics] 单首歌词处理
   * @param {(item: object) => Promise<object>} [opts.runLoudness] 单首响度测量
   */
  constructor(opts = {}) {
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.runMv = typeof opts.runMv === 'function' ? opts.runMv : null;
    this.runLyrics = typeof opts.runLyrics === 'function' ? opts.runLyrics : null;
    this.runLoudness = typeof opts.runLoudness === 'function' ? opts.runLoudness : null;
    this.options = { ...DEFAULTS, ...(opts.options || {}) };
    /** @type {{state:string, items:object[], current:string|null, startedAt:string|null, finishedAt:string|null, startedBy:string|null, counts:object, errors:string[]}} */
    this.status = this._empty();
    this._generation = 0;   // 每次 start/cancel +1，旧循环看到不一致就退出
    this._cancelled = false;
  }

  _empty() {
    return {
      state: 'idle',        // idle | running | done | cancelled | failed
      items: [],
      current: null,        // 当前处理的 spotifyId
      startedAt: null,
      finishedAt: null,
      counts: { total: 0, pending: 0, done: 0, failed: 0, skipped: 0, remaining: 0 },
      errors: [],
    };
  }

  _emit() {
    this._recount();
    try { this.onChange(this.toPublic()); } catch { /* 回调失败不影响任务 */ }
  }

  _recount() {
    const items = this.status.items;
    const counts = { total: items.length, pending: 0, done: 0, failed: 0, skipped: 0, remaining: 0 };
    for (const item of items) {
      if (item.state === 'pending') counts.pending += 1;
      else if (item.state === 'done') counts.done += 1;
      else if (item.state === 'failed') counts.failed += 1;
      else if (item.state === 'skipped') counts.skipped += 1;
    }
    counts.remaining = counts.pending;
    this.status.counts = counts;
  }

  toPublic() {
    const s = this.status;
    return {
      state: s.state,
      current: s.current,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      counts: { ...s.counts },
      errors: s.errors.slice(-5),
      // 明细只给前 200 条，避免 payload 过大（曲库页只需要看进度和失败项）
      items: s.items.slice(0, 200).map((item) => ({
        spotifyId: item.spotifyId,
        title: item.title,
        kinds: item.kinds,
        state: item.state,
        results: item.results || {},
        error: item.error || null,
      })),
    };
  }

  /** 正在跑就返回 true（避免重复点击开两个队列） */
  get running() {
    return this.status.state === 'running';
  }

  /**
   * 启动一批。
   * @param {Array<{spotifyId:string, title:string, kinds:string[]}>} items
   * @param {{startedBy?: string}} meta
   */
  start(items, meta = {}) {
    if (this.running) return { ok: false, reason: 'already-running', job: this.toPublic() };
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item && /^[A-Za-z0-9]{22}$/.test(String(item.spotifyId || '')))
      .map((item) => ({
        spotifyId: String(item.spotifyId),
        title: String(item.title || '').slice(0, 120),
        kinds: (Array.isArray(item.kinds) && item.kinds.length ? item.kinds : ['mv', 'lyrics'])
          .filter((kind) => KIND_RUNNERS.includes(kind)),
        state: 'pending',
        results: {},
        error: null,
      }));
    if (!list.length) return { ok: false, reason: 'empty', job: this.toPublic() };

    this._generation += 1;
    this._cancelled = false;
    this.status = {
      ...this._empty(),
      state: 'running',
      items: list,
      startedAt: nowIso(),
      startedBy: meta.startedBy || null,
    };
    this._emit();
    const generation = this._generation;
    // 后台跑，不阻塞 HTTP 响应
    this._loop(generation).catch((error) => {
      this.status.state = 'failed';
      this.status.finishedAt = nowIso();
      this.status.errors.push(String(error && error.message));
      this._emit();
    });
    return { ok: true, job: this.toPublic() };
  }

  /** 取消：当前这首跑完（或超时）后停止，剩下的标记 skipped */
  cancel() {
    if (!this.running) return { ok: false, reason: 'not-running', job: this.toPublic() };
    this._cancelled = true;
    this._generation += 1;
    this.status.state = 'cancelled';
    this.status.finishedAt = nowIso();
    for (const item of this.status.items) if (item.state === 'pending') item.state = 'skipped';
    this._emit();
    return { ok: true, job: this.toPublic() };
  }

  async _loop(generation) {
    let rateLimitHits = 0;
    while (generation === this._generation) {
      const item = this.status.items.find((entry) => entry.state === 'pending');
      if (!item) break;
      if (this._cancelled) break;
      this.status.current = item.spotifyId;
      this._emit();
      try {
        const result = await this._runItem(item);
        item.results = result || {};
        item.state = 'done';
        if (item.results.rateLimited) {
          // 被 YouTube 限流：这首留到下次，整批歇一会儿
          rateLimitHits += 1;
          item.state = 'skipped';
          item.error = 'YouTube 限流，稍后重试';
          if (rateLimitHits >= this.options.maxRateLimitHits) {
            for (const rest of this.status.items) if (rest.state === 'pending') rest.state = 'skipped';
            this.status.errors.push('连续多次被 YouTube 限流，本批提前结束（稍后可以再点一次）');
            break;
          }
        }
      } catch (error) {
        item.state = 'failed';
        item.error = String((error && error.message) || error).slice(0, 300);
        this.status.errors.push(`${item.title || item.spotifyId}: ${item.error}`);
        // 单首失败不影响后面的：继续循环
      }
      this._emit();
      if (generation !== this._generation) break;
      await sleep(this.options.gapMs); // 节流：绝不并发轰炸 YouTube
    }
    if (generation === this._generation) {
      this.status.current = null;
      this.status.state = this._cancelled ? 'cancelled' : 'done';
      this.status.finishedAt = nowIso();
      this._emit();
    }
  }

  /**
   * 处理一首歌的所有 kind（mv / lyrics / loudness）。
   *
   * 抛错约定：单首的 runner 抛异常时，把错误**继续往上抛**（由 _loop 记成 failed），
   * 不能吞成一个 `{error}` 结果 —— 那样这首歌会被算成 done（曾经就是这个 bug）。
   */
  async _runItem(item) {
    const results = {};
    for (const kind of item.kinds) {
      if (this._cancelled) break;
      const runner = kind === 'mv' ? this.runMv : kind === 'loudness' ? this.runLoudness : this.runLyrics;
      if (typeof runner !== 'function') continue;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), this.options.itemTimeoutMs);
        timer.unref?.();
      });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => runner(item)),
          timeout,
        ]);
        if (result && result.__timeout) {
          results[kind] = { error: 'timeout' };
          throw new Error(`${kind} 处理超时`);
        }
        results[kind] = result || {};
        if (result && result.rateLimited) return { ...results, rateLimited: true };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return results;
  }

  /** 给 /api/library/admin 用：一眼看出"还有多少没匹配" */
  attachSummary(payload) {
    return { ...payload, matcher: this.toPublic() };
  }
}

module.exports = { MatchWorker, DEFAULTS, KIND_RUNNERS };
