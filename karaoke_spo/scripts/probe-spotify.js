/**
 * CP1 探针：用 Client Credentials 实际调用 Spotify Web API，确认当前 app 在
 * Development Mode 下到底能用哪些端点。输出原始状态码，不做任何推测。
 *
 * 用法: node scripts/probe-spotify.js
 * 结果写入 logs/probe-spotify-<ts>.json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function token() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('缺少 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function call(label, url, accessToken, method = 'GET') {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return {
      label,
      method,
      url,
      status: res.status,
      ms: Date.now() - started,
      ok: res.ok,
      error: parsed && parsed.error ? parsed.error : null,
      // 只保留结构信息，避免把大响应写进日志
      summary: summarize(label, parsed),
    };
  } catch (e) {
    return { label, method, url, status: 0, ms: Date.now() - started, ok: false, error: e.message };
  }
}

function summarize(label, json) {
  if (!json) return null;
  if (label === 'search') {
    return {
      tracksReturned: json.tracks && json.tracks.items ? json.tracks.items.length : null,
      firstTrack: json.tracks && json.tracks.items && json.tracks.items[0]
        ? {
            id: json.tracks.items[0].id,
            name: json.tracks.items[0].name,
            artists: (json.tracks.items[0].artists || []).map((a) => a.name),
            durationMs: json.tracks.items[0].duration_ms,
            hasPreview: Boolean(json.tracks.items[0].preview_url),
            externalUrl: json.tracks.items[0].external_urls && json.tracks.items[0].external_urls.spotify,
          }
        : null,
      total: json.tracks ? json.tracks.total : null,
    };
  }
  if (label === 'track') {
    return { id: json.id, name: json.name, durationMs: json.duration_ms, explicit: json.explicit };
  }
  return { keys: Object.keys(json).slice(0, 12) };
}

(async () => {
  loadEnv();
  const t = await token();
  const out = {
    at: new Date().toISOString(),
    token: {
      status: t.status,
      expiresIn: t.json.expires_in || null,
      scopes: t.json.scope || null,
      hasRefreshToken: Boolean(t.json.refresh_token),
      error: t.json.error || null,
      errorDescription: t.json.error_description || null,
    },
    calls: [],
  };

  if (t.status === 200) {
    const at = t.json.access_token;
    const search = await call('search', 'https://api.spotify.com/v1/search?q=Counting%20Stars&type=track&limit=3', at);
    out.calls.push(search);
    const trackId = search.summary && search.summary.firstTrack ? search.summary.firstTrack.id : null;
    if (trackId) {
      out.calls.push(await call('track', `https://api.spotify.com/v1/tracks/${trackId}`, at));
    }
    // 以下端点按文档需要用户授权，用 client_credentials 预期失败；这里用实测证明。
    out.calls.push(await call('me.player', 'https://api.spotify.com/v1/me/player', at));
    out.calls.push(await call('me.player.currently-playing', 'https://api.spotify.com/v1/me/player/currently-playing', at));
    if (trackId) {
      out.calls.push(await call('audio-features', `https://api.spotify.com/v1/audio-features/${trackId}`, at));
      out.calls.push(await call('recommendations', `https://api.spotify.com/v1/recommendations?seed_tracks=${trackId}&limit=2`, at));
    }
  }

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  const file = path.join(ROOT, 'logs', `probe-spotify-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

  console.log(`token: ${out.token.status} expires_in=${out.token.expiresIn} refresh=${out.token.hasRefreshToken}`);
  for (const c of out.calls) {
    const err = c.error ? ` error="${c.error.message || JSON.stringify(c.error)}" reason=${c.error.reason || '-'}` : '';
    console.log(`${c.status}\t${c.ms}ms\t${c.label}${err}`);
    if (c.summary) console.log(`\t${JSON.stringify(c.summary)}`);
  }
  console.log(`\nraw => ${file}`);
})().catch((e) => {
  console.error('PROBE FAILED:', e.message);
  process.exitCode = 1;
});
