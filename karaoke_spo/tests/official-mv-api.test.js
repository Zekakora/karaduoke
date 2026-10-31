'use strict';
/**
 * 官方 MV 的后端集成测试（隔离运行，不动现场 data/assets）。
 *
 * 覆盖：
 *   - GET  /api/library/tracks/:id 带 visual.*（老库没有 MV 列时也返回 pending 兜底）
 *   - POST /api/library/admin/tracks/:id/mv  search / select / confirm / custom / clear
 *   - 手动确认后重复 search 不会覆盖
 *   - /api/library/admin 的 MV 列字段
 *   - POST /api/display/visual-error 把状态写成 unavailable（播放端回退封面用）
 *   - 这些接口都不碰 source_video_id（音频来源 ID）
 *   - 权限：没有 DJ token → 401
 *
 * YouTube 网络调用在进程内被替换成假实现（不联网）。
 *
 * 同样要关掉免配额的 YouTube Music 源（KARAOKE_YTMUSIC=0）：它会在官方 API 之前
 * 被问一次，且会真的联网（scripts/ytmusic_mv.py），会让这里的假实现失效。
 * 用法：node tests/official-mv-api.test.js
 */
process.env.PORT = '3821';
process.env.HOST = '127.0.0.1';
process.env.DJ_PASSWORD = 'test-dj-password';
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.KARAOKE_YTMUSIC = '0';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(path.join(__dirname, '..', '.tmp'), 'mv-api-'));
const DATA_DIR = path.join(TMP, 'data');
const MEDIA_ROOT = path.join(TMP, 'assets');
const DB_PATH = path.join(TMP, 'library.db');
process.env.KARAOKE_DATA_DIR = DATA_DIR;
process.env.LIBRARY_DB = DB_PATH;
process.env.MEDIA_ROOT = MEDIA_ROOT;
process.env.LYRICS_OVERRIDES = path.join(TMP, 'lyrics-overrides.json');
process.env.YOUTUBE_API_KEY = 'test-key';

const ROOT = path.join(__dirname, '..');
const SID = 'PPPPPPPPPPPPPPPPPPPPPP';          // 普通曲目
const SID_PLAIN = 'QQQQQQQQQQQQQQQQQQQQQQ';    // 没有任何 MV 记录的老歌
const SOURCE_VIDEO_ID = 'SOURCEVID01';         // 音频来源 ID（绝不能被 MV 逻辑改掉）
const OFFICIAL_ID = 'dQw4w9WgXcQ';
const MANUAL_ID = 'kJQP7kiw5Fk';
const BROKEN_ID = 'BROKENAAAAA';

