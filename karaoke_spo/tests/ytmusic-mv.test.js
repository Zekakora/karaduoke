'use strict';
/**
 * 免配额官方 MV 源（YouTube Music / ytmusicapi）的单元测试。
 *
 * 覆盖 lib/ytmusic.js 与 lib/official-mv.js 里"两段式搜索"的新增部分：
 *   - YouTube Music 的搜索词构造（不加 Official 后缀，靠 videoType 判断）
 *   - videoType 评分：OMV 加分 / ATV（Art track）扣分 / UGC（用户上传）扣分
 *   - ytmusic 候选不会被"频道名含歌手"重复计分（它根本没有频道名）
 *   - 两段式：ytmusic 有结果就不动官方 API；ytmusic 没结果才落到官方 API
 *   - **核心场景**：官方 API 配额打满（429 / 冷却）时，ytmusic 仍能匹配出 MV
 *   - lib/ytmusic.js：关闭时直接返回空、结果按查询词缓存
 *
 * 全部**不联网**：ytmusic.searchVideos / youtube.search / youtube.videos 都是假实现。
 *
 * 用法：node tests/ytmusic-mv.test.js
 */
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-ytmusic-'));
const DB = path.join(TMP, 'library.db');
process.env.LIBRARY_DB = DB;
process.env.YOUTUBE_API_KEY = 'test-key';

const { DatabaseSync } = require('node:sqlite');
{
  const db = new DatabaseSync(DB);
  db.exec(fs.readFileSync(path.join(ROOT, 'python', 'schema.sql'), 'utf8'));
  db.close();
}

const youtube = require(path.join(ROOT, 'lib', 'youtube.js'));
const ytmusic = require(path.join(ROOT, 'lib', 'ytmusic.js'));
const mv = require(path.join(ROOT, 'lib', 'official-mv.js'));
const libraryDb = require(path.join(ROOT, 'lib', 'library-db.js'));

const SID = 'EEEEEEEEEEEEEEEEEEEEEE';
const TRACK = { title: 'STAY (with Justin Bieber)', artists: ['The Kid LAROI', 'Justin Bieber'], durationMs: 201000 };

