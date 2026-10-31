'use strict';
/**
 * Official MV Resolver —— 为 Spotify 曲目找到**官方 Music Video**，只用于视频模式的背景画面。
 *
 * 与音频侧完全分开：
 *   * `source_video_id`（音频处理）由 Python 流水线（scripts/fetch_audio.py）决定，
 *     下载 MP4 → 提取音频 → Demucs。那是**音频来源**，标题里往往带 "(Audio)"、Lyric Video，
 *     甚至根本不是官方频道。
 *   * `visual_video_id`（本模块）只负责"看起来对不对"，通过 YouTube IFrame Player 静音在线播放。
 *   两者独立存储、独立更新，任何一方都不会覆盖另一方。
 *
 * 本模块**不下载任何视频**：只用 YouTube Data API（lib/youtube.js）搜索/取元数据，
 * 然后把选中的 videoId 写进曲库（python/library.py 的 update_visual）。
 *
 * 工作流程见 docs/official-mv.md，简述：
 *   1. 已有可用结果（auto_matched / manually_confirmed + 合法 videoId）→ **直接复用**，不调 API；
 *   2. 否则**先用 YouTube Music（ytmusicapi）搜索** —— 它不走官方 Data API，没有每日配额，
 *      而且结果带 `videoType`（OMV = 官方 MV / ATV = 自动生成音频 / UGC = 用户上传）；
 *   3. YouTube Music 拿不到候选（没装 / 网络问题 / 真的没有）→ **官方 Data API 兜底**：
 *      构造多个搜索词（Official Music Video / Official Video / MV），search.list 拉候选，
 *      再用 videos.list 补齐时长、embeddable、privacyStatus、liveBroadcastContent；
 *   4. 逐个候选打分（标题/歌手/频道/官方标识/时长/视频类型），排除 Live/Lyric/Audio/Karaoke/Cover…；
 *   5. 最高分 ≥ `autoThreshold` 且领先第二名 ≥ `minMargin` → auto_matched；
 *      否则最高分 ≥ `pendingThreshold` → 存候选、保持 pending，等管理员在大屏/曲库里选；
 *      都不满足 → not_found。没有 API Key / 配额用完 → 保持 pending（以后还会再试）。
 *
 * 之所以把 ytmusicapi 排在前面：官方 API 每天 10,000 单位、`search.list` 一次 100 单位，
 * 批量匹配几十首歌就会把配额打光，打光之后整晚都只能看模糊封面。ytmusicapi 是
 * YouTube Music 自己的接口，没有这个限制（详见 lib/ytmusic.js）。
 */

const libraryDb = require('./library-db.js');
const youtube = require('./youtube.js');
// 免配额源（ytmusicapi）。官方 Data API 退居兜底，见 searchCandidates()。
const ytmusic = require('./ytmusic.js');

// ---------------------------------------------------------------- 配置（集中在这里，方便调）
// 每次搜索的词模板。`{artist}` = 主歌手，`{title}` = 清理过的歌名（去括号后缀/feat./remix）。
const QUERY_TEMPLATES = [
  '{artist} {title} Official Music Video',
  '{artist} {title} Official Video',
  '{artist} {title} MV',
];
// 主歌手之外，再用"全部歌手"补一次（合唱/feat. 的歌，官方 MV 常在第二歌手的频道）
const SECONDARY_QUERY_TEMPLATE = '{artists} {title} Official Video';
// YouTube Music 的搜索词：它是**音乐搜索引擎**，加 "Official Music Video" 反而会把
// 结果带偏（会去匹配标题字面），直接给「歌手 + 歌名」命中率最高，
// 官方与否由结果里的 videoType 判断，不靠标题。
const YTMUSIC_QUERY_TEMPLATES = [
  '{artist} {title}',
  '{artists} {title}',
];
// 多个搜索词之间的最小间隔（毫秒）。YouTube 短时间连发 search.list 会 429。
const SEARCH_GAP_MS = Number(process.env.YOUTUBE_SEARCH_GAP_MS || 400);

