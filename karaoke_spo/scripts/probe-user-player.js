'use strict';
/**
 * 用户级端点探针（只读为主）。
 *
 * 请求：
 *   GET  /v1/me
 *   GET  /v1/me/player
 *   GET  /v1/me/player/currently-playing
 *   GET  /v1/me/player/devices
 *   PUT  /v1/me/player/pause       (只发一次)
 *   GET  /v1/me/player/recently-played?limit=1
 *
 * token 过期时用 refresh_token 刷新，并原子写回 data/spotify-token.json。
 * 无 token 时不伪造、不降级 client_credentials，只报告"未授权"。
 *
 * 用法: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-user-player.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'data', 'spotify-token.json');
const ENV_FILE = path.join(ROOT, '.env');
const LOG_DIR = path.join(ROOT, 'logs');
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const BODY_CHARS = 500;

function loadEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return { ...process.env };
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { ...process.env, ...out };
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

async function refreshToken(env, current) {
  const basic = Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, BODY_CHARS) }; }
  const meta = { status: res.status, ok: res.ok, error: json.error || null, errorDescription: json.error_description || null };
  if (!res.ok) return { meta, token: null };
  const token = {
    ...current,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || current.refreshToken,
    scope: json.scope || current.scope,
    expiresAt: Date.now() + ((json.expires_in || 3600) - 60) * 1000,
  };
  atomicWrite(TOKEN_FILE, token);
  return { meta, token };
}

const ENDPOINTS = [
  { id: 'me', method: 'GET', path: '/me', note: '用户档案（关注 product 字段）' },
  { id: 'player', method: 'GET', path: '/me/player', note: '当前播放状态' },
  { id: 'currently-playing', method: 'GET', path: '/me/player/currently-playing', note: '当前曲目' },
  { id: 'devices', method: 'GET', path: '/me/player/devices', note: '可用设备' },
  { id: 'pause', method: 'PUT', path: '/me/player/pause', note: '暂停（仅发一次）', write: true },
  { id: 'recently-played', method: 'GET', path: '/me/player/recently-played?limit=1', note: '最近播放' },
];

(async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const env = loadEnv();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    at: new Date().toISOString(),
    tokenFile: TOKEN_FILE,
    node: process.version,
    tokenPresent: fs.existsSync(TOKEN_FILE),
    refresh: null,
    results: [],
    summary: {},
  };

  let token = readToken();
  if (!token) {
    report.status = 'NO_USER_TOKEN';
    const out = path.join(LOG_DIR, `probe-user-player-${ts}.json`);
    atomicWrite(out, report);
    console.log('TOKEN: ABSENT -> 未完成用户授权，无法验证用户级端点（不伪造 token）。');
    console.log('先访问 http://127.0.0.1:3000/api/spotify/login 取授权链接并在浏览器完成授权。');
    console.log(`report -> ${out}`);
    return;
  }

  report.scope = token.scope || null;
  report.expiresAt = token.expiresAt ? new Date(token.expiresAt).toISOString() : null;
  report.expiredOnEntry = token.expiresAt ? Date.now() >= token.expiresAt : null;

  if (token.expiresAt && Date.now() >= token.expiresAt) {
    if (!token.refreshToken) {
      report.status = 'EXPIRED_NO_REFRESH_TOKEN';
      const out = path.join(LOG_DIR, `probe-user-player-${ts}.json`);
      atomicWrite(out, report);
      console.log('TOKEN: 已过期且无 refresh_token，需要重新授权。');
      console.log(`report -> ${out}`);
      return;
    }
    const r = await refreshToken(env, token);
    report.refresh = r.meta;
    if (!r.token) {
      report.status = 'REFRESH_FAILED';
      const out = path.join(LOG_DIR, `probe-user-player-${ts}.json`);
      atomicWrite(out, report);
      console.log(`REFRESH FAILED status=${r.meta.status} error=${r.meta.error}`);
      console.log(`report -> ${out}`);
      return;
    }
    token = r.token;
    report.expiresAt = new Date(token.expiresAt).toISOString();
  }
  report.status = 'OK';

  for (const ep of ENDPOINTS) {
    const started = Date.now();
    const rec = { id: ep.id, method: ep.method, url: `${API}${ep.path}`, note: ep.note, isWrite: Boolean(ep.write) };
    try {
      const res = await fetch(`${API}${ep.path}`, {
        method: ep.method,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          ...(ep.write ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(ep.write ? { body: '{}' } : {}),
      });
      const text = await res.text();
      rec.status = res.status;
      rec.statusText = res.statusText;
      rec.contentType = res.headers.get('content-type');
      rec.bodyLength = text.length;
      rec.bodyPreview = text.slice(0, BODY_CHARS);
      rec.ms = Date.now() - started;
      if (text) {
        try { rec.bodyJson = JSON.parse(text); } catch { rec.bodyJson = null; }
      }
      if (res.headers.get('retry-after')) rec.retryAfter = res.headers.get('retry-after');
    } catch (e) {
      rec.error = e.message;
      rec.ms = Date.now() - started;
    }
    report.results.push(rec);

    if (rec.id === 'me' && rec.bodyJson) {
      report.meProduct = rec.bodyJson.product ?? null;
      report.meDisplayName = rec.bodyJson.display_name ?? null;
      report.meCountry = rec.bodyJson.country ?? null;
      if (rec.status === 200 && report.meProduct) {
        report.premiumNote = report.meProduct === 'premium'
          ? 'product=premium(满足 SDK 播放要求)'
          : `product=${report.meProduct} -> 不满足 SDK 播放所需的 premium`;
      }
    }
  }

  const codes = {};
  for (const r of report.results) codes[r.id] = r.status ?? r.error;
  report.summary = codes;

  const out = path.join(LOG_DIR, `probe-user-player-${ts}.json`);
  atomicWrite(out, report);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('endpoint', 34)}${pad('method', 8)}${pad('status', 8)}${pad('ms', 7)}body`);
  console.log('-'.repeat(110));
  for (const r of report.results) {
    const brief = (r.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${pad(r.url.replace(API, ''), 34)}${pad(r.method, 8)}${pad(r.status ?? 'ERR', 8)}${pad(r.ms, 7)}${brief}`);
  }
  console.log(`\nscope=${report.scope}`);
  console.log(`expiresAt=${report.expiresAt}  refresh=${report.refresh ? JSON.stringify(report.refresh) : 'not needed'}`);
  if (report.meProduct !== undefined) console.log(`/me product=${report.meProduct}  ${report.premiumNote || ''}`);
  console.log(`\nreport -> ${out}`);
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });
