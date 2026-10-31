'use strict';
/**
 * 后台制作队列（模式 B）：用户点了曲库里没有 / 未就绪的歌 → 后台跑 pipeline.py。
 *
 * 设计要点
 * - **多首并行（默认 3 首）**：同时跑最多 `concurrency` 个 pipeline 子进程。
 *   实测（Arc B390 / 16 核）单首耗时 ≈ 元数据 2s + max(下载 20s, 歌词 5s) +
 *   分离 25s + 成片 5s ≈ 52s，其中 GPU 分离只占 ~25s。让 3 首并行，
 *   下载/歌词/成片互不阻塞，GPU 由 Python 侧的跨进程锁（scripts/gpu_lock.py）
 *   串行化 —— 并发 2 个 Demucs 每个都要 1.8 倍时间、进程各吃 4.5GB 内存，
 *   吞吐只快 ~20%，不值得。
 *   可用环境变量 KARAOKE_PREPARE_CONCURRENCY=1..4 覆盖（1 = 旧版严格串行）。
 * - **持久化**：任务写 data/prepare-jobs.json（原子写：临时文件 + fsync + rename），
 *   进程重启后 load() 会把未完成的任务重新排进队列继续跑。
 * - **幂等**：同一 spotifyId 已在准备队列（含 running）里 → 直接返回已有任务，不重复入队。
 * - **阶段识别**：用宽松正则解析 pipeline.py 的 stdout，识别出阶段与百分比；
 *   解析失败不会让任务失败 —— 只是进度不前进，最终以退出码为准。
 *
 * 状态机：
 *   queued → running → ready
 *                    ↘ failed      （pipeline 退出码非 0 / 抛错）
 *                    ↘ interrupted （进程重启时子进程随父进程消失）
 *   queued|canceled/running → canceled（用户取消，kill 子进程）
 *
 * 本模块不依赖 server.js，可以单独 require 测试。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ENV_DIR } = require('./env');
const { childEnv } = require('./child-env');

const ROOT = path.resolve(__dirname, '..');
const JOBS_FILE = path.join(ROOT, 'data', 'prepare-jobs.json');
const LOG_DIR = path.join(ROOT, 'logs');

// Python 解释器：控制面板注入的 KARAOKE_PYTHON 优先，
// 其次根目录 env\python，最后回退到旧布局 karaoke_spo\python\.venv-xpu / .venv。
//
// 注意：`firstExisting` 在"全都不存在"时返回**第一个候选**（即 process.env.KARAOKE_PYTHON，
// 未设置时就是 undefined）。以前直接把它当解释器路径用，spawn 出来的错误是
// `spawn undefined ENOENT`，每首歌都"处理失败"却看不出原因。这里显式做三件事：
//   1. 环境变量为空时回退到 env\python 的真实路径（而不是空字符串）；
//   2. 所有候选都转成绝对路径，避免 cwd 变化时解析到别处；
//   3. 启动时打印一行"用的哪个 Python / 是否存在"，没有就直接指向安装方式。
// 另一个坑：直接 `node karaoke_spo/main.js` 启动时不会经过启动器，
// ENV_DIR 会退化成 `karaoke_spo\env\`（不存在），所以额外找**项目根**的 env\python。
const PYTHON_CANDIDATES = [
  process.env.KARAOKE_PYTHON,
  path.join(ENV_DIR, 'python', 'Scripts', 'python.exe'),
  path.join(ROOT, 'env', 'python', 'Scripts', 'python.exe'),
  path.join(ROOT, '..', 'env', 'python', 'Scripts', 'python.exe'),
  path.join(ROOT, 'python', '.venv-xpu', 'Scripts', 'python.exe'),
  path.join(ROOT, 'python', '.venv', 'Scripts', 'python.exe'),
].filter((candidate) => Boolean(candidate && String(candidate).trim()));

function resolvePython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
    try { if (fs.existsSync(abs)) return abs; } catch { /* ignore */ }
  }
  return PYTHON_CANDIDATES.length ? path.resolve(ROOT, PYTHON_CANDIDATES[0]) : '';
}

