# 播放画面双模式

> 2026-10-29 需求澄清。模式 B 的 display 页支持两种画面，在 admin 切换。

## 两种画面

### 模式 1 · 视频 + 两行歌词（`playbackMode: 'video'`）

```
┌────────────────────────────────────────┐
│                                        │
│                                        │
│           [YouTube 720p 视频]           │
│                                        │
│                                        │
│   ▸ 正在唱的这句         ← 大，逐字高亮   │
│     下一句               ← 小，半透明     │
└────────────────────────────────────────┘
```

- 视频**静音**（`<video muted>`）
- 音频走 **KaraokeMixer**（伴奏 + 人声，人声强度可调）
- 歌词只显示**当前行 + 下一行**，固定位置（距底边约 12%）
- 逐字高亮沿用 QRC 数据

### 模式 2 · 仿 Apple Music（`playbackMode: 'lyrics'`）

现有界面：左列专辑封面（居中），右列滚动歌词多行。

## 关键约束：视频必须静音

**视频音轨不用。** 原因：

| 若用视频音轨 | 若用 MP3 混音 |
| --- | --- |
| 音画天然同步 | 需要手动对齐 |
| **人声强度滑块失效** | **人声强度可调**（模式 B 核心功能） |

模式 B 的存在意义就是「伴奏/人声可调」，所以必须走 MP3。
技术上：

```html
<video muted playsinline src="/media/output/library/<id>/video.mp4"></video>
```

混音器同时播 `accompaniment.mp3` + `vocals.mp3`，时间轴以 mixer 为准。

### 同步策略

`<video>` 作为纯视觉层，由 mixer 驱动：

```js
// mixer 的 onTimeUpdate 里校正视频
const drift = Math.abs(video.currentTime - mixer.getCurrentTime());
if (drift > 0.3) video.currentTime = mixer.getCurrentTime();
```

阈值 0.3 秒：小于这个值肉眼看不出来，频繁 seek 反而卡顿。

暂停/播放/跳转全部作用于 mixer，视频跟随。

## 视频规格

| 项 | 值 |
| --- | --- |
| 分辨率 | **1280×720** |
| 容器 | MP4 |
| 编码 | H.264 (avc1) |
| 音频 | **不保留**（`-an`），省空间 |
| 体积 | 约 33 MB/首（实测 Bohemian Rhapsody） |

存储位置：`assets/output/library/<spotifyId>/video.mp4`

## 存储体积影响

| 项 | 之前 | 之后 |
| --- | --- | --- |
| 4 个 MP3 | 54.9 MB | 54.9 MB |
| video.mp4 | — | ~33 MB |
| **每首合计** | **54.9 MB** | **~88 MB** |

4 首歌从 159.5 MB → 约 260 MB。

## 流水线改动

### `fetch_audio.py` 新增 `--keep-video`

下载步骤除了抽音频，再下一份 720p 视频（去音轨）：

```python
video_opts = {
    'format': 'bestvideo[height<=720][ext=mp4]+worstaudio/bestvideo[height<=720][ext=mp4]',
    'outtmpl': str(video_path),
    'quiet': True,
}
# 再 ffmpeg 去掉音轨
ffmpeg -i raw.mp4 -an -c:v copy video.mp4
```

**注意**：先下带音轨的（yt-dlp 需要音轨才能完整下载），再用 ffmpeg `-an` 剥掉。

### 存量补齐

现有 4 首需要补视频。写个脚本批量处理：

```powershell
python\.venv-xpu\Scripts\python.exe scripts\add_video.py --all
```

读取 `tracks.source_video_id` 拿 YouTube ID，下载对应视频。

## 前端实现

### 目录

```
public/
├── display-video-mode.js    ← 新增：视频 + 两行歌词
├── lyrics-view.js           ← 现有：Apple Music 风格
└── karaoke-mixer.js         ← 现有：音频混音
```

### `display-video-mode.js` 结构

```js
class VideoLyricsMode {
  constructor(root, { videoUrl, lyrics, onSeek })
  mount()          // 创建 <video> + 歌词容器
  setLyrics(payload)  // 载入歌词（含 chars）
  update(tSec)     // 由 mixer.onTimeUpdate 驱动
  destroy()
}
```

`update()` 逻辑：
1. 二分查找当前行
2. 更新当前行文字（逐字进度用 CSS 变量 `--lv-progress`）
3. 更新下一行文字
4. 校正视频时间（drift > 0.3s 才 seek）

### admin 切换

`playbackMode` 下拉已有两个选项（video / lyrics），在模式 B 下**现在被隐藏了**——要恢复显示。

| 值 | 画面 |
| --- | --- |
| `video` | 视频 + 两行歌词 |
| `lyrics` | 仿 Apple Music |

**注意**：模式 B 的默认值要从 `'lyrics'` 改回 `'video'`（用户要的主模式是视频）。

## 歌词数据

复用 `GET /api/lyrics/lookup?videoId=&title=&duration=&wordLevel=1`

- `wordLevel=1` → QQ 逐字 QRC（有 `chars` 数组）
- 失败回落 lrclib 行级

两行显示时：
- 当前行：用 `chars` 做逐字高亮
- 下一行：纯文本，不逐字

## 验证清单

- [ ] `fetch_audio.py --keep-video` 能下到 720p MP4 并剥掉音轨
- [ ] 存量 4 首补齐视频
- [ ] `GET /media/output/library/<id>/video.mp4` 返回 200 + Range 支持
- [ ] admin 里能切换两种模式
- [ ] 视频模式：视频播放、静音、歌词两行、逐字高亮、人声滑块可用
- [ ] Apple Music 模式：原样不变
- [ ] 音画同步：seek 后 0.3s 内对齐
- [ ] 回归测试全过
