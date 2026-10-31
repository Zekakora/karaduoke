'use strict';
/**
 * 官方 MV Resolver（lib/official-mv.js + lib/youtube.js）的单元测试。
 *
 * 全部**不联网**：lib/youtube.js 的 search/videos 被替换成假实现，只验证
 *   - 搜索词构造（去括号后缀 / feat. / 版本名）
 *   - 评分规则：歌名、歌手、频道、官方标识、时长、负向词（Live / Lyric / Audio / Karaoke…）
 *   - 两级阈值：高置信度自动采用，低置信度进 pending，找不到进 not_found
 *   - 写库：状态 + 候选，且**不覆盖** manually_confirmed
 *   - 已有结果不重复搜索（复用）
 *
 * 用法：node tests/official-mv.test.js
 *
 * 注意：这里只测**官方 Data API 那一路**（youtube.search/videos 被替换成假实现），
 * 所以要把免配额的 YouTube Music 源关掉，否则 lib/official-mv.js 会先去问 ytmusicapi
 * （还会真的联网，测试结果就不确定了）。ytmusic 那一路见 tests/ytmusic-mv.test.js。
 */
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.KARAOKE_YTMUSIC = '0';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-mv-'));
const DB = path.join(TMP, 'library.db');
process.env.LIBRARY_DB = DB;
process.env.YOUTUBE_API_KEY = 'test-key';

const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB);
db.exec(fs.readFileSync(path.join(ROOT, 'python', 'schema.sql'), 'utf8'));
db.close();

const youtube = require(path.join(ROOT, 'lib', 'youtube.js'));
const mv = require(path.join(ROOT, 'lib', 'official-mv.js'));
const libraryDb = require(path.join(ROOT, 'lib', 'library-db.js'));

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';       // 普通曲目
const SID_LOCKED = 'BBBBBBBBBBBBBBBBBBBBBB'; // 已手动确认
const SID_NONE = 'CCCCCCCCCCCCCCCCCCCCCC'; // 搜不到
const TRACK = { title: 'STAY (with Justin Bieber)', artists: ['The Kid LAROI', 'Justin Bieber'], durationMs: 201000 };