const DEFAULT_PYTHON = resolvePython();
const DEFAULT_STEPS = 'metadata,download,lyrics,separate,finalize';

/**
 * 同时制作几首。默认 3：实测 GPU 分离 ~25s/首，其余阶段（网络/成片）能完全叠在
 * 别人的 GPU 时间里；4 首以上 GPU 已饱和，吞吐不再提升，只会拉长单首等待。
 * 环境变量 KARAOKE_PREPARE_CONCURRENCY 可覆盖，范围 1..4。
 */
const DEFAULT_CONCURRENCY = 3;
function normalizeConcurrency(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(4, Math.max(1, n));
}

/**
 * 阶段顺序 + 每个阶段在整体进度里的起点百分比。
 *
 * `mv`（官方 MV 匹配）是**并行**阶段：由 server.js 在本进程里跑（只调 YouTube Data API，
 * 不占 GPU），与 pipeline.py 子进程同时进行。它的成败**不影响**音频制作：
 * 失败时 job 仍是 ready，只是 job.mv 里记下原因，大屏回退模糊封面。
 */
const STAGES = [
  { key: 'queued', label: '排队中', percent: 0 },
  { key: 'metadata', label: '读取元数据', percent: 5 },
  { key: 'download', label: '下载音频', percent: 15 },
  { key: 'lyrics', label: '匹配歌词', percent: 30 },
  { key: 'separate', label: '分离音轨', percent: 40 },
  { key: 'finalize', label: '生成成品', percent: 92 },
  { key: 'mv', label: '匹配官方 MV', percent: 96 },
  { key: 'done', label: '完成', percent: 100 },
];
const STAGE_PERCENT = Object.fromEntries(STAGES.map((s) => [s.key, s.percent]));
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

/** pipeline.py 的输出行 → 阶段。宽松匹配：不依赖行首标记或固定措辞。 */
const STAGE_PATTERNS = [
  { stage: 'metadata', re: /元数据[：:]|fetch_metadata|Spotify 元数据|\[metadata\]/i },
  { stage: 'download', re: /下载完成|已下载，跳过|fetch_audio|\[download\]|开始下载|下载中|并行：下载/i },
  { stage: 'lyrics', re: /歌词[：:]|已有歌词|歌词：没有找到|lrclib|\[lyrics\]/i },
  { stage: 'separate', re: /分离完成|已有 htdemucs 分离结果|\[separate\]|Separator\(|demucs|等待 GPU 分离锁|GPU 分离锁/i },
  { stage: 'finalize', re: /finalize_track|生成成品|encode_mp3|\[finalize\]|=== 结果 ===|等待成片锁|成片锁/i },
];

function nowIso() { return new Date().toISOString(); }

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }

/**
 * 原子写：先写临时文件 + fsync，再 rename 覆盖。
 * 与 server.js 的 writeStateAtomic 同一套做法，避免"写一半被杀 → 文件损坏"。
 */
function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 从 pipeline stdout 行里抽取百分比（0-100）。没有就返回 null。 */
function parsePercent(line) {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v);
}