const CONFIG = {
  // 每个搜索词拉几个候选（search.list 返回的视频数）
  maxResultsPerQuery: 8,
  // 最多并行/串行发几个搜索请求（每次 search = 100 配额单位）
  maxQueries: 3,
  // 自动采用：**只要能搜到可嵌入的候选，就取分数最高的那个**，不需要管理员确认。
  // 之前要求"≥70 分且领先第二名 ≥12 分"，实测很多真·官方 MV 只有 60~70 分
  // （时长、频道名对不上等），结果全掉进 pending，视频模式一直是模糊封面。
  // 现在的规则：
  //   * 最高分 ≥ autoThreshold(60) → 直接 auto_matched
  //   * 不到 60（例如只有歌词视频/翻唱号）但仍 ≥ pendingThreshold(25) → 也采用最高分，
  //     只是把它标成 "auto_weak"，管理员可以在曲库页看到并随时改；
  //     这样"有得用"优先于"看起来严谨"。
  //   * 低于 pendingThreshold 或压根没有候选 → not_found（用模糊封面）
  autoThreshold: 60,
  pendingThreshold: 25,
  // 保留字段（兼容旧调用），新的判定不再要求领先幅度
  minMargin: 0,
  // 评分项
  //
  // 2026-10-30 调整（实测发现的问题）：
  //   * 官方 MV 的时长经常比 Spotify 多几十秒（MV 有剧情前奏/尾奏、片头片尾，
  //     例：Blinding Lights 音频 200s vs 官方 MV 263s；STAY 音频 201s vs MV 244s）。
  //     原来 >60s 直接 -20，把真正的官方 MV 从 77 压到 57，反而和 55 分的
  //     歌词视频拉不开差距 → 只能进 pending。现在"可信官方频道"本身给更高权重，
  //     时长只做"明显不合理"的判断（Live/Extended 一般差得更多）。
  //   * "官方标识 + 可信频道"组合才是强证据，两者都满足时再给一份组合奖励。
  weights: {
    // ── 主要判断：是不是"歌手官方发布的、非歌词的 MV"（这两项占绝大部分权重）──
    officialChannel: 40,   // 频道是**主歌手本人**的官方频道 / VEVO / 唱片公司（最强证据）
    officialMarker: 30,    // 标题明确写着 Official Music Video / Official Video
    // ── YouTube Music（ytmusicapi）专属信号 ──
    // 官方 Data API 没有 videoType：它是 YouTube Music 自己标的"这是什么类型的视频"，
    // 比"标题里有没有 Official"更靠谱（很多官方 MV 标题只写歌名）。
    // OMV = Official Music Video；ATV = Art track（自动生成静态封面的音频，等于 Topic）；
    // UGC = 用户上传（翻唱 / 二创 / 现场录像）。
    ytmusicOmv: 35,        // YouTube Music 标注为官方 MV
    ytmusicAtv: -25,       // Art track：只是带封面的音频，不是 MV
    ytmusicUgc: -25,       // 用户上传：翻唱 / 二创 / 现场
    // 需求：标题里**同时**出现歌手 + 歌名 + "Official Music Video" 时再加分。
    // 这是"三个都对上"的最强信号（比只有其中两项更可信）。
    artistTitleOfficialBonus: 15,
    // ── 次要：名称是否对得上（防止同名不同歌）──
    titleStrong: 20,       // 标题包含完整歌名
    titlePartial: 12,      // 只包含 ≥60% 的歌名词
    titleMismatch: -20,    // 标题完全不含歌名
    artist: 10,            // 标题里出现主歌手
    // ── 时长：只做"明显不是同一首/不是一个版本"的粗判，权重很低 ──
    //   规则：与 Spotify 时长相差**不超过 30%** 就算合理，不扣分；超过才扣一点。
    durationWithinRatio: 0,
    durationOutsideRatio: -10,
    durationUnknown: 0,
    durationRatioTolerance: 0.3,
    // 其它弱证据只保留极小权重（几乎不影响结论）
    artistOther: 2,
    channelNameMatch: 5,
  },
  // 负向关键词：命中即扣分并记录（这些**不是** MV）
  negative: [
    { re: /\blive\b|\bconcert\b|\btour\b|现场|演唱会/i, hits: 'Live/Concert' },
    { re: /\blyric(s)?\s*video\b|\bwith lyrics\b|\blyrics video\b|歌词版/i, hits: 'Lyric Video' },
    { re: /\baudio\b|\baudio only\b|\btopic\b/i, hits: 'Audio Only' },
    { re: /\bkaraoke\b|\binstrumental\b|伴奏/i, hits: 'Karaoke' },
    { re: /\bcover\b|\bcovered by\b|翻唱/i, hits: 'Cover' },
    { re: /\breaction\b|\breacts\b/i, hits: 'Reaction' },
    { re: /\btutorial\b|\bhow to play\b|\blesson\b/i, hits: 'Tutorial' },
    { re: /\bshorts\b|\bteaser\b|\bpreview\b|\bsnippet\b/i, hits: 'Shorts/Teaser' },
    { re: /\bsped up\b|\bslowed\b|\breverb\b|\bnightcore\b|\b8d\b|\bbass boosted\b/i, hits: 'Remix/Edited' },
    { re: /\bremix\b|\bmashup\b|\bmedley\b/i, hits: 'Remix' },
    { re: /\bfanmade\b|\bfan made\b|\bfan-?video\b/i, hits: 'Fan-made' },
    { re: /\b1 hour\b|\bloop(ed)?\b|\bextended\b/i, hits: 'Loop/Extended' },
  ],
  negativeWeight: 25,
  // "官方标识"：标题里需要出现其中之一
  officialMarkers: [
    /\bofficial\s+music\s+video\b/i,
    /\bofficial\s+video\b/i,
    /\bofficial\s+mv\b/i,
  ],
  // 唱片公司 / 歌手官方频道的表记（要和"含主歌手"一起判断，见评分第 4 步）。
  // Topic 是自动生成的音频频道，**不算** MV，单独负向处理。
  companyChannelPatterns: [
    /vevo$/i,          // XXXVEVO
    /\bofficial\b/i,   // XXX Official
    /\brecords?\b/i,   // Republic Records
    /\b(label|music|entertainment)\b/i,
  ],
  // 时长只按**比例**判断：|实际 - Spotify| / Spotify ≤ 30% 即视为同一版本。
  // （MV 常带剧情前奏/片尾，绝对秒差没意义，比例更稳。）
};

// ---------------------------------------------------------------- 文本工具

/** 小写 + 去变音符号 + 全角转半角，便于比较 */
function normalizeText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 歌名清理：去掉括号/方括号里的版本说明（Remastered / From "XXX" / feat. xxx / Live），
 * 去掉 feat./ft./featuring 之后的部分，去掉 Remix/Edit/Version 后缀。
 * 例：Happy - From "Despicable Me 2" → Happy；
 *     STAY (with Justin Bieber) → STAY；Lover (Remix) [feat. Shawn Mendes] → Lover
 */
function cleanTitle(rawTitle) {
  let text = String(rawTitle || '');
  text = text.replace(/\((?:[^()]*)\)/g, ' ');
  text = text.replace(/\[(?:[^\[\]]*)\]/g, ' ');
  text = text.replace(/\s+[-–—]\s+(?:from|music from|theme from)\b.*$/i, ' ');
  text = text.replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$/i, ' ');
  text = text.replace(/\s*[-–—]\s*(?:remaster(?:ed)?|remix|edit|version|radio edit|explicit|clean)\b.*$/i, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** 只保留字母/数字/CJK，用于"标题是否真的包含歌名"的判断 */
function squash(text) {
  return normalizeText(text).replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, '');
}