let passed = 0;
let failed = 0;
const failures = [];
function record(name, error) {
  if (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  } else {
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
}
function test(name, fn) {
  try { fn(); record(name, null); } catch (error) { record(name, error); }
}
async function testAsync(name, fn) {
  try { await fn(); record(name, null); } catch (error) { record(name, error); }
}

// ---------------------------------------------------------------- 假 YouTube
/** 每个假候选配一个**合法的 11 位 videoId**（写库时会校验格式） */
const ids = {
  OFFICIAL_STAY: 'dQw4w9WgXcQ',
  LIVE_STAY: 'LIVEAAAAAAAA',
  LYRIC_STAY: 'LYRICAAAAAAA',
  TOPIC_STAY: 'TOPICAAAAAAA',
  OTHER_ARTIST_STAY: 'OTHERAAAAAAA',
  NO_EMBED: 'NOEMBEDAAAAA',
  FAN_COVER: 'FANCOVERAAAA',
};

/** 用 CATALOG 的 key 决定"这个候选是什么"，方便断言 */
const CATALOG = {
  // 官方 MV（高置信度）
  OFFICIAL_STAY: {
    title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', channelTitle: 'TheKidLAROIVEVO',
    durationSeconds: 201, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // Live 版本：标题/频道都对，但带了 Live
  LIVE_STAY: {
    title: 'The Kid LAROI, Justin Bieber - STAY (Live from Los Angeles)', channelTitle: 'TheKidLAROIVEVO',
    durationSeconds: 205, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // 歌词版
  LYRIC_STAY: {
    title: 'The Kid LAROI, Justin Bieber - STAY (Official Lyric Video)', channelTitle: 'TheKidLAROIVEVO',
    durationSeconds: 201, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // 音频频道（Topic）
  TOPIC_STAY: {
    title: 'STAY (with Justin Bieber)', channelTitle: 'The Kid LAROI - Topic',
    durationSeconds: 201, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // 同名但不同艺人
  OTHER_ARTIST_STAY: {
    title: 'Some Other Band - STAY (Official Video)', channelTitle: 'SomeOtherBand',
    durationSeconds: 198, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // 不允许嵌入
  NO_EMBED: {
    title: 'The Kid LAROI, Justin Bieber - STAY (Official Video)', channelTitle: 'TheKidLAROIVEVO',
    durationSeconds: 201, embeddable: false, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
  // 低置信度：标题对、频道是翻唱号
  FAN_COVER: {
    title: 'The Kid LAROI, Justin Bieber - STAY', channelTitle: 'Random Uploader',
    durationSeconds: 199, embeddable: true, privacyStatus: 'public', liveBroadcastContent: 'none',
  },
};

let searchCalls = 0;
let videoCalls = 0;
let searchImpl = async () => [];
let videosImpl = async () => new Map();

youtube.search = async (opts) => { searchCalls += 1; return searchImpl(opts); };
youtube.videos = async (wanted) => { videoCalls += 1; return videosImpl(wanted); };

/** 让下一轮搜索返回这些 CATALOG key 对应的候选（返回实际发出的搜索词，方便断言） */
function install(keys) {
  const queries = [];
  searchImpl = async (opts) => {
    queries.push(opts.q);
    // 每个搜索词都返回同一批候选（真实 API 会去重，这里也一样）
    return keys.map((key) => ({ videoId: ids[key], title: CATALOG[key].title, channelTitle: CATALOG[key].channelTitle }));
  };
  videosImpl = async (wanted) => {
    const map = new Map();
    for (const key of keys) {
      if (wanted.includes(ids[key])) map.set(ids[key], { videoId: ids[key], ...CATALOG[key] });
    }
    return map;
  };
  return queries;
}

(async () => {
  try {
    // 建三首曲目
    const seed = new DatabaseSync(DB);
    const insert = seed.prepare('INSERT INTO tracks (spotify_id, title, artists, duration_ms) VALUES (?, ?, ?, ?)');
    insert.run(SID, TRACK.title, JSON.stringify(TRACK.artists), TRACK.durationMs);
    insert.run(SID_LOCKED, TRACK.title, JSON.stringify(TRACK.artists), TRACK.durationMs);
    insert.run(SID_NONE, 'Obscure Song Nobody Has', JSON.stringify(['Unknown Artist']), 180000);
    seed.close();

    console.log('\n[搜索词]');
    test('清理歌名里的括号/feat./版本后缀', () => {
      assert.strictEqual(mv.cleanTitle('Happy - From "Despicable Me 2"'), 'Happy');
      assert.strictEqual(mv.cleanTitle('STAY (with Justin Bieber)'), 'STAY');
      assert.strictEqual(mv.cleanTitle('Lover (Remix) [feat. Shawn Mendes]'), 'Lover');
      assert.strictEqual(mv.cleanTitle('bad idea right?'), 'bad idea right?');
    });
    test('构造多个搜索词（含 Official Music Video / Official Video / MV）', () => {
      const queries = mv.buildQueries(TRACK);
      assert.ok(queries.length >= 3, JSON.stringify(queries));
      assert.ok(queries[0].includes('Official Music Video'), queries[0]);
      assert.ok(queries.some((q) => q.includes('Official Video')), queries);
      assert.ok(queries.some((q) => q.endsWith('MV')), queries);
      // 歌名里的括号内容不能带进搜索词（会降低命中率）
      assert.ok(!queries.some((q) => q.includes('Justin Bieber)')), queries);
    });

    console.log('\n[评分]');
    test('精确匹配：官方频道 + Official Video + 时长一致 → 高分', () => {
      const scored = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY }, TRACK);
      assert.ok(scored.score >= 85, `score=${scored.score} reasons=${scored.reasons}`);
      assert.strictEqual(scored.negative.length, 0, scored.negative);
    });
    test('Live 版本被扣分，明显低于官方 MV', () => {
      const official = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY }, TRACK).score;
      const live = mv.scoreCandidate({ ...CATALOG.LIVE_STAY }, TRACK);
      assert.ok(live.score < official - 20, `live=${live.score} official=${official}`);
      assert.ok(live.negative.includes('Live/Concert'), live.negative);
    });
    test('Lyric Video 被识别并扣分', () => {
      const lyric = mv.scoreCandidate({ ...CATALOG.LYRIC_STAY }, TRACK);
      assert.ok(lyric.negative.includes('Lyric Video'), lyric.negative);
      assert.ok(lyric.score < mv.CONFIG.autoThreshold, `lyric=${lyric.score}`);
    });
    test('Topic（音频频道）不会被当成 MV', () => {
      const topic = mv.scoreCandidate({ ...CATALOG.TOPIC_STAY }, TRACK);
      assert.ok(topic.negative.includes('Topic Audio'), topic.negative);
      assert.ok(topic.score < mv.CONFIG.autoThreshold, `topic=${topic.score}`);
    });
    test('同名不同艺人：分数明显低于正确艺人', () => {
      const right = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY }, TRACK).score;
      const other = mv.scoreCandidate({ ...CATALOG.OTHER_ARTIST_STAY }, TRACK).score;
      assert.ok(other < right - 20, `other=${other} right=${right}`);
    });
    test('不允许嵌入 / 非公开：扣分并记录', () => {
      const noEmbed = mv.scoreCandidate({ ...CATALOG.NO_EMBED }, TRACK);
      assert.ok(noEmbed.reasons.some((r) => r.includes('不允许嵌入')), noEmbed.reasons);
      const priv = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY, privacyStatus: 'private' }, TRACK);
      assert.ok(priv.reasons.some((r) => r.includes('非公开')), priv.reasons);
    });
    test('时长差超过 30% 才扣分（Live Aid 那种差距会明显掉分）', () => {
      // 用一个"没有官方标识、没有官方频道"的候选测时长扣分，避免满分被 100 截断掩盖差异
      const weak = { title: 'The Kid LAROI, Justin Bieber - STAY', channelTitle: 'Random Uploader' };
      const within = mv.scoreCandidate({ ...weak, durationSeconds: Math.round(201 * 1.2) }, TRACK);
      const wayOff = mv.scoreCandidate({ ...weak, durationSeconds: 80 }, TRACK);
      assert.ok(within.reasons.some((r) => r.includes('不扣分')), within.reasons);
      assert.ok(wayOff.reasons.some((r) => /时长差 \d+%（>30%）/.test(r)), wayOff.reasons);
      assert.ok(wayOff.score < within.score, `wayOff=${wayOff.score} within=${within.score}`);
      // 282s vs 201s ≈ 40% 差 → 也超过 30%
      const slight = mv.scoreCandidate({ ...weak, durationSeconds: 282 }, TRACK);
      assert.ok(slight.reasons.some((r) => r.includes('>30%')), slight.reasons);
    });
    test('MV 前后奏在 30% 以内不扣分（需求：时长只做粗判，权重低）', () => {
      // 实测：Blinding Lights 音频 200s，官方 MV 263s（差 ~32%，略超 30% 才扣 10 分）
      const within = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY, durationSeconds: Math.round(201 * 1.25) }, TRACK);
      assert.ok(within.reasons.some((r) => r.includes('不扣分')), `25% 差应不扣分：${within.reasons}`);
      const slightlyOver = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY, durationSeconds: 201 + 63 }, TRACK);
      assert.ok(slightlyOver.reasons.some((r) => r.includes('31%')), `应显示实际百分比：${slightlyOver.reasons}`);
      // 即便略超 30%，官方频道 + 官方标识依然足够高，属于 auto 区
      assert.ok(slightlyOver.score >= mv.CONFIG.autoThreshold, `official=${slightlyOver.score}`);
    });
    test('官方标识 + 官方频道的组合强于只命中其一', () => {
      const both = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY }, TRACK).score;
      const noMarker = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY, title: 'The Kid LAROI, Justin Bieber - STAY' }, TRACK).score;
      const noChannel = mv.scoreCandidate({ ...CATALOG.OFFICIAL_STAY, channelTitle: 'Random Uploader' }, TRACK).score;
      assert.ok(both > noMarker && both > noChannel, `both=${both} noMarker=${noMarker} noChannel=${noChannel}`);
    });

    console.log('\n[自动选择：永远取最高分]');
    test('高分 → auto_matched，选第一名', () => {
      const verdict = mv.decide([
        { videoId: 'aaaaaaaaaaa', score: 95, reasons: [] },
        { videoId: 'bbbbbbbbbbb', score: 55, reasons: [] },
      ]);
      assert.strictEqual(verdict.status, 'auto_matched');
      assert.strictEqual(verdict.chosen.videoId, 'aaaaaaaaaaa');
    });
    test('分数一般（不再是 pending 等人工确认）→ 仍自动选最高分', () => {
      const verdict = mv.decide([
        { videoId: 'aaaaaaaaaaa', score: mv.CONFIG.autoThreshold - 5, reasons: [] },
        { videoId: 'bbbbbbbbbbb', score: mv.CONFIG.autoThreshold - 1, reasons: [] },
      ]);
      assert.strictEqual(verdict.status, 'auto_matched', '应自动采用最高分');
      assert.strictEqual(verdict.chosen.videoId, 'aaaaaaaaaaa');
      assert.strictEqual(verdict.weak, true, '应标记为置信度一般');
    });
    test('全部低于 pendingThreshold → not_found（用模糊封面）', () => {
      const verdict = mv.decide([{ videoId: 'aaaaaaaaaaa', score: mv.CONFIG.pendingThreshold - 1, reasons: [] }]);
      assert.strictEqual(verdict.status, 'not_found');
      assert.strictEqual(verdict.chosen, null);
    });
    test('没有候选 → not_found', () => {
      assert.strictEqual(mv.decide([]).status, 'not_found');
    });

    console.log('\n[搜索 + 写库]');
    await testAsync('官方 MV 存在 → auto_matched，并写入 visualVideoId / 评分 / 候选', async () => {
      const queries = install(['OFFICIAL_STAY', 'LYRIC_STAY', 'LIVE_STAY', 'NO_EMBED', 'TOPIC_STAY']);
      const result = await mv.resolve({ spotifyId: SID, force: true });
      assert.strictEqual(result.status, 'auto_matched', JSON.stringify(result.visual));
      assert.strictEqual(result.visual.visualVideoId, ids.OFFICIAL_STAY);
      assert.ok(result.visual.visualMatchScore >= mv.CONFIG.autoThreshold);
      assert.ok(queries.length >= 1);
      const row = libraryDb.getVisual(SID);
      assert.strictEqual(row.visualMatchStatus, 'auto_matched');
      assert.ok(row.candidates.length >= 1, '应保存候选供管理员查看');
      // 不可嵌入的候选不该进入候选列表
      assert.ok(!row.candidates.some((c) => c.videoId === ids.NO_EMBED), '不可嵌入的候选被保存了');
    });
    await testAsync('已匹配的歌再次解析：复用，不再调用 YouTube', async () => {
      searchCalls = 0;
      const result = await mv.resolve({ spotifyId: SID });
      assert.strictEqual(searchCalls, 0, `不该再搜索（实际 ${searchCalls} 次）`);
      assert.strictEqual(result.searched, false);
      assert.strictEqual(result.visual.visualVideoId, ids.OFFICIAL_STAY);
    });
    await testAsync('置信度一般也自动选最高分（不再进 pending 等人工确认）', async () => {
      // 只有"风格不明确"的候选：标题对、频道陌生
      install(['FAN_COVER', 'OTHER_ARTIST_STAY']);
      const result = await mv.resolve({ spotifyId: SID, force: true });
      assert.strictEqual(result.status, 'auto_matched', JSON.stringify(result.visual));
      assert.strictEqual(result.visual.visualVideoId, ids.OTHER_ARTIST_STAY, '应取分数最高的那个');
      assert.ok(result.visual.visualMatchScore >= mv.CONFIG.pendingThreshold);
      const row = libraryDb.getVisual(SID);
      assert.strictEqual(row.visualMatchStatus, 'auto_matched');
      assert.ok(row.candidates.length >= 1, '候选仍要保存，方便人工复核');
    });
    await testAsync('找不到 → not_found（并记录，之后不自动重搜）', async () => {
      install([]);
      const result = await mv.resolve({ spotifyId: SID_NONE, force: true });
      assert.strictEqual(result.status, 'not_found');
      assert.strictEqual(result.visual.visualVideoId, null);
      searchCalls = 0;
      const again = await mv.resolve({ spotifyId: SID_NONE });
      assert.strictEqual(searchCalls, 0, 'not_found 之后不应反复搜索');
      assert.strictEqual(again.searched, false);
    });
    await testAsync('管理员手动确认后，自动匹配不会覆盖', async () => {
      install(['OFFICIAL_STAY', 'LYRIC_STAY']);
      const confirmed = mv.confirm(SID, { videoId: 'MANUALAAAAA', title: '手工选的 MV' });
      assert.ok(confirmed.ok, JSON.stringify(confirmed));
      assert.strictEqual(confirmed.visual.visualMatchStatus, 'manually_confirmed');
      // 再跑一次自动匹配（force 也不行）
      await mv.resolve({ spotifyId: SID, force: true });
      const row = libraryDb.getVisual(SID);
      assert.strictEqual(row.visualVideoId, 'MANUALAAAAA', '手动确认的 MV 被自动匹配覆盖了');
      assert.strictEqual(row.visualMatchStatus, 'manually_confirmed');
    });
    await testAsync('播放失败上报 → unavailable，并清掉坏 videoId', async () => {
      mv.confirm(SID_LOCKED, { videoId: 'BROKENVIDEO' });
      const visual = mv.markUnavailable(SID_LOCKED, { videoId: 'BROKENVIDEO', reason: '视频不允许嵌入' });
      assert.strictEqual(visual.visualMatchStatus, 'unavailable');
      assert.strictEqual(visual.visualVideoId, null, '坏掉的 videoId 应清空，避免反复加载');
      assert.ok(String(visual.visualMatchReason).includes('不允许嵌入'), visual.visualMatchReason);
    });
    await testAsync('迟到的旧播放器错误不会误伤新视频', async () => {
      mv.confirm(SID_LOCKED, { videoId: 'NEWVIDEOAAA' });
      mv.markUnavailable(SID_LOCKED, { videoId: 'OLDVIDEOAAA', reason: '旧播放器迟到事件' });
      const row = libraryDb.getVisual(SID_LOCKED);
      assert.strictEqual(row.visualVideoId, 'NEWVIDEOAAA', '新视频被旧事件标坏了');
      assert.strictEqual(row.visualMatchStatus, 'manually_confirmed');
    });
    await testAsync('清除 → 回到 pending + 空 videoId（播放端回退封面）', async () => {
      const result = mv.clear(SID);
      assert.ok(result.ok);
      assert.strictEqual(result.visual.visualVideoId, null);
      assert.strictEqual(result.visual.visualMatchStatus, 'pending');
    });
    await testAsync('没有 API Key → 不当成"没有 MV"，不写 not_found', async () => {
      // 新建一首从没搜过的歌，保证这条断言不受前面用例留下的状态影响
      const sidFresh = 'DDDDDDDDDDDDDDDDDDDDDD';
      const seed2 = new DatabaseSync(DB);
      seed2.prepare('INSERT INTO tracks (spotify_id, title, artists, duration_ms) VALUES (?, ?, ?, ?)')
        .run(sidFresh, TRACK.title, JSON.stringify(TRACK.artists), TRACK.durationMs);
      seed2.close();
      // youtube.search 抛 YOUTUBE_NO_KEY（真实实现里没 Key 就是抛这个）
      searchImpl = async () => { const e = new Error('没有配置 YouTube API Key'); e.code = 'YOUTUBE_NO_KEY'; throw e; };
      const result = await mv.resolve({ spotifyId: sidFresh, force: true });
      assert.notStrictEqual(result.status, 'not_found', '没 Key 被误判成 not_found');
      const row = libraryDb.getVisual(sidFresh);
      assert.notStrictEqual(row.visualMatchStatus, 'not_found');
      assert.strictEqual(row.visualVideoId, null);
    });

    console.log('\n[验证工具]');
    test('videoId 校验：只接受 11 位', () => {
      assert.strictEqual(mv.fromRow({ visual_video_id: 'dQw4w9WgXcQ' }).visualVideoId, 'dQw4w9WgXcQ');
      const bad = mv.confirm(SID, { videoId: 'short' });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.reason, 'BAD_VIDEO_ID');
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
