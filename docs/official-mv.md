# 官方 MV（visualVideoId）—— 视频模式的背景画面

> 模式 B 的 Video Mode 背景从"本地 720p/1080p `video.mp4`"改成了 **YouTube 官方 MV 在线播放**。
> 本文说明三种资源怎么区分、匹配算法、数据库字段、管理接口和播放端行为。

---

## 1. 三种资源，别混

| 资源 | 字段 / 位置 | 用途 | 是否下载 | 生命周期 |
| --- | --- | --- | --- | --- |
| **音频处理输入** | `tracks.source_video_id` → `data/library/<videoId>.wav` | yt-dlp / spotDL 从 YouTube 取音频（**先下媒体文件，再 ffmpeg 抽成 44.1k WAV**） | 是 | 成片成功后由 `pipeline.py` 的 `cleanup` 删除 |
| **最终 MP3** | `assets/output/library/<spotifyId>/{accompaniment,vocals,guide,original}.mp3` | KaraokeMixer 唯一音频来源 | — | **长期保留** |
| **官方 MV** | `tracks.visual_video_id` | 视频模式的背景画面，YouTube IFrame **静音**在线播放 | **否** | 只存 11 位 videoId + 元数据 |

`source_video_id` 与 `visual_video_id` 是**两个独立的列**，写入函数也是两个
（`update_source()` / `update_visual()`），任何一方都不会覆盖另一方。
旧版管线下载的本地背景 `video.mp4` 已彻底移除（`fetch_audio.py --keep-video`、
`scripts/add_video.py` 都删掉了）。

---

## 2. 工作流程

```
Spotify Track（title / artists / duration_ms / release_date）
        │
        ├───────────────────────────────┐
        ▼                               ▼
  Audio Pipeline                  Official MV Resolver（lib/official-mv.js）
  fetch_audio → WAV                     │ ① 已有 auto_matched / manually_confirmed → 直接复用
        │                               │ ② 构造搜索词 → YouTube Data API search.list
  Demucs → 4 轨                         │ ③ videos.list 补时长 / embeddable / privacyStatus
        │                               │ ④ 逐个候选打分 → 排除 Live / Lyric / Audio / Karaoke…
  finalize → 4 个 MP3                   │ ⑤ 高置信度 → auto_matched；低置信度 → pending
        │                               │ ⑥ 没找到 → not_found
        ▼                               ▼
  cleanup 删除临时 WAV            visual_video_id（SQLite）
        │                               │
        └──────────────┬────────────────┘
                       ▼
                 Video Mode（大屏）
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
YouTube IFrame(Muted)          模糊专辑封面（回退）
        │
   歌词叠加（逐字/逐行）
```

触发时机（`server.js`）：

- **自动**：后台制作任务开始/完成时（`syncPrepareState` → `maybeStartMvResolve`），
  以及在队列里但还没匹配过的歌。MV 匹配是**并行**阶段：只调 YouTube Data API，
  不占 GPU/CPU，失败**不影响**音频制作成败。
- **手动**：DJ 在「曲库管理 → MV」里点「重新搜索」。
- 已有结论的歌（`not_found` / `pending` 且已记录过候选）不会每次启动都重搜；
  只有管理员点「重新搜索」才会再打 API。

---

## 3. 搜索与评分

### 3.0 两个候选源：**YouTube Music 优先，官方 Data API 兜底**

官方 Data API 每天只有 10,000 单位，`search.list` 一次就 100 单位 —— 一次匹配三个
搜索词 = 300 单位，批量补几十首歌很容易把配额打光，之后整晚都只能用模糊封面。

所以候选搜索分两段（`searchCandidates()`）：

```
① YouTube Music（scripts/ytmusic_mv.py + lib/ytmusic.js）  ← 首选
     · 走 YouTube Music 自己的接口（ytmusicapi），**没有每日配额**
     · 结果带 videoType：OMV=官方 MV / ATV=Art track（只有封面图的音频）/ UGC=用户上传
     · 拿不到候选（没装 / 网络问题 / 真的没有）才往下走
② 官方 YouTube Data API（lib/youtube.js）                ← 兜底
     · 原来的三词搜索 + videos.list 补元数据
```

