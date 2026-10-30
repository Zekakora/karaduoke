# 播放画面双模式

> 2026-10-29 需求澄清；2026-10-30 **视频背景改为 YouTube 官方 MV**（不再用本地 MP4）。
> 模式 B 的 display 页支持两种画面，在 admin 切换。

## 两种画面

### 模式 1 · 视频 + 两行歌词（`playbackMode: 'video'`）

```
┌────────────────────────────────────────┐
│                                        │
│      [YouTube 官方 MV（静音）]          │
│                                        │
│                                        │
│   ▸ 正在唱的这句         ← 大，逐字高亮   │
│     下一句               ← 小，半透明     │
└────────────────────────────────────────┘
```

- 背景是 **YouTube 官方 MV**（IFrame Player API，`youtube-nocookie.com`），**永远静音**
- 没有 MV / 匹配中 / 视频不可用 → 自动换成 **模糊专辑封面**
- 音频走 **KaraokeMixer**（伴奏 + 人声，人声强度可调）
- 歌词只显示**当前行 + 下一行**，固定位置（距底边约 12%）
- 逐字高亮沿用 QRC 数据

### 模式 2 · 仿 Apple Music（`playbackMode: 'lyrics'`）

现有界面：左列专辑封面（居中），右列滚动歌词多行。

## 关键约束：MV 必须静音

**YouTube 的声音不用。** 原因：

| 若用 YouTube 的声音 | 若用 MP3 混音 |
| --- | --- |
| 音画天然同步 | 不必同步（MV 只是背景） |
| **人声强度滑块失效** | **人声强度可调**（模式 B 核心功能） |

模式 B 的存在意义就是「伴奏/人声可调」，所以必须走 MP3。
YouTube 播放器按官方要求正常显示（`controls:1`，不隐藏、不缩小），只是被容器裁剪放大铺满。

### 为什么不再保存本地 `video.mp4`

旧方案从**音频来源**那个 YouTube 视频里再下一份 720p/1080p、剥掉音轨当背景。
问题：那本来就是"为了抽音频"的视频（经常是 Audio/Lyric 版，甚至不是官方频道），
画面和"官方 MV"不是一回事；而且每首歌多占 20–35 MB。

现在改为：

| 资源 | 要不要 | 说明 |
| --- | --- | --- |
| 音频处理用的临时媒体文件 | 要 | 下载 → 抽 44.1k WAV；成片成功后由 pipeline 删除 |
| 最终 4 个 MP3 | 要 | KaraokeMixer 播放，长期保留 |
| 官方 MV | **在线播放** | 只存 `visualVideoId`，YouTube IFrame 静音播放，不下载 |
| 本地背景 `video.mp4` | **不要** | 已移除（`--keep-video` / `add_video.py` / 前端引用一并删除） |

官方 MV 的搜索、匹配、管理见 [official-mv.md](./official-mv.md)。

### 同步策略

MV 作为纯视觉层，**不跟随时间轴**：

| 本地音频 | YouTube MV |
| --- | --- |
| Play / Pause / Resume | 跟随播放 / 暂停 / 继续 |
| Stop、歌曲结束 | `stopVideo()` |
| 切歌 | 销毁旧播放器，加载新 MV |
| MV 比歌短 | `onStateChange === ENDED` 时 `loadVideoById` 从头循环 |
| MV 比歌长 | 随歌结束停止 |

不通过 `currentTime` 强制校正，也不频繁 `seekTo()`（那既卡顿、也没必要）。

### 失败回退

以下任一情况立刻回退模糊专辑封面，**不影响**本地音频与歌词：
没有 videoId、尚未匹配、`not_found` / `unavailable`、非法 id、
IFrame API 加载失败、播放器 ready 超时（9s）、`onError`（2/5/100/101/150）、
网络错误、播放中视频被删除或转私密。

失败时会 `POST /api/display/visual-error`，服务端把 `visual_match_status` 写成
`unavailable`，下次不再自动加载同一个坏视频。

## 存储体积影响

| 项 | 旧方案 | 现在 |
| --- | --- | --- |
| 4 个 MP3 | 54.9 MB | 54.9 MB |
| 本地 video.mp4 | +20~35 MB/首 | **0** |
| 官方 MV | — | 0（在线播放） |
| 音频处理输入 WAV | 留到下次处理 | 成片成功后删除 |

## 前端实现

```
public/
├── video-lyrics-mode.js   ← 视频画面：MV iframe + 两行歌词（本文档）
├── video-lyrics-mode.css
├── lyrics-view.js         ← Apple Music 风格
├── karaoke-mixer.js       ← 音频混音
└── app.js                 ← 两类画面的挂载 / 切换 / MV 失败上报
```

```js
new VideoLyricsMode(root, {
  visualVideoId,            // 官方 MV（null → 模糊封面）
  coverUrl,                 // 专辑封面（回退用）
  duration,
  onSeek: sec => mixer.seek(sec),      // 点画面只动本地音频
  onVideoError: d => reportVisualError(spotifyId, d),
});
```

`update(tSec)` 只驱动歌词；MV 的播放/暂停由 `setPlaying(bool)` 驱动。

### admin 切换

| 值 | 画面 |
| --- | --- |
| `video` | 官方 MV（静音）+ 两行歌词 |
| `lyrics` | 仿 Apple Music |

## 验证清单

- [x] 有 `visualVideoId` → 创建 IFrame 播放器，且静音
- [x] 没有 / 非法 / 未匹配 → 不初始化播放器，显示模糊封面
- [x] play / pause / resume 跟随；歌曲结束 `stopVideo`
- [x] MV 比歌短 → 循环；MV 比歌长 → 随歌停
- [x] 切歌销毁旧播放器
- [x] 不可用 / 网络错误 → 回退封面，歌词与音频不受影响，并上报 `unavailable`
- [x] 不再引用 `/media/output/library/<id>/video.mp4`
- [ ] 现场大屏上人工确认一遍 MV 画面与歌词可读性（需联网 + 真机）
