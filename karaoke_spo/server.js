const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { decryptQrc } = require('./lib/qrc-decrypt.js');
const libraryDb = require('./lib/library-db.js');
const lyricsOverrides = require('./lib/lyrics-overrides.js');
// QRC 解析只有一份实现（lib/qrc-parse.js），qq-lyrics.js 也用同一个
const { parseQrcXml } = require('./lib/qrc-parse.js');
const netease = require('./lib/netease-lyrics.js');
const spotify = require('./lib/spotify.js');
const { PrepareQueue } = require('./lib/prepare-queue.js');
const queueOrder = require('./lib/queue-order.js');
const { MODE, MODE_LABEL } = require('./lib/mode.js');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.DJ_PASSWORD || 'karaok-admin';
// When the room is exposed through a tunnel, QR codes must use the public URL
// instead of the host/IP that happened to serve the display page.
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
// 启动器与本进程之间的内部通道；没有这个令牌就不开放内部接口。
const INTERNAL_TOKEN = String(process.env.INTERNAL_TOKEN || '').trim();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BROWSER_COOKIE_NAME = 'karaoke_browser_id';
const ANIMATION_TYPES = ['fireworks', 'confetti', 'hearts', 'sparkles', 'disco', 'balloons', 'petals', 'bubbles', 'neon', 'aurora', 'shootingStars'];
const API_VERSION = 8;
// 测试可以把状态/任务写到临时目录，避免动到现场 data（见 tests/queue-order.test.js）
const DATA_DIR = process.env.KARAOKE_DATA_DIR
  ? path.resolve(process.env.KARAOKE_DATA_DIR)
  : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const demoCatalog = [
  ['dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley', '3:33'],
  ['kJQP7kiw5Fk', 'Despacito', 'Luis Fonsi ft. Daddy Yankee', '4:42'],
  ['fJ9rUzIMcZQ', 'Bohemian Rhapsody', 'Queen', '5:55'],
  ['3JZ_D3ELwOQ', 'Uptown Funk', 'Mark Ronson ft. Bruno Mars', '4:31'],
  ['OPf0YbXqDm0', 'Counting Stars', 'OneRepublic', '4:17'],
  ['CevxZvSJLk8', 'Roar', 'Katy Perry', '3:43'],
  ['RgKAFK5djSk', 'See You Again', 'Wiz Khalifa ft. Charlie Puth', '3:58'],
  ['LsoLEjrDogU', 'Shape of You', 'Ed Sheeran', '4:24']
].map(([videoId, title, channelTitle, duration]) => ({
  videoId, title, channelTitle, duration,
  thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}));

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function createAdminToken() {
  const issuedAt = Date.now().toString();
  const nonce = crypto.randomBytes(18).toString('hex');
  const payload = `${issuedAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('hex');
  return `${payload}.${signature}`;
}
function verifyAdminToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return false;
  const issuedAt = Number(parts[0]);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > ADMIN_SESSION_TTL_MS || issuedAt > Date.now() + 60_000) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', ADMIN_PASSWORD).update(payload).digest('hex');
  const actualBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function defaultState() {
  return {
    settings: {
      roomName: 'Karaoke Night',
      maxQueuedSongsPerGuest: 3,
      allowDuplicatePerSession: false,
      allowDuplicateVideo: true,
      requireApproval: false,
      onlyKaraokeSongs: false,
      blacklistKeywords: [],
      guestInactivityMinutes: 60,
      broadcastDuration: 8,
      broadcastInterval: 4,
      drinkDuration: 8,
      drinkInterval: 4,
      drinkRotationSeconds: 12,
      drinks: [],
      publicUrl: PUBLIC_URL,
      interfaceLanguage: 'en',
      interfaceTheme: 'system',
      // 'video' = 原样嵌入 YouTube；'lyrics' = 用歌词视图替换 YouTube 画面（音频仍由 YouTube 提供）
      playbackMode: 'lyrics',
      // 歌词显示方式：true=逐字（有 QRC 数据时），false=逐行
      lyricsWordLevel: true,
      // 视频模式下是否叠歌词
      videoShowLyrics: true,
      // 歌词是否显示翻译（网易云/QQ 的 tlyric）
      showTranslation: true,
      sourceMode: MODE
    },
    sessions: {},
    blockedGuests: [],
    songs: [],
    broadcasts: [],
    importantBroadcast: null,
    playback: {
      currentRequestId: null,
      status: 'idle',
      volume: 75,
      // 人声强度 0–100（DJ 在大屏控制台调，本地曲目有效）
      vocalLevel: 25,
      version: 0,
      updatedAt: now()
    }
  };
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let text = null;
  try {
    text = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    // 文件不存在 = 首次启动，建默认值
    const state = defaultState();
    writeStateAtomic(state);
    return state;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // 文件存在但解析失败 = 数据损坏（常见于写入中进程被杀）。
    // 绝不能静默重建：那会丢掉队列/会话/黑名单，而且用户毫无察觉。
    // 先备份原文件，再用默认值启动，并把问题写进日志。
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.writeFileSync(backup, text, 'utf8');
      console.error(`[state] state.json 解析失败（${err.message}），原文件已备份到 ${backup}`);
    } catch {
      console.error(`[state] state.json 解析失败（${err.message}），且备份失败`);
    }
    const state = defaultState();
    writeStateAtomic(state);
    return state;
  }
}

/**
 * 原子写 state.json：先写临时文件 + fsync，再 rename 覆盖。
 * rename 在同一分区是原子的，所以任何时刻读到的都是完整 JSON，
 * 不会出现"写一半被杀 → 下次启动解析失败"的情况。
 */
function writeStateAtomic(payload) {
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STATE_FILE);
}

const state = loadState();
state.importantBroadcast ??= null;
state.animation ??= null;
// 旧 state.json 没有 vocalLevel，补齐默认 100（=原曲）
if (typeof state.playback?.vocalLevel !== 'number') state.playback.vocalLevel = 25;
// 歌词显示：默认逐字（有逐字数据时）；视频模式默认叠歌词
if (typeof state.settings.lyricsWordLevel !== 'boolean') state.settings.lyricsWordLevel = true;
if (typeof state.settings.videoShowLyrics !== 'boolean') state.settings.videoShowLyrics = true;
if (typeof state.settings.showTranslation !== 'boolean') state.settings.showTranslation = true;
state.settings.publicUrl ??= PUBLIC_URL;
state.settings.interfaceLanguage ??= 'zh';
state.settings.interfaceTheme ??= 'system';
// 旧 state.json 没有这个字段，必须补默认值，否则播放模式读出来是 undefined。
// 本地曲目没有视频，画面固定歌词
state.settings.playbackMode = 'lyrics';
// 音源：'youtube' = 模式 A（YouTube 搜索 + iframe 播放）
//       'local'   = 模式 B（Spotify 搜索 + 本地 Demucs 音源）
// 模式 B 固定走本地曲库，不提供切换（模式 A 在另一个独立工程里）
state.settings.sourceMode = MODE;
// 本地曲库的曲目名不会有 karaoke 字样，这个过滤在模式 B 下必须关闭
state.settings.onlyKaraokeSongs = false;
state.settings.blacklistKeywords = normalizeBlacklistKeywords(state.settings.blacklistKeywords);
state.settings.guestInactivityMinutes = clamp(Number(state.settings.guestInactivityMinutes) || 60, 5, 10080);
state.blockedGuests = Array.isArray(state.blockedGuests) ? state.blockedGuests : [];
state.settings.drinks ??= [];
state.settings.drinkRotationSeconds ??= 12;
// 0.3.2 起酒水改用「显示时长 + 间隔」两个独立值；旧字段只用于迁移。
state.settings.drinkDuration ??= Number(state.settings.drinkRotationSeconds) || 8;
state.settings.drinkInterval ??= 4;
state.settings.broadcastInterval ??= 4;
// 旧版广播带 expiresAt，过期的不再进入新的循环列表。
state.broadcasts = (Array.isArray(state.broadcasts) ? state.broadcasts : [])
  .filter(item => !item.expiresAt || new Date(item.expiresAt).getTime() > Date.now());
const sseClients = new Set();
const guestCleanupTimer = setInterval(cleanupInactiveGuests, 60 * 1000);
guestCleanupTimer.unref?.();
let importantBroadcastTimer = null;
// 由启动器在隧道建立后注入的临时地址，优先级高于手动配置的公网地址。
let tunnelUrl = '';
// 启动器保存设置后可以热更新 API Key，不必重启服务。
let runtimeYoutubeApiKey = '';

function youtubeApiKey() {
  return runtimeYoutubeApiKey || String(process.env.YOUTUBE_API_KEY || '').trim();
}

function currentPublicUrl() {
  return tunnelUrl || state.settings.publicUrl || '';
}

function normalizePublicUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : '';
}

function normalizeBlacklistKeywords(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；]+/);
  const seen = new Set();
  return raw.map(item => String(item || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80))
    .filter(item => {
      const key = item.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
}

function matchedBlacklistKeyword(title) {
  const normalizedTitle = String(title || '').toLocaleLowerCase();
  return state.settings.blacklistKeywords.find(keyword => normalizedTitle.includes(String(keyword).toLocaleLowerCase())) || '';
}

function requestCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    }
    return cookies;
  }, {});
}

function browserIdFromRequest(req) {
  const value = requestCookies(req)[BROWSER_COOKIE_NAME];
  return value ? hash(value) : '';
}

function clientBrowserIdFromRequest(req) {
  const value = String(req.headers['x-browser-id'] || '').trim().slice(0, 160);
  return value ? hash(value) : '';
}

function requestBrowserIdentities(req) {
  return { cookieHash: browserIdFromRequest(req), clientHash: clientBrowserIdFromRequest(req) };
}

function issueBrowserCookie(req, res) {
  const current = requestCookies(req)[BROWSER_COOKIE_NAME];
  if (current) return { value: current, hash: hash(current) };
  const value = crypto.randomBytes(24).toString('hex');
  res.setHeader('Set-Cookie', `${BROWSER_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  return { value, hash: hash(value) };
}

function attachBrowserToSession(req, res, session) {
  const browser = issueBrowserCookie(req, res);
  const clientHash = clientBrowserIdFromRequest(req);
  if (!session.browserIdHash || (clientHash && !session.clientBrowserIdHash)) {
    session.browserIdHash ||= browser.hash;
    if (clientHash) session.clientBrowserIdHash = clientHash;
    persist();
  }
  return { cookieHash: browser.hash, clientHash };
}

function isDisplayNameTaken(displayName, exceptSessionId = '') {
  const normalized = String(displayName || '').trim().toLocaleLowerCase();
  return Object.values(state.sessions).some(session => session.id !== exceptSessionId && String(session.displayName || '').trim().toLocaleLowerCase() === normalized);
}

function sessionHasLiveSongs(sessionId) {
  return state.songs.some(song => song.sessionId === sessionId && ['queued', 'playing'].includes(song.status));
}

function cleanupInactiveGuests() {
  const timeoutMinutes = clamp(Number(state.settings.guestInactivityMinutes) || 60, 5, 10080);
  const cutoff = Date.now() - timeoutMinutes * 60 * 1000;
  const stale = Object.entries(state.sessions).filter(([, session]) => {
    const activityAt = new Date(session.lastSongAt || session.createdAt || session.lastSeenAt).getTime();
    return Number.isFinite(activityAt) && activityAt <= cutoff && !sessionHasLiveSongs(session.id);
  });
  if (!stale.length) return 0;
  stale.forEach(([sessionKey]) => delete state.sessions[sessionKey]);
  persist();
  broadcast();
  return stale.length;
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function persist() {
  writeStateAtomic(state);
}

/**
 * 歌曲唯一标识。
 *
 * 以前去重直接比 videoId，但本地曲目（source='local'）没有 videoId，
 * 两个 null 相等会把所有本地歌判成重复，只剩第一首能点。
 * 统一走这个函数，不同来源各用各的 id。
 */
function songKey(song) {
  if (!song) return '';
  if (song.source === 'local') return `local:${song.spotifyId || song.id || ''}`;
  return `yt:${song.videoId || song.id || ''}`;
}

/**
 * 真正可以开播的等待项（status='queued'）。
 * 注意：选下一首不能只用它 —— 还要看排在它前面的 preparing 歌有没有做完，
 * 见 startNext() 与 lib/queue-order.js 的 chooseNextSong()。
 */
function pendingSongs() {
  return queueOrder.pendingSongs(state.songs);
}

function currentSong() {
  return state.songs.find(song => song.id === state.playback.currentRequestId) || null;
}

function normalizeQueue() {
  // 含 preparing / prepare_failed：制作中的歌也要稳定占住队列位置，
  // 否则下一次归一 queued 的 queuePosition 后，新歌会排到它前面去。
  queueOrder.normalizePositions(state.songs);
}

function publicState() {
  const current = currentSong();
  const broadcasts = state.broadcasts.slice(-20);
  const prepareSummary = prepareQueue.summary();
  // 制作中的歌也要出现在前台队列里（显示「准备中」），但不能被当成下一首播放。
  const queue = state.songs
    .filter(song => queueOrder.ACTIVE_STATUSES.includes(song.status))
    .sort(queueOrder.compareQueueOrder)
    .map(publicSong);
  return {
    settings: { ...state.settings, publicUrl: currentPublicUrl() },
    publicBase: currentPublicUrl() || lanOrigin(),
    apiVersion: API_VERSION,
    queue,
    current: current ? publicSong(current) : null,
    playback: { ...state.playback },
    broadcast: broadcasts[broadcasts.length - 1] || null,
    broadcasts,
    importantBroadcast: state.importantBroadcast,
    animation: state.animation,
    // 后台制作任务概览（前端一般不用，DJ 控制台/排查用）
    prepare: {
      running: prepareSummary.running,
      runningCount: prepareSummary.runningCount,
      concurrency: prepareSummary.concurrency,
      pending: prepareSummary.pending
    },
    serverTime: now()
  };
}

function publicSong(song) {
  const out = {
    id: song.id,
    videoId: song.videoId,
    title: song.title,
    channelTitle: song.channelTitle,
    thumbnailUrl: song.thumbnailUrl,
    duration: song.duration,
    singerName: song.singerNameSnapshot,
    isPinned: song.isPinned,
    queuePosition: song.queuePosition,
    createdAt: song.createdAt,
    status: song.status,
    // display 页靠这两个字段区分播放引擎：local → KaraokeMixer（本地双轨），youtube → YT.Player。
    // 缺了它们前端只能看到 videoId 为 null，无法判断该用哪种播放器。
    source: song.source === 'local' ? 'local' : 'youtube',
    spotifyId: song.spotifyId || null
  };
  // 制作状态：用户侧只看粗粒度（准备中/已就绪/准备失败），
  // 百分比与阶段只给 DJ 控制台用（adminState 里带完整 progress）。
  if (song.source === 'local' && (song.status === 'preparing' || song.status === 'prepare_failed')) {
    out.prepareState = song.status === 'preparing' ? 'preparing' : 'failed';
    out.prepareLabel = song.status === 'preparing' ? '准备中' : '准备失败';
    out.error = song.error || null;
    out.progress = song.progress || null;
  }
  return out;
}

function adminState() {
  const users = Object.values(state.sessions).map(session => ({
    id: session.id,
    displayName: session.displayName,
    songCount: state.songs.filter(song => song.sessionId === session.id && song.status === 'queued').length,
    lastSeenAt: session.lastSeenAt,
    lastSongAt: session.lastSongAt || null,
    blockedUntil: session.blockedUntil || null
  })).sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  const blockedGuests = state.blockedGuests.map(block => ({ id: block.id, displayName: block.displayName, blockedAt: block.blockedAt, browserLocked: Boolean(block.browserIdHash || block.clientBrowserIdHash) }));
  // 队列项在 DJ 侧保留完整制作进度（前端用户侧只看到粗粒度状态）
  const queue = state.songs
    .filter(song => queueOrder.ACTIVE_STATUSES.includes(song.status))
    .sort(queueOrder.compareQueueOrder)
    .map(song => {
      const out = publicSong(song);
      if (song.source === 'local' && song.spotifyId) {
        const job = prepareQueue.getStatus(song.spotifyId);
        out.prepareJob = job;
      }
      return out;
    });
  return {
    ...publicState(),
    queue,
    users,
    blockedGuests,
    prepareJobs: prepareQueue.list(),
    history: state.songs.slice(-20).reverse().map(publicSong)
  };
}

function broadcast(event = 'state') {
  const payload = `event: ${event}\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// ---------------------------------------------------------------- 后台制作（模式 B）
// 用户点了曲库里没有/未就绪的歌 → 入队后台跑 pipeline.py。
// 默认 3 首并行；GPU 分离由 Python 侧的跨进程锁串行化，下载/歌词/成片互相重叠。
// 任务与应用状态解耦：用户删掉队列项不会停掉制作，产物照样进曲库。
const prepareQueue = new PrepareQueue({
  jobsFile: path.join(DATA_DIR, 'prepare-jobs.json'),
  // 测试用：只跑状态机，不真的 spawn Python（正常启动不设这个变量）
  disableSpawn: process.env.KARAOKE_PREPARE_DISABLE_SPAWN === '1',
  onChange: () => {
    // 任务状态变化 → 持久化 + 广播。节流到 250ms：Demucs 阶段日志很密，
    // 每条都 persist+broadcast 会把 CPU 和 SSE 带宽浪费掉。
    schedulePrepareSync();
  },
});
const PREPARE_SYNC_MS = 250;
let prepareSyncTimer = null;
function schedulePrepareSync() {
  if (prepareSyncTimer) return;
  prepareSyncTimer = setTimeout(() => {
    prepareSyncTimer = null;
    syncPrepareState();
  }, PREPARE_SYNC_MS);
}
function syncPrepareState() {
  try {
    applyPrepareJobsToQueue();
    // 制作完成 → 队列项从 preparing 变成 queued。
    // 这时如果播放器正好空着（上一首唱完、下一首还在处理），要主动开播，
    // 否则那首歌会一直躺在队列里没人放，大屏停在待机画面。
    if (!currentSong() && pendingSongs().length) startNext();
    persist();
    broadcast();
  } catch (err) {
    console.error(`[prepare] 同步队列状态失败：${err.message}`);
  }
}

/** 后台任务状态 → 队列项 status/progress。只动 source==='local' 的未播放项。 */
function applyPrepareJobsToQueue() {
  for (const song of state.songs) {
    if (song.source !== 'local' || !song.spotifyId) continue;
    if (!['preparing', 'queued', 'prepare_failed'].includes(song.status)) continue;
    const job = prepareQueue.getStatus(song.spotifyId);
    if (!job) {
      // 任务已被清理（例如重启后任务文件被删）：以曲库实际状态为准
      const track = libraryDb.getTrack(song.spotifyId);
      if (track && track.ready) {
        song.status = 'queued';
        song.progress = null;
        delete song.error;
      }
      continue;
    }
    song.progress = job.progress
      ? { stage: job.progress.stage, percent: job.progress.percent, stageLabel: job.stageLabel || null }
      : null;
    song.prepareStage = job.stage || null;
    if (job.status === 'ready') {
      // 制作完成 → 变成普通等待队列项，可以播放
      if (song.status !== 'queued') {
        song.status = 'queued';
        song.prepareFailedAt = null;
        delete song.error;
        song.readyAt = now();
      }
      song.progress = { stage: 'done', percent: 100 };
    } else if (job.status === 'failed') {
      song.status = 'prepare_failed';
      song.error = job.error || '制作失败';
      song.prepareFailedAt = now();
    } else if (job.status === 'canceled') {
      song.status = 'prepare_failed';
      song.error = '制作已被 DJ 取消';
      song.prepareFailedAt = now();
    } else {
      song.status = 'preparing';
    }
  }
}

/** 本地曲目是否可以直接播放（曲库里已分离出人声+伴奏）。 */
function isLocalTrackReadyForPlayback(spotifyId) {
  const track = libraryDb.getTrack(spotifyId);
  return Boolean(track && track.ready);
}

function mutate(fn) {
  const result = fn();
  state.playback.version += 1;
  state.playback.updatedAt = now();
  normalizeQueue();
  persist();
  broadcast();
  return result;
}

function startNext() {
  // 按完整队列顺序选下一首，而不是只看 queued：排在前面的歌还在 preparing 时
  // 必须等它，不能越过它去播后面的 ready 歌（否则就是点歌插队）。
  const picked = queueOrder.chooseNextSong(state.songs);
  const next = picked.next;
  if (!next) {
    state.playback.currentRequestId = null;
    state.playback.status = 'idle';
    // picked.blockedBy 非空 = 队首还在后台制作。大屏会继续显示「处理中」，
    // 等 syncPrepareState 在制作完成后再调到这里开播。
    return null;
  }
  next.status = 'playing';
  state.playback.currentRequestId = next.id;
  state.playback.status = 'transition';
  return next;
}

function finishCurrent(status, errorMessage) {
  const current = currentSong();
  if (current) {
    current.status = status;
    current.endedAt = now();
    if (errorMessage) current.errorMessage = errorMessage;
  }
  state.playback.currentRequestId = null;
  return startNext();
}

/**
 * 没有正在播放的歌时，DJ 的「切歌」要作用在队首正在制作的歌上。
 *
 * 制作中的歌不是 current，以前 skip 只处理 current，于是大屏卡在「处理中」时
 * 按切歌完全没反应。这里把它标记为 skipped 并解除与制作任务的关联：
 * 后台下载/分离照常跑完（曲库资产建设），只是不再挡着后面的队列。
 */
function skipPreparingHead() {
  const head = queueOrder.activeSongs(state.songs)[0];
  if (!head || head.status !== 'preparing') return false;
  head.status = 'skipped';
  head.endedAt = now();
  // 与用户删队列项一致：任务不取消，只解绑（正在跑的不打断，排队中的降优先级）。
  if (head.source === 'local' && head.spotifyId) prepareQueue.detachSong(head.spotifyId, head.id);
  return true;
}
function resetLiveSession() {
  clearTimeout(importantBroadcastTimer);
  importantBroadcastTimer = null;
  state.sessions = {};
  state.blockedGuests = [];
  state.songs = [];
  state.broadcasts = [];
  state.importantBroadcast = null;
  state.playback.currentRequestId = null;
  state.playback.status = 'idle';
  state.playback.volume = 75;
}

function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;
  return state.sessions[hash(String(token))] || null;
}

function isAdmin(req) {
  const token = req.headers['x-admin-token'];
  return verifyAdminToken(token);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, status, message, code, params) {
  const payload = { error: message };
  if (code) payload.code = code;
  if (params) payload.params = params;
  sendJson(res, status, payload);
}

/** OAuth 回调是浏览器直接跳转来的，返回一个给人看的小页面而不是 JSON。 */
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function spotifyDoneHtml(ok, message = '') {
  const title = ok ? 'Spotify 授权成功' : 'Spotify 授权失败';
  const detail = ok
    ? '可以关闭这个窗口，回到控制面板继续操作。'
    : String(message || '未知错误').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const color = ok ? '#0d9488' : '#b42318';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>`
    + '<style>body{margin:0;height:100vh;display:grid;place-items:center;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f6f9fb;color:#1d2b3a}'
    + `.card{background:#fff;border:1px solid #e3ebf2;border-radius:16px;padding:36px 42px;text-align:center;box-shadow:0 18px 40px rgba(16,42,67,.08)}`
    + `h1{margin:0 0 10px;font-size:20px;color:${color}}p{margin:0;color:#5b6b7c;font-size:14px;line-height:1.6}</style></head>`
    + `<body><div class="card"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求格式不是有效 JSON'); }
}

async function youtubeSearch(query) {
  const q = String(query || '').trim();
  const directVideoId = extractYouTubeVideoId(q);
  if (directVideoId) return [await youtubeVideoItem(directVideoId)];
  if (!q) return demoCatalog.slice(0, 6);
  if (youtubeApiKey()) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('q', q);
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('key', youtubeApiKey());
    const response = await fetch(url);
    if (!response.ok) throw new Error(`YouTube 搜索失败（${response.status}）`);
    const data = await response.json();
    return (data.items || []).map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      duration: '—',
      thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      embeddable: true
    }));
  }
  const lower = q.toLowerCase();
  return demoCatalog.filter(item => `${item.title} ${item.channelTitle}`.toLowerCase().includes(lower));
}

function extractYouTubeVideoId(input) {
  const value = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0]?.match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const queryId = parsed.searchParams.get('v');
      if (queryId && /^[A-Za-z0-9_-]{11}$/.test(queryId)) return queryId;
      const parts = parsed.pathname.split('/').filter(Boolean);
      const markerIndex = parts.findIndex(part => ['shorts', 'embed', 'live', 'v'].includes(part));
      const candidate = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      if (candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function formatIsoDuration(value) {
  const match = String(value || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '—';
  const hours = Number(match[1] || 0), minutes = Number(match[2] || 0), seconds = Number(match[3] || 0);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function youtubeVideoItem(videoId) {
  const known = demoCatalog.find(item => item.videoId === videoId);
  if (youtubeApiKey()) {
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'snippet,contentDetails,status');
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', youtubeApiKey());
    const response = await fetch(url);
    if (!response.ok) throw new Error(`YouTube 视频信息获取失败（${response.status}）`);
    const data = await response.json();
    const item = data.items?.[0];
    if (item) {
      // 嵌入被禁用（或在当前地区不可播放）的视频在 iframe 里只会显示 Song Unavailable。
      const embeddable = item.status?.embeddable !== false && item.status?.privacyStatus !== 'private';
      return { videoId, title: item.snippet.title, channelTitle: item.snippet.channelTitle, duration: formatIsoDuration(item.contentDetails?.duration), thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, embeddable };
    }
  }
  return known || { videoId, title: `YouTube 视频 ${videoId}`, channelTitle: 'YouTube 链接', duration: '—', thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, embeddable: true };
}

function startImportantBroadcast(message) {
  mutate(() => {
    const previous = state.importantBroadcast;
    state.importantBroadcast = {
      id: previous?.id || id('important'),
      message,
      status: 'active',
      createdAt: previous?.createdAt || now(),
      countdownEndsAt: null,
      resumeAfterStop: previous?.resumeAfterStop ?? Boolean(currentSong() && ['playing', 'transition'].includes(state.playback.status))
    };
    if (currentSong()) state.playback.status = 'paused';
  });
  return state.importantBroadcast;
}

function stopImportantBroadcast() {
  if (!state.importantBroadcast) return null;
  const broadcastId = state.importantBroadcast.id;
  clearTimeout(importantBroadcastTimer);
  mutate(() => {
    state.importantBroadcast.status = 'countdown';
    state.importantBroadcast.countdownEndsAt = new Date(Date.now() + 3000).toISOString();
  });
  importantBroadcastTimer = setTimeout(() => {
    if (!state.importantBroadcast || state.importantBroadcast.id !== broadcastId) return;
    mutate(() => {
      const shouldResume = state.importantBroadcast.resumeAfterStop;
      state.importantBroadcast = null;
      if (currentSong()) state.playback.status = shouldResume ? 'playing' : 'paused';
      else {
        state.playback.status = 'idle';
        if (pendingSongs().length) startNext();
      }
    });
  }, 3100);
  return state.importantBroadcast;
}

// ---- 歌词查询（供 display 页的 lyrics 播放模式使用） ----
// 说明：不引入新依赖，用 Node 内置 fetch。两个源按顺序降级：
//   1) lrclib.net（免鉴权，行级 LRC，英文歌覆盖好）
//   2) QQ 音乐（中文歌覆盖好，返回 LRC + 翻译）
const LYRICS_CACHE_MS = 6 * 60 * 60 * 1000;
const lyricsCache = new Map();
// 正在后台把「库里的行级歌词」升级成逐字的 cacheKey，避免同一首歌重复联网。
const lyricsUpgrades = new Set();
// Spotify 搜索结果缓存（同一 query + limit 5 分钟内复用，减少打 Spotify 的次数）
const SPOTIFY_SEARCH_CACHE_MS = 5 * 60 * 1000;
const spotifySearchCache = new Map();
const LYRICS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseYoutubeTitle(rawTitle) {
  // 从 YouTube 标题里猜 "歌手 - 歌名"，去掉常见噪声。
  let text = String(rawTitle || '');
  text = text.replace(/\((?:official|lyrics?|audio|video|mv|m\/v|hd|hq|remaster(?:ed)?|explicit|clean|visualizer)[^)]*\)/gi, ' ');
  text = text.replace(/\[(?:official|lyrics?|audio|video|mv|m\/v|hd|hq|remaster(?:ed)?|explicit|clean|visualizer)[^\]]*\]/gi, ' ');
  text = text.replace(/\b(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|with\s*lyrics|lyrics|hd|hq|4k)\b/gi, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  let artist = '';
  let title = text;
  const separators = [' - ', ' – ', ' — ', ' | '];
  for (const sep of separators) {
    const idx = text.indexOf(sep);
    if (idx > 0) {
      artist = text.slice(0, idx).trim();
      title = text.slice(idx + sep.length).trim();
      break;
    }
  }
  // "Song by Artist" 形式
  const byMatch = title.match(/^(.*?)\s+by\s+(.+)$/i);
  if (!artist && byMatch) { title = byMatch[1].trim(); artist = byMatch[2].trim(); }
  const featIdx = title.search(/\s+(?:feat\.?|ft\.?|featuring)\s+/i);
  if (featIdx > 0) title = title.slice(0, featIdx).trim();
  return { artist, title: title || text };
}

function parseLrcText(text) {
  const lines = [];
  const meta = {};
  const re = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const tag = trimmed.match(/^\[(ti|ar|al|by|offset|length):(.*)\]$/i);
    if (tag) { meta[tag[1].toLowerCase()] = tag[2].trim(); continue; }
    const stamps = [...trimmed.matchAll(re)];
    if (!stamps.length) continue;
    const body = trimmed.replace(re, '').trim();
    for (const s of stamps) {
      const mm = Number(s[1]);
      const rest = String(s[2]).replace(':', '.');
      const sec = Number(rest);
      lines.push({ startMs: Math.round((mm * 60 + sec) * 1000), text: body });
    }
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  // 去掉「作词 : xxx」「作曲 : xxx」这类署名行（网易云会把它们做成带时间戳的正常行）。
  // 全被删掉时保留原样，宁可多显示也不要空。
  const { isCreditLine } = require('./lib/qrc-parse.js');
  const kept = lines.filter((l) => l.text && !isCreditLine(l.text));
  const use = kept.length ? kept : lines;
  lines.length = 0;
  lines.push(...use);
  for (let i = 0; i < lines.length; i++) {
    lines[i].endMs = i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + 6000;
  }
  return { lines, meta };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, headers: { 'User-Agent': LYRICS_UA, ...(options.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupLyricsLrclib(artist, title, duration) {
  const params = new URLSearchParams({ track_name: title, artist_name: artist || '' });
  if (duration) params.set('duration', String(Math.round(duration)));
  if (artist) {
    try {
      const hit = await fetchJsonWithTimeout(`https://lrclib.net/api/get?${params}`);
      if (hit?.syncedLyrics || hit?.plainLyrics) {
        return { provider: 'lrclib', syncedLyrics: hit.syncedLyrics || '', plainLyrics: hit.plainLyrics || '', duration: hit.duration };
      }
    } catch { /* 404 = 无精确匹配，走 search */ }
  }
  try {
    const list = await fetchJsonWithTimeout(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${title}`.trim() })}`);
    if (!Array.isArray(list) || !list.length) return null;
    const ranked = list.filter((x) => x.syncedLyrics || x.plainLyrics)
      .sort((a, b) => Math.abs((a.duration || 0) - (duration || 0)) - Math.abs((b.duration || 0) - (duration || 0)));
    const best = ranked[0];
    return best ? { provider: 'lrclib', syncedLyrics: best.syncedLyrics || '', plainLyrics: best.plainLyrics || '', duration: best.duration } : null;
  } catch { return null; }
}