function words(text) {
  return normalizeText(text).split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/).filter(Boolean);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词边界安全的包含判断（避免 `Stay` 命中 `Stays`、`one` 命中 `money`） */
function containsPhrase(haystack, phrase) {
  const h = squash(haystack);
  const p = squash(phrase);
  if (!p) return false;
  return h.includes(p);
}

// ---------------------------------------------------------------- 打分

/**
 * 给一个候选打分。返回 { score, reasons[], negative[] }，score 0..100。
 * 可解释：reasons 是逐项加减的中文明细，管理员在曲库页能直接看到为什么自动选了它。
 *
 * @param {object} candidate  youtube.videos() 或 search() 的结果（至少 title/channelTitle/durationSeconds）
 * @param {{title: string, artists: string[], durationMs?: number}} track
 */
function scoreCandidate(candidate, track, config = CONFIG) {
  const w = config.weights;
  const reasons = [];
  const negative = [];
  let score = 0;

  const title = cleanTitle(track.title || '');
  const artists = (track.artists || []).map(String).filter(Boolean);
  const primaryArtist = artists[0] || '';
  const videoTitle = String(candidate.title || '');
  // ytmusic 只给**艺人列表**、不给频道名。如果拿艺人冒充频道，下面的
  // 「频道名含主歌手」会再算一次分（和 videoType 重复计分），所以这里直接置空，
  // "是不是官方"完全交给第 4b 步的 videoType 判断。
  const channel = candidate.ytmusic ? '' : String(candidate.channelTitle || '');
  const normVideoTitle = normalizeText(videoTitle);

  // 1) 歌名
  const titleSquashed = squash(title);
  const videoSquashed = squash(videoTitle);
  if (titleSquashed && videoSquashed.includes(titleSquashed)) {
    score += w.titleStrong;
    reasons.push(`标题含歌名 +${w.titleStrong}`);
  } else {
    const titleWords = words(title);
    const videoWords = new Set(words(videoTitle));
    const hit = titleWords.filter((word) => videoWords.has(word)).length;
    const ratio = titleWords.length ? hit / titleWords.length : 0;
    if (ratio >= 0.6) {
      const pts = Math.round(w.titlePartial * ratio);
      score += pts;
      reasons.push(`标题部分匹配 ${hit}/${titleWords.length} 词 +${pts}`);
    } else {
      score += w.titleMismatch;
      reasons.push(`标题不含歌名 ${w.titleMismatch}`);
    }
  }

  // 2) 艺人
  const artistInTitle = Boolean(primaryArtist) && containsPhrase(videoTitle, primaryArtist);
  const primaryInTitle = artistInTitle || (primaryArtist && normalizeText(channel).includes(normalizeText(primaryArtist)));
  const otherInTitle = artists.slice(1).find((artist) => containsPhrase(videoTitle, artist));
  // YouTube Music 的**艺人署名**：它不给频道名，但会标"这首歌归属于谁"，
  // 同样是"这位歌手发布的"的证据（比标题里写着歌手弱一点）。
  const creditedArtists = Array.isArray(candidate.ytmusicArtists) ? candidate.ytmusicArtists.map(String).filter(Boolean) : null;
  const artistCredited = Boolean(creditedArtists && primaryArtist)
    && creditedArtists.some((name) => containsPhrase(name, primaryArtist));
  if (primaryInTitle) {
    score += w.artist;
    reasons.push(`含主歌手 +${w.artist}`);
  } else if (artistCredited) {
    score += w.artist;
    reasons.push(`YouTube Music 署名「${creditedArtists.find((name) => containsPhrase(name, primaryArtist))}」 +${w.artist}`);
  }
  if (otherInTitle) {
    score += w.artistOther;
    reasons.push(`含合作歌手「${otherInTitle}」+${w.artistOther}`);
  }

  // 3) 官方标识（标题）：这是"官方 MV"最直接的证据，权重很高
  const officialMarker = config.officialMarkers.find((re) => re.test(normVideoTitle));
  if (officialMarker) {
    score += w.officialMarker;
    reasons.push(`标题写明官方 MV +${w.officialMarker}`);
    // 追加分：标题里**歌手 + 歌名 + Official Music Video 同时出现**
    // （"Artist - Song (Official Music Video)" 这种最标准的官方 MV 标题格式）
    const titleHasSong = Boolean(titleSquashed) && videoSquashed.includes(titleSquashed);
    const titleHasArtist = artistInTitle || artists.some((artist) => containsPhrase(videoTitle, artist));
    if (titleHasSong && titleHasArtist) {
      score += w.artistTitleOfficialBonus;
      reasons.push(`标题同时含歌手+歌名+官方 MV +${w.artistTitleOfficialBonus}`);
    }
  }

  // 4) 频道：**主歌手本人的官方频道**是最强证据
  const isTopic = /\b-?\s*topic$/i.test(normalizeText(channel));
  const channelSquashed = squash(channel);
  // 频道名里是否直接含**主歌手**（不是任意合作歌手，避免把别人的频道算成官方）
  const primaryInChannel = Boolean(squash(primaryArtist)) && channelSquashed.includes(squash(primaryArtist));
  const companyChannel = config.companyChannelPatterns.some((re) => re.test(channel));
  if (isTopic) {
    // Topic = YouTube 自动生成的"音频"频道：几乎必然是 Audio，不是 MV
    score += -config.negativeWeight;
    reasons.push(`Topic 音频频道 -${config.negativeWeight}`);
    negative.push('Topic Audio');
  } else if (primaryInChannel && companyChannel) {
    // 例：TheWeekndVEVO / TaylorSwift / AdeleOfficial → 歌手官方频道
    score += w.officialChannel;
    reasons.push(`主歌手官方频道「${channel}」 +${w.officialChannel}`);
  } else if (primaryInChannel) {
    // 频道名含主歌手但不像官方机构（可能是粉丝号/搬运号）：给一半
    score += Math.round(w.officialChannel / 2);
    reasons.push(`频道名含歌手（未确认官方） +${Math.round(w.officialChannel / 2)}`);
  } else if (companyChannel) {
    // 是唱片公司/媒体官方号，但不是这位歌手的（常见于 VA 合集）
    score += w.channelNameMatch;
    reasons.push(`唱片公司/媒体频道（非歌手本人） +${w.channelNameMatch}`);
  }

  // 4b) YouTube Music 的 videoType（ytmusicapi 独有，官方 Data API 没有）
  //
  // 这是本源**最可靠的信号**：YouTube Music 自己标了这条视频是什么类型，
  // 不像"标题里有没有 Official"那样依赖上传者的命名习惯。
  // 官方 MV 常常标题只有歌名（"Blinding Lights"），靠标题永远判不出来，靠这个能。
  const videoType = String(candidate.videoType || '').trim().toUpperCase();
  if (videoType === 'MUSIC_VIDEO_TYPE_OMV') {
    score += w.ytmusicOmv;
    reasons.push(`YouTube Music 标注：官方 MV +${w.ytmusicOmv}`);
  } else if (videoType === 'MUSIC_VIDEO_TYPE_ATV') {
    score += w.ytmusicAtv;
    reasons.push(`YouTube Music 标注：Art track（只有封面图的音频）${w.ytmusicAtv}`);
    negative.push('Audio Only');
  } else if (videoType === 'MUSIC_VIDEO_TYPE_UGC') {
    score += w.ytmusicUgc;
    reasons.push(`YouTube Music 标注：用户上传（非官方）${w.ytmusicUgc}`);
    negative.push('Fan-made');
  }

  // 5) 时长：只判断"是不是同一首歌/同一个版本"，权重很低。
  //    规则来自实际需求：**相差不超过 30% 就算合理**（MV 常带剧情前奏/片尾）。
  const wantSeconds = track.durationMs ? Number(track.durationMs) / 1000 : null;
  const gotSeconds = Number.isFinite(Number(candidate.durationSeconds)) ? Number(candidate.durationSeconds) : null;
  if (wantSeconds && gotSeconds) {
    const ratio = Math.abs(gotSeconds - wantSeconds) / wantSeconds;
    const pct = Math.round(ratio * 100);
    if (ratio <= (w.durationRatioTolerance || 0.3)) {
      score += w.durationWithinRatio;
      reasons.push(`时长差 ${pct}%（≤30%，不扣分）`);
    } else {
      score += w.durationOutsideRatio;
      reasons.push(`时长差 ${pct}%（>30%） ${w.durationOutsideRatio}`);
    }
  } else {
    score += w.durationUnknown;
    reasons.push('无时长信息');
  }

  // 6) 视频类型负向词（标题 + 描述开头）
  const haystack = `${normVideoTitle} ${normalizeText(candidate.description || '').slice(0, 200)}`;
  for (const rule of config.negative) {
    if (rule.re.test(haystack)) {
      score += -config.negativeWeight;
      reasons.push(`负向词「${rule.hits}」 -${config.negativeWeight}`);
      negative.push(rule.hits);
      break; // 同一候选只扣一次
    }
  }

  // 7) 硬性排除（与负向词无关，只看 API 元数据）
  if (candidate.liveBroadcastContent && candidate.liveBroadcastContent !== 'none') {
    score += -config.negativeWeight;
    reasons.push(`直播/首映 -${config.negativeWeight}`);
    negative.push('Live/Concert');
  }
  if (candidate.privacyStatus && candidate.privacyStatus !== 'public') {
    score += -40;
    reasons.push(`非公开视频（${candidate.privacyStatus}） -40`);
    negative.push('Not public');
  }
  if (candidate.embeddable === false) {
    score += -40;
    reasons.push('不允许嵌入 -40');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score * 100) / 100)),
    reasons,
    negative,
  };
}

/** 供 API/前端展示：把评分规则原样吐出来（便于调参和解释） */
function describeConfig() {
  return {
    queryTemplates: QUERY_TEMPLATES,
    secondaryQueryTemplate: SECONDARY_QUERY_TEMPLATE,
    ytmusicQueryTemplates: YTMUSIC_QUERY_TEMPLATES,
    ytmusic: ytmusic.status(),
    ...CONFIG,
  };
}

// ---------------------------------------------------------------- 搜索 & 匹配

function buildQueries(track) {
  const artists = (track.artists || []).map(String).filter(Boolean);
  const artist = artists[0] || '';
  const title = cleanTitle(track.title || '');
  const out = [];
  for (const template of QUERY_TEMPLATES) {
    const q = template.replace('{artist}', artist).replace('{title}', title).replace(/\s+/g, ' ').trim();
    if (q && !out.includes(q)) out.push(q);
  }
  if (artists.length > 1) {
    const q = SECONDARY_QUERY_TEMPLATE
      .replace('{artists}', artists.join(' '))
      .replace('{title}', title)
      .replace(/\s+/g, ' ')
      .trim();
    if (q && !out.includes(q)) out.push(q);
  }
  return out.slice(0, Math.max(1, CONFIG.maxQueries));
}

function toCandidateRecord(id, info, scored) {
  return {
    videoId: id,
    title: info?.title || '',
    channelTitle: info?.channelTitle || '',
    channelId: info?.channelId || null,
    duration: Number.isFinite(info?.durationSeconds) ? info.durationSeconds : null,
    embeddable: info ? info.embeddable !== false : null,
    privacyStatus: info?.privacyStatus || null,
    liveBroadcastContent: info?.liveBroadcastContent || null,
    thumbnailUrl: info?.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    score: scored.score,
    reasons: scored.reasons,
    negative: scored.negative,
    // 这个候选是从哪儿来的：'ytmusic' = YouTube Music（免配额），'youtube' = 官方 Data API。
    // 管理员在曲库页能看到，排查"为什么选了它"时很有用。
    source: info?.source || null,
    videoType: info?.videoType || null,
  };
}

