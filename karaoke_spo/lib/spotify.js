'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'data', 'spotify-token.json');
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

/** 内存中的 PKCE 握手（单用户实验台，够用） */
const pending = new Map();

// 加载 .env：Node 20.12+ 内置，不引入 dotenv 依赖。
// 只在进程启动时读一次；已存在的真实环境变量优先（不覆盖）。
let envLoaded = false;
function loadEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile) || typeof process.loadEnvFile !== 'function') return;
  try {
    // 先记下真实环境变量，loadEnvFile 会覆盖它们，需要还原
    const protect = {};
    for (const key of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI']) {
      if (process.env[key] !== undefined) protect[key] = process.env[key];
    }
    process.loadEnvFile(envFile);
    Object.assign(process.env, protect);
  } catch {
    /* .env 格式有问题就忽略，按未配置处理 */
  }
}
loadEnvOnce();

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(t) {
  atomicWrite(TOKEN_FILE, t);
}

function credentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret && redirectUri) };
}

function basicAuth() {
  const { clientId, clientSecret } = credentials();
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** Client Credentials：只能访问非用户数据端点（搜索足够） */
async function clientCredentialsToken() {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`client_credentials 失败 ${res.status}: ${json.error_description || json.error}`);
  return { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 PKCE 授权链接；state 与 verifier 暂存内存 */
function buildAuthUrl() {
  const { clientId, redirectUri, configured } = credentials();
  if (!configured) throw new Error('Spotify 未配置（检查 .env）');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));
  pending.set(state, { verifier, createdAt: Date.now() });
  // 清理超过 10 分钟的握手
  for (const [k, v] of pending) if (Date.now() - v.createdAt > 600000) pending.delete(k);

  const url = new URL(`${ACCOUNTS}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  return url.toString();
}

async function exchangeCode(code, state) {
  const entry = pending.get(state);
  if (!entry) throw new Error('未知或过期的 state');
  pending.delete(state);
  const { clientId, clientSecret, redirectUri } = credentials();
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: entry.verifier,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`换取 token 失败 ${res.status}: ${json.error_description || json.error}`);
  const token = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    scope: json.scope || '',
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    obtainedAt: new Date().toISOString(),
  };
  saveToken(token);
  return token;
}

async function refresh() {
  const current = readToken();
  if (!current || !current.refreshToken) throw new Error('没有 refresh_token，需要重新授权');
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`刷新 token 失败 ${res.status}: ${json.error_description || json.error}`);
  const token = {
    ...current,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || current.refreshToken,
    scope: json.scope || current.scope,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  saveToken(token);
  return token;
}

/** 返回可用的用户 token（必要时自动刷新） */
async function userToken() {
  const current = readToken();
  if (!current) return null;
  // 只有 refreshToken 的 token（从控制面板导入）expiresAt 为 0，走 refresh 换取 accessToken
  if (current.expiresAt && Date.now() < current.expiresAt) return current;
  return refresh();
}

/**
 * 应用控制面板推来的运行时配置。
 *
 * 优先级：控制面板（config\config.json）> .env > 默认空。
 * 这样发布时把凭证从 .env 里删掉、只留在面板配置里，也不会丢功能。
 */
function applyRuntimeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return status();
  const mapping = {
    SPOTIFY_CLIENT_ID: cfg.clientId,
    SPOTIFY_CLIENT_SECRET: cfg.clientSecret,
    SPOTIFY_REDIRECT_URI: cfg.redirectUri,
  };
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value === 'string' && value.trim()) process.env[key] = value.trim();
  }
  const refreshToken = typeof cfg.refreshToken === 'string' ? cfg.refreshToken.trim() : '';
  if (refreshToken) {
    const current = readToken();
    // 面板里的授权和本地文件不一致时才覆盖，避免每次同步都重写文件
    if (!current || current.refreshToken !== refreshToken) {
      saveToken({
        accessToken: null,
        refreshToken,
        scope: typeof cfg.scope === 'string' ? cfg.scope : '',
        expiresAt: 0,
        obtainedAt: new Date().toISOString(),
      });
    }
  }
  return status();
}

/** 导出授权状态，供控制面板存进 config.json（发布时脱敏用） */
function exportToken() {
  const token = readToken();
  return {
    refreshToken: (token && token.refreshToken) || '',
    scope: (token && token.scope) || '',
  };
}

/** 清除本机授权（面板点「退出账号」时用） */
function clearToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* 文件不存在就算了 */ }
  return status();
}

/**
 * 全局串行限速：所有 Spotify Web API 调用排队执行，且互相间隔 ≥ MIN_INTERVAL_MS。
 * 目的：严格避免高并发，避免触发 Dev Mode 的 per-bucket 配额（429 QUOTA_EXCEEDED）。
 */
const MIN_INTERVAL_MS = Number(process.env.SPOTIFY_MIN_INTERVAL_MS || 400);
let lastCallAt = 0;
let chain = Promise.resolve();

function rateLimited(fn) {
  const run = chain.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // 让后续任务排队；错误不阻断队列
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function apiGet(pathname, token) {
  return rateLimited(async () => {
    const res = await fetch(`${API}${pathname}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0) || 2;
      // 只做一次退避重试，且退避时间遵从服务端
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      lastCallAt = Date.now();
      const retry = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
      const retryText = await retry.text();
      let retryBody = null;
      try { retryBody = retryText ? JSON.parse(retryText) : null; } catch { retryBody = { raw: retryText }; }
      return { status: retry.status, body: retryBody, rateLimited: true };
    }
    return { status: res.status, body, rateLimited: false };
  });
}