async function lookupLyricsQq(artist, title, duration) {
  const qCall = async (body) => {
    const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'User-Agent': LYRICS_UA, Referer: 'https://y.qq.com/', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  // 搜索交给 lib/qq-lyrics.js：那里已经改用仍可用的 soso 接口。
  // musicu.fcg 的 DoSearchForQQMusicDesktop 现在对未登录请求一律 code=2001（风控），
  // 之前「QQ 总是没结果、每次都落到网易云」就是它导致的；歌词接口本身是好的。
  const qqLib = require('./lib/qq-lyrics.js');
  let match = null;
  try { match = await qqLib.findBestMatch(title, artist ? [artist] : [], duration); } catch { match = null; }
  if (!match || !match.mid) return null;
  const pick = { song: match, score: 100 };

  // 先尝试逐字 QRC：需要 crypt:1 + qrc:1，否则返回的是解不开的另一形态。
  try {
    const jq = await qCall({
      comm: { ct: 24, cv: 4747474, platform: 'yqq.json', g_tk: 5381, format: 'json' },
      req_1: {
        method: 'GetPlayLyricInfo',
        module: 'music.musichallSong.PlayLyricInfo',
        param: {
          crypt: 1, qrc: 1, type: 1, lrc_t: 0, qrc_t: 0, roma: 0, roma_t: 0,
          trans: 1, trans_t: 0, needSingingAnnotations: false,
          songMid: pick.song.mid, songID: pick.song.id,
        },
      },
    });
    const dq = jq?.req_1?.data;
    if (process.env.LYRICS_DEBUG) {
      console.error(`[qrc] mid=${pick.song.mid} code=${jq?.req_1?.code} hasLyric=${Boolean(dq?.lyric)} len=${dq?.lyric ? dq.lyric.length : 0}`);
    }
    if (dq?.lyric) {
      const xml = decryptQrc(dq.lyric);
      const parsed = parseQrcXml(xml);
      if (process.env.LYRICS_DEBUG) {
        console.error(`[qrc] xml=${xml.length} lines=${parsed.lines.length} chars=${parsed.lines.reduce((s, l) => s + l.chars.length, 0)}`);
      }
      if (parsed.lines.length) {
        // 翻译：QRC 响应里的 trans 是 base64 的 LRC，和逐字歌词一起返回。
        // 之前这里硬编码成空串，导致「逐字有、翻译没有」—— 而走库/覆盖表的那份是
        // 网易云的完整结果，于是两个画面看起来一个缺歌词、一个缺翻译。
        let transLyrics = '';
        if (dq.trans) {
          // 注意：trans 和 lyric 一样是**加密的**，不是明文 base64。
          // 直接 base64 解码只会得到乱码（之前就是这样，等于等于没有翻译）。
          try { transLyrics = decryptQrc(dq.trans); } catch {
            try { transLyrics = Buffer.from(dq.trans, 'base64').toString('utf8'); } catch { transLyrics = ''; }
          }
        }
        return {
          provider: 'qqmusic',
          format: 'qrc',
          qrcLines: parsed.lines,
          syncedLyrics: parsed.plainText,
          transLyrics,
        };
      }
    }
  } catch (err) {
    if (process.env.LYRICS_DEBUG) console.error('[qrc] 失败:', err.message);
  }

  const j = await qCall({
    comm: { ct: 6, cv: 0 },
    req_1: { method: 'GetPlayLyricInfo', module: 'music.musichallSong.PlayLyricInfo', param: { songMid: pick.song.mid, songID: pick.song.id, qrc: 0, trans: 1, roma: 0 } },
  });
  const d = j?.req_1?.data;
  if (!d?.lyric) return null;
  const decode = (b64) => { try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; } };
  return { provider: 'qqmusic', syncedLyrics: decode(d.lyric), transLyrics: d.trans ? decode(d.trans) : '' };
}

/**
 * 解析 QRC XML 成 [{ startMs, endMs, text, chars:[{text,startMs,endMs}] }]
 *
 * 行格式：[行开始ms,行时长ms] 字(字开始ms,字时长ms) 字(字开始ms,字时长ms) ...
 * 注意时间戳是**两段式** (start,dur)。
 */
function mergeTranslation(lines, transText) {
  if (!transText) return lines;
  const trans = parseLrcText(transText).lines;
  if (!trans.length) return lines;
  const map = new Map(trans.map((t) => [t.startMs, t.text]));
  for (const line of lines) {
    const direct = map.get(line.startMs);
    if (direct) { line.translation = direct; continue; }
    // 时间戳常有几十毫秒偏差，找最近的
    let best = null;
    for (const t of trans) {
      const diff = Math.abs(t.startMs - line.startMs);
      if (diff <= 300 && (!best || diff < best.diff)) best = { diff, text: t.text };
    }
    if (best) line.translation = best.text;
  }
  return lines;
}

/**
 * 查歌词。
 *
 * @param {object} opt
 * @param {string} [opt.artist]    显式歌手（本地曲目从曲库带过来，优先于标题解析）
 * @param {string} [opt.songTitle] 显式歌名（同上）
 * @param {string} [opt.rawTitle]  "歌手 - 歌名" 形式的原始标题（YouTube 场景）
 */