`videoType` 是官方 API **没有**的信号，比"标题里有没有 Official"更可靠：很多真·官方 MV
的标题只有歌名（例：`Blinding Lights`）。所以即使官方 API 配额完好，也优先问 YouTube Music。

| videoType | 含义 | 评分 |
| --- | --- | --- |
| `MUSIC_VIDEO_TYPE_OMV` | 官方 MV | **+35** |
| `MUSIC_VIDEO_TYPE_ATV` | Art track（自动生成静态封面的音频，等于 Topic） | −25 且记 `Audio Only` |
| `MUSIC_VIDEO_TYPE_UGC` | 用户上传（翻唱 / 二创 / 现场） | −25 且记 `Fan-made` |

实现细节：Python 在**子进程**里跑（一次搜索 1~3 秒，不能卡住点歌的 HTTP 响应），
结果按查询词缓存 6 小时；失败后歇 10 分钟（`KARAOKE_YTMUSIC_COOLDOWN_MS`），期间
`ytmusic.enabled()` 为 false，官方 API 无缝接管。`KARAOKE_YTMUSIC=0` 可彻底关掉。

搜索词也不一样：YouTube Music 本身就是音乐搜索引擎，加 `Official Music Video`
反而把结果带偏，所以只用「歌手 + 歌名」（`YTMUSIC_QUERY_TEMPLATES`）。

### 3.1 搜索词（官方 API 那一路，`CONFIG` 集中在 `lib/official-mv.js` 顶部）

歌名先做 `cleanTitle()`：去掉括号/方括号里的版本说明（`From "…"`、`Remastered`、`feat. …`）、
`feat./ft./featuring/with` 之后的部分、`Remix/Edit/Version` 后缀。

```
{artist} {title} Official Music Video
{artist} {title} Official Video
{artist} {title} MV
{artists} {title} Official Video      ← 只在有多个歌手时追加（合唱常在第二歌手频道）
```

最多取前 3 个（`maxQueries`），每个搜索词 `maxResultsPerQuery = 8`。
`videoEmbeddable=true` 让 API 层先过滤掉不能嵌入的视频；
`videos.list` 再拿 `status.embeddable / privacyStatus / contentDetails.duration / liveBroadcastContent`，
**明确不可嵌入或非公开的直接不进候选**（管理员也没法选）。

### 3.2 评分维度（满分 100）

| 维度 | 规则 | 分值 |
| --- | --- | --- |
| 歌名 | 标题包含完整歌名（去标点后比较） | **+30** |
| | 含 ≥60% 的歌名词 | +18 × 比例 |
| | 完全不含 | **−30** |
| 艺人 | 标题或频道名含主歌手 | +15 |
| | 含合作歌手 | +8 |
| 官方标识 | 标题含 `Official Music Video` / `Official Video` / `Official MV` | +12 |
| 频道 | VEVO / Official / Records / Music 且含歌手名 | **+20** |
| | 名字像官方但**不含**歌手名 / 频道名含歌手名（弱证据） | +10 |
| | `… - Topic`（自动生成的音频频道） | −20 且记 `Topic Audio` |
| 时长 | 与 Spotify 差 ≤ 8s | +10 |
| | ≤ 25s | +5 |
| | ≤ 60s | −8 |
| | > 60s | **−20** |
| 负向词（标题+描述） | Live/Concert、Lyric Video、Audio、Karaoke、Cover、Reaction、Tutorial、Shorts、Remix、Fan-made、Loop/Extended | **−25** |
| API 元数据 | `liveBroadcastContent ≠ none` | −25 |
| | 非公开 | −40 |
| | 不允许嵌入 | −40 |
| **YouTube Music `videoType`** | `OMV`（官方 MV） | **+35** |
| | `ATV`（Art track，只有封面图的音频） | −25 且记 `Audio Only` |
| | `UGC`（用户上传） | −25 且记 `Fan-made` |

