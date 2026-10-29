const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

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
const API_VERSION = 7;
const DATA_DIR = path.join(__dirname, 'data');
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
      interfaceTheme: 'system'
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
state.settings.publicUrl ??= PUBLIC_URL;
state.settings.interfaceLanguage ??= 'zh';
state.settings.interfaceTheme ??= 'system';
// 本工程是模式 A（YouTube 在线）：音源固定 YouTube，播放画面固定 YouTube 视频。
// 旧 state.json 里可能残留 playbackMode / sourceMode（迁移期试装模式 B 时写进去的），
// 这里直接剔除，避免前端被错误的分支带偏（曾导致点歌台去请求本地曲库接口）。
delete state.settings.playbackMode;
delete state.settings.sourceMode;
state.settings.onlyKaraokeSongs ??= false;
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

function pendingSongs() {
  return state.songs
    .filter(song => song.status === 'queued')
    .sort((a, b) => Number(a.isPinned) - Number(b.isPinned) || a.queuePosition - b.queuePosition)
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.queuePosition - b.queuePosition);
}

function currentSong() {
  return state.songs.find(song => song.id === state.playback.currentRequestId) || null;
}

function normalizeQueue() {
  const queued = pendingSongs();
  queued.forEach((song, index) => { song.queuePosition = index; });
}

function publicState() {
  const current = currentSong();
  const broadcasts = state.broadcasts.slice(-20);
  return {
    settings: { ...state.settings, publicUrl: currentPublicUrl() },
    publicBase: currentPublicUrl() || lanOrigin(),
    apiVersion: API_VERSION,
    queue: pendingSongs().map(publicSong),
    current: current ? publicSong(current) : null,
    playback: { ...state.playback },
    broadcast: broadcasts[broadcasts.length - 1] || null,
    broadcasts,
    importantBroadcast: state.importantBroadcast,
    animation: state.animation,
    serverTime: now()
  };
}

function publicSong(song) {
  return {
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
    status: song.status
  };
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
  return { ...publicState(), users, blockedGuests, history: state.songs.slice(-20).reverse().map(publicSong) };
}