/** YouTube Music 的搜索词（见 YTMUSIC_QUERY_TEMPLATES 的说明） */
function buildYtmusicQueries(track) {
  const artists = (track.artists || []).map(String).filter(Boolean);
  const artist = artists[0] || '';
  const title = cleanTitle(track.title || '');
  const out = [];
  for (const template of YTMUSIC_QUERY_TEMPLATES) {
    const q = template
      .replace('{artist}', artist)
      .replace('{artists}', artists.join(' '))
      .replace('{title}', title)
      .replace(/\s+/g, ' ')
      .trim();
    if (q && !out.includes(q)) out.push(q);
  }
  return out.slice(0, 2);
}

/**
 * 用官方 API 的 videos.list 补齐候选的时长 / 可嵌入状态（一次最多 50 个 id，只花 1 单位）。
 *
 * 只在"官方 API 还能用"时才补：今日配额已经打满时硬调只会白白报错。
 * 补不到就返回空 Map —— 调用方按"时长未知、可嵌入未知"继续走，不会因此丢掉候选。
 */
async function fetchVideoDetails(videoIds) {
  if (!videoIds.length || !youtube.hasKey()) return new Map();
  if (youtube.quota().exhausted) return new Map();
  try {
    return await youtube.videos(videoIds);
  } catch {
    return new Map();
  }
}

/**
 * ① 首选源：YouTube Music（ytmusicapi），**不消耗官方 API 配额**。
 *
 * 拿不到任何候选时返回空数组（不抛错），由 searchCandidates() 落到官方 API 兜底。
 */
async function collectFromYtmusic(track, { limitPerQuery, failures = [] }) {
  const queries = buildYtmusicQueries(track);
  if (!queries.length || !ytmusic.enabled()) {
    return { candidates: [], queries, failures };
  }
  const found = await ytmusic.searchVideos(queries, { limit: limitPerQuery });
  const seen = new Map(); // videoId → ytmusic item
  for (const items of found.items.values()) {
    for (const item of items) if (item.videoId && !seen.has(item.videoId)) seen.set(item.videoId, item);
  }
  for (const [query, message] of Object.entries(found.errors || {})) {
    failures.push({ query, code: 'YTMUSIC_ERROR', message: String(message).slice(0, 200) });
  }
  if (!seen.size) return { candidates: [], queries, failures };

  // 官方 API 还能用就顺手补一下时长/可嵌入（1 单位，很便宜）；补不到也不影响结论
  const details = await fetchVideoDetails([...seen.keys()]);

  const candidates = [];
  for (const [videoId, item] of seen) {
    const info = details.get(videoId);
    if (info && (info.embeddable === false || (info.privacyStatus && info.privacyStatus !== 'public'))) continue;
    const merged = {
      // 官方 API 给的标题更完整（ytmusic 的标题偶尔带奇怪的空格），有就用它的
      title: info?.title || item.title || '',
      // ytmusic 不给频道名：把艺人列表当作"发布方"展示（评分里已经置空，不会重复计分）
      channelTitle: info?.channelTitle || (item.artists || []).join(', ') || '',
      channelId: info?.channelId || null,
      description: info?.description || '',
      durationSeconds: info?.durationSeconds ?? item.durationSeconds ?? null,
      embeddable: info?.embeddable ?? null,
      privacyStatus: info?.privacyStatus ?? null,
      liveBroadcastContent: info?.liveBroadcastContent ?? null,
      // ── ytmusic 专属字段：评分靠它们判断"是不是官方 MV" ──
      ytmusic: true,
      ytmusicArtists: item.artists || [],
      videoType: item.videoType || '',
      source: 'ytmusic',
    };
    const scored = scoreCandidate(merged, track);
    candidates.push(toCandidateRecord(videoId, { ...merged, thumbnailUrl: info?.thumbnailUrl || item.thumbnailUrl }, scored));
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, queries, failures };
}

/**
 * 搜索候选并按分数排序（**只读**，不写库）。
 *
 * 两段落：先 YouTube Music（免配额），拿不到候选再用官方 Data API 兜底。
 *
 * @param {{title: string, artists: string[], durationMs?: number}} track
 * @param {{limitPerQuery?: number}} opts
 * @returns {Promise<{candidates: Array, queries: string[], source?: string, reason?: string}>}
 */
async function searchCandidates(track, opts = {}) {
  const limitPerQuery = Math.max(1, Math.min(Number(opts.limitPerQuery) || CONFIG.maxResultsPerQuery, 25));
  const failures = [];

  // ── ① YouTube Music（ytmusicapi）：不占官方配额，优先 ──
  const ytm = await collectFromYtmusic(track, { limitPerQuery, failures });
  if (ytm.candidates.length) {
    return { candidates: ytm.candidates, queries: ytm.queries, failures, source: 'ytmusic', reason: null };
  }

  // ── ② 官方 YouTube Data API：兜底 ──
  const official = await collectFromOfficialApi(track, { limitPerQuery, failures });
  return { ...official, source: official.candidates.length ? 'youtube' : official.source };
}