class PrepareQueue {
  /**
   * @param {object} [opts]
   * @param {string} [opts.jobsFile]     持久化文件路径（测试可覆盖）
   * @param {string} [opts.logDir]       每个任务的日志目录（测试可覆盖）
   * @param {string} [opts.pythonExe]    Python 解释器路径
   * @param {string} [opts.projectRoot]  项目根（spawn 的 cwd）
   * @param {string[]} [opts.steps]      pipeline 步骤
   * @param {number} [opts.concurrency]  同时制作几首（默认 3，范围 1..4）
   * @param {boolean} [opts.disableSpawn] 只跑状态机、不真跑子进程（单元测试用）
   * @param {(event: object) => void} [opts.onChange] 任何状态变化时回调（server 用来 persist + broadcast）
   * @param {(line: string, job: object) => void} [opts.onLog] 子进程输出回调
   */
  constructor(opts = {}) {
    this.jobsFile = opts.jobsFile || JOBS_FILE;
    this.logDir = opts.logDir || LOG_DIR;
    // 显式传入 > 环境变量 > 自动探测（必须是**存在**的路径，见文件顶部 resolvePython 的说明）
    this.pythonExe = opts.pythonExe
      || (process.env.KARAOKE_PYTHON && String(process.env.KARAOKE_PYTHON).trim())
      || DEFAULT_PYTHON;
    this.projectRoot = opts.projectRoot || ROOT;
    // 步骤可以由调用方指定，也允许用环境变量覆盖（排查问题时只跑 metadata,download，不必等 Demucs）
    this.steps = opts.steps || String(process.env.KARAOKE_PREPARE_STEPS || '').trim() || DEFAULT_STEPS;
    this.concurrency = normalizeConcurrency(opts.concurrency ?? process.env.KARAOKE_PREPARE_CONCURRENCY);
    this.disableSpawn = Boolean(opts.disableSpawn);
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.spawnImpl = opts.spawnImpl || spawn;

    /** @type {Map<string, object>} spotifyId → job */
    this.jobs = new Map();
    /** 等待启动的队列（只放 spotifyId），先进先出 */
    this.pending = [];
    /** @type {Map<string, object>} 正在运行的 job（最多 concurrency 个） */
    this.runningJobs = new Map();
    /** @type {Map<string, import('child_process').ChildProcess>} spotifyId → 子进程 */
    this.children = new Map();
    this.stopped = false;
    /** 去重/取消/启动逻辑串行化，避免并发 enqueue 同时把两个任务标成 running */
    this._lock = Promise.resolve();
    this._drainScheduled = false;
    /** disableSpawn 模式下每个任务的 unlock 回调（测试用） */
    this._stageUnlocks = new Map();
    /** 每个任务各自的 stdout/stderr 行缓冲（并发时不能共用一份） */
    this._lineBuffers = new Map();
  }

  /** 兼容旧接口：第一个正在运行的任务（没有则 null）。 */
  get running() {
    return this.runningJobs.size ? this.runningJobs.values().next().value : null;
  }

  /** 兼容旧接口：第一个子进程（没有则 null）。 */
  get child() {
    return this.children.size ? this.children.values().next().value : null;
  }