> **不只看标题里的 `Official`**：`Official Lyric Video` 也会命中官方标识，但会被
> "Lyric Video" 负向词扣掉 25 分；频道官方性也不是只看名字 —— 必须"频道风格像官方"
> **且** "能对上歌手"才给满分 20。

评分明细会原样保存（`visual_match_reason`）并在曲库页的 MV 弹窗里显示，方便解释"为什么选了它"。

### 3.3 两级阈值

| 条件 | 结果 |
| --- | --- |
| 最高分 ≥ `autoThreshold(70)` **且** 领先第二名 ≥ `minMargin(12)` | `auto_matched`（自动采用） |
| 最高分 ≥ `pendingThreshold(45)` 但差距不够 | `pending`（**保存候选**，等管理员选） |
| 最高分 < 45，或没有可嵌入候选 | `not_found` |
| 没 Key / 配额 / 网络错误 | **不写状态**（保持原样），下次再试 |

阈值、权重、负向词都在 `lib/official-mv.js` 的 `CONFIG` 里，改完重启服务生效；
`GET /api/library/admin/tracks/:id/mv` 会把它返回给前端展示。

### 3.4 配额与缓存（`lib/youtube.js`）

- `search.list` = 100 单位/次、`videos.list` = 1 单位/次（YouTube 每天 10000）。
- 搜索结果缓存 6 小时，视频详情缓存 24 小时。
- 进程内预算 `YOUTUBE_DAILY_UNIT_BUDGET`（默认 4500），超出后不再发起新的 search
  （留一半给模式 A 的搜索框），抛 `YOUTUBE_QUOTA_GUARD`，Resolver 当作"暂时搜不到"。
- API Key **只从环境变量 / 控制面板配置读**，不写进代码。

**被 429 之后**：`lib/youtube.js` 会设一个冷却并**落盘**（`data/youtube-cooldown.json`），
避免重启后立刻继续撞 429。区分两种：

| 情况 | 冷却到 | 前端表现 |
| --- | --- | --- |
| 短时限流（429） | `RATE_LIMIT_COOLDOWN_MS`（默认 10 分钟） | 一键匹配按钮变红 |
| **每日配额用完**（`Search Queries per day`） | 下一个太平洋时间零点 | 一键匹配按钮变红 |

**红色 ≠ 禁用。** 以前配额用完时按钮直接 `disabled` + 一行"今天配额已用完，明天自动恢复"，
等于判死刑——明明可以手动再试一次却被挡住。现在的交互是：

1. 按钮变**红色**但仍可点，旁边一个「配额受限」小标；
2. 点下去弹**二次确认**（文案会说明"将改用 YouTube Music 源（无配额限制）"）；
3. 确认后带 `force: true` 请求 → 服务端先 `youtube.clearCooldown()` 清掉冷却，
   让官方 API 真的再试一次，同时 MV 匹配本来就优先走免配额的 YouTube Music。

即使官方 API 全天不可用，只要 Python 环境里有 `ytmusicapi`，匹配依然能跑完。

---

## 4. 数据库字段与迁移

`python/schema.sql` 的 `tracks` 表新增：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `visual_video_id` | TEXT | YouTube videoId（11 位） |
| `visual_match_status` | TEXT DEFAULT `'pending'` | `pending / auto_matched / manually_confirmed / not_found / unavailable` |
| `visual_match_score` | REAL | 0–100 |
| `visual_video_title` | TEXT | 视频标题 |
| `visual_channel_title` | TEXT | 频道名 |
| `visual_duration` | INTEGER | 秒 |
| `visual_match_reason` | TEXT | 评分明细 / 失败原因 |
| `visual_matched_at` | TEXT | 匹配时间 |
| `visual_candidates` | TEXT | JSON 数组：上次搜索的候选（管理员挑选用） |

