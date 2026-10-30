# Spotify Karaoke Local —— 模式 B · 本地曲库版

> 与 `D:\Projects\spotify\karaoke-hub`（模式 A · YouTube 版）是**两套完全独立的工程**。
> 不同目录、不同端口、不同状态文件，改这里不会影响那边。

## 这是什么

一个**自包含**的局域网卡拉OK控制台。音源是本地分离好的曲目：

- 搜索走**本地 SQLite 曲库**
- 每首歌有 4 个 MP3：伴奏 / 人声 / 引导 / 原曲
- 播放时用 **Web Audio 双源混音**，人声强度 0–100% 连续可调
- 画面是仿 Apple Music 的歌词页，支持**逐字高亮**（QQ 音乐 QRC）

## 快速开始

> 本工程已并入 `D:\Projects\Karaduoke` 双模式项目。
> **启动入口在项目根**：双击 `Karaduoke\启动卡拉OK.cmd`（控制面板 8787，可切换 A/B 模式）。
> 也可以在本目录直接 
ode main.js` 单独跑服务（不使用控制面板）。

服务端口由项目根 `config\config.json` 统一管理（A/B 两个模式共用同一个端口，默认 **3100**）。

## 目录结构

```
karaoke_spo\
├── server.js                  服务端（含模式 B 定制）
├── main.js                    直接启动服务的入口
├── public\                    前台页面（admin / join / display）
│   ├── lyrics-view.js/css     歌词视图（Apple Music 风格）
│   ├── video-lyrics-mode.js/css  视频模式：YouTube 官方 MV（静音）+ 两行歌词
│   ├── karaoke-mixer.js       Web Audio 双源混音
│   └── lyrics-preview.html    歌词/混音预览页
├── lib\
│   ├── library-db.js          曲库访问（node:sqlite，含官方 MV 读写）
│   ├── official-mv.js         官方 MV Resolver（搜索 / 评分 / 状态机）
│   ├── youtube.js             YouTube Data API 唯一客户端（配额 / 缓存）
│   ├── qrc-decrypt.js         QQ QRC 逐字歌词解密
│   ├── qq-lyrics.js           歌词源
│   └── spotify.js             Spotify 元数据
├── python\
│   ├── （环境在项目根 env\python）
│   ├── library.py             SQLite 数据层
│   ├── schema.sql             表结构
│   └── worker.py              常驻分离 worker
├── scripts\
│   ├── pipeline.py            流水线（metadata/download/lyrics/separate/finalize/cleanup）
│   ├── fetch_audio.py         YouTube 匹配下载 → 44.1k WAV（只管音频，不下视频）
│   ├── fetch_metadata.py      Spotify 元数据 + 封面
│   ├── fetch_lyrics.py        lrclib 歌词
│   └── finalize_track.py      混音 + MP3 编码
├── data\
│   ├── library.db             曲库（SQLite）
│   ├── bin\ffmpeg.exe         媒体工具
│   └── library\               下载的原始 WAV
├── assets\
│   ├── output\library\<id>\   每首歌 4 个 MP3
│   ├── covers\<id>.jpg        专辑封面
│   └── lyrics\<id>.lrc        歌词文件
├── .cache\                    torch / huggingface 模型缓存
├── config\config.json         端口、DJ 密码等
└── tests\
```

## 加新歌

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:TORCH_HOME='D:\Projects\spotify-karaoke-local\.cache\torch'
$env:HF_HOME='D:\Projects\spotify-karaoke-local\.cache\huggingface'

python\.venv-xpu\Scripts\python.exe scripts\pipeline.py `
  --spotify-id <22位SpotifyID> `
  --steps metadata,download,lyrics,separate,finalize
```

`--title` 可省略——歌名、歌手、专辑、时长、封面全部由 Spotify API 提供。

各步骤幂等，重复跑不会重做已完成的部分。cleanup 会在确认 4 个 MP3 合格后
删除音频处理输入（data/library/<videoId>.wav）和下载中间文件；--keep-audio 可保留。

官方 MV 不在这条流水线里：它由 Node 侧 lib/official-mv.js 单独匹配，
经 YouTube IFrame 静音在线播放，不下载（见 ../docs/official-mv.md）。

## 测试

```powershell
node tests\playback-lyrics.test.js        # 16 passed
node tests\library-mode.test.js           # 12 passed
node tests\official-mv.test.js            # 23 passed（官方 MV 评分 / 状态机）
node tests\official-mv-api.test.js        # 14 passed（MV 管理接口）
node tests\video-lyrics-mv.test.js        # 20 passed（视频模式播放器）
..\env\python\Scripts\python.exe tests\test_library.py            # 11 passed
..\env\python\Scripts\python.exe tests\test_pipeline_cleanup.py   # 10 passed（临时文件清理）
```

## 关键设计

### 为什么只存 4 个 MP3

Demucs 四轨严格加性分解（`drums+bass+other+vocals ≈ mix`），所以：

- `accompaniment` = 三轨求和
- 播放时 `伴奏 + 人声 × 强度` 实时混音

存 4 轨 WAV 要 634.6 MB，存 4 个 MP3 只要 54.9 MB，**省 91%**。

### 为什么必须用 Web Audio

两个 `<audio>` 元素即使 `currentTime` 对齐，几分钟后会漂移几十毫秒，
叠加产生**梳状滤波**（听感"发虚"）。

`AudioBufferSourceNode` 从同一个 `AudioContext` 时钟派生，`start(0, offset)`
同时调用 → **采样级同步，永不漂移**。

实测两条轨逐样本等长（差 0 样本），能量误差 4.51%。

### 音源与画面

| 字段 | 本工程取值 | 说明 |
| --- | --- | --- |
| `sourceMode` | 固定 `local` | 只走本地曲库 |
| `playbackMode` | `video` / `lyrics`（DJ 可切） | video = YouTube 官方 MV（静音）+ 两行歌词；lyrics = 仿 Apple Music |
| `visual_video_id` | 由 `lib/official-mv.js` 匹配 | 官方 MV 的 YouTube videoId；与音频来源 `source_video_id` 无关 |

## 已知边界

1. **MV 是 YouTube 在线播放**：断网 / 视频下架 / 不允许嵌入时退回模糊专辑封面（K 歌不受影响）
2. **封面是 Spotify 专辑图**（640×640）
3. **逐字歌词依赖 QQ 音乐**，会限流；拿到后落盘缓存
4. **分离需要 XPU**（Intel Arc iGPU），CPU 下 RTF 慢 10 倍以上
5. **`onlyKaraokeSongs` 强制关闭**——本地曲目名不含 "karaoke"
6. 已在播放的歌可以再点一次（0.3.8 原有语义，去重只查 `queued`）

## 与模式 A 的关系

| | 模式 A | 模式 B |
| --- | --- | --- |
| 目录 | `D:\Projects\spotify\karaoke-hub` | `D:\Projects\spotify-karaoke-local` |
| 音源 | YouTube | 本地曲库 |
| 端口 | 3000 | 3100 |
| 搜索 | YouTube Data API | 本地 SQLite |
| 音轨 | 单一视频音轨 | 伴奏 + 人声可混 |

**互不影响。**