  // ------------------------------------------------------------ 持久化
  load() {
    // 重启后重新开始，允许调度（stop() 会把 stopped 置 true）
    this.stopped = false;
    let text = null;
    try {
      text = fs.readFileSync(this.jobsFile, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      return { restored: 0 };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      // 损坏不静默重建：备份后从空开始
      const backup = `${this.jobsFile}.corrupt-${Date.now()}`;
      try { fs.writeFileSync(backup, text, 'utf8'); } catch { /* ignore */ }
      console.error(`[prepare] ${path.basename(this.jobsFile)} 解析失败（${err.message}），已备份到 ${backup}`);
      return { restored: 0, error: err.message };
    }
    const list = Array.isArray(data?.jobs) ? data.jobs : [];
    let restored = 0;
    for (const raw of list) {
      if (!raw || !raw.spotifyId) continue;
      // 已结束（ready/failed/canceled）的任务不需要恢复，重启时直接丢掉
      if (!['queued', 'running'].includes(raw.status)) continue;
      const job = { ...raw };
      // 重启时 last running 的子进程已随父进程消失：标成 interrupted 重新排队
      if (job.status === 'running') {
        job.restarts = (job.restarts || 0) + 1;
        job.lastError = job.error || `上次进程中断（第 ${job.restarts} 次重启后续跑）`;
        job.status = 'queued';
        job.stage = 'queued';
        job.progress = { stage: 'queued', percent: 0, note: job.lastError };
        job.pid = null;
      }
      job.error = null;
      this.jobs.set(job.spotifyId, job);
      if (!this.pending.includes(job.spotifyId)) this.pending.push(job.spotifyId);
      restored += 1;
    }
    // 持久化文件里残留的 pending 顺序不再可信（以 jobs 为准重建）
    // 恢复出来的任务要真正跑起来：load() 只负责重建内存状态，由调用方/这里触发调度
    if (this.pending.length) this._scheduleDrain();
    return { restored };
  }

  save() {
    const jobs = [...this.jobs.values()].map((job) => ({
      spotifyId: job.spotifyId,
      title: job.title || null,
      songId: job.songId || null,
      status: job.status,
      stage: job.stage || null,
      progress: job.progress || null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      pid: job.pid || null,
      restarts: job.restarts || 0,
      cancelRequested: Boolean(job.cancelRequested),
      // 官方 MV 并行阶段的结果（重启后保留，避免重复搜索）
      mv: job.mv || null,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
    }));
    writeFileAtomic(this.jobsFile, JSON.stringify({
      version: 1,
      updatedAt: nowIso(),
      // 兼容旧字段：第一个运行中的任务；真正完整的信息看 runningJobs
      running: this.running ? this.running.spotifyId : null,
      runningJobs: [...this.runningJobs.keys()],
      pending: [...this.pending],
      jobs,
    }, null, 2));
  }

  _changed(job, extra = {}) {
    job.updatedAt = nowIso();
    try { this.save(); } catch (err) { console.error(`[prepare] 保存任务文件失败：${err.message}`); }
    try { this.onChange(this.toPublic(job), extra); } catch (err) { console.error(`[prepare] onChange 回调失败：${err.message}`); }
  }

  // ------------------------------------------------------------ 公共 API
  /**
   * 入队。同一 spotifyId 已在队列/运行中 → 不重复入队，返回已有任务。
   * @returns {{job: object, created: boolean}}
   */
  enqueue({ spotifyId, title, songId } = {}) {
    const id = String(spotifyId || '').trim();
    if (!id) throw new Error('enqueue 需要 spotifyId');
    const existing = this.jobs.get(id);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      // 新点歌带上 songId 时把 songId 挂上去（之前可能没有）
      if (songId && !existing.songId) {
        existing.songId = songId;
        existing.title = title || existing.title;
        this._changed(existing, { deduped: true });
      }
      return { job: this.toPublic(existing), created: false };
    }
    const job = {
      spotifyId: id,
      title: title ? String(title).slice(0, 200) : null,
      songId: songId ? String(songId) : null,
      status: 'queued',
      stage: 'queued',
      progress: { stage: 'queued', percent: STAGE_PERCENT.queued },
      startedAt: null,
      finishedAt: null,
      error: null,
      pid: null,
      restarts: existing?.restarts || 0,
      cancelRequested: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    this._changed(job, { enqueued: true });
    this._scheduleDrain();
    return { job: this.toPublic(job), created: true };
  }

  getStatus(spotifyId) {
    const job = this.jobs.get(String(spotifyId || ''));
    return job ? this.toPublic(job) : null;
  }

  /**
   * 取消：queued 直接出队；running 则 kill 子进程；已 terminally 的返回原样。
   *
   * **不要从用户侧调用**：点歌触发的制作属于"曲库资产建设"，用户删除队列项
   * 不应该让已开始的下载半途而废（半成品会浪费整次下载+分离）。只有 DJ 控制台
   * 才走这里。
   */
  cancel(spotifyId) {
    const id = String(spotifyId || '');
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'not-found', job: null };
    if (!['queued', 'running'].includes(job.status)) {
      return { ok: false, reason: `already-${job.status}`, job: this.toPublic(job) };
    }
    job.cancelRequested = true;
    const wasRunning = job.status === 'running';
    this.pending = this.pending.filter((x) => x !== id);
    const child = this.children.get(id);
    if (wasRunning && child) {
      // Windows 上没有 SIGTERM 优雅退出：直接终止。
      try { child.kill(); } catch { /* ignore */ }
      try { if (child.pid) process.kill(child.pid); } catch { /* ignore */ }
    }
    job.status = 'canceled';
    job.stage = null;
    job.progress = { ...(job.progress || {}), stage: 'canceled', percent: job.progress?.percent || 0 };
    job.finishedAt = nowIso();
    job.error = job.error || '用户取消';
    job.pid = null;
    this._changed(job, { canceled: true });
    // 兜底：立刻把槽位释放出来，后面的任务可以开始跑；
    // 真实 close 事件稍后再到一次，_onChildExit 对非 running 状态是幂等的。
    if (this.runningJobs.has(id)) this._onChildExit(job, null, 'SIGKILL');
    return { ok: true, job: this.toPublic(job) };
  }