function normalizeTrack(t) {
  if (!t) return null;
  const images = (t.album && t.album.images) || [];
  // Spotify 返回的 images 已按尺寸降序；仍显式挑最大的，防御异常顺序
  const best = images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0] || null;
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    artistIds: (t.artists || []).map((a) => a.id).filter(Boolean),
    album: t.album ? t.album.name : null,
    albumId: t.album ? t.album.id : null,
    albumReleaseDate: t.album ? t.album.release_date || null : null,
    albumType: t.album ? t.album.album_type || null : null,
    coverUrl: best ? best.url : null,
    coverWidth: best ? best.width || null : null,
    coverHeight: best ? best.height || null : null,
    coverUrlSmall: images.length ? images[images.length - 1].url : null,
    durationMs: t.duration_ms,
    trackNumber: t.track_number || null,
    discNumber: t.disc_number || null,
    explicit: Boolean(t.explicit),
    popularity: typeof t.popularity === 'number' ? t.popularity : null,
    uri: t.uri,
    externalUrl: t.external_urls ? t.external_urls.spotify : null,
    previewUrl: t.preview_url || null,
    isPlayable: t.is_playable !== false,
  };
}

/** 按 ID 取单曲完整元数据（封面/专辑/时长等） */
async function getTrack(trackId) {
  const id = String(trackId || '').trim();
  if (!/^[A-Za-z0-9]{22}$/.test(id)) {
    const err = new Error('trackId 不合法');
    err.status = 400;
    throw err;
  }
  let token = await userToken();
  if (!token) token = await clientCredentialsToken();
  const { status, body } = await apiGet(`/tracks/${id}`, token);
  if (status !== 200) {
    const err = new Error(`取单曲失败 ${status}`);
    err.status = status;
    throw err;
  }
  return normalizeTrack(body);
}

/** 批量取多首（Spotify 上限 50/次），保持输入顺序，缺失的返回 null */
async function getTracks(trackIds) {
  const ids = (trackIds || []).map((x) => String(x || '').trim()).filter((x) => /^[A-Za-z0-9]{22}$/.test(x));
  if (!ids.length) return [];
  let token = await userToken();
  if (!token) token = await clientCredentialsToken();
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { status, body } = await apiGet(`/tracks?ids=${chunk.join(',')}`, token);
    if (status !== 200 || !body || !Array.isArray(body.tracks)) continue;
    for (const t of body.tracks) out.push(normalizeTrack(t));
  }
  return out;
}

async function search(q, limit = 10) {
  // 2026 Dev Mode：/search 的 limit 上限被降到 10，超过会被拒绝，这里强制收敛
  const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 10);
  let token = await userToken();
  if (!token) token = await clientCredentialsToken();
  const { status, body } = await apiGet(`/search?q=${encodeURIComponent(q)}&type=track&limit=${safeLimit}`, token);
  if (status !== 200) {
    const err = new Error(`搜索失败 ${status}: ${body && body.error ? body.error.message : 'unknown'}`);
    err.status = status;
    err.body = body;
    throw err;
  }
  return {
    query: q,
    tracks: (body.tracks ? body.tracks.items : []).map(normalizeTrack).filter(Boolean),
  };
}

async function player() {
  const token = await userToken();
  if (!token) {
    const e = new Error('尚未完成用户授权（/api/spotify/login）');
    e.status = 401;
    throw e;
  }
  const { status, body } = await apiGet('/me/player', token);
  if (status === 204) return { active: false };
  if (status !== 200) {
    const e = new Error(`读取播放状态失败 ${status}`);
    e.status = status;
    e.body = body;
    throw e;
  }
  return {
    active: true,
    isPlaying: body.is_playing,
    progressMs: body.progress_ms,
    device: body.device ? body.device.name : null,
    track: normalizeTrack(body.item),
    shuffle: body.shuffle_state,
    repeat: body.repeat_state,
  };
}

async function transfer(deviceId, play = false) {
  const token = await userToken();
  if (!token) throw new Error('尚未完成用户授权');
  const status = await rateLimited(async () => {
    const res = await fetch(`${API}/me/player`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [deviceId], play }),
    });
    return res.status;
  });
  if (status !== 204 && status !== 200) throw new Error(`转移播放失败 ${status}`);
}

function status() {
  const { configured } = credentials();
  const token = readToken();
  // 有 accessToken 且没过期才算「当前可用」；只有 refreshToken 时靠 refresh() 现换。
  const hasAccess = Boolean(token && token.expiresAt && token.expiresAt > Date.now());
  return {
    configured,
    authorized: Boolean(token && token.refreshToken),
    hasAccess,
    refreshToken: Boolean(token && token.refreshToken),
    scope: token ? token.scope || '' : '',
    expiresAt: hasAccess ? new Date(token.expiresAt).toISOString() : null,
    expiresInSec: hasAccess ? Math.max(0, Math.round((token.expiresAt - Date.now()) / 1000)) : null,
  };
}

module.exports = {
  credentials,
  status,
  applyRuntimeConfig,
  exportToken,
  clearToken,
  buildAuthUrl,
  exchangeCode,
  userToken,
  refresh,
  search,
  getTrack,
  getTracks,
  normalizeTrack,
  player,
  transfer,
  clientCredentialsToken,
};
