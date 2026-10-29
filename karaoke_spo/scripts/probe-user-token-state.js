'use strict';
/**
 * 只读探针：检查是否已有用户 token（data/spotify-token.json）。
 * 存在则打印 scope / expiresAt（不打印 token 全文）并提示可用 probe-user-player.js；
 * 不存在则调用本机 /api/spotify/login 取授权链接并原样打印。
 *
 * 用法: node scripts/probe-user-token-state.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'data', 'spotify-token.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOCAL = 'http://127.0.0.1:3000';

function redact(t) {
  if (typeof t !== 'string' || t.length < 12) return '<absent>';
  return `${t.slice(0, 4)}...${t.slice(-4)} (len=${t.length})`;
}

(async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { at: new Date().toISOString(), tokenFile: TOKEN_FILE, tokenExists: false };

  if (fs.existsSync(TOKEN_FILE)) {
    report.tokenExists = true;
    let token = null;
    try {
      token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      report.parseOk = true;
    } catch (e) {
      report.parseOk = false;
      report.parseError = e.message;
    }
    if (token) {
      report.hasAccessToken = Boolean(token.accessToken);
      report.accessTokenPreview = redact(token.accessToken);
      report.hasRefreshToken = Boolean(token.refreshToken);
      report.refreshTokenPreview = redact(token.refreshToken);
      report.scope = token.scope || null;
      report.expiresAt = token.expiresAt ? new Date(token.expiresAt).toISOString() : null;
      report.expiresInSec = token.expiresAt ? Math.round((token.expiresAt - Date.now()) / 1000) : null;
      report.expired = token.expiresAt ? Date.now() >= token.expiresAt : null;
      report.obtainedAt = token.obtainedAt || null;
    }
  }

  // 本机服务状态（交叉验证 server.js 读到的同一份 token）
  try {
    const r = await fetch(`${LOCAL}/api/spotify/status`);
    report.localStatus = { status: r.status, body: await r.json() };
  } catch (e) {
    report.localStatus = { error: e.message };
  }

  // 无 token 时取授权链接
  if (!report.tokenExists) {
    try {
      const r = await fetch(`${LOCAL}/api/spotify/login`);
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
      report.login = { status: r.status, body };
    } catch (e) {
      report.login = { error: e.message };
    }
  }

  const out = path.join(LOG_DIR, `probe-user-token-state-${ts}.json`);
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(tmp, out);

  console.log(`token file: ${TOKEN_FILE}`);
  console.log(report.tokenExists ? 'TOKEN: EXISTS' : 'TOKEN: ABSENT (用户授权尚未完成)');
  if (report.tokenExists) {
    console.log(`  scope      : ${report.scope}`);
    console.log(`  expiresAt  : ${report.expiresAt}  (expired=${report.expired}, expiresInSec=${report.expiresInSec})`);
    console.log(`  refresh    : ${report.hasRefreshToken}`);
  }
  console.log(`local /api/spotify/status: ${report.localStatus.status} ${JSON.stringify(report.localStatus.body)}`);
  if (report.login) {
    console.log(`local /api/spotify/login   : ${report.login.status}`);
    console.log('AUTH URL:');
    console.log(report.login.body && report.login.body.url ? report.login.body.url : JSON.stringify(report.login.body));
  }
  console.log(`\nreport -> ${out}`);
})().catch((e) => {
  console.error('FATAL', e.stack || e.message);
  process.exit(1);
});