  /**
   * 把任务与队列项解绑（用户删队列项时调用）。**不会**停止正在跑的任务：
   * 制作照常跑完，产物留在曲库，下次点同一首歌时直接是 ready。
   *
   * 同时**降低优先级**：把还没开跑的任务挪到排队末尾。
   * 理由：用户主动删掉了这首歌，说明他不想唱了；后台继续跑是为了曲库资产，
   * 但不该占着制作槽位挡住别人刚点的歌。
   */
  detachSong(spotifyId, songId) {
    const job = this.jobs.get(String(spotifyId || ''));
    if (!job) return null;
    if (songId && job.songId && job.songId !== songId) return this.toPublic(job);
    if (job.songId === null && !songId) return this.toPublic(job);
    job.songId = null;
    // 还没开跑 → 挪到队尾；已经在跑的不打断（打断会白费已下载/已分离的部分）
    // 注意 this.pending 里存的是 spotifyId，不是 job.id
    if (job.status === 'queued') {
      const key = String(job.spotifyId || spotifyId || '');
      const idx = this.pending.indexOf(key);
      if (idx >= 0) {
        this.pending.splice(idx, 1);
        this.pending.push(key);
      }
    }
    this._changed(job, { detached: Boolean(songId), deprioritized: job.status === 'queued' });
    return this.toPublic(job);
  }

  /**
   * 测试/调试用：手动把一个 running 任务推进到终态（disableSpawn 模式下没有子进程）。
   * @param {string} spotifyId
   * @param {{status?: 'ready'|'failed'|'canceled', error?: string, code?: number}} opts
   */
  finishJob(spotifyId, opts = {}) {
    const job = this.jobs.get(String(spotifyId || ''));
    if (!job) return null;
    if (opts.status === 'canceled') job.cancelRequested = true;
    const code = opts.status === 'ready' ? 0 : (opts.code ?? 1);
    this._onChildExit(job, code, null, opts.error || null, []);
    return this.toPublic(job);
  }

  /** 直接从内存里移除任务记录（测试/管理用）。 */
  forget(spotifyId) {
    const id = String(spotifyId || '');
    this.pending = this.pending.filter((x) => x !== id);
    return this.jobs.delete(id);
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
      .map((job) => this.toPublic(job));
  }

  /** 当前有多少任务在跑 / 排队（server 在 /api/state 暴露概览） */
  summary() {
    const jobs = this.list();
    return {
      running: this.running ? this.toPublic(this.running) : null,
      runningJobs: [...this.runningJobs.values()].map((job) => this.toPublic(job)),
      runningCount: this.runningJobs.size,
      concurrency: this.concurrency,
      pending: this.pending.length,
      counts: jobs.reduce((acc, job) => { acc[job.status] = (acc[job.status] || 0) + 1; return acc; }, {}),
    };
  }

  toPublic(job) {
    if (!job) return null;
    const stage = job.progress?.stage || job.stage || job.status;
    return {
      spotifyId: job.spotifyId,
      title: job.title,
      songId: job.songId,
      status: job.status,
      stage: job.stage || null,
      stageLabel: STAGE_LABEL[stage] || null,
      progress: job.progress ? { ...job.progress } : null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      error: job.error || null,
      pid: job.pid || null,
      restarts: job.restarts || 0,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
      // 官方 MV（并行阶段）：{state:'running'|'done'|'failed', status, visualVideoId, reason}
      mv: job.mv ? { ...job.mv } : null,
    };
  }

  // ------------------------------------------------------------ 官方 MV（并行阶段）
  /**
   * 记录"正在匹配官方 MV"。由 server 在派发 MV 搜索前调用。
   * 这是**并行**阶段：音频 pipeline 照常在跑，任务状态仍是 running。
   */
  markMvRunning(spotifyId) {
    const job = this.jobs.get(String(spotifyId || ''));
    if (!job) return null;
    job.mv = { state: 'running', updatedAt: nowIso() };
    this._changed(job, { mv: true });
    return this.toPublic(job);
  }