function broadcast(event = 'state') {
  const payload = `event: ${event}\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const client of sseClients) client.write(payload);
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
  const next = pendingSongs()[0];
  if (!next) {
    state.playback.currentRequestId = null;
    state.playback.status = 'idle';
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
      if (nextFixedUrl !== state.settings.publicUrl) {
        state.settings.publicUrl = nextFixedUrl;
        persist();
      }
      if (changed) broadcast();
      return sendJson(res, 200, { publicUrl: currentPublicUrl() });
    }
    return sendError(res, 404, '未找到接口', 'NOT_FOUND');
  }

  if (method === 'GET' && pathname === '/api/config') {
    issueBrowserCookie(req, res);
    return sendJson(res, 200, { roomName: state.settings.roomName, joinUrl: `${publicOrigin(req)}/join`, maxQueuedSongsPerGuest: state.settings.maxQueuedSongsPerGuest, onlyKaraokeSongs: state.settings.onlyKaraokeSongs, publicUrl: currentPublicUrl(), interfaceLanguage: state.settings.interfaceLanguage, interfaceTheme: state.settings.interfaceTheme });
  }
  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, publicState());

  if (method === 'GET' && pathname === '/api/my-queue') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '请先建立点歌会话', 'SESSION_REQUIRED');
    attachBrowserToSession(req, res, session);
    session.lastSeenAt = now();
    return sendJson(res, 200, { songs: pendingSongs().filter(song => song.sessionId === session.id).map(publicSong), session: { id: session.id, displayName: session.displayName } });
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
    const key = songKey({ source, videoId: body.videoId, spotifyId: body.spotifyId });
    if (!state.settings.allowDuplicatePerSession && state.songs.some(song => song.sessionId === session.id && songKey(song) === key && song.status === 'queued')) return sendError(res, 409, '你已经点过这首歌', 'DUPLICATE_SESSION_SONG');
    if (!state.settings.allowDuplicateVideo && state.songs.some(song => songKey(song) === key && song.status === 'queued')) return sendError(res, 409, '这首歌已经在等待队列中', 'DUPLICATE_VIDEO');
    const song = {
      id: id('song'), roomId: 'main', source,
      videoId: source === 'youtube' ? String(body.videoId) : null,
      spotifyId: source === 'local' ? String(body.spotifyId) : null,
      title,
      channelTitle: String(body.channelTitle || (source === 'local' ? '本地曲库' : 'YouTube')).slice(0, 100),
      thumbnailUrl: String(body.thumbnailUrl || ''),
      duration: String(body.duration || '—'), sessionId: session.id, singerNameSnapshot: session.displayName,
      status: 'queued', isPinned: false, queuePosition: state.songs.length, createdAt: now()
    };
    mutate(() => {
      state.songs.push(song);
      session.lastSongAt = now();
      // 队列空着时，第一首歌必须直接开播（即使之前是暂停/停止状态）。
      if (!currentSong() && !state.importantBroadcast) startNext();
    });
    return sendJson(res, 201, { song: publicSong(song), state: publicState() });
  }
  if (method === 'PATCH' && pathname === '/api/queue/order') {
    const session = getSession(req);
    if (!session) return sendError(res, 401, '请先建立点歌会话', 'SESSION_REQUIRED');
    const body = await readBody(req);
    const first = state.songs.find(item => item.id === body.firstId && item.status === 'queued');
    const second = state.songs.find(item => item.id === body.secondId && item.status === 'queued');
    if (!first || !second) return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
    if (first.sessionId !== session.id || second.sessionId !== session.id) return sendError(res, 403, '只能调整自己点的歌', 'NOT_YOUR_SONG');
    if (first.id !== second.id) {
      mutate(() => {
        const position = first.queuePosition;
        first.queuePosition = second.queuePosition;
        second.queuePosition = position;
      });
    }
    return sendJson(res, 200, publicState());
  }
  const queueMatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (method === 'DELETE' && queueMatch) {
    const session = getSession(req);
    const song = state.songs.find(item => item.id === queueMatch[1]);
    if (!song || song.status !== 'queued') return sendError(res, 404, '歌曲不在等待队列中', 'SONG_NOT_QUEUED');
    if (!isAdmin(req) && (!session || song.sessionId !== session.id)) return sendError(res, 403, '只能删除自己的等待歌曲', 'NOT_YOUR_SONG');
    mutate(() => { song.status = 'removed'; song.endedAt = now(); });
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
        else if (body.action === 'skip') finishCurrent('skipped');
        else if (body.action === 'stop') {
          state.songs.filter(song => song.status === 'playing').forEach(song => { song.status = 'skipped'; song.endedAt = now(); });
          state.playback.currentRequestId = null;
          state.playback.status = 'idle';
        }
        else if (body.action === 'volume') state.playback.volume = clamp(Number(body.volume) || 0, 0, 100);
      });
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
const MEDIA_ROOT = path.resolve(PUBLIC_DIR, '..', '..', 'assets');

function serveMedia(req, res, url) {
  let rel = decodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  // 只允许这三棵子树
  if (!/^(output|lyrics|covers)\//.test(rel)) return sendError(res, 404, '资源不存在', 'NOT_FOUND');
  const filePath = path.resolve(MEDIA_ROOT, rel);
  if (!filePath.startsWith(MEDIA_ROOT + path.sep)) return sendError(res, 400, '非法路径', 'BAD_PATH');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, '资源不存在', 'NOT_FOUND');

  const ext = path.extname(filePath).toLowerCase();
  const types = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.lrc': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
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
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  });
  return fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === '/' || pathname === '/join' || pathname === '/admin' || pathname === '/display') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, '页面不存在');
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
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
  return server;
}

if (require.main === module) start();

module.exports = { start, server };