/** 官方 Data API 的搜索（原 searchCandidates 的实现，拆出来便于"两段式"复用） */
async function collectFromOfficialApi(track, { limitPerQuery, failures = [] }) {
  const queries = buildQueries(track);
  const seen = new Map(); // videoId → search item
  let queryOk = 0;        // 成功的搜索词数量（0 = 所有搜索都失败了，不能当成"没有 MV"）

  for (const [index, query] of queries.entries()) {
    // 多个搜索之间留一点间隔：YouTube 对短时间连发的 search.list 很敏感（429）
    if (index > 0) await new Promise((r) => setTimeout(r, SEARCH_GAP_MS));
    try {
      const items = await youtube.search({ q: query, maxResults: limitPerQuery, videoEmbeddable: true });
      queryOk += 1;
      for (const item of items) if (item.videoId && !seen.has(item.videoId)) seen.set(item.videoId, item);
    } catch (error) {
      failures.push({ query, code: error.code || 'YOUTUBE_ERROR', message: error.message });
      // 没 Key / 配额用完 / 被限流：后面的搜索也不会成功，直接停
      if (['YOUTUBE_NO_KEY', 'YOUTUBE_QUOTA_GUARD', 'YOUTUBE_QUOTA_EXCEEDED', 'YOUTUBE_RATE_LIMITED'].includes(error.code)) break;
    }
  }

  if (!seen.size) {
    const fatal = failures.find((f) => ['YOUTUBE_NO_KEY', 'YOUTUBE_QUOTA_GUARD', 'YOUTUBE_QUOTA_EXCEEDED'].includes(f.code));
    return {
      candidates: [],
      queries,
      failures,
      // SEARCH_FAILED = 一次都没成功（网络/Key/配额问题，不是"没有 MV"）；
      // NO_RESULTS = 搜索成功了但真的一条都没有。
      reason: fatal ? fatal.code : (queryOk === 0 ? 'SEARCH_FAILED' : 'NO_RESULTS'),
    };
  }

  // 补齐时长 / embeddable / 直播状态（videos.list 一次最多 50 个，只花 1 单位）
  let details = new Map();
  try {
    details = await youtube.videos([...seen.keys()]);
  } catch (error) {
    // 详情拿不到就只按搜索结果打分（没有时长）；不因为这一步失败就放弃整体
    failures.push({ query: '(videos.list)', code: error.code || 'YOUTUBE_ERROR', message: error.message });
  }
  // 官方 API 的候选：来源标出来，方便管理员/日志区分
  const source = 'youtube';

  const candidates = [];
  for (const [videoId, item] of seen) {
    const info = details.get(videoId);
    // 明确不可嵌入 / 非公开的直接丢弃（不进候选列表，管理员也没法选）
    if (info && (info.embeddable === false || (info.privacyStatus && info.privacyStatus !== 'public'))) continue;
    const merged = {
      title: info?.title || item.title || '',
      channelTitle: info?.channelTitle || item.channelTitle || '',
      channelId: info?.channelId || item.channelId || null,
      description: info?.description || item.description || '',
      durationSeconds: info?.durationSeconds ?? null,
      embeddable: info?.embeddable ?? null,
      privacyStatus: info?.privacyStatus ?? null,
      liveBroadcastContent: info?.liveBroadcastContent ?? null,
      source,
    };
    const scored = scoreCandidate(merged, track);
    candidates.push(toCandidateRecord(videoId, { ...merged, thumbnailUrl: info?.thumbnailUrl || item.thumbnailUrl }, scored));
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, queries, failures, source: 'youtube', reason: candidates.length ? null : 'NO_EMBEDDABLE_CANDIDATES' };
}

/**
 * 根据候选列表得出匹配结论（纯函数，便于测试）。
 *
 * @returns {{status: string, chosen: object|null, reason: string}}
 */
/**
 * 匹配结论：高分才自动采用；中等分只保留候选，等管理员确认。
 *
 *   ≥ autoThreshold  → auto_matched（高置信度）
 *   ≥ pendingThreshold → pending（候选保留在库，人工确认后才作为背景）
 *   其余             → not_found（用模糊封面）
 *
 * 低分也自动采用会把「1 step forward, 3 steps back」匹配成同歌手的另一首
 * 「the cure」（实测 45 分）—— 这种错误 MV 比没有 MV 更糟，所以中等分不再自动采用。
 * 管理员仍然可以随时在曲库页查看/更换（换过就是 manually_confirmed，自动匹配不会覆盖）。
 */
function decide(candidates, config = CONFIG) {
  if (!candidates || !candidates.length) {
    return { status: 'not_found', chosen: null, reason: '没有可嵌入的候选视频' };
  }
  const best = candidates[0];
  const second = candidates[1] || null;
  if (best.score >= config.autoThreshold) {
    return {
      status: 'auto_matched',
      chosen: best,
      reason: `自动选用最高分 ${best.score}（第二名 ${second ? second.score : '—'}）；${best.reasons.join('；')}`,
    };
  }
  if (best.score >= config.pendingThreshold) {
    return {
      status: 'pending',
      chosen: best,
      weak: true,
      reason: `最高分 ${best.score} 置信度不足（< ${config.autoThreshold}），保留候选等待人工确认；${best.reasons.join('；')}`,
    };
  }
  return {
    status: 'not_found',
    chosen: null,
    reason: `最高分只有 ${best.score}（< ${config.pendingThreshold}），没有像样的 MV 候选`,
  };
}

// ---------------------------------------------------------------- 对外主流程

/** 曲库里的 visual 记录 → 播放/API 用的形状（没有记录时给 pending 空值） */
/** 空记录：表示"没有 MV / 还没匹配"。调用方据此回退模糊封面。 */
function emptyVisual() {
  return {
    visualVideoId: null,
    visualMatchStatus: 'pending',
    visualMatchScore: null,
    visualVideoTitle: null,
    visualChannelTitle: null,
    visualDuration: null,
    visualMatchReason: null,
    visualMatchedAt: null,
  };
}