  /**
   * 记录官方 MV 匹配结果。**不改变** job.status（MV 失败不等于制作失败）。
   * @param {{status?: string, visualVideoId?: string|null, reason?: string, skipped?: boolean}} result
   */
  setMvResult(spotifyId, result = {}) {
    const job = this.jobs.get(String(spotifyId || ''));
    if (!job) return null;
    job.mv = {
      state: result.skipped ? 'done' : result.error ? 'failed' : 'done',
      status: result.status || null,
      visualVideoId: result.visualVideoId || null,
      reason: result.reason || result.error || null,
      updatedAt: nowIso(),
    };
    this._changed(job, { mv: true });
    return this.toPublic(job);
  }

  /** 当前没有 finish 的 MV 阶段是否还在跑（server 用来避免重复派发） */
  isMvPending(spotifyId) {
    const job = this.jobs.get(String(spotifyId || ''));
    return Boolean(job && job.mv && job.mv.state === 'running');
  }

  /**
   * 关掉当前子进程（进程退出时调用，避免留下孤儿 Demucs）。
   *
   * `simulateCrash: true` = 模拟进程被杀：任务**保持 running 落盘**，
   * 下次启动 load() 看到 running 会重新排队续跑（pipeline 幂等，已完成的步骤会跳过）。
   * 默认（process exit）不需要特殊处理：进程整个没了，文件里就是 running。
   */
  stop({ simulateCrash = false } = {}) {
    this.stopped = true;
    const children = [...this.children.values()];
    this.children.clear();
    this._lineBuffers.clear();
    if (simulateCrash) {
      // 先停止子进程的 close 回调影响状态：摘掉 listeners 再 kill，
      // 任务在文件里保持 running，下次 load() 会重新排队续跑。
      for (const child of children) {
        try { child.removeAllListeners('close'); } catch { /* ignore */ }
        try { child.removeAllListeners('error'); } catch { /* ignore */ }
        try { child.kill(); } catch { /* ignore */ }
      }
      this.runningJobs.clear();
      this._stageUnlocks.clear();
      this.pending = [];
      return;
    }
    for (const child of children) {
      try { child.kill(); } catch { /* ignore */ }
      try { if (child.pid) process.kill(child.pid); } catch { /* ignore */ }
    }
    this.runningJobs.clear();
    this._stageUnlocks.clear();
  }

  // ------------------------------------------------------------ 调度
  _scheduleDrain() {
    if (this._drainScheduled) return;
    this._drainScheduled = true;
    setImmediate(() => {
      this._drainScheduled = false;
      this._drain().catch((err) => console.error(`[prepare] 调度异常：${err.message}`));
    });
  }

  async _drain() {
    if (this.stopped) return;
    // 并发启动：最多 concurrency 个；_run 同步登记到 runningJobs，
    // 所以循环条件能立刻看到已占用的槽位。
    while (!this.stopped && this.runningJobs.size < this.concurrency && this.pending.length) {
      const nextId = this.pending.shift();
      const job = this.jobs.get(nextId);
      if (!job || job.status !== 'queued' || job.cancelRequested) continue;
      this._run(job);
    }
  }