async function lookupLyrics({ videoId, rawTitle, duration, wantWordLevel, artist, songTitle }) {
  // 显式传入的 artist/title 优先：本地曲目有结构化的歌名和歌手，
  // 不该再从标题字符串里猜（只给歌名时 parseYoutubeTitle 拆不出歌手，
  // 会导致 lrclib/QQ 匹配不到或匹配错歌）。
  const parsed = (artist || songTitle)
    ? {
        artist: String(artist || '').trim(),
        title: String(songTitle || rawTitle || '').trim(),
      }
    : parseYoutubeTitle(rawTitle);
  let result = null;

  // 顺序：QQ 逐字 → QQ 行级 → 网易云 → lrclib
  // QQ 逐字最好但限流极凶（code=2001）；网易云对中文歌覆盖远好于 lrclib；
  // lrclib 放最后，因为它的中文命中率最差。
  if (wantWordLevel) {
    try { result = await lookupLyricsQq(parsed.artist, parsed.title, duration); } catch { result = null; }
    // QQ 只拿到行级（qrcLines 为空）也算失败，继续往下走
    if (result && !result.qrcLines) result = null;
  }
  // 只要行级：先问 QQ（它同时给翻译）
  if (!result) {
    try { result = await lookupLyricsQq(parsed.artist, parsed.title, duration); } catch { result = null; }
  }
  // 网易云兜底：QQ 限流时中文歌基本只能靠它。
  // 现在它会优先返回逐字 YRC（有的话），没有才退回行级 LRC。
  if (!result) {
    try {
      const ne = await netease.fetchLyrics(parsed.title, parsed.artist ? [parsed.artist] : [], duration);
      if (ne) {
        result = {
          provider: 'netease',
          syncedLyrics: ne.content,
          transLyrics: ne.translation || '',
          format: ne.format || 'lrc',
          // 逐字（YRC）时带上行数据，服务端后面会直接用它
          qrcLines: ne.wordLevel && ne.lines && ne.lines.length ? ne.lines : null,
        };
      }
    } catch { result = null; }
  }
  // 最后才用 lrclib
  if (!result) {
    try { result = await lookupLyricsLrclib(parsed.artist, parsed.title, duration); } catch { result = null; }
  }
  if (!result) {
    return { found: false, lines: [], provider: null, parsed, videoId: videoId || null, reason: 'no-match' };
  }
  const synced = result.syncedLyrics || '';
  let lines;
  if (result.qrcLines && result.qrcLines.length) {
    // 逐字歌词：直接用 QRC/YRC 解析结果（每行带 chars）
    lines = result.qrcLines;
    // 逐字歌词同样要合翻译：否则「有逐字就没翻译」，和行级那份不一致。
    if (result.transLyrics) lines = mergeTranslation(lines, result.transLyrics);
  } else if (synced) {
    lines = parseLrcText(synced).lines;
    if (result.transLyrics) lines = mergeTranslation(lines, result.transLyrics);
  } else {
    lines = String(result.plainLyrics || '').split(/\r?\n/).filter((l) => l.trim()).map((text) => ({ startMs: null, endMs: null, text: text.trim() }));
  }
  return {
    found: true,
    provider: result.provider,
    format: result.format || (synced ? 'lrc' : 'plain'),
    wordLevel: Boolean(result.qrcLines && result.qrcLines.length),
    synced: Boolean(synced),
    lines,
    parsed,
    videoId: videoId || null,
    sourceDuration: result.duration || null,
  };
}

/**
 * 库里有行级歌词、但本次请求要逐字时，**后台**尝试升级到逐字。
 *
 * 绝对不能在请求里 await：QQ 搜索有 3.5s 串行间隔 + 限流冷却（2001 会退避几十秒），
 * 冷启动实测一次升级要 ~40s。以前阻塞着等结果，大屏在这段时间里一行歌词都没有，
 * 看起来就像「新处理的歌没有歌词」。现在先把库里那份返回，升级成功再写覆盖表 +
 * 更新缓存，下次播放自动用逐字版。
 */
function scheduleWordLevelUpgrade({ videoId, rawTitle, duration, artist, songTitle, cacheKey }) {
  if (!videoId || lyricsUpgrades.has(cacheKey)) return;
  lyricsUpgrades.add(cacheKey);
  lookupLyrics({ videoId, rawTitle, duration, wantWordLevel: true, artist, songTitle })
    .then((upgraded) => {
      const upLines = (upgraded && upgraded.lines) || [];
      const gotWord = upLines.some((l) => (l.chars || []).length > 1);
      // 合理性校验：真实歌词不可能只有两三行。
      // 自动升级曾把 "Blinding Lights" 换成 2 行的错误匹配、把 "drop dead" 换成 3 行，
      // 宁可保留库里完整的那份，也不要这种垃圾逐字。
      const plausible = upLines.length >= 8;
      if (!gotWord || !plausible) return;
      // 升级期间 DJ 可能手动重匹配过；显式结果优先，别被后台自动结果盖掉。
      const existing = lyricsOverrides.get(videoId);
      if (existing?.payload && !existing.payload.autoUpgraded) return;
      try { lyricsOverrides.set(videoId, { ...upgraded, autoUpgraded: true }); } catch { /* ignore */ }
      lyricsCache.set(cacheKey, { at: Date.now(), payload: upgraded });
    })
    .catch(() => { /* 升级失败就继续用库里的行级歌词 */ })
    .finally(() => { lyricsUpgrades.delete(cacheKey); });
}

