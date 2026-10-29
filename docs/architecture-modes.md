# 模式 A / 模式 B —— 概念定义与目标架构

> 写于 2026-10-28，用于**防止混淆**。实现前先读这一页。

---

## 1. 两个"模式"是两条正交的轴

| 轴 | 字段 | 取值 | 含义 | 状态 |
| --- | --- | --- | --- | --- |
| **音源** | `sourceMode` | `youtube` / `local` | 歌从哪来、怎么处理 | ❌ 未做 |
| **画面** | `playbackMode` | `video` / `lyrics` | 播放时画面长什么样 | ✅ 已做 |

用户的「模式 A / 模式 B」= **音源轴**，不是画面轴。

### 组合的可行性

| 音源 | 画面 | 是否可行 | 说明 |
| --- | --- | --- | --- |
| A：YouTube | 视频 | ✅ 现状 | 直接嵌 YouTube 卡拉OK视频 |
| A：YouTube | 歌词 | ✅ 已实现 | 只有音频，歌词按标题查 |
| B：本地 Demucs | 歌词 | ⬜ 待做 | 模式 B 的最终形态 |
| B：本地 | 视频 | ❌ 无意义 | 没有视频 |

---

## 2. 模式 A（现状，YouTube 原生）

```
控制台 / admin
  └─ 搜索框  →  GET /api/youtube/search  →  YouTube Data API
       └─ 点"点歌"  →  写入 state.songs（videoId / title / thumbnailUrl）
            └─ display 页  →  YT.Player(videoId)  →  全屏视频
```

- 搜索、元数据、播放**全部走 YouTube**
- 无本地文件、无数据库、无分离
- 代码全在 `karaoke-hub\server.js` + `public\app.js`

---

## 3. 模式 B（目标，Spotify → 本地 → Demucs）

```
控制台 / admin
  └─ 搜索框  →  GET /api/spotify/search  →  Spotify Web API（client_credentials）
       └─ 点"点歌"  →  写 SQLite tracks（spotify_id 唯一，去重）
            └─ 后台任务（异步）
                 1. resolve   : Spotify 元数据 → YouTube 匹配（时长/歌手评分）→ yt-dlp 下载
                 2. transcode : → 44.1kHz/16bit/stereo WAV
                 3. separate  : Demucs htdemucs on XPU → drums/bass/other/vocals
                 4. lyrics    : lrclib → QQ 降级 → 写 lyrics 表
                 5. encode    : 4 轨 → MP3 320k（省 77%）
            └─ display 页  →  <audio> 播本地文件 + Web Audio 混音 + 歌词视图
```

### 关键设计约束

1. **`spotify_id` 是唯一键**，重复点歌不重复下载（`tracks.spotify_id UNIQUE` + `audio_sha256`）
2. **人声轨必须保留**，用于原唱开关 / 引导音量（`vocals.mp3` 单独存）
3. **伴奏不单独存**：播放时 `drums + bass + other` 实时求和
   - 实测证明 `sum_non_vocals ≡ mix - vocals`（Demucs 四轨严格加性分解）
4. **引导音量播放时实时混**，不预渲染多版本（避免叠加编码损失）
5. **匹配必须校验时长**：同一搜索词会返回 Live Aid 版（165s）而 Spotify 是 355s，不校验就下错歌
6. **不猜**：匹配分低于阈值就判失败并记录原因，不下载错误音频

---

## 4. 现在的代码分布（这是最容易搞混的地方）

```
D:\Projects\spotify\
├── karaoke-hub\                    ← 【唯一交付工程】控制台
│   ├── server.js                   模式 A 全部 + playbackMode + 歌词接口
│   ├── public\app.js               display / admin / join
│   ├── public\lyrics-view.js       ✅ 歌词画面（模式 B 的显示层）
│   ├── launcher\main.js            启动服务 + 内网穿透
│   └── tests\playback-lyrics.test.js  15/15
│
├── server.js                       ← 实验服务器（945 行），NOT 控制台
│                                    模式 B 后端：Spotify 搜索 / 曲库 API / 音频任务
├── lib\spotify.js                  Spotify 客户端（PKCE + client_credentials）
├── lib\qq-lyrics.js                QQ 音乐歌词源
├── python\library.py               SQLite 数据层
├── python\worker.py                常驻 Demucs worker（JSON 行协议）
├── scripts\pipeline.py             ← 模式 B 流水线（CLI，手动逐段跑）
├── scripts\fetch_audio.py          YouTube 匹配下载
├── scripts\fetch_lyrics.py         lrclib
├── scripts\encode_mp3.py           MP3 320k
├── scripts\mix_karaoke.py          引导人声混音
├── data\library.db                 SQLite 曲库
├── assets\output\library\<id>\     4 轨 stem 输出
└── .tmp\kh-writable\               ← 废稿，不要再用
```

**核心事实**：模式 B 的代码**全部在控制台之外**，两边没有任何连接。
karaoke-hub 里 `spotify` / `demucs` / `library.db` / `/media/` 出现 **0 次**（grep 实测）。

---

## 5. 整合的 7 项差距

| # | 缺什么 | 工作量 | 风险 |
| --- | --- | --- | --- |
| 1 | `lib/spotify.js` 合并进 karaoke-hub | 小 | 无 |
| 2 | `sourceMode` 设置 + 控制台开关 | 小 | 无 |
| 3 | 队列项支持 `source: 'local'` | **中** | 要扩 `state.songs`，可能回归 |
| 4 | 后台任务：控制台调 Python | **中** | spawn 在 AI 会话里 EPERM，无法完整验证 |
| 5 | `/media/library/*` + Range | 小 | 无 |
| 6 | SQLite 接控制台（`node:sqlite` 只读） | 小 | 无 |
| 7 | 本地播放 + Web Audio 混音 | **中** | 无 |

---

## 6. 两种执行顺序（待用户决策）

**模式 B 中，一首歌什么时候开始处理？**

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| (a) 入队即处理 | 轮到播放时已就绪，等待少 | 用户中途删歌会浪费算力（一首 ~40s 分离） |
| (b) 轮播前处理 | 省资源 | 切歌会卡（冷启 ~6s + 分离 ~40s） |

**已实现 (a)。** 入队即处理，同时最多 3 首；GPU 分离与成片由跨进程文件锁串行，
下载/歌词/成片互相重叠（见 `docs/background-download.md`）。删除队列项不取消制作。