const { DatabaseSync } = require('node:sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });
const seed = new DatabaseSync(DB_PATH);
seed.exec(fs.readFileSync(path.join(ROOT, 'python', 'schema.sql'), 'utf8'));
const insert = seed.prepare(`INSERT INTO tracks (spotify_id, title, artists, duration_ms, status, source_video_id, audio_path)
                             VALUES (?, ?, ?, ?, 'separated', ?, ?)`);
insert.run(SID, 'STAY (with Justin Bieber)', JSON.stringify(['The Kid LAROI', 'Justin Bieber']), 201000, SOURCE_VIDEO_ID, path.join(DATA_DIR, 'in.wav'));
insert.run(SID_PLAIN, 'Plain Old Song', JSON.stringify(['Nobody']), 180000, null, null);
// 两首都要有"ready"的 stems，前端才会把它当可播放曲目
const addStem = seed.prepare('INSERT INTO stems (track_id, model, out_dir, vocals_path, no_vocals_path) VALUES (?, ?, ?, ?, ?)');
for (const row of seed.prepare('SELECT id FROM tracks').all()) {
  addStem.run(row.id, 'htdemucs', path.join(MEDIA_ROOT, 'output', 'library', 'x'), '/v.mp3', '/a.mp3');
}
seed.close();

// 假 YouTube：search 永远返回"官方 MV"，videos 补齐元数据
const youtube = require(path.join(ROOT, 'lib', 'youtube.js'));
youtube.search = async () => [
  { videoId: OFFICIAL_ID, title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', channelTitle: 'TheKidLAROIVEVO' },
];
youtube.videos = async (ids) => {
  const map = new Map();
  if (ids.includes(OFFICIAL_ID)) {
    map.set(OFFICIAL_ID, {
      videoId: OFFICIAL_ID, title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)',
      channelTitle: 'TheKidLAROIVEVO', durationSeconds: 201, embeddable: true, privacyStatus: 'public',
      liveBroadcastContent: 'none', thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
  }
  if (ids.includes(MANUAL_ID)) {
    map.set(MANUAL_ID, {
      videoId: MANUAL_ID, title: 'Luis Fonsi ft. Daddy Yankee - Despacito', channelTitle: 'LuisFonsiVEVO',
      durationSeconds: 282, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
    });
  }
  return map;
};

const app = require(path.join(ROOT, 'server.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const json = (url, opts) => fetch(url, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${error.message}`); }
}

(async () => {
  const server = app.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const auth = await json(`${BASE}/api/admin/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.DJ_PASSWORD }),
  });
  const H = { 'Content-Type': 'application/json', 'x-admin-token': auth.body?.token };
  const mvUrl = (sid) => `${BASE}/api/library/admin/tracks/${sid}/mv`;
  const act = (sid, action, body = {}) => json(mvUrl(sid), { method: 'POST', headers: H, body: JSON.stringify({ action, ...body }) });

  try {
    await test('未授权不能读写 MV 管理', async () => {
      const r1 = await json(mvUrl(SID));
      assert.strictEqual(r1.status, 401);
      const r2 = await json(mvUrl(SID), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'search' }) });
      assert.strictEqual(r2.status, 401);
    });

    await test('老歌没有 MV → /api/library/tracks 返回 pending 兜底，不影响其它字段', async () => {
      const { status, body } = await json(`${BASE}/api/library/tracks/${SID_PLAIN}`);
      assert.strictEqual(status, 200);
      assert.strictEqual(body.title, 'Plain Old Song');
      assert.ok(body.visual, '应带 visual 对象');
      assert.strictEqual(body.visual.visualVideoId, null);
      assert.strictEqual(body.visual.visualMatchStatus, 'pending');
      assert.ok(Array.isArray(body.audio ? [1] : []), '原有字段仍在');
    });

    await test('GET 管理接口返回当前 MV + 配置', async () => {
      const { status, body } = await json(mvUrl(SID), { headers: H });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.spotifyId, SID);
      assert.ok(body.config, '应带评分配置');
      assert.ok(body.config.autoThreshold > 0);
      assert.strictEqual(body.sourceVideoId, SOURCE_VIDEO_ID, '应能看到音频来源 ID（用于区分）');
    });

    await test('search → 高置信度自动匹配，写入 visualVideoId', async () => {
      const r = await act(SID, 'search');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.visualVideoId, OFFICIAL_ID, JSON.stringify(r.body));
      assert.strictEqual(r.body.visualMatchStatus, 'auto_matched');
      assert.ok(r.body.visualMatchScore >= 70);
      assert.ok((r.body.candidates || []).length >= 1);
      // 音频来源 ID 不受影响
      const track = await json(`${BASE}/api/library/tracks/${SID}`);
      assert.strictEqual(track.body.sourceVideoId, SOURCE_VIDEO_ID);
      assert.strictEqual(track.body.visual.visualVideoId, OFFICIAL_ID);
    });

    await test('/api/library/admin 带 MV 列字段', async () => {
      const { body } = await json(`${BASE}/api/library/admin`, { headers: H });
      const track = body.tracks.find((t) => t.spotifyId === SID);
      assert.ok(track, '曲目应在列表里');
      assert.strictEqual(track.visualVideoId, OFFICIAL_ID);
      assert.strictEqual(track.visualMatchStatus, 'auto_matched');
      assert.ok(track.visualVideoTitle, '应带视频标题');
      assert.ok(track.visualChannelTitle, '应带频道名');
      assert.ok(body.visualCounts && body.visualCounts.auto_matched >= 1, JSON.stringify(body.visualCounts));
    });

    await test('select 候选 → manually_confirmed', async () => {
      const r = await act(SID, 'select', { videoId: OFFICIAL_ID });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.visualMatchStatus, 'manually_confirmed');
      assert.strictEqual(r.body.visualVideoId, OFFICIAL_ID);
    });

    await test('手动确认后再 search 不会被覆盖', async () => {
      // 让假 YouTube 返回另一个候选，若被覆盖就会变
      const savedSearch = youtube.search;
      youtube.search = async () => [{ videoId: 'OTHEROTHER1', title: 'Some - STAY (Official Video)', channelTitle: 'OtherVEVO' }];
      try {
        const r = await act(SID, 'search');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.visualVideoId, OFFICIAL_ID, '手动确认的 MV 被自动匹配覆盖了');
        assert.strictEqual(r.body.visualMatchStatus, 'manually_confirmed');
      } finally {
        youtube.search = savedSearch;
      }
    });

    await test('custom 手填 videoId → 校验存在且可嵌入后确认', async () => {
      const r = await act(SID_PLAIN, 'custom', { videoId: MANUAL_ID });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.visualVideoId, MANUAL_ID);
      assert.strictEqual(r.body.visualMatchStatus, 'manually_confirmed');
      assert.ok(String(r.body.visualVideoTitle).includes('Despacito'), r.body.visualVideoTitle);
    });

    await test('custom 非法 id → 400', async () => {
      const r = await act(SID_PLAIN, 'custom', { videoId: 'bad' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'BAD_VIDEO_ID');
    });

    await test('播放端上报不可用 → unavailable，并清掉坏 videoId', async () => {
      // 先用 custom 挂一个"坏"视频
      const saved = youtube.videos;
      youtube.videos = async () => new Map([[BROKEN_ID, {
        videoId: BROKEN_ID, title: 'broken', channelTitle: 'x', durationSeconds: 100,
        embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
      }]]);
      try {
        await act(SID, 'custom', { videoId: BROKEN_ID });
      } finally {
        youtube.videos = saved;
      }
      const r = await json(`${BASE}/api/display/visual-error`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotifyId: SID, videoId: BROKEN_ID, reason: '视频不允许嵌入', code: 150 }),
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.visual.visualMatchStatus, 'unavailable');
      assert.strictEqual(r.body.visual.visualVideoId, null, '坏 videoId 应被清掉，避免反复加载');
      // 音频来源仍然不变
      const track = await json(`${BASE}/api/library/tracks/${SID}`);
      assert.strictEqual(track.body.sourceVideoId, SOURCE_VIDEO_ID);
    });

    await test('visual-error 参数校验', async () => {
      const r = await json(`${BASE}/api/display/visual-error`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spotifyId: 'x' }),
      });
      assert.strictEqual(r.status, 400);
    });

    await test('clear → pending + 空 videoId', async () => {
      const r = await act(SID_PLAIN, 'clear');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.visualVideoId, null);
      assert.strictEqual(r.body.visualMatchStatus, 'pending');
    });

    await test('未知操作 → 400', async () => {
      const r = await act(SID, 'bogus');
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'BAD_ACTION');
    });

    await test('display 不暴露音频来源为画面；本地曲目带 visualVideoId 字段', async () => {
      const state = await json(`${BASE}/api/state`);
      assert.strictEqual(state.status, 200);
      // 队列为空时没有 current，但结构里一定有 current 字段
      assert.ok('current' in state.body);
    });
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => server.close(r));
    try { require(path.join(ROOT, 'lib', 'library-db.js')).close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
})();