async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  if (pathname.startsWith('/internal/')) {
    if (!INTERNAL_TOKEN || String(req.headers['x-internal-token'] || '') !== INTERNAL_TOKEN || !isLoopback(req)) {
      return sendError(res, 404, '未找到接口', 'NOT_FOUND');
    }
    if (method === 'POST' && pathname === '/internal/public-url') {
      const body = await readBody(req);
      const nextTunnelUrl = normalizePublicUrl(body.tunnelUrl);
      const nextFixedUrl = normalizePublicUrl(body.fixedUrl);
      const changed = nextTunnelUrl !== tunnelUrl || nextFixedUrl !== state.settings.publicUrl;
      tunnelUrl = nextTunnelUrl;
      if (body.youtubeApiKey !== undefined) runtimeYoutubeApiKey = String(body.youtubeApiKey || '').trim();
      // 控制面板推来的 Spotify 凭证 / 授权状态（config\config.json → 运行时）
      if (body.spotify !== undefined) spotify.applyRuntimeConfig(body.spotify);
      if (nextFixedUrl !== state.settings.publicUrl) {
        state.settings.publicUrl = nextFixedUrl;
        persist();
      }
      if (changed) broadcast();
      return sendJson(res, 200, { publicUrl: currentPublicUrl(), spotify: spotify.status() });
    }
    // 供控制面板「导入授权」用：把本机 token 交给面板存进 config.json
    if (method === 'GET' && pathname === '/internal/spotify/export') {
      return sendJson(res, 200, spotify.exportToken());
    }
    // 供控制面板「退出账号」用：清掉本机 token 文件
    if (method === 'POST' && pathname === '/internal/spotify/clear') {
      const result = spotify.clearToken();
      broadcast();
      return sendJson(res, 200, result);
    }
    return sendError(res, 404, '未找到接口', 'NOT_FOUND');
  }

  if (method === 'GET' && pathname === '/api/config') {
    issueBrowserCookie(req, res);
    return sendJson(res, 200, { roomName: state.settings.roomName, joinUrl: `${publicOrigin(req)}/join`, maxQueuedSongsPerGuest: state.settings.maxQueuedSongsPerGuest, onlyKaraokeSongs: state.settings.onlyKaraokeSongs, publicUrl: currentPublicUrl(), interfaceLanguage: state.settings.interfaceLanguage, interfaceTheme: state.settings.interfaceTheme, playbackMode: state.settings.playbackMode, sourceMode: state.settings.sourceMode });
  }
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, publicState());

  // ---- 本地曲库（模式 B）----
  if (method === 'GET' && pathname === '/api/library/summary') {
    return sendJson(res, 200, libraryDb.summary());
  }
  if (method === 'GET' && pathname === '/api/library/tracks') {
    const res2 = libraryDb.listTracks({
      q: url.searchParams.get('q') || '',
      limit: Number(url.searchParams.get('limit')) || 100,
      includeUnready: url.searchParams.get('all') === '1',
    });
    return sendJson(res, 200, res2);
  }
  if (method === 'GET' && pathname.startsWith('/api/library/tracks/')) {
    const id = decodeURIComponent(pathname.slice('/api/library/tracks/'.length));
    const track = libraryDb.getTrack(id);
    if (!track) return sendError(res, 404, '曲库中没有这首歌', 'TRACK_NOT_FOUND');
    return sendJson(res, 200, track);
  }
  // ---- 曲库管理（DJ 控制台「曲库管理」标签页）----
  // 曲库全部曲目（含未就绪/失败）+ 处理状态/耗时/大小/匹配分/失败原因，
  // 正在后台跑的曲目用内存任务状态覆盖 status/progress。
  if (method === 'GET' && pathname === '/api/library/admin') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const data = libraryDb.adminTracks({ q: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit')) || 200 });
    if (data.available) {
      const OUT_DIR = path.join(__dirname, 'assets', 'output', 'library');
      data.tracks = data.tracks.map((track) => {
        const job = prepareQueue.getStatus(track.spotifyId);
        const out = { ...track };
        if (job && (job.status === 'queued' || job.status === 'running')) {
          out.status = 'processing';
          out.statusText = '处理中';
          out.progress = job.progress || null;
          out.stage = job.stage || null;
          out.stageLabel = job.stageLabel || null;
          out.ready = false;
          out.error = null;
          out.jobStatus = job.status;
        } else if (job && job.status === 'failed') {
          out.status = 'failed';
          out.statusText = '处理失败';
          out.error = job.error || out.error;
          out.jobStatus = job.status;
        } else if (job && track.status === 'separated') {
          out.jobStatus = job.status;
        }
        // 成品 4 个 mp3 的总大小
        try {
          const dir = path.join(OUT_DIR, track.spotifyId);
          if (fs.existsSync(dir)) {
            let bytes = 0;
            for (const name of ['accompaniment.mp3', 'vocals.mp3', 'guide.mp3', 'original.mp3']) {
              const p = path.join(dir, name);
              if (fs.existsSync(p)) bytes += fs.statSync(p).size;
            }
            out.outputBytes = bytes || null;
          }
        } catch { /* ignore */ }
        // 歌词来源以**实际生效的**为准：
        // DB 里是流水线自动抓的结果，DJ 手动「改词重搜」写在覆盖表里。
        // 不合并的话，重搜成功过 library 仍显示 lrclib，看着像没生效。
        const ov = lyricsOverrides.get(`local:${track.spotifyId}`);
        if (ov && ov.payload) {
          const pl = ov.payload;
          out.lyricsProvider = pl.provider || 'override';
          out.lyricsFormat = pl.format || null;
          out.lyricsSynced = Boolean(pl.synced ?? true);
          out.lyricsCount = Math.max(1, out.lyricsCount || 0);
          out.lyricsChars = (pl.lines || []).reduce((n, l) => n + ((l.chars || []).length || 1), 0);
          out.lyricsOverridden = true;
          out.lyricsOverrideAt = ov.at || null;
        }
        return out;
      });
      data.prepareJobs = prepareQueue.list();
      data.counts = data.tracks.reduce((acc, track) => { acc[track.status] = (acc[track.status] || 0) + 1; return acc; }, {});
    }
    return sendJson(res, 200, data);
  }
  // 从曲库删除一首歌（DB 记录 + 成品/封面/歌词/原始 WAV）。
  // 前端一直是 DELETE /api/library/admin/tracks/:id，但服务端以前没有这个路由，
  // 所以才会提示「接口不存在」。
  const libraryDeleteMatch = pathname.match(/^\/api\/library\/admin\/tracks\/([^/]+)$/);
  if (method === 'DELETE' && libraryDeleteMatch) {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const spotifyId = decodeURIComponent(libraryDeleteMatch[1]);
    if (!/^[A-Za-z0-9]{22}$/.test(spotifyId)) return sendError(res, 400, 'spotifyId 不合法', 'BAD_SPOTIFY_ID');

    // 正在跑的制作任务先停掉，否则删完它又会把文件和数据库记录写回来
    const job = prepareQueue.getStatus(spotifyId);
    if (job && ['queued', 'running'].includes(job.status)) prepareQueue.cancel(spotifyId);

    const result = libraryDb.deleteTrack(spotifyId);
    if (!result.ok) {
      if (result.reason === 'not-found') return sendError(res, 404, '曲库里没有这首歌', 'TRACK_NOT_FOUND');
      return sendError(res, 500, `删除曲库记录失败：${result.error || result.reason}`, 'LIBRARY_DELETE_FAILED');
    }

    // 清掉队列里引用这首歌的项；如果它正在播放，直接切到下一首
    mutate(() => {
      state.songs
        .filter(song => song.spotifyId === spotifyId && ['queued', 'preparing', 'prepare_failed'].includes(song.status))
        .forEach(song => { song.status = 'removed'; song.endedAt = now(); });
      const current = currentSong();
      if (current && current.spotifyId === spotifyId) finishCurrent('skipped');
      else if (!currentSong() && !state.importantBroadcast) startNext();
    });

    // 歌词缓存 / 手动覆盖也一起清掉，避免删除后还能命中旧数据
    for (const key of [...lyricsCache.keys()]) {
      if (key.startsWith(`local:${spotifyId}|`)) lyricsCache.delete(key);
    }
    try { lyricsOverrides.remove(`local:${spotifyId}`); } catch { /* ignore */ }

    // 只删项目资产目录内的文件；DB 里指向旧工程/外部目录的路径不动
    const removedFiles = [];
    const fileErrors = [];
    const removePath = (target) => {
      if (!target) return;
      const resolved = path.resolve(target);
      const allowed = [MEDIA_ROOT + path.sep, DATA_DIR + path.sep];
      if (!allowed.some(root => resolved.startsWith(root))) return;
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
        removedFiles.push(resolved);
      } catch (error) {
        fileErrors.push(`${resolved}: ${error.message}`);
      }
    };
    removePath(path.join(MEDIA_ROOT, 'output', 'library', spotifyId));
    removePath(path.join(MEDIA_ROOT, 'covers', `${spotifyId}.jpg`));
    for (const ext of ['.lrc', '.yrc', '.qrc']) removePath(path.join(MEDIA_ROOT, 'lyrics', `${spotifyId}${ext}`));
    removePath(result.audioPath);
    removePath(result.albumArtPath);
    if (fileErrors.length) console.warn(`[library] 删除 ${spotifyId} 时部分文件失败：${fileErrors.join(' | ')}`);

    syncPrepareState();
    return sendJson(res, 200, { ok: true, spotifyId, removedFiles, fileErrors });
  }
  // ---- 残留文件清理（曲库管理页「清理残留」弹窗）----
  // 歌曲从曲库删掉后，产物有时还留在磁盘上（早期清理逻辑不完整、或文件被别的
  // 流程写回来）。扫描是只读的，只报"磁盘上有、数据库里已经没有记录"的条目；
  // 删除走另一个接口，路径必须过白名单。
  if (method === 'GET' && pathname === '/api/library/admin/orphans') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const data = libraryDb.scanOrphans({
      assetsRoot: MEDIA_ROOT,
      dataRoot: DATA_DIR,
      overrideKeys: lyricsOverrides.list().map((item) => item.key),
    });
    // 正在排队/制作的歌，产物正在被写入，不能当成残留 —— 交给前端置灰
    data.activeIds = prepareQueue.list()
      .filter((job) => job.status === 'queued' || job.status === 'running')
      .map((job) => String(job.spotifyId));
    return sendJson(res, 200, data);
  }
  if (method === 'POST' && pathname === '/api/library/admin/orphans/purge') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const body = await readBody(req);
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const overrideKeys = Array.isArray(body.overrideKeys) ? body.overrideKeys.map(String) : [];
    if (!paths.length && !overrideKeys.length) return sendError(res, 400, '没有要清理的内容', 'NOTHING_TO_PURGE');

    const activeIds = prepareQueue.list()
      .filter((job) => job.status === 'queued' || job.status === 'running')
      .map((job) => String(job.spotifyId));

    // 删之前落一份清单：文件是真删（不进回收站），有清单至少能查删过什么
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const files = paths.length
      ? libraryDb.purgeFiles(paths, {
          assetsRoot: MEDIA_ROOT,
          dataRoot: DATA_DIR,
          blockedIds: activeIds,
          manifestFile: path.join(DATA_DIR, `orphan-cleanup-${stamp}.json`),
        })
      : { ok: true, removed: [], rejected: [], failed: [], freedBytes: 0, manifest: null };

    const overrides = { removed: [], skipped: [] };
    for (const key of overrideKeys) {
      const m = /^local:(.+)$/.exec(key);
      if (!m) { overrides.skipped.push({ key, reason: 'bad-key' }); continue; }
      if (activeIds.includes(m[1])) { overrides.skipped.push({ key, reason: 'job-active' }); continue; }
      if (!lyricsOverrides.remove(key)) { overrides.skipped.push({ key, reason: 'not-found' }); continue; }
      for (const cacheKey of [...lyricsCache.keys()]) {
        if (cacheKey.startsWith(`${key}|`)) lyricsCache.delete(cacheKey);
      }
      overrides.removed.push(key);
    }

    return sendJson(res, 200, { ok: files.ok && !files.failed.length, files, overrides });
  }
  // ---- 后台制作任务 ----
  if (method === 'GET' && pathname === '/api/prepare') {
    const spotifyId = String(url.searchParams.get('spotifyId') || '').trim();
    if (spotifyId) {
      const job = prepareQueue.getStatus(spotifyId);
      if (!job) return sendError(res, 404, '没有这个制作任务', 'JOB_NOT_FOUND');
      return sendJson(res, 200, job);
    }
    // 公开接口只给概览；完整任务列表要 DJ 权限
    const summary = prepareQueue.summary();
    if (isAdmin(req)) return sendJson(res, 200, { ...summary, jobs: prepareQueue.list() });
    return sendJson(res, 200, {
      running: summary.running,
      runningCount: summary.runningCount,
      concurrency: summary.concurrency,
      pending: summary.pending,
      counts: summary.counts
    });
  }
  if (method === 'GET' && pathname === '/api/prepare/status') {
    const spotifyId = String(url.searchParams.get('spotifyId') || '').trim();
    if (!spotifyId) return sendError(res, 400, '需要 spotifyId', 'MISSING_QUERY');
    const job = prepareQueue.getStatus(spotifyId);
    if (!job) return sendError(res, 404, '没有这个制作任务', 'JOB_NOT_FOUND');
    return sendJson(res, 200, job);
  }
  // 取消制作：**仅 DJ**。点歌触发的制作是曲库资产建设，普通用户无权中断。
  if (method === 'POST' && pathname === '/api/prepare/cancel') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const body = await readBody(req);
    const result = prepareQueue.cancel(String(body.spotifyId || ''));
    if (!result.ok) return sendError(res, 404, result.reason === 'not-found' ? '没有这个制作任务' : `任务已经${result.reason}`, 'JOB_NOT_CANCELABLE');
    syncPrepareState();
    return sendJson(res, 200, { job: result.job, state: publicState() });
  }
  // ---- Spotify 授权（OAuth PKCE）----
  // 流程由控制面板发起：面板拿 /auth 的地址 → 打开浏览器 → Spotify 回到 /callback。
  if (method === 'GET' && pathname === '/api/spotify/status') {
    return sendJson(res, 200, spotify.status());
  }
  if (method === 'GET' && pathname === '/api/spotify/auth') {
    try {
      const credentials = spotify.credentials();
      return sendJson(res, 200, {
        url: spotify.buildAuthUrl(),
        redirectUri: credentials.redirectUri || '',
        configured: credentials.configured,
      });
    } catch (error) {
      return sendError(res, 400, error.message, 'SPOTIFY_NOT_CONFIGURED');
    }
  }
  // 浏览器从 accounts.spotify.com 跳回来，没法带 admin token，所以这里不校验权限；
  // CSRF 由 PKCE 的 state（内存握手表）兜住。
  // 两个路径都接受：老 .env 里注册的是 /api/spotify/auth/callback，新推荐 /api/spotify/callback。
  if (method === 'GET' && (pathname === '/api/spotify/callback' || pathname === '/api/spotify/auth/callback')) {
    const code = String(url.searchParams.get('code') || '');
    const stateParam = String(url.searchParams.get('state') || '');
    const errorParam = String(url.searchParams.get('error') || '');
    try {
      if (errorParam) throw new Error(errorParam === 'access_denied' ? '用户取消了授权' : errorParam);
      if (!code) throw new Error('缺少 code 参数');
      await spotify.exchangeCode(code, stateParam);
      broadcast();
      return sendHtml(res, 200, spotifyDoneHtml(true));
    } catch (error) {
      return sendHtml(res, 400, spotifyDoneHtml(false, error.message));
    }
  }
  if (method === 'POST' && pathname === '/api/spotify/logout') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    spotify.clearToken();
    broadcast();
    return sendJson(res, 200, spotify.status());
  }

  // ---- Spotify 搜索（模式 B：搜索走 Spotify，结果标记 已就绪/未就绪）----
  // 只有固定查询串（不按请求体/头变化）才缓存；limit 很小，5 分钟缓存足以挡住重复点击。
  if (method === 'GET' && pathname === '/api/spotify/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 10), 10);
    if (!q) return sendJson(res, 200, { query: '', items: [], available: true });
    const cacheKey = `${limit}|${q}`;
    const cached = spotifySearchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SPOTIFY_SEARCH_CACHE_MS) return sendJson(res, 200, cached.payload);
    try {
      const { tracks } = await spotify.search(q, limit);
      const items = (tracks || []).map((track) => {
        const local = libraryDb.getTrack(track.id);
        return {
          spotifyId: track.id,
          title: track.name,
          artists: track.artists || [],
          album: track.album || null,
          durationMs: track.durationMs || null,
          cover: track.coverUrl || null,
          localCover: (local && local.cover) || null,
          popularity: track.popularity,
          inLibrary: Boolean(local),
          ready: Boolean(local && local.ready),
          source: 'spotify',
        };
      });
      const payload = { query: q, items, available: true };
      spotifySearchCache.set(cacheKey, { at: Date.now(), payload });
      return sendJson(res, 200, payload);
    } catch (error) {
      // Spotify 不可用不影响点歌台本身：HTTP 仍然 200，前端降级提示
      return sendJson(res, 200, { query: q, items: [], available: false, reason: error.message || 'Spotify 搜索失败' });
    }
  }
  if (method === 'GET' && pathname === '/api/lyrics/lookup') {
    // 歌词查询：display 页统一走这里，避免每个客户端各发一次网络请求。
    // 结果做内存缓存（同一 videoId 不重复查询）。
    const videoId = String(url.searchParams.get('videoId') || '').trim();
    const rawTitle = String(url.searchParams.get('title') || '').trim();
    // 本地曲目带结构化的歌手/歌名，直接传，免得从标题猜
    const artist = String(url.searchParams.get('artist') || '').trim();
    const songTitle = String(url.searchParams.get('songTitle') || '').trim();
    const duration = Number(url.searchParams.get('duration')) || 0;
    const wantWordLevel = url.searchParams.get('wordLevel') === '1';
    if (!videoId && !rawTitle && !songTitle) return sendError(res, 400, '需要 videoId 或 title', 'MISSING_QUERY');
    const cacheKey = `${videoId || ''}|${artist}|${songTitle || rawTitle}|${wantWordLevel ? 'w' : 'l'}`;
    const cached = lyricsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LYRICS_CACHE_MS) return sendJson(res, 200, cached.payload);
    // DJ 手动重新匹配过的结果优先（存 data/lyrics-overrides.json）。
    // 键用 songKey：前端把 `local:<spotifyId>` 或 `yt:<videoId>` 放在 videoId 参数里。
    const override = lyricsOverrides.get(videoId);
    if (override && override.payload) {
      return sendJson(res, 200, { ...override.payload, overridden: true });
    }
    // 其次用曲库里已存的歌词（流水线抓的，不联网）。
    // 有这一步才不会每切一次歌就去打 QQ —— 那家限流很凶（code=2001）。
    if (videoId.startsWith('local:')) {
      const sid = videoId.slice('local:'.length);
      const stored = libraryDb.getLyrics(sid);
      if (stored && stored.content) {
        const raw = String(stored.content).replace(/^\uFEFF/, '');
        const fmt = String(stored.format || '').toLowerCase();
        // 老数据里有个坑：流水线把网易云的 YRC（逐字）也标成了 format='lrc'。
        // 只按 format 判断会拿 YRC 去喂 LRC 解析器 → 0 行 → 落到联网查询，
        // 大屏就要等 QQ 几十秒才出歌词。这里按内容再兜底识别一次。
        const isQrc = fmt === 'qrc' || raw.includes('<QrcInfos');
        const looksYrc = !isQrc && /^[ \t]*(?:\[\d+[ \t]*,[ \t]*\d+\]|\{[ \t]*"t"[ \t]*:)/m.test(raw);
        let storedLines = [];
        if (isQrc) {
          storedLines = parseQrcXml(raw).lines;
        } else if (fmt === 'yrc' || looksYrc) {
          // 网易云逐字：库里存的就是原始 YRC 文本，解析即可还原 chars
          storedLines = netease.parseYrc(raw);
        } else if (stored.synced) {
          storedLines = parseLrcText(raw).lines;
        } else {
          storedLines = raw.split(/\r?\n/).filter((t) => t.trim())
            .map((text) => ({ startMs: null, endMs: null, text: text.trim() }));
        }
        if (storedLines.length) {
          const storedWordLevel = storedLines.some((l) => (l.chars || []).length > 1);
          const payload = {
            found: true,
            provider: stored.provider || 'library',
            format: isQrc ? 'qrc' : looksYrc ? 'yrc' : (fmt || (stored.synced ? 'lrc' : 'plain')),
            wordLevel: storedWordLevel,
            lines: storedLines,
            parsed: { artist, title: songTitle || rawTitle },
            videoId,
            fromLibrary: true,
          };
          lyricsCache.set(cacheKey, { at: Date.now(), payload });
          // 库里这份是行级、而本次请求要逐字 → 后台升级，先返回已有歌词。
          // 以前是 await 联网升级，QQ 限流时一次要 ~40s，大屏整段时间没有歌词。
          if (wantWordLevel && !storedWordLevel) {
            scheduleWordLevelUpgrade({ videoId, rawTitle, duration, artist, songTitle, cacheKey });
          }
          return sendJson(res, 200, payload);
        }
      }
    }
    try {
      const payload = await lookupLyrics({ videoId, rawTitle, duration, wantWordLevel, artist, songTitle });
      lyricsCache.set(cacheKey, { at: Date.now(), payload });
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 200, { found: false, lines: [], provider: null, error: error.message });
    }
  }
  // 重新匹配歌词（仅 DJ）：允许改歌名/歌手再搜，结果写入覆盖表并立即生效
  if (method === 'POST' && pathname === '/api/library/lyrics/rematch') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    const body = await readBody(req);
    const spotifyId = String(body.spotifyId || '').trim();
    if (!/^[A-Za-z0-9]{22}$/.test(spotifyId)) return sendError(res, 400, 'spotifyId 不合法', 'BAD_SPOTIFY_ID');
    const track = libraryDb.getTrack(spotifyId);
    if (!track) return sendError(res, 404, '曲库里没有这首歌', 'TRACK_NOT_FOUND');
    const songTitle = String(body.songTitle || body.title || track.title || '').trim();
    const artist = String(body.artist || (track.artists || []).join(', ') || '').trim();
    if (!songTitle) return sendError(res, 400, '需要歌名', 'MISSING_TITLE');
    const duration = track.durationMs ? Math.round(track.durationMs / 1000) : 0;
    const wantWordLevel = body.wordLevel !== false;
    const key = `local:${spotifyId}`;
    let payload;
    try {
      payload = await lookupLyrics({
        videoId: key, rawTitle: '', duration, wantWordLevel,
        artist, songTitle,
      });
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: error.message, songTitle, artist });
    }
    if (!payload || !payload.found || !(payload.lines || []).length) {
      // 没找到就**不要**覆盖已有歌词，如实返回失败让 DJ 改关键词再试
      return sendJson(res, 200, {
        ok: false,
        reason: 'no-match',
        songTitle, artist,
        provider: payload?.provider || null,
      });
    }
    lyricsOverrides.set(key, payload, { songTitle, artist });
    // 覆盖表变了，清掉内存缓存，避免旧结果抢先命中
    lyricsCache.delete(`${key}|${artist}|${songTitle}|w`);
    lyricsCache.delete(`${key}|${artist}|${songTitle}|l`);
    return sendJson(res, 200, {
      ok: true,
      songTitle,
      artist,
      provider: payload.provider,
      wordLevel: Boolean(payload.wordLevel),
      lines: (payload.lines || []).length,
      preview: (payload.lines || []).slice(0, 3).map((l) => l.text),
    });
  }
  if (method === 'GET' && pathname === '/api/my-queue') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '请先建立点歌会话', 'SESSION_REQUIRED');
    attachBrowserToSession(req, res, session);
    session.lastSeenAt = now();
    // 不能只查 pendingSongs()（它只含 status==='queued'）：
    // 歌一点下去就先进 preparing，那段时间用户看不到自己的歌、也没法删。
    // 这里和 /api/state 的公开队列保持同样的状态集合。
    const mine = state.songs
      .filter((song) => song.sessionId === session.id && queueOrder.ACTIVE_STATUSES.includes(song.status))
      .sort(queueOrder.compareQueueOrder)
      .map((song) => {
        const out = publicSong(song);
        if (song.source === 'local' && song.spotifyId) out.prepareJob = prepareQueue.getStatus(song.spotifyId);
        return out;
      });
    return sendJson(res, 200, { songs: mine, session: { id: session.id, displayName: session.displayName } });
  }
  if (method === 'GET' && pathname === '/api/admin/state') {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    cleanupInactiveGuests();
    return sendJson(res, 200, adminState());
  }
  if (method === 'GET' && pathname === '/api/youtube/search') {
    try { return sendJson(res, 200, { items: await youtubeSearch(url.searchParams.get('q')) }); }
    catch (error) { return sendError(res, 502, error.message, 'YOUTUBE_SEARCH_FAILED'); }
  }
  if (method === 'GET' && pathname === '/api/qr') {
    try { return sendJson(res, 200, { dataUrl: await QRCode.toDataURL(url.searchParams.get('text') || `${publicOrigin(req)}/join`, { margin: 1, width: 360, color: { dark: '#102a43', light: '#ffffff' } }) }); }
    catch (error) { return sendError(res, 500, error.message); }
  }
  if (method === 'GET' && pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (method === 'POST' && pathname === '/api/sessions') {
    cleanupInactiveGuests();
    const browserIdentities = requestBrowserIdentities(req);
    if ((browserIdentities.cookieHash || browserIdentities.clientHash) && state.blockedGuests.some(block => (browserIdentities.cookieHash && block.browserIdHash === browserIdentities.cookieHash) || (browserIdentities.clientHash && block.clientBrowserIdHash === browserIdentities.clientHash))) return sendError(res, 403, '此浏览器已被 DJ 拉黑', 'BROWSER_BLOCKED');
    const body = await readBody(req);
    const displayName = String(body.displayName || '').trim().slice(0, 24);
    if (!displayName) return sendError(res, 400, '请输入演唱者昵称', 'DISPLAY_NAME_REQUIRED');
    if (isDisplayNameTaken(displayName)) return sendError(res, 409, '这个 Guest 名称已经被使用', 'DISPLAY_NAME_TAKEN');
    const token = crypto.randomBytes(24).toString('hex');
    const browser = issueBrowserCookie(req, res);
    const session = { id: id('guest'), displayName, browserIdHash: browser.hash, clientBrowserIdHash: browserIdentities.clientHash, createdAt: now(), lastSeenAt: now(), lastSongAt: null };
    state.sessions[hash(token)] = session;
    persist();
    return sendJson(res, 201, { token, session: { id: session.id, displayName } });
  }
  if (method === 'PATCH' && pathname === '/api/sessions') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '会话已失效，请重新进入', 'SESSION_EXPIRED');
    attachBrowserToSession(req, res, session);
    const body = await readBody(req);
    const displayName = String(body.displayName || '').trim().slice(0, 24);
    if (!displayName) return sendError(res, 400, '请输入演唱者昵称', 'DISPLAY_NAME_REQUIRED');
    if (isDisplayNameTaken(displayName, session.id)) return sendError(res, 409, '这个 Guest 名称已经被使用', 'DISPLAY_NAME_TAKEN');
    session.displayName = displayName;
    session.lastSeenAt = now();
    persist();
    return sendJson(res, 200, { session: { id: session.id, displayName } });
  }
  if (method === 'POST' && pathname === '/api/queue') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '请先建立点歌会话', 'SESSION_REQUIRED');
    attachBrowserToSession(req, res, session);
    if (session.blockedUntil && new Date(session.blockedUntil) > new Date()) return sendError(res, 403, '当前会话暂时不能点歌', 'SESSION_BLOCKED');
    const body = await readBody(req);
    const source = body.source === 'local' ? 'local' : 'youtube';
    if (!body.title) return sendError(res, 400, '歌曲信息不完整', 'SONG_INCOMPLETE');
    // 本地曲目用 spotifyId 标识，YouTube 曲目用 videoId
    if (source === 'youtube' && !body.videoId) return sendError(res, 400, '歌曲信息不完整', 'SONG_INCOMPLETE');
    if (source === 'local' && !body.spotifyId) return sendError(res, 400, '缺少 spotifyId', 'SONG_INCOMPLETE');
    const title = String(body.title).trim().slice(0, 160);
    // onlyKaraokeSongs 只对 YouTube 搜索生效：本地曲库已经是我们处理过的卡拉OK音源，
    // 标题里不会有 "karaoke" 字样，用它过滤会把本地点歌全部拒掉（曾发生）。
    if (source === 'youtube' && state.settings.onlyKaraokeSongs && !/karaoke/i.test(title)) {
      return sendError(res, 400, '仅允许标题含 Karaoke 的歌曲', 'SONG_NOT_KARAOKE');
    }
    const matchedKeyword = matchedBlacklistKeyword(title);
    if (matchedKeyword) return sendError(res, 400, `视频标题含黑名单关键字“${matchedKeyword}”`, 'SONG_BLACKLISTED', { keyword: matchedKeyword });
    const queuedCount = state.songs.filter(song => song.sessionId === session.id && song.status === 'queued').length;
    if (queuedCount >= state.settings.maxQueuedSongsPerGuest) return sendError(res, 409, `已达到上限：当前 ${queuedCount} 首，最多 ${state.settings.maxQueuedSongsPerGuest} 首`, 'QUEUE_LIMIT', { current: queuedCount, max: state.settings.maxQueuedSongsPerGuest });
    // 去重必须用 songKey：本地曲目的 videoId 是 null，直接比 videoId 会让
    // "null === null" 把所有本地歌都判成重复（只剩第一首能点）。
    // 「还在制作中」的项也算重复，否则用户连点两次会堆出两条一样的歌。
    const key = songKey({ source, videoId: body.videoId, spotifyId: body.spotifyId });
    const activeStatuses = ['queued', 'preparing'];
    if (!state.settings.allowDuplicatePerSession && state.songs.some(song => song.sessionId === session.id && songKey(song) === key && activeStatuses.includes(song.status))) return sendError(res, 409, '你已经点过这首歌', 'DUPLICATE_SESSION_SONG');
    if (!state.settings.allowDuplicateVideo && state.songs.some(song => songKey(song) === key && activeStatuses.includes(song.status))) return sendError(res, 409, '这首歌已经在等待队列中', 'DUPLICATE_VIDEO');
    // 本地曲目要判定「能不能立刻播」：
    //   曲库已 ready → 直接进等待队列（原行为）
    //   曲库里没有 / 未就绪 → 进后台制作（status='preparing'），点歌仍然成功（201）
    const needsPrepare = source === 'local' && !isLocalTrackReadyForPlayback(body.spotifyId);
    const song = {
      id: id('song'), roomId: 'main', source,
      videoId: source === 'youtube' ? String(body.videoId) : null,
      spotifyId: source === 'local' ? String(body.spotifyId) : null,
      title,
      channelTitle: String(body.channelTitle || (source === 'local' ? '本地曲库' : 'YouTube')).slice(0, 100),
      thumbnailUrl: String(body.thumbnailUrl || ''),
      duration: String(body.duration || '—'), sessionId: session.id, singerNameSnapshot: session.displayName,
      status: needsPrepare ? 'preparing' : 'queued',
      isPinned: false,
      // 必须排在所有 active 项（含 preparing）之后。以前用 state.songs.length，
      // 在归一 queued 位置后可能比制作中的歌还小，新歌就插到它前面了。
      queuePosition: queueOrder.nextQueuePosition(state.songs),
      createdAt: now()
    };
    if (needsPrepare) song.progress = { stage: 'queued', percent: 0 };
    mutate(() => {
      state.songs.push(song);
      session.lastSongAt = now();
      // 队列空着时，第一首歌必须直接开播（即使之前是暂停/停止状态）。
      // 制作中的歌没音频，不能开播，只入队等制作完成。
      // startNext() 内部还会检查完整队列：前面有歌在 preparing 时不会插队开播。
      if (!needsPrepare && !currentSong() && !state.importantBroadcast) startNext();
    });
    let prepareJob = null;
    if (needsPrepare) {
      const { job } = prepareQueue.enqueue({ spotifyId: song.spotifyId, title, songId: song.id });
      prepareJob = job;
      song.progress = { stage: job.progress?.stage || 'queued', percent: job.progress?.percent || 0 };
      syncPrepareState();
    }
    return sendJson(res, 201, { song: publicSong(song), prepareJob, state: publicState() });
  }
  if (method === 'PATCH' && pathname === '/api/queue/order') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '请先建立点歌会话', 'SESSION_REQUIRED');
    const body = await readBody(req);
    // 允许移动所有还占着队列位置的歌（queued / preparing / prepare_failed）。
    // 以前只认 queued：用户对「准备中」的歌按上移/下移会得到 404，
    // 前端又把 404 误当成「服务端版本过旧」。
    const first = state.songs.find(item => item.id === body.firstId && queueOrder.ACTIVE_STATUSES.includes(item.status));
    const second = state.songs.find(item => item.id === body.secondId && queueOrder.ACTIVE_STATUSES.includes(item.status));
    if (!first || !second) return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
    if (first.sessionId !== session.id || second.sessionId !== session.id) return sendError(res, 403, '只能调整自己点的歌', 'NOT_YOUR_SONG');
    if (first.id !== second.id) {
      mutate(() => {
        // 用「移动」而不是「交换」：只改变这首歌和目标歌的相对位置，
        // 中间夹着的其他用户的歌保持原顺序。
        const order = queueOrder.activeSongs(state.songs);
        const from = order.indexOf(first);
        const to = order.indexOf(second);
        if (from < 0 || to < 0 || from === to) return;
        order.splice(from, 1);
        const anchor = order.indexOf(second);
        if (anchor < 0) return;
        order.splice(from < to ? anchor + 1 : anchor, 0, first);
        order.forEach((song, index) => { song.queuePosition = index; });
        // 把 ready 的歌移到准备中的歌前面后，如果当前没在播，应该立刻开播。
        if (!currentSong() && !state.importantBroadcast) startNext();
      });
    }
    return sendJson(res, 200, publicState());
  }
  const queueMatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (method === 'DELETE' && queueMatch) {
    const session = getSession(req);
    const song = state.songs.find(item => item.id === queueMatch[1]);
    if (!song || !['queued', 'preparing', 'prepare_failed'].includes(song.status)) return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
    if (!isAdmin(req) && (!session || song.sessionId !== session.id)) return sendError(res, 403, '只能删除自己的等待歌曲', 'NOT_YOUR_SONG');
    mutate(() => { song.status = 'removed'; song.endedAt = now(); });
    // 关键：删队列项 ≠ 取消下载。制作是曲库资产建设，已经开始就让它跑完，
    // 只把任务与这条队列项解绑（任务继续，产物照旧进曲库）。
    if (song.source === 'local' && song.spotifyId) prepareQueue.detachSong(song.spotifyId, song.id);
    return sendJson(res, 200, publicState());
  }
  if (method === 'POST' && pathname === '/api/display/event') {
    const body = await readBody(req);
    const current = currentSong();
    if (!current || body.requestId !== current.id) return sendError(res, 409, '播放请求已变化', 'STALE_PLAYBACK');
    mutate(() => {
      if (body.event === 'playing' && !state.importantBroadcast) state.playback.status = 'playing';
      else if (body.event === 'paused') state.playback.status = 'paused';
      else if (body.event === 'ended') finishCurrent('played');
      else if (body.event === 'error') finishCurrent('failed', String(body.detail || '播放器无法播放'));
    });
    return sendJson(res, 200, publicState());
  }
  // 大屏上的人声条里有个「逐字/逐行」切换按钮。大屏没有 DJ token，
  // 所以单独开一个和 /api/display/event 同级的轻量接口（局域网内由 DJ 操作大屏）。
  // 大屏的人声滑块也要能写回服务端：否则切歌/重渲染就回到默认 100（原声）。
  if (method === 'POST' && pathname === '/api/display/vocal') {
    const body = await readBody(req);
    if (body.vocalLevel === undefined) return sendError(res, 400, '缺少 vocalLevel', 'BAD_REQUEST');
    mutate(() => {
      const next = clamp(Number(body.vocalLevel) || 0, 0, 100);
      if (next !== state.playback.vocalLevel) console.log(`[vocal] 大屏写入 ${state.playback.vocalLevel} → ${next}`);
      state.playback.vocalLevel = next;
    });
    return sendJson(res, 200, { vocalLevel: state.playback.vocalLevel });
  }
  if (method === 'POST' && pathname === '/api/display/lyrics-mode') {
    const body = await readBody(req);
    if (body.wordLevel === undefined) return sendError(res, 400, '缺少 wordLevel', 'BAD_REQUEST');
    mutate(() => { state.settings.lyricsWordLevel = Boolean(body.wordLevel); });
    return sendJson(res, 200, { lyricsWordLevel: state.settings.lyricsWordLevel });
  }
  if (method === 'POST' && pathname === '/api/admin/auth') {
    const body = await readBody(req);
    if (String(body.password || '') !== ADMIN_PASSWORD) return sendError(res, 401, 'DJ 密码不正确', 'BAD_PASSWORD');
    const token = createAdminToken();
    return sendJson(res, 200, { token, state: adminState() });
  }
  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendError(res, 401, '需要 DJ 权限', 'ADMIN_REQUIRED');
    if (method === 'POST' && pathname === '/api/admin/guests/block') {
      cleanupInactiveGuests();
      const body = await readBody(req);
      const target = Object.entries(state.sessions).find(([, session]) => session.id === String(body.sessionId || ''));
      if (!target) return sendError(res, 404, 'Guest 不存在或已离开', 'GUEST_NOT_FOUND');
      const [sessionKey, session] = target;
      mutate(() => {
        const alreadyBlocked = (session.browserIdHash && state.blockedGuests.some(block => block.browserIdHash === session.browserIdHash)) || (session.clientBrowserIdHash && state.blockedGuests.some(block => block.clientBrowserIdHash === session.clientBrowserIdHash)) || state.blockedGuests.some(block => block.sessionId === session.id);
        if (!alreadyBlocked) state.blockedGuests.push({ id: id('blocked'), sessionId: session.id, displayName: session.displayName, browserIdHash: session.browserIdHash || '', clientBrowserIdHash: session.clientBrowserIdHash || '', blockedAt: now() });
        state.songs.filter(song => song.sessionId === session.id && song.status === 'queued').forEach(song => { song.status = 'removed'; song.endedAt = now(); });
        delete state.sessions[sessionKey];
      });
      return sendJson(res, 200, adminState());
    }
    const blockedGuestMatch = pathname.match(/^\/api\/admin\/guests\/blocked\/([^/]+)$/);
    if (method === 'DELETE' && blockedGuestMatch) {
      const blockedId = blockedGuestMatch[1];
      if (!state.blockedGuests.some(block => block.id === blockedId)) return sendError(res, 404, '黑名单记录不存在', 'BLOCKED_GUEST_NOT_FOUND');
      mutate(() => { state.blockedGuests = state.blockedGuests.filter(block => block.id !== blockedId); });
      return sendJson(res, 200, adminState());
    }
    const adminQueueMatch = pathname.match(/^\/api\/admin\/queue\/([^/]+)$/);
    if (method === 'DELETE' && adminQueueMatch) {
      const song = state.songs.find(item => item.id === adminQueueMatch[1]);
      if (!song || song.status !== 'queued') return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
      mutate(() => { song.status = 'removed'; song.endedAt = now(); });
      return sendJson(res, 200, adminState());
    }
    if (method === 'PATCH' && adminQueueMatch) {
      const song = state.songs.find(item => item.id === adminQueueMatch[1]);
      if (!song || song.status !== 'queued') return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
      const body = await readBody(req);
      mutate(() => {
        if (body.action === 'pin') song.isPinned = true;
        if (body.action === 'unpin') song.isPinned = false;
        if (body.action === 'move') song.queuePosition = Number(body.position) || 0;
      });
      return sendJson(res, 200, adminState());
    }
    if (method === 'PATCH' && pathname === '/api/admin/queue') {
      const body = await readBody(req);
      const order = Array.isArray(body.order) ? body.order : [];
      mutate(() => order.forEach((songId, index) => { const song = state.songs.find(item => item.id === songId && item.status === 'queued'); if (song) song.queuePosition = index; }));
      return sendJson(res, 200, adminState());
    }
    if (method === 'POST' && pathname === '/api/admin/playback') {
      const body = await readBody(req);
      mutate(() => {
        if (body.action === 'pause' && currentSong()) state.playback.status = 'paused';
        else if (body.action === 'resume' && currentSong() && !state.importantBroadcast) state.playback.status = 'playing';
        else if (body.action === 'skip') {
          // 没有 current 时，队首可能正卡在 preparing：切歌要能跳过它，否则队列走不动。
          if (!currentSong()) skipPreparingHead();
          finishCurrent('skipped');
        }
        else if (body.action === 'stop') {
          state.songs.filter(song => song.status === 'playing').forEach(song => { song.status = 'skipped'; song.endedAt = now(); });
          state.playback.currentRequestId = null;
          state.playback.status = 'idle';
        }
        else if (body.action === 'volume') state.playback.volume = clamp(Number(body.volume) || 0, 0, 100);
        // 人声强度（0–100）。只对本地曲目有意义：YouTube 音轨是混好的，拆不开。
        // 存在 playback 里是为了让大屏跟着 DJ 的控制走（SSE 广播）。
        else if (body.action === 'vocal') {
          const next = clamp(Number(body.vocalLevel) || 0, 0, 100);
          if (next !== state.playback.vocalLevel) console.log(`[vocal] 控制台写入 ${state.playback.vocalLevel} → ${next}`);
          state.playback.vocalLevel = next;
        }
      });
      return sendJson(res, 200, adminState());
    }
    // 取消后台制作：仅 DJ。用户侧删队列项不会停任务（见 /api/queue/:id）。
    const prepareCancelMatch = pathname.match(/^\/api\/admin\/prepare\/([^/]+)$/);
    if (method === 'DELETE' && prepareCancelMatch) {
      const result = prepareQueue.cancel(decodeURIComponent(prepareCancelMatch[1]));
      if (!result.ok && result.reason === 'not-found') return sendError(res, 404, '没有这个制作任务', 'JOB_NOT_FOUND');
      syncPrepareState();
      return sendJson(res, 200, adminState());
    }
    if (method === 'POST' && pathname === '/api/admin/new-session') {
      mutate(() => resetLiveSession());
      return sendJson(res, 200, adminState());
    }
    if (method === 'PATCH' && pathname === '/api/admin/settings') {
      const body = await readBody(req);
      if (body.publicUrl !== undefined) {
        const publicUrl = String(body.publicUrl).trim().replace(/\/+$/, '');
        if (publicUrl) {
          try {
            const parsed = new URL(publicUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
          } catch {
            return sendError(res, 400, '公网地址必须是有效的 http 或 https 地址', 'INVALID_PUBLIC_URL');
          }
        }
      }
      mutate(() => {
        if (body.roomName !== undefined) state.settings.roomName = String(body.roomName).trim().slice(0, 50) || state.settings.roomName;
        if (body.maxQueuedSongsPerGuest !== undefined) state.settings.maxQueuedSongsPerGuest = clamp(Number(body.maxQueuedSongsPerGuest) || 1, 1, 10);
        if (body.allowDuplicatePerSession !== undefined) state.settings.allowDuplicatePerSession = Boolean(body.allowDuplicatePerSession);
        if (body.allowDuplicateVideo !== undefined) state.settings.allowDuplicateVideo = Boolean(body.allowDuplicateVideo);
        if (body.onlyKaraokeSongs !== undefined) state.settings.onlyKaraokeSongs = Boolean(body.onlyKaraokeSongs);
        if (body.blacklistKeywords !== undefined) state.settings.blacklistKeywords = normalizeBlacklistKeywords(body.blacklistKeywords);
        if (body.guestInactivityMinutes !== undefined) state.settings.guestInactivityMinutes = clamp(Number(body.guestInactivityMinutes) || 60, 5, 10080);
        if (body.broadcastDuration !== undefined) state.settings.broadcastDuration = clamp(Number(body.broadcastDuration) || 8, 3, 30);
        if (body.broadcastInterval !== undefined) state.settings.broadcastInterval = clamp(Number(body.broadcastInterval) || 0, 0, 60);
        if (body.drinkDuration !== undefined) state.settings.drinkDuration = clamp(Number(body.drinkDuration) || 8, 3, 120);
        if (body.drinkInterval !== undefined) state.settings.drinkInterval = clamp(Number(body.drinkInterval) || 0, 0, 60);
        if (body.publicUrl !== undefined) {
          const nextPublicUrl = String(body.publicUrl).trim().replace(/\/+$/, '');
          // 快速隧道的地址是临时的，不要因为 DJ 点了保存就把它固化进配置。
          if (!(tunnelUrl && nextPublicUrl === tunnelUrl)) state.settings.publicUrl = nextPublicUrl;
        }
        if (body.interfaceLanguage !== undefined && ['zh', 'en', 'de'].includes(body.interfaceLanguage)) state.settings.interfaceLanguage = body.interfaceLanguage;
        if (body.interfaceTheme !== undefined && ['system', 'day', 'night'].includes(body.interfaceTheme)) state.settings.interfaceTheme = body.interfaceTheme;
        if (body.playbackMode !== undefined) state.settings.playbackMode = body.playbackMode === 'lyrics' ? 'lyrics' : 'video';
        // 音源模式（sourceMode）不在这里改：这个构建固定走本地曲库（见 lib/mode.js 的 MODE），
        // 换模式要开另一个工程的启动器。这里故意忽略 body.sourceMode。
        // 歌词显示方式：逐字（有 QRC 数据时才真正逐字）/ 逐行
        if (body.lyricsWordLevel !== undefined) state.settings.lyricsWordLevel = Boolean(body.lyricsWordLevel);
        // 视频模式下是否叠歌词
        if (body.videoShowLyrics !== undefined) state.settings.videoShowLyrics = Boolean(body.videoShowLyrics);
        // 歌词翻译开关
        if (body.showTranslation !== undefined) state.settings.showTranslation = Boolean(body.showTranslation);
      });
      return sendJson(res, 200, adminState());
    }
    if (method === 'POST' && pathname === '/api/admin/broadcast') {
      const body = await readBody(req);
      const message = String(body.message || '').trim().slice(0, 100);
      if (!message) return sendError(res, 400, '广播内容不能为空', 'EMPTY_BROADCAST');
      const durationSeconds = clamp(Number(body.durationSeconds) || state.settings.broadcastDuration, 3, 30);
      mutate(() => {
        state.broadcasts.push({ id: id('broadcast'), roomId: 'main', message, durationSeconds, createdAt: now(), expiresAt: null });
        if (state.broadcasts.length > 30) state.broadcasts.splice(0, state.broadcasts.length - 30);
      });
      return sendJson(res, 201, adminState());
    }
    const broadcastMatch = pathname.match(/^\/api\/admin\/broadcast\/([^/]+)$/);
    if (method === 'DELETE' && broadcastMatch) {
      const broadcastId = broadcastMatch[1];
      if (!state.broadcasts.some(item => item.id === broadcastId)) return sendError(res, 404, '广播不存在', 'BROADCAST_NOT_FOUND');
      mutate(() => { state.broadcasts = state.broadcasts.filter(item => item.id !== broadcastId); });
      return sendJson(res, 200, adminState());
    }
    if (method === 'PATCH' && pathname === '/api/admin/drinks') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
      mutate(() => {
        state.settings.drinks = items.map((item, index) => ({
          id: item.id || id(`drink_${index}`),
          name: String(item.name || '').trim().slice(0, 40),
          price: String(item.price || '').trim().slice(0, 20)
        })).filter(item => item.name);
      });
      return sendJson(res, 200, adminState());
    }
    if (method === 'POST' && pathname === '/api/admin/animation') {
      const body = await readBody(req);
      const type = String(body.type || '');
      if (!ANIMATION_TYPES.includes(type)) return sendError(res, 400, '不支持的动画', 'BAD_ANIMATION');
      mutate(() => { state.animation = { id: id('anim'), type, startedAt: now(), durationMs: 7000 }; });
      return sendJson(res, 200, adminState());
    }
    if (method === 'POST' && pathname === '/api/admin/important-broadcast') {
      const body = await readBody(req);
      const message = String(body.message || '').trim().slice(0, 120) || 'DJ 正在广播中';
      if (body.action === 'start') {
        startImportantBroadcast(message);
        return sendJson(res, 200, adminState());
      }
      if (body.action === 'stop') {
        stopImportantBroadcast();
        return sendJson(res, 200, adminState());
      }
      return sendError(res, 400, '重要广播操作无效', 'INVALID_IMPORTANT_ACTION');
    }
  }
  return sendError(res, 404, '未找到接口', 'NOT_FOUND');
}

