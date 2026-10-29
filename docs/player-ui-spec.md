# 歌词播放界面视觉规格（依据 `img.png`，2170×1388）

> 参考图是 Apple Music / Lyricify 风格的歌词页。以下是**从图上量出来的规格**，实现按这个来。
> 关键约束（用户原话）：**左侧只保留专辑封面**；整个画面**嵌入 karaoke-hub 原来的 YouTube 嵌入位**（`#player.player-frame`）。

---

## 1. 整体布局

```
┌──────────────────────────────────────────────────────────┐
│ ┌───────────────┐                                        │
│ │               │   Sometimes it's hard to find          │  ← 淡化行
│ │   专辑封面     │   有时难以寻得                          │  ← 翻译
│ │  （正方形）    │                                        │
│ │  圆角 24px    │   Find my way up into the              │  ← 当前行（粗体白）
│ │               │   clouds, tune it out, they can        │
│ │               │   be so loud                            │
│ └───────────────┘   通往云端的路 屏蔽喧嚣 它们如此刺耳      │  ← 当前行翻译
│                                                     
│                       You remind me of a time           │  ← 淡化行
│                       你让我想起那段                     │
└──────────────────────────────────────────────────────────┘
```

- **封面列**：宽约 40%，封面**水平居中 + 垂直居中**（左列内绝对居中），正方形，圆角明显
- **歌词列**：宽约 55%，**左对齐**，右侧留白
- 两列之间有明显留白
- 背景：封面**模糊 + 放大 + 压暗**，铺满整个画面

### 用户对参考图的删减要求
参考图左侧除了封面还有：歌曲名 + 歌手名 + 收藏/更多按钮 + 进度条 + 时间 + 播放控制。
**全部去掉，只留封面。**

---

## 2. 封面

| 属性 | 值 |
| --- | --- |
| 形状 | 正方形 |
| 圆角 | 约 24px（占边长 1.2%） |
| 宽度 | 容器宽的 40%，**水平居中 + 垂直居中** |
| 阴影 | 柔和投影，`0 18px 48px rgba(0,0,0,.35)` |
| 图源 | YouTube 封面取 `maxresdefault.jpg`，失败回落 `hqdefault.jpg` |

> 参考图里封面是**倒置**的（Ariana Grande 的脸朝下）。这是截图时的动画中间态，**实现时不复现**，正常正向显示。

---

## 3. 背景

- 取封面图，`blur(60px)` + `scale(1.2)`，`filter: saturate(.7)`
- 叠加暗色渐变遮罩，四角更暗：
  ```css
  background: radial-gradient(circle at 50% 45%, rgba(0,0,0,.15), rgba(0,0,0,.55));
  ```
- 整体色调跟随封面（暖米色 -> 暖米色，见参考图）
- 兜底：无封面时用深灰渐变

---

## 4. 歌词排版

| 元素 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| **当前行** | `clamp(28px, 3.4vw, 56px)` | 700 | `#ffffff` |
| 当前行翻译 | `clamp(16px, 1.7vw, 28px)` | 400 | `rgba(255,255,255,.72)` |
| 其他行 | 同当前行字号 | 700 | `rgba(255,255,255,.33)` |
| 其他行翻译 | 同上 | 400 | `rgba(255,255,255,.22)` |

- 行高：`1.32`
- 每行（含翻译）为一个块，块间距：`clamp(18px, 2.2vw, 34px)`
- 翻译紧贴在主行下方，间距 `6px`
- **当前行居中显示在歌词列的垂直中线附近**（滚动让当前行落在 50% 高度）
- 过渡：`transform .45s cubic-bezier(.22,.61,.36,1)`, `opacity .35s ease`

### 逐字高亮（有 syllable 数据时）
- 用 `background-clip: text` 做渐变填充
- 已完成部分 `#ffffff`，未完成部分 `rgba(255,255,255,.45)`
- 渐变边界随进度移动

### 空行（呼吸点）
- 显示 `•••`，颜色 `rgba(255,255,255,.3)`，不参与高亮

---

## 5. 缩放与响应式

- 容器宽 < 900px：改为**上下布局**（封面在上，高度 40%），歌词在下
- 字号用 `clamp()` + `vw`，跟随容器而不是固定 px

---

## 6. 交互（保持但不显眼）

- 点击歌词行 → `seekTo(该行 startMs)`
- 用户手动滚动 → 暂停自动跟随 3 秒
- 不做可见的控制条（参考图有，但用户要求删）

---

## 7. 集成点（karaoke-hub）

```
public/app.js:1141  renderShell(...) 里的 <div id="player" class="player-frame"></div>
```

`playbackMode === 'lyrics'` 时：
- `#player` 内渲染歌词视图（替换 `#yt-player`）
- **YouTube 播放器保留在 DOM 里但不可见**（`opacity:0; pointer-events:none; position:absolute; width:1px;height:1px`）
  —— 用 `display:none` 会让部分浏览器暂停播放，所以用 opacity 方案
- 音频继续由 YouTube 提供，歌词同步读 `playerInstance.getCurrentTime()`（**直接读播放器时钟，无网络漂移**）

`playbackMode === 'video'` 时：恢复原样，行为完全不变。

---

## 8. 歌词数据来源

`GET /api/lyrics/lookup?videoId=&title=&duration=`

服务端流程：
1. 从 YouTube 标题里拆 `Artist - Song`（去掉 `(Official Video)`、`[MV]`、`feat.` 等噪声）
2. 调 lrclib `/api/get` → 失败走 `/api/search`
3. 再失败走 QQ 音乐
4. 返回 `{lines:[{startMs,endMs,text,translation}], provider, synced}`

前端只渲染，**不自己发网络请求**（避免每个 display 页各发一次）。