/**
 * 曲库记录 → 前端形状。**两种输入都认**：
 *   * `libraryDb.getVisual()`：已经是驼峰形状（visualVideoId…，**没有 track 元数据**）；
 *   * `libraryDb.getVisualRow()` / python 的原始行：下划线形状（visual_video_id…），
 *     并且**同时带有** spotifyId / title / artists 等曲目元数据 ——
 *     所以绝不能用 `...row` 展开（会把驼峰字段覆盖成 undefined）。
 */
function fromRow(row) {
  if (!row) return emptyVisual();
  // libraryDb.updateVisual() 返回 {ok, visual}：自动拆包，避免调用方误传整个结果对象
  if (row.visual && typeof row.visual === 'object' && row.visualVideoId === undefined && row.visual_video_id === undefined) {
    return fromRow(row.visual);
  }
  if (row.visualVideoId !== undefined && row.visual_video_id === undefined) {
    // 驼峰形状（getVisual 的返回）
    return {
      ...emptyVisual(),
      visualVideoId: row.visualVideoId || null,
      visualMatchStatus: row.visualMatchStatus || 'pending',
      visualMatchScore: row.visualMatchScore ?? null,
      visualVideoTitle: row.visualVideoTitle || null,
      visualChannelTitle: row.visualChannelTitle || null,
      visualDuration: row.visualDuration ?? null,
      visualMatchReason: row.visualMatchReason || null,
      visualMatchedAt: row.visualMatchedAt || null,
      candidates: Array.isArray(row.candidates) ? row.candidates : [],
    };
  }
  // 下划线形状（原始行 / getVisualRow）
  return {
    visualVideoId: row.visual_video_id || null,
    visualMatchStatus: row.visual_match_status || 'pending',
    visualMatchScore: row.visual_match_score ?? null,
    visualVideoTitle: row.visual_video_title || null,
    visualChannelTitle: row.visual_channel_title || null,
    visualDuration: row.visual_duration ?? null,
    visualMatchReason: row.visual_match_reason || null,
    visualMatchedAt: row.visual_matched_at || null,
  };
}

/** 这条记录能否直接拿来播放（不会再用 YouTube 搜索） */
function isReusable(visual) {
  if (!visual || !visual.visualVideoId) return false;
  return ['auto_matched', 'manually_confirmed'].includes(visual.visualMatchStatus);
}

/**
 * 解析一首歌的官方 MV（幂等、节流）：
 *   - 已有可复用的结果 → 原样返回，**不调用 YouTube**；
 *   - 否则搜索 + 打分 → 写库（除非是 manually_confirmed，自动匹配不会覆盖）。
 *
 * force = true：管理员点「重新搜索」——即使已有结果也重新搜；
 *              但仍不会覆盖 manually_confirmed（要覆盖请用 confirm/custom）。
 *
 * @returns {Promise<{status, visual, searched: boolean, reason?: string, candidates?: Array}>}
 */
async function resolve({ spotifyId, track = null, force = false, limitPerQuery } = {}) {
  const id = String(spotifyId || '');
  if (!id) throw new Error('resolve 需要 spotifyId');
  const meta = track || libraryDb.getTrack(id);
  if (!meta) return { status: 'pending', visual: emptyVisual(), searched: false, reason: '曲库里没有这首歌' };

  const row = libraryDb.getVisualRow(id);
  const current = fromRow(row);

  if (!force) {
    if (isReusable(current)) {
      return { status: current.visualMatchStatus, visual: current, searched: false, reason: '复用已保存的 MV' };
    }
    // 管理员明确选了「用模糊封面」：这是拍板结果，自动匹配不许覆盖，也不再浪费配额重搜。
    if (current.visualMatchStatus === 'cover_only') {
      return { status: 'cover_only', visual: current, searched: false, reason: '管理员已选择使用模糊封面' };
    }
    // 最近一次搜索已经下过结论（not_found / 未达阈值）→ 不重复打 API，
    // 免得每次启动都重搜；管理员点「重新搜索」走 force 才会再来一次。
    if (current.visualMatchedAt && ['not_found', 'pending', 'unavailable'].includes(current.visualMatchStatus) && row?.visual_candidates) {
      return { status: current.visualMatchStatus, visual: current, searched: false, reason: '已有搜索结论，跳过（需要重搜请点「重新搜索」）' };
    }
  }

  const found = await searchCandidates(
    { title: meta.title || '', artists: meta.artists || [], durationMs: meta.durationMs || null },
    { limitPerQuery },
  );

  if (!found.candidates.length) {
    // "搜不到" 和 "没法搜" 是两回事：
    //   SEARCH_FAILED / 没 Key / 配额 / 网络/HTTP 错误 → 这次不算结论，保持原状态（之后还能再试）；
    //   NO_RESULTS / 没有可嵌入的候选 → 确实是 not_found，记下来避免反复搜索。
    // YOUTUBE_RATE_LIMITED（429）也算"暂时失败"：不写 not_found，保持原状态，下次（或刷新缓存后）再试。
    const TRANSIENT_CODES = ['YOUTUBE_NO_KEY', 'YOUTUBE_QUOTA_GUARD', 'YOUTUBE_QUOTA_EXCEEDED', 'YOUTUBE_NETWORK', 'YOUTUBE_HTTP_ERROR', 'YOUTUBE_RATE_LIMITED'];
    const transient = TRANSIENT_CODES.includes(found.reason)
      || found.reason === 'SEARCH_FAILED'
      || Boolean(found.failures?.some((f) => TRANSIENT_CODES.includes(f.code)));
    if (transient) {
      // 网络/配额/Key/限流问题不是"没有 MV"：不改状态，下次（或管理员重试）再来。
      // rateLimited 单独标出来，让"一键匹配"能识别成"跳过稍后重试"，而不是算成功。
      const rateLimited = found.reason === 'YOUTUBE_RATE_LIMITED'
        || Boolean(found.failures?.some((f) => f.code === 'YOUTUBE_RATE_LIMITED'));
      return {
        status: current.visualMatchStatus,
        visual: current,
        searched: false,
        rateLimited,
        source: found.source || null,
        reason: found.reason,
      };
    }
    const visual = libraryDb.updateVisual(id, {
      status: 'not_found',
      reason: found.reason === 'SEARCH_FAILED' ? '搜索失败' : '没有可嵌入的候选视频',
      candidates: [],
    });
    return { status: 'not_found', visual: fromRow(visual), searched: true, source: found.source || null, reason: found.reason };
  }

  const verdict = decide(found.candidates);
  const topCandidates = found.candidates.slice(0, 8).map(({ videoId, title, channelTitle, duration, score, reasons, embeddable, thumbnailUrl, source, videoType }) => ({
    videoId, title, channelTitle, duration, score, reasons, embeddable, thumbnailUrl, source, videoType,
  }));
  const chosen = verdict.chosen;
  const visual = libraryDb.updateVisual(id, {
    status: verdict.status,
    video_id: chosen?.videoId || null,
    video_title: chosen?.title || null,
    channel_title: chosen?.channelTitle || null,
    duration: chosen?.duration ?? null,
    score: chosen?.score ?? (found.candidates[0]?.score ?? null),
    reason: verdict.reason,
    candidates: topCandidates,
  });
  return {
    status: verdict.status,
    visual: fromRow(visual),
    searched: true,
    candidates: topCandidates,
    source: found.source || null,
    reason: verdict.reason,
  };
}