function origin(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}`;
}

function lanOrigin() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      candidates.push(item.address);
    }
  }
  const preferred = candidates.find(address => address.startsWith('192.168.'))
    || candidates.find(address => address.startsWith('10.'))
    || candidates.find(address => /^172\.(1[6-9]|2\d|3[01])\./.test(address))
    || candidates[0];
  return preferred ? `http://${preferred}:${PORT}` : '';
}

function publicOrigin(req) {
  const explicit = currentPublicUrl();
  if (explicit) return explicit;
  const host = String(req.headers.host || '');
  // 从局域网设备访问时，用它实际访问的地址；大屏在 localhost 打开时用探测到的 LAN 地址，二维码才扫得动。
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return origin(req);
  return lanOrigin() || origin(req);
}

// 本地曲库媒体（模式 B 用）：把项目根 assets/ 下的音频与歌词暴露出来。
// 单独走这里而不是 serveStatic，因为要支持 Range（音频拖动必须）。
// 模式 B：音频与封面在项目根 assets/
// 本项目里 server.js 就在根目录，public/ 的上一级即根。
const MEDIA_ROOT = process.env.MEDIA_ROOT
  ? path.resolve(process.env.MEDIA_ROOT)
  : path.resolve(PUBLIC_DIR, '..', 'assets');