迁移在 `python/library.py` 的 `_MIGRATIONS` / `_migrate()`：

- `init_db()` 现在**先 `_migrate()` 再执行 `schema.sql`**。原因：`schema.sql` 里有
  `CREATE INDEX ... ON tracks(visual_video_id)`，而 `CREATE TABLE IF NOT EXISTS`
  不会给老表加列，先跑 schema 会让老库直接报 `no such column`。
- 可重复执行：列已存在就跳过；`visual_match_status` 带 `DEFAULT 'pending'`，
  老曲目迁移后自动是"待匹配"。
- 不影响 `source_video_id`、音频路径、播放队列、原有处理状态。
- Node 侧（`lib/library-db.js`）用 `hasVisualColumns()` 判断列是否存在，
  老库（服务运行期间还没被 Python 迁移）时用 `NULL AS visual_*` 兜底，接口不会 500。

---

## 5. 管理员怎么管

入口：**控制台 → 曲库管理**（`/library`）→ 每行的「MV」列 + 「MV」按钮。

| 能看到 | 状态徽章（自动匹配 / 已确认 / 待确认 / 不可用 / 未找到 + 分数）、视频标题、
频道名、时长、悬停显示评分明细 |
| --- | --- |
| 顶部筛选 | 「MV：全部 / 待确认 / 自动匹配 / …」，带各自数量 |
| 弹窗里能做的 | 重新搜索 · 从候选里「选用」· 手填 videoId · 确认当前 MV · 清除 |

对应的接口（都需要 DJ token）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/library/admin/tracks/:spotifyId/mv` | 当前 MV + 候选 + 评分配置 |
| POST | 同上 `{action:'search'}` | 重新搜索（不覆盖"已确认"） |
| POST | `{action:'select', videoId}` | 从候选中选一个 → `manually_confirmed` |
| POST | `{action:'custom', videoId}` | 手填（会校验视频存在且可嵌入） |
| POST | `{action:'confirm', videoId?}` | 确认当前保存的就是官方 MV |
| POST | `{action:'clear'}` | 清除 → `pending` + 空 videoId（播放回退封面） |
| POST | `/api/display/visual-error` `{spotifyId, videoId, reason, code}` | 大屏上报"这个 MV 放不出来" → `unavailable` |

**手动确认的不会被自动匹配覆盖**（`update_visual` 里 `manually_confirmed` 是锁定态，
除非管理员显式操作或 `status='unavailable'`）。

---

## 6. 播放端行为（`public/video-lyrics-mode.js` + `app.js`）

- 画面层：`.vlm-mv` 里放 YouTube IFrame（`youtube-nocookie.com`、`controls:1`、
  **`mute:1`**），按 16:9 放大铺满后裁剪。**不隐藏播放器、不伪造交互**。
- 音频：始终是 KaraokeMixer 的本地 MP3；MV 永远静音（`onReady` / 播放中都再 `mute()` 一次）。
- 同步：**不做时间轴同步**，也不调 `seekTo`：

  | 本地音频 | YouTube MV |
  | --- | --- |
  | Play / Pause / Resume | 跟随 |
  | Stop / 歌曲结束 | `stopVideo()` |
  | 切歌 | 销毁旧播放器 → 加载新 MV |
  | MV 比歌短 | `onStateChange=ENDED` 时 `loadVideoById` 重头循环 |
  | MV 比歌长 | 随歌结束停止 |

- 回退（以下任一情况都退回模糊专辑封面，歌词/音频不受影响）：
  没有 videoId、尚未匹配、`not_found` / `unavailable`、非法 id、IFrame API 加载失败、
  播放器 ready 超时（9s）、`onError`（2/5/100/101/150）、网络错误、播放中被删/转私密。
  失败时还会调 `POST /api/display/visual-error`，把状态写成 `unavailable`，
  下次不再自动加载同一个坏视频。