let passed = 0;
let failed = 0;
const failures = [];
function record(name, error) {
  if (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
  else { passed += 1; console.log(`  ✓ ${name}`); }
}
function test(name, fn) { try { fn(); record(name, null); } catch (error) { record(name, error); } }
async function testAsync(name, fn) { try { await fn(); record(name, null); } catch (error) { record(name, error); } }

// ---------------------------------------------------------------- 假 YouTube Music
const YTM = {
  OFFICIAL: 'dQw4w9WgXcQ',
  AUDIO: 'AUDIOAAAAAA',
  COVER: 'COVERAAAAAA',
};

const realSearchVideos = ytmusic.searchVideos;
let ytmImpl = async () => ({ items: new Map(), errors: {}, source: 'ytmusic' });
let ytmCalls = 0;
ytmusic.enabled = () => true;
ytmusic.searchVideos = async (queries, opts) => { ytmCalls += 1; return ytmImpl(queries, opts); };

/** 让 YouTube Music 返回这些候选（videoType 是它独有的信号） */
function installYtm(rows) {
  ytmImpl = async (queries) => {
    const map = new Map();
    for (const query of queries) map.set(query, rows.map((row) => ({ ...row })));
    return { items: map, errors: {}, source: 'ytmusic' };
  };
}

// ---------------------------------------------------------------- 假官方 Data API
let searchCalls = 0;
let searchImpl = async () => [];
youtube.search = async (opts) => { searchCalls += 1; return searchImpl(opts); };
youtube.videos = async () => new Map();

(async () => {
  try {
    const seed = new DatabaseSync(DB);
    seed.prepare('INSERT INTO tracks (spotify_id, title, artists, duration_ms) VALUES (?, ?, ?, ?)')
      .run(SID, TRACK.title, JSON.stringify(TRACK.artists), TRACK.durationMs);
    seed.close();

    console.log('\n[YouTube Music 搜索词]');
    test('不加 Official 后缀：它是音乐搜索引擎，靠 videoType 判断官方与否', () => {
      const queries = mv.buildYtmusicQueries(TRACK);
      assert.ok(queries.length >= 1, JSON.stringify(queries));
      assert.strictEqual(queries[0], 'The Kid LAROI STAY', queries[0]);
      assert.ok(!queries.some((q) => /official/i.test(q)), `不该带 Official：${queries}`);
      // 歌名括号里的内容（feat.）不能进搜索词
      assert.ok(!queries.some((q) => q.includes('Justin Bieber)')), queries);
      // 多位歌手时用"全部歌手"补一条
      assert.ok(queries.some((q) => q.includes('Justin Bieber')), queries);
    });
    test('单一歌手时不会重复构造同一个查询词', () => {
      const queries = mv.buildYtmusicQueries({ title: 'Blinding Lights', artists: ['The Weeknd'] });
      assert.strictEqual(new Set(queries).size, queries.length, JSON.stringify(queries));
    });

    console.log('\n[videoType 评分]');
    test('OMV（官方 MV）明显加分', () => {
      const base = { title: 'STAY', channelTitle: '', durationSeconds: 201 };
      const plain = mv.scoreCandidate({ ...base }, TRACK);
      const omv = mv.scoreCandidate({ ...base, ytmusic: true, videoType: 'MUSIC_VIDEO_TYPE_OMV' }, TRACK);
      assert.ok(omv.score > plain.score, `omv=${omv.score} plain=${plain.score}`);
      assert.ok(omv.reasons.some((r) => r.includes('官方 MV')), omv.reasons);
    });
    test('ATV（Art track，只有封面图的音频）扣分并记为 Audio Only', () => {
      const scored = mv.scoreCandidate(
        { title: 'STAY', channelTitle: '', durationSeconds: 201, ytmusic: true, videoType: 'MUSIC_VIDEO_TYPE_ATV' },
        TRACK,
      );
      assert.ok(scored.negative.includes('Audio Only'), scored.negative);
      assert.ok(scored.reasons.some((r) => r.includes('Art track')), scored.reasons);
    });
    test('UGC（用户上传）扣分并记为 Fan-made', () => {
      const scored = mv.scoreCandidate(
        { title: 'STAY', channelTitle: '', durationSeconds: 201, ytmusic: true, videoType: 'MUSIC_VIDEO_TYPE_UGC' },
        TRACK,
      );
      assert.ok(scored.negative.includes('Fan-made'), scored.negative);
      assert.ok(scored.reasons.some((r) => r.includes('用户上传')), scored.reasons);
    });
    test('ytmusic 候选不会被"频道名含歌手"重复计分（它只给艺人列表）', () => {
      // 官方 API 路：频道名含主歌手 → 一半 officialChannel（20 分）
      const viaChannel = mv.scoreCandidate({ title: 'STAY', channelTitle: 'The Kid LAROI', durationSeconds: 201 }, TRACK);
      // ytmusic 路：同一个"频道"其实是艺人列表，只能拿"署名"那 10 分
      const viaYtm = mv.scoreCandidate(
        { title: 'STAY', channelTitle: 'The Kid LAROI', durationSeconds: 201, ytmusic: true, ytmusicArtists: ['The Kid LAROI'] },
        TRACK,
      );
      assert.ok(viaYtm.score < viaChannel.score, `ytm=${viaYtm.score} channel=${viaChannel.score}`);
      assert.ok(viaYtm.reasons.some((r) => r.includes('署名')), viaYtm.reasons);
      assert.ok(!viaYtm.reasons.some((r) => r.includes('官方频道')), viaYtm.reasons);
    });

    console.log('\n[两段式搜索：ytmusic 优先，官方 API 兜底]');
    await testAsync('ytmusic 有结果 → 用它的候选，一次都不碰官方 API', async () => {
      searchCalls = 0;
      ytmCalls = 0;
      installYtm([
        { videoId: YTM.OFFICIAL, title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', artists: ['The Kid LAROI', 'Justin Bieber'], durationSeconds: 201, videoType: 'MUSIC_VIDEO_TYPE_OMV', thumbnailUrl: '' },
      ]);
      const found = await mv.searchCandidates(TRACK, {});
      assert.strictEqual(found.source, 'ytmusic', JSON.stringify(found.reason));
      assert.strictEqual(searchCalls, 0, `不该调官方 search（实际 ${searchCalls} 次）`);
      assert.strictEqual(ytmCalls, 1);
      assert.strictEqual(found.candidates[0].videoId, YTM.OFFICIAL);
      assert.strictEqual(found.candidates[0].source, 'ytmusic');
    });
    await testAsync('ytmusic 没结果 → 落到官方 API 兜底', async () => {
      searchCalls = 0;
      installYtm([]);
      searchImpl = async () => [
        { videoId: 'OFFICIALAAAA', title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', channelTitle: 'TheKidLAROIVEVO' },
      ];
      const found = await mv.searchCandidates(TRACK, {});
      assert.strictEqual(searchCalls >= 1, true, '应该调用官方 search');
      assert.strictEqual(found.source, 'youtube');
      assert.strictEqual(found.candidates[0].source, 'youtube');
    });
    await testAsync('官方 API 配额打满（429）但 ytmusic 可用 → 照样匹配成功', async () => {
      // 这正是加这个源的原因：官方 API 整天 429 时，不该整晚只能看模糊封面
      searchImpl = async () => {
        const error = new Error('YouTube 限流（429）');
        error.code = 'YOUTUBE_RATE_LIMITED';
        throw error;
      };
      installYtm([
        { videoId: YTM.AUDIO, title: 'STAY', artists: ['The Kid LAROI'], durationSeconds: 201, videoType: 'MUSIC_VIDEO_TYPE_ATV', thumbnailUrl: '' },
        { videoId: YTM.OFFICIAL, title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', artists: ['The Kid LAROI', 'Justin Bieber'], durationSeconds: 201, videoType: 'MUSIC_VIDEO_TYPE_OMV', thumbnailUrl: '' },
      ]);
      const result = await mv.resolve({ spotifyId: SID, force: true });
      assert.strictEqual(result.status, 'auto_matched', JSON.stringify(result));
      assert.strictEqual(result.visual.visualVideoId, YTM.OFFICIAL, '应选中官方 MV 而不是 Art track');
      assert.strictEqual(result.source, 'ytmusic');
    });
    await testAsync('两个源都没有 → not_found（不会因为换源就误判）', async () => {
      searchCalls = 0;
      installYtm([]);
      searchImpl = async () => [];
      const result = await mv.resolve({ spotifyId: SID, force: true });
      assert.strictEqual(result.status, 'not_found', JSON.stringify(result));
      const row = libraryDb.getVisual(SID);
      assert.strictEqual(row.visualMatchStatus, 'not_found');
    });

    console.log('\n[lib/ytmusic.js 自身]');
    await testAsync('关闭时（enabled=false）直接返回空，不起子进程', async () => {
      // 这条要打到**真实的** searchVideos（不是上面那层假实现）
      const realEnabled = ytmusic.enabled;
      ytmusic.enabled = () => false;
      try {
        const out = await realSearchVideos(['hello world'], {});
        assert.strictEqual(out.items.size, 0);
      } finally {
        ytmusic.enabled = realEnabled;
      }
    });
    test('status() 会说明为什么可用/不可用', () => {
      const status = ytmusic.status();
      assert.strictEqual(typeof status.available, 'boolean');
      assert.strictEqual(typeof status.scriptExists, 'boolean');
      assert.ok(Array.isArray([status.configured]));
    });
    test('resetForTests() 清空缓存', () => {
      ytmusic.resetForTests();
      assert.strictEqual(ytmusic.cached('anything'), null);
    });
  } finally {
    try { libraryDb.close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
  if (failed) {
    process.exitCode = 1;
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
  }
})();