function serveMedia(req, res, url) {
  let rel = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  // 只允许这三棵子树
  if (!/^(output|lyrics|covers)\//.test(rel)) return sendError(res, 404, '资源不存在', 'NOT_FOUND');
  const filePath = path.resolve(MEDIA_ROOT, rel);
  if (!filePath.startsWith(MEDIA_ROOT + path.sep)) return sendError(res, 400, '非法路径', 'BAD_PATH');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, '资源不存在', 'NOT_FOUND');

  const ext = path.extname(filePath).toLowerCase();
  const types = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.lrc': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
  const total = fs.statSync(filePath).size;
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'public, max-age=3600',
      });
      // HEAD 只要头，不要体（视频探测/预检走 HEAD）
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  // /library = 曲库管理独立页面（与 /admin 共用同一份 index.html + app.js，靠 pathname 分派）
  if (pathname === '/' || pathname === '/join' || pathname === '/admin' || pathname === '/display' || pathname === '/library') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, '页面不存在', 'PAGE_NOT_FOUND');
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

// 进程退出时收掉后台制作子进程，别留下孤儿 Demucs 吃显存。
// 注意：**不要**注册 SIGINT/SIGTERM listener —— 那会阻止 Node 默认退出，
// 导致测试（同一进程里 start()/close()）和启动脚本里进程不结束。
// 进程被强杀时子进程会跟着死，下次启动的恢复逻辑负责把它接回来续跑。
process.on('exit', () => { try { prepareQueue.stop(); } catch { /* ignore */ } });