/**
 * 播放端报告"这个 MV 放不出来"（IFrame onError / 初始化失败 / 不可嵌入）。
 * 把状态改成 unavailable 并记录原因 —— 下次不再自动加载同一个坏视频（播放端回退模糊封面）。
 */
function markUnavailable(spotifyId, { videoId = null, reason = '' } = {}) {
  const id = String(spotifyId || '');
  if (!id) return null;
  const row = libraryDb.getVisualRow(id);
  if (!row) return null;
  // 只有当报告的就是当前保存的那个视频时才改状态：用户手动改了 MV 之后，
  // 旧播放器的迟到的 onError 不应该把新视频标成坏掉。
  if (videoId && row.visual_video_id && videoId !== row.visual_video_id) {
    return fromRow(row);
  }
  const visual = libraryDb.updateVisual(id, {
    status: 'unavailable',
    reason: `播放失败：${String(reason || 'YouTube 播放器报错').slice(0, 300)}`,
  });
  return fromRow(visual);
}

/** 管理员手动确认/选择（force：覆盖任何已有状态，包括之前的手动确认） */
function confirm(spotifyId, { videoId, title = null, channelTitle = null, duration = null, score = null, reason = null } = {}) {
  const id = String(spotifyId || '');
  const row = libraryDb.getVisualRow(id);
  if (!row) return { ok: false, reason: 'TRACK_NOT_FOUND' };
  if (videoId !== undefined && videoId !== null && videoId !== '' && !/^[A-Za-z0-9_-]{11}$/.test(String(videoId))) {
    return { ok: false, reason: 'BAD_VIDEO_ID' };
  }
  const visual = libraryDb.updateVisual(id, {
    status: 'manually_confirmed',
    video_id: videoId || null,
    video_title: title,
    channel_title: channelTitle,
    duration,
    score,
    reason: reason || '管理员手动确认',
    force: true,
  });
  return { ok: true, visual: fromRow(visual) };
}

/** 管理员清除 MV（回到 pending + 空 videoId，播放时回退模糊封面） */
function clear(spotifyId) {
  const row = libraryDb.getVisualRow(String(spotifyId || ''));
  if (!row) return { ok: false, reason: 'TRACK_NOT_FOUND' };
  const visual = libraryDb.updateVisual(String(spotifyId), { clear: true, force: true });
  return { ok: true, visual: fromRow(visual) };
}

/**
 * 管理员明确选择「使用模糊封面」（不播 MV，也不让自动匹配再补回来）。
 *
 * 和 clear() 的区别：
 *   * clear  → 回到 pending（"还没定"），自动匹配会再搜，播放时也会用搜到的 MV；
 *   * 本函数 → cover_only（"就定用封面"），自动匹配跳过，播放时一定是模糊封面。
 * 候选列表保留，管理员随时还能从候选里换回某个 MV。
 */
function chooseCover(spotifyId, { reason = '管理员选择使用模糊封面' } = {}) {
  const id = String(spotifyId || '');
  const row = libraryDb.getVisualRow(id);
  if (!row) return { ok: false, reason: 'TRACK_NOT_FOUND' };
  const visual = libraryDb.updateVisual(id, {
    status: 'cover_only',
    video_id: null,
    video_title: '',
    channel_title: '',
    duration: null,
    score: null,
    reason,
    force: true,
  });
  if (!visual || visual.ok === false) return { ok: false, reason: visual?.reason || 'db-error' };
  return { ok: true, visual: fromRow(visual) };
}

module.exports = {
  CONFIG,
  QUERY_TEMPLATES,
  SECONDARY_QUERY_TEMPLATE,
  YTMUSIC_QUERY_TEMPLATES,
  cleanTitle,
  normalizeText,
  scoreCandidate,
  searchCandidates,
  collectFromYtmusic,
  decide,
  buildQueries,
  buildYtmusicQueries,
  resolve,
  markUnavailable,
  confirm,
  clear,
  chooseCover,
  emptyVisual,
  fromRow,
  isReusable,
  describeConfig,
};