  _run(job) {
    return new Promise((resolve) => {
      const done = () => { try { resolve(); } catch { /* ignore */ } };
      this.runningJobs.set(job.spotifyId, job);
      job.status = 'running';
      // 起始阶段是 queued，等第一行可识别的输出再推进到 metadata/download/...
      job.stage = 'queued';
      // startedAt 只记录**首次**开始时间：重启后续跑不重置（否则耗时看不准）
      job.startedAt = job.startedAt || nowIso();
      job.error = null;
      this._changed(job, { started: true });

      if (this.disableSpawn) {
        // 单元测试模式：任务停在 running，由测试显式调用 finishJob() 推进
        this._stageUnlocks.set(job.spotifyId, done);
        return;
      }

      // 解释器不存在时直接给出可操作的错误，而不是让 spawn 抛一个看不懂的 ENOENT，
      // 更不要把它记到"这首歌"头上（那是环境问题，重试同一首歌也没用）。
      if (!this.pythonExe || !fs.existsSync(this.pythonExe)) {
        const hint = `找不到 Python 解释器：${this.pythonExe || '(空)'}。`
          + '请用项目根的启动器（启动卡拉OK）启动服务，或在控制面板「环境配置」里指定 Python 路径；'
          + '也可以手动设置环境变量 KARAOKE_PYTHON 指向 env\\python\\Scripts\\python.exe。';
        this._onChildExit(job, null, null, hint);
        done();
        return;
      }

      const args = ['scripts/pipeline.py', '--spotify-id', job.spotifyId, '--steps', this.steps];
      let child;
      try {
        child = this.spawnImpl(this.pythonExe, args, {
          cwd: this.projectRoot,
          env: childEnv({
            // 显式把"自己解析出来的 ENV_DIR"传给 Python，原因有两个：
            //   * 直接 `node karaoke_spo/main.js` 启动时没有启动器注入 KARAOKE_ENV_DIR，
            //     pipeline 里的 ffmpeg 会按旧路径找不到；
            //   * 打包后 env\ 可能在项目根而不是工程根。
            KARAOKE_ENV_DIR: ENV_DIR,
            KARAOKE_PYTHON: this.pythonExe,
            KARAOKE_BIN_DIR: path.join(ENV_DIR, 'bin'),
            KARAOKE_FFMPEG: path.join(ENV_DIR, 'bin', 'ffmpeg.exe'),
            KARAOKE_FFPROBE: path.join(ENV_DIR, 'bin', 'ffprobe.exe'),
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            TORCH_HOME: process.env.TORCH_HOME || path.join(ENV_DIR, 'cache', 'torch'),
            HF_HOME: process.env.HF_HOME || path.join(ENV_DIR, 'cache', 'huggingface'),
            TMP: path.join(this.projectRoot, '.tmp'),
            TEMP: path.join(this.projectRoot, '.tmp'),
            // fetch_metadata.py 要用 node 调 Spotify。打包后服务跑在
            // dist\...\runtime\node.exe，PATH 里可能没有 node，所以显式传绝对路径。
            NODE_EXE: process.execPath,
          }),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        this._onChildExit(job, null, null, `无法启动 Python：${err.message}`);
        done();
        return;
      }
      this.children.set(job.spotifyId, child);
      job.pid = child.pid || null;
      this._changed(job, { pid: job.pid });

      const logFile = path.join(this.logDir, `prepare-${job.spotifyId}.log`);
      ensureDir(this.logDir);
      let logStream = null;
      try { logStream = fs.createWriteStream(logFile, { flags: 'a' }); } catch { logStream = null; }
      const tail = [];
      const writeLog = (prefix, text) => {
        if (logStream) { try { logStream.write(`${prefix}${text}\n`); } catch { /* ignore */ } }
      };
      writeLog('', `\n=== ${nowIso()} spawn ${this.pythonExe} ${args.join(' ')} (pid=${job.pid}) ===`);

      const handleLine = (prefix, line) => {
        if (!line || !String(line).trim()) return;
        const text = String(line);
        writeLog(prefix, text);
        tail.push(text);
        if (tail.length > 40) tail.shift();
        try { this.onLog(text, this.toPublic(job)); } catch { /* ignore */ }
        this._applyLine(job, text);
      };
      this._lineBuffers.set(job.spotifyId, { out: '', err: '' });
      child.stdout?.on('data', (chunk) => this._consumeChunk(job, chunk, '', handleLine));
      child.stderr?.on('data', (chunk) => this._consumeChunk(job, chunk, '[stderr] ', handleLine));
      child.on('error', (err) => {
        tail.push(`spawn error: ${err.message}`);
        this._onChildExit(job, null, null, `子进程错误：${err.message}`, tail);
        done();
      });
      child.on('close', (code, signal) => {
        if (logStream) { try { logStream.end(); } catch { /* ignore */ } }
        this._onChildExit(job, code, signal, null, tail);
        done();
      });
    });
  }

  _consumeChunk(job, chunk, prefix, handleLine) {
    let buf = this._lineBuffers.get(job.spotifyId);
    if (!buf) {
      buf = { out: '', err: '' };
      this._lineBuffers.set(job.spotifyId, buf);
    }
    const key = prefix ? 'err' : 'out';
    buf[key] += chunk.toString('utf8');
    const parts = buf[key].split(/\r?\n|\r/);
    buf[key] = parts.pop() || '';
    for (const line of parts) handleLine(prefix, line);
  }

  /** 阶段只允许前进（finalize 的 92% 之后 inner progress 不会再回到 separate） */
  static get ORDER() { return STAGES.map((s) => s.key); }

  /** 解析一行输出，必要时推进阶段/百分比。宽松：识别不出就忽略。 */  _applyLine(job, line) {
    if (job.status !== 'running' && job.status !== 'queued') return;
    let matched = null;
    for (const p of STAGE_PATTERNS) {
      if (p.re.test(line)) { matched = p.stage; break; }
    }
    const pct = parsePercent(line);
    if (!matched && pct === null) return;
    const order = PrepareQueue.ORDER;
    const curStage = job.progress?.stage || 'queued';
    const currentPct = job.progress?.percent || 0;
    let stage = matched || curStage;
    // 忽略倒退的阶段（例如日志回显了旧字样）：只前进，不后退
    if (matched && order.indexOf(matched) < order.indexOf(curStage)) stage = curStage;
    const base = STAGE_PERCENT[stage] ?? 0;
    const nextBase = STAGES[order.indexOf(stage) + 1]?.percent ?? 100;
    const stageMax = Math.max(base + 1, nextBase - 1);
    let percent = currentPct;
    if (pct !== null) {
      // 把行内百分比映射进当前阶段区间：避免 "50%" 把整体进度推到 50% 或让进度倒退
      percent = base + Math.round((pct / 100) * (stageMax - base));
    } else {
      percent = Math.max(percent, base);
    }
    percent = Math.min(99, Math.max(currentPct, percent));
    const changed = stage !== curStage || percent !== currentPct;
    if (!changed) return;
    job.stage = stage;
    job.progress = {
      ...(job.progress || {}),
      stage,
      stageLabel: STAGE_LABEL[stage] || null,
      percent,
      lastLine: String(line).slice(0, 200),
    };
    this._changed(job, { stageChanged: true });
  }

  /**
   * 子进程结束（close / error / cancel 兜底）。
   * 幂等：cancel 里先手工调用一次，之后真正的 close 事件到达时直接返回。
   */
  _onChildExit(job, code, signal, forcedError, tail = []) {
    const id = job.spotifyId;
    this.runningJobs.delete(id);
    this.children.delete(id);
    this._lineBuffers.delete(id);
    if (job.status !== 'running') {
      // cancel() 已经提前收尾过：只需把槽位让出来，让后面的任务能跑
      this._scheduleDrain();
      return;
    }
    job.pid = null;
    job.finishedAt = nowIso();
    job.durationMs = job.startedAt ? Math.max(0, new Date(job.finishedAt) - new Date(job.startedAt)) : null;

    if (job.cancelRequested) {
      job.status = 'canceled';
      job.stage = null;
      job.progress = { ...(job.progress || {}), stage: 'canceled' };
      job.error = job.error || '用户取消';
    } else if (code === 0) {
      job.status = 'ready';
      job.stage = 'done';
      job.progress = { stage: 'done', stageLabel: STAGE_LABEL.done, percent: 100 };
      job.error = null;
    } else {
      job.status = 'failed';
      job.stage = 'failed';
      job.progress = { ...(job.progress || {}), stage: 'failed' };
      job.error = forcedError
        || `pipeline 退出码 ${code}${signal ? ` (signal ${signal})` : ''}`
        + (tail.length ? `：${tail.slice(-6).join(' | ').slice(-900)}` : '');
    }
    const unlock = this._stageUnlocks.get(id) || null;
    this._stageUnlocks.delete(id);
    this._changed(job, { finished: true, unlock: Boolean(unlock) });
    if (unlock) unlock();
    this._scheduleDrain();
  }
}

module.exports = {
  PrepareQueue,
  STAGES,
  STAGE_LABEL,
  STAGE_PERCENT,
  JOBS_FILE,
  DEFAULT_PYTHON,
  DEFAULT_STEPS,
  DEFAULT_CONCURRENCY,
  normalizeConcurrency,
  writeFileAtomic,
  parsePercent,
};