const server = http.createServer(async (req, res) => {  try {
    const url = new URL(req.url, origin(req));
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.pathname === '/events') return await handleApi(req, res, url);
    if (url.pathname.startsWith('/media/')) return serveMedia(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, error.message || '服务器错误', 'SERVER_ERROR');
  }
});

function start() {
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n[错误] 端口 ${PORT} 已被占用。`);
      console.error('控制台里的服务可能正在运行，先关闭它再测试；或者换一个端口：');
      console.error(`  PowerShell: $env:PORT=3100; npm start\n`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT, HOST, () => {
    console.log(`LAN Karaoke Console running at http://localhost:${PORT}`);
    console.log(`DJ password: ${ADMIN_PASSWORD === 'karaok-admin' ? 'karaok-admin (default)' : '(from DJ_PASSWORD)'}`);
  });
  restorePrepareJobs();
  return server;
}

/**
 * 启动时恢复后台制作任务：
 * 1) 读 data/prepare-jobs.json，把未完成的任务重新排进队列继续跑（最多并发 3 首）；
 * 2) 队列里 status=preparing 但任务已丢失（比如手动删了任务文件）的项，
 *    如果曲库其实已经 ready 就放行，否则重新入队。
 */
function restorePrepareJobs() {
  const { restored } = prepareQueue.load();
  let requeued = 0;
  for (const song of state.songs) {
    if (song.source !== 'local' || song.status !== 'preparing' || !song.spotifyId) continue;
    if (prepareQueue.getStatus(song.spotifyId)) continue;
    const track = libraryDb.getTrack(song.spotifyId);
    if (track && track.ready) {
      song.status = 'queued';
      song.progress = null;
      continue;
    }
    prepareQueue.enqueue({ spotifyId: song.spotifyId, title: song.title, songId: song.id });
    requeued += 1;
  }
  // 丢了队列项、但任务还在跑（用户已删歌）的情况：任务继续，不需要额外处理
  if (restored || requeued) console.log(`[prepare] 恢复后台任务：jobs=${restored} requeued=${requeued}`);
  else if (prepareQueue.pending.length) console.log(`[prepare] 待执行任务 ${prepareQueue.pending.length} 个`);
  schedulePrepareSync();
}

if (require.main === module) start();

module.exports = { start, server };

