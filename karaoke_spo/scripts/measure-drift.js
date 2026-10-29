'use strict';
/**
 * 播放进度测量：轮询 /me/player，记录真实进度与本地时钟，计算漂移。
 * 注意：这测的是 **Web API 轮询路径**，不是 Web Playback SDK 的 player_state_changed 事件频率
 * （后者必须在浏览器里由 SDK 触发，见 docs/test-records/phase-2-sync.md 的说明）。
 *
 * 用法: node scripts/measure-drift.js [秒数] [间隔ms]
 * 输出: docs/test-records/phase-2-player-drift.csv
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DURATION_S = Number(process.argv[2] || 60);
const INTERVAL_MS = Number(process.argv[3] || 1000);
const OUT = path.join(ROOT, 'docs', 'test-records', 'phase-2-player-drift.csv');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function token() {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'spotify-token.json'), 'utf8'));
  return t.access_token || t.accessToken;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  loadEnv();
  const at = await token();
  const rows = [];
  const started = Date.now();
  let anchor = null; // {positionMs, wallMs, playing}
  let last = null;

  console.log(`采样 ${DURATION_S}s，间隔 ${INTERVAL_MS}ms`);
  while (Date.now() - started < DURATION_S * 1000) {
    const wall = Date.now();
    const res = await fetch('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${at}` } });
    if (res.status === 204) {
      console.log('204：当前没有活动播放设备，停止采样');
      break;
    }
    const body = await res.json();
    const track = body.item;
    if (!track) break;
    const real = body.progress_ms;
    const playing = body.is_playing;

    // 纯本地插值：以上一次采样为锚点，用墙钟推进
    // 只有"前后同曲、且都在播放"才计算漂移：
    //  - 暂停↔恢复会改相位（如换设备、重复播放）
    //  - 换曲会重置进度
    //   这两种情况都不该被算作时钟漂移，否则会产生几十万毫秒的假异常值。
    const comparable = anchor && anchor.playing && playing && anchor.trackId === track.id;
    const predicted = anchor
      ? (anchor.playing ? anchor.positionMs + (wall - anchor.wallMs) : anchor.positionMs)
      : real;
    const drift = comparable ? predicted - real : null;

    rows.push({
      at: new Date(wall).toISOString(),
      trackId: track.id,
      track: track.name,
      playing,
      progressMs: real,
      predictedMs: Math.round(predicted),
      driftMs: drift == null ? '' : Math.round(drift),
      intervalMs: last ? wall - last : 0,
      device: body.device ? body.device.name : null,
    });
    last = wall;
    anchor = { positionMs: real, wallMs: wall, playing, trackId: track.id };
    const driftText = drift == null ? '—' : `${Math.round(drift)}ms`;
    process.stdout.write(`\r${rows.length} 条 · ${playing ? '播放中' : '已暂停'} · drift=${driftText} · ${track.name.slice(0, 24)}   `);
    await sleep(INTERVAL_MS);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const header = 'at,trackId,track,playing,progressMs,predictedMs,driftMs,intervalMs,device';
  const csv = [header]
    .concat(rows.map((r) => [r.at, r.trackId, JSON.stringify(r.track), r.playing, r.progressMs, r.predictedMs, r.driftMs, r.intervalMs, JSON.stringify(r.device || '')].join(',')))
    .join('\n');
  fs.writeFileSync(OUT, csv, 'utf8');

  const drifts = rows.map((r) => r.driftMs).filter((d) => d !== '').map((d) => Math.abs(Number(d))).sort((a, b) => a - b);
  const pick = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
  const intervals = rows.map((r) => r.intervalMs).filter((x) => x > 0).sort((a, b) => a - b);
  console.log(`\n\n样本 ${rows.length} 条；其中可比较（前后都在播放）${drifts.length} 条`);
  if (drifts.length) {
    console.log(`|drift| P50=${pick(drifts, 0.5)}ms P95=${pick(drifts, 0.95)}ms max=${drifts[drifts.length - 1]}ms`);
  }
  console.log(`请求间隔 P50=${pick(intervals, 0.5)}ms P95=${pick(intervals, 0.95)}ms max=${intervals[intervals.length - 1]}ms`);
  console.log(`CSV => ${OUT}`);
})().catch((e) => {
  console.error('测量失败:', e.message);
  process.exitCode = 1;
});
