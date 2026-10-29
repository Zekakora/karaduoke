# 播放模式（视频 / 歌词）设计文档

> 目标：在 karaoke-hub 里保留下载下来的视频，同时支持两种播放形式——
> **A. 视频模式（现有）**：YouTube IFrame 播放器 + 队列；
> **B. 歌词模式**：仿 Apple Music / Lyricify 的滚动歌词界面（封面上方、逐行高亮、逐字高亮、呼吸点、点击跳转）。
> 两个模式**共用同一条点歌队列与 SSE 状态**，切换时**不中断播放**。

版本：0.3.8 → 本次增量（`API_VERSION` 8 → 9）。

---

## 1. 现有架构摘要（先读代码再动手）

| 关注点 | 现状 |
| --- | --- |
| state 结构 | `data/state.json`：`{ settings, sessions, blockedGuests, songs[], broadcasts[], importantBroadcast, animation, playback }` |
| 播放状态字段 | `state.playback = { currentRequestId, status: idle\|transition\|playing\|paused, volume, version, updatedAt }`；当前歌曲靠 `playback.currentRequestId` 指向 `songs[]` 里 `status==='playing'` 的那条 |
| 模式路由 | 纯前端：`public/app.js` 第 1 行 `mode = admin / display / join`（按 `location.pathname` 判断），服务端对 `/admin`、`/display`、`/join` 都返回同一个 `public/index.html` |
| 控制台播放控制 | `POST /api/admin/playback`（`pause / resume / skip / stop / volume`），需要 `x-admin-token`；设置走 `PATCH /api/admin/settings` |
| SSE 事件 | 只有一种事件名：`state`（`broadcast()` 写 `event: state` + `publicState()` JSON），连上时立即推一次 |
| 大屏接收播放指令 | `initDisplay()` → `connectEvents(render)`；`render(state)` 比较 `currentRequestId`，变化则 `new YT.Player(...)` 重挂播放器，否则 `pauseVideo / playVideo / setVolume`；播放事件通过 `POST /api/display/event` 回写 `playback.status`（`playing/paused/ended/error`） |

结论：**“播放指令”本质就是 `publicState()` 里的 `playback` + `current` + `settings`**，
所以新增“播放模式”只要放进 `settings` 并让大屏在 `render()` 里分支即可，不需要新的事件通道。

---

## 2. 新增配置项

```jsonc
// data/state.json（只加一个字段，其余不动）
{
  "settings": {
    "playbackMode": "video"   // "video" | "lyrics"
  }
}
```

- **位置**：沿用现有 `settings`（`defaultState()` 里加默认值 `'video'`）。
- **迁移**：`loadState()` 之后 `if (!PLAYBACK_MODES.includes(state.settings.playbackMode)) state.settings.playbackMode = 'video'`，
  旧 `state.json` 不需要手工改。
- **写入**：`PATCH /api/admin/settings`，body `{ "playbackMode": "lyrics" }`。
  - 非法值 → `400 { code: "INVALID_PLAYBACK_MODE", params: { allowed: ["video","lyrics"] } }`，**且不写任何其它字段**（先校验、后 mutate）。
  - 合法值 → `mutate()` → `persist()` → `broadcast('state')`，大屏与手机立刻收到。
- **对外**：`/api/state.settings.playbackMode`、`/api/config.playbackMode`、`/api/admin/state.settings.playbackMode`。

---

## 3. 控制台 UI 在哪加

| 项 | 具体位置 |
| --- | --- |
| 切换器 DOM | `public/app.js` → `ensurePlaybackModeSwitch(token, state)`，插到 `#admin-content > section.grid > "正在播放" .card.panel` 的 `.control-strip` **之后**（`insertAdjacentHTML('afterend')`） |
| 生成标记 | `playbackModeSwitchMarkup(state)`：`📺 视频模式 | 🎵 歌词模式` 两段式 segmented 控件（`data-playback-mode`） |
| 事件绑定 | 在 `bindAdminEvents()` 的 `applyAdminLanguage(...)` / `ensureAdminExtras(...)` 之前调用 `ensurePlaybackModeSwitch()` |
| 切换动作 | `PATCH /api/admin/settings { playbackMode }` → `updateAdminContent(token, next)` → toast |
| 状态提示 | 当前歌曲无歌词/音频时，控件下方红字提示“会自动退回视频模式”；切换时 toast 同名文案 |
| 多语言 | `PLAYBACK_MODE_LABELS`（zh/en/de），`applyAdminLanguage()` 里同步 label 与按钮文字 |
| 样式 | `public/styles.css` 末尾 `.playback-mode / .segmented / .seg-btn`（含 night 主题） |

> 现有 `render()` 每次 SSE 都会重建整个 `#admin-content`，切换器放在 `bindAdminEvents` 里重建，
> 因此**不新增状态**，也不用管重绘时序。

---

## 4. 两种模式如何共用队列与 SSE

```
                          ┌───────────── /events (event: state) ─────────────┐
手机 /join 点歌 ──► state.songs[] ──► pendingSongs / current ──► publicState() ──┤
                          │                                                    │
控制台 /admin ──PATCH settings.playbackMode ──► mutate() ──broadcast ──────────┤
                          │                                                    ▼
                          └──────────── state.playback (不改) ─────────► 大屏 /display
                                                                            │
                                             render(state) ─► applyPlaybackMode(state)
                                                                            │
                                        ┌───────────────────────────────────┴─────────┐
                                        ▼                                             ▼
                            video: #yt-player 可见                       lyrics: #lyrics-layer 可见
                            YouTube IFrame 播放                          <audio> 播本地音频 + LRC
```

- **队列一份**：`playbackMode` 只影响大屏的“显示层”，`state.songs / playback / queue` 完全不动；
  手机端、控制台队列表、`skip / stop / pause / resume / volume` 在两个模式下语义一致。
- **SSE 事件名不变**：仍只有 `state`。大屏 `render()` 里新增一次 `applyPlaybackMode(state)`，
  以及“没有当前歌曲时隐藏歌词层”“新歌挂载后再套用一次”两处小改。
- **切歌与换模式互不影响**：换模式不会重排 `queuePosition`，也不会触发 `finishCurrent()`。

---

## 5. 歌词数据从哪来

本地目录（首次启动自动 `mkdir -p`，空目录 = 全部退化到视频模式）：

```
assets/
  lyrics/<key>.lrc      # 必需，UTF-8，标准 LRC / 强化 LRC
  media/<key>.mp3|m4a|aac|ogg|opus|wav|flac|webm   # 可选，歌词模式下的音频
  covers/<key>.jpg|png|webp|avif                   # 可选，封面
```

`<key>` 的解析顺序（服务端 `lyricsCandidates()`）：

1. `song.id`（点歌实例级，例如 `song_ab12…`）
2. `song.videoId`（原样，区分大小写）
3. `videoId.toLowerCase()`

key 只允许 `[A-Za-z0-9_-]{1,128}`（`lib/lyrics.js:normalizeKey`），杜构路径穿越。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/lyrics/:key` | 服务端解析好的行级歌词：`{ key, file, lineCount, offsetMs, meta, lines:[{startMs,endMs,text,words:[{startMs,text}]}], hasMedia, audioUrl, coverUrl }`；找不到 → `404 LYRICS_NOT_FOUND` |
| GET | `/api/lyrics/:key/audio` | 本地音频流，支持 `Range`（206）以便 `<audio>` 拖进度 |
| GET | `/api/lyrics/:key/cover` | 封面图 |

三个接口都是**只读、免 DJ token**（大屏在房间电视上打开，没法登录），且**永不写 `state`**。

### 可播放性（`publicSong().lyrics`）

```jsonc
"lyrics": { "key": "dQw4w9WgXcQ", "available": true, "hasMedia": true, "ready": true,
            "lineCount": 34, "coverUrl": "/api/lyrics/dQw4w9WgXcQ/cover",
            "audioUrl": "/api/lyrics/dQw4w9WgXcQ/audio" }
```

`ready = 有 LRC 行 && 有本地音频` → 歌词模式下才会真正用 `<audio>` 播。
只有 LRC 没有音频时，歌词层会退化为**用视频 iframe 的 `getCurrentTime()` 当时钟**的只读歌词页（可选，见 §6.4）。

### `parseLrc()`（`lib/lyrics.js`，零依赖）

- 多时间戳：`[00:12.00][01:20.00]副歌` → 生成两行（同一份文本）。
- 乱序：按时间稳定排序（同时间点保留原文顺序）。
- 空行 / 无时间戳行：丢弃。
- 元数据：`[ti:] [ar:] [al:]` 等进 `meta`；`[offset:+500]` 叠加到所有行（正数 = 歌词提前）。
- 小数位：1 位=十分之一秒、2 位=百分之一秒、3 位=毫秒；也接受 `[mm:ss:xx]` 的老写法。
- 逐字：`<00:12.30>Hel<00:12.55>lo` → `words[]`（缺失首个时间戳时退化为相对行起点）。
- `endMs` = 下一行 `startMs`；最后一行 `startMs + 10s`（可传 `maxDurationMs`）。
- 护栏：最多 2000 行、单行 500 字符、单行最多 60 个逐字时间戳。
- 解析结果按 `mtime + size` 缓存在进程内（`createLyricsLibrary().readLrc`），改文件即失效。

---

## 6. 切换时的行为：不中断播放

核心原则：**播放器实例常驻，只切显示层。**

### 6.1 大屏 DOM

```html
<div id="player" class="player-frame">
  <div id="lyrics-layer" class="lyrics-host"></div>   <!-- z-index:3，默认 display:none -->
  <div id="yt-player">…YT iframe…</div>               <!-- z-index:1，常驻不销毁 -->
</div>
```

- `player.classList.toggle('mode-lyrics', active)`：CSS 让 `#yt-player { visibility:hidden }`（**不是 `display:none`**，
  视频流不会被浏览器挂起），歌词层 `.active` 显示并接管 pointer-events。
- 切回 `video`：只把歌词层 `setActive(false)`，`#yt-player` 重新可见。

### 6.2 音频 vs 视频

- 歌词模式**必须**有本地音频（`lyrics.ready`）。进入时 `ensureLyricsAudio(state)` 创建唯一一个 `<audio src="/api/lyrics/<key>/audio">`，
  回写 `play / ended` 到 `/api/display/event`，暂停由 `state.playback.status === 'paused'` 驱动。
- 进入歌词模式时 `playerInstance.pauseVideo()`（避免两路声音叠加）；切回视频模式时 `playVideo()` 从原位置继续（iframe 从未销毁）。
- 同一首歌反复切换只换可见性；换歌（`currentRequestId` 变化）才重建 `<audio>`。

### 6.3 渲染层（`public/lyrics-view.js`，无依赖 IIFE）

| 需求 | 实现 |
| --- | --- |
| 封面上方 | `.lyrics-head`：封面（`coverUrl` 或 YouTube 缩略图兜底）+ 标题 + 演唱者 |
| 当前行居中高亮 | `centerLine(index)`：`el.offsetTop + h/2 - viewport.clientHeight/2` → `scrollTo({behavior:'smooth'})`；`.current` 放大 1.045 + 白色 + 发光 |
| 前后行淡化 | `.done {opacity:.4}` / 默认 `opacity:.62` / `.current {opacity:1}` + 顶部/底部 mask 渐隐 |
| 逐字高亮 | `line.words` 存在时渲染 `.lyrics-word`，按 `data-start-ms` 切 `.sung` |
| 呼吸点 | `.lyrics-dots i` × 3，`@keyframes lyricsBreath` 错峰 0/0.2/0.4s；暂停时 `animation-play-state:paused` |
| 点击跳转 | `track` 上事件委托：点行 → `seek(line.startMs)` |
| rAF 驱动 | `requestAnimationFrame(tick)`，只在 `active` 时跑；逐帧算 `index`（线性/二分）后写 class，未变化不重排 |
| 手动滚动后暂停跟随 3 秒 | `wheel / touchmove / scroll` → `pauseFollowing()`，`setTimeout(resumeFollowing, 3000)`；程序平滑滚动在 `lastScrollAt + 400ms` 内被忽略，避免自触发 |
| 性能 | 只对 ±8 行设置 `will-change`；超长歌词也只改 class，不重建 DOM |

### 6.4 播放时钟

```
<audio> 存在        → 用 audio.currentTime
没有 <audio>        → controller.setClock(() => playerInstance.getCurrentTime() * 1000)
```

即“视频在放、只想看歌词”也能工作（纯只读时钟，不额外创建播放实例）。

---

## 7. 失败降级

| 场景 | 行为 |
| --- | --- |
| 歌没有 LRC | `lyrics.ready === false` → 大屏按视频模式渲染；若当前开关是 lyrics，控制台/大屏 toast“已退回视频模式” |
| 有 LRC 没有音频 | 同上（`ready=false`）；若要“只读歌词”，可后续放宽为仅 `available` |
| LRC 存在但 `/api/lyrics/:key` 返回 404 / 网络失败 | 歌词层清空并显示红色 banner，调用方 `onFallback` → 退回视频模式 |
| `assets/**` 被删 / 无权限 | `ensureDirs()` 静默失败，全部歌 `lyrics=null`，等价于纯视频模式 |
| `/api/lyrics/*` 500 | 只影响歌词接口本身；`/api/state` 不受影响（测试覆盖） |
| 本地音频 `error` 事件 | `setFallback(...)` 红条提示，视频层仍可用 |

---

## 8. 改动文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `lib/lyrics.js` | 新增 | `parseLrc / findLineIndex / normalizeKey / createLyricsLibrary`，零依赖 |
| `public/lyrics-view.js` | 新增 | 歌词渲染层（rAF、居中、逐字、呼吸点、点击跳转、3 秒跟随锁） |
| `server.js` | 修改 | `PLAYBACK_MODES`、`settings.playbackMode`、`publicSong().lyrics`、`/api/lyrics/:key(+audio/cover)`、`PATCH settings` 校验、`API_VERSION=9` |
| `public/app.js` | 修改 | 控制台切换器、`createLyricsRenderer`、`applyPlaybackMode`、大屏骨架 `#lyrics-layer`、`mountPlayer` 不覆盖歌词层 |
| `public/index.html` | 修改 | `<script src="/lyrics-view.js">`（先于 app.js） |
| `public/styles.css` | 修改 | 切换器样式 + `#player` 双图层布局 |
| `tests/playback-modes.test.js` | 新增 | 同进程 Node 测试 |
| `docs/playback-modes.md` | 新增 | 本文档 |

---

## 9. 未做 / 需要浏览器手动确认

1. 歌词模式的**真实听感**（音画同步、音量、切歌残响）只能在浏览器里听。
2. 歌词模式目前要求有本地音频；`assets/media` 为空时大屏恒为视频模式，这是有意的降级。
3. 未做歌词行的手动编辑 UI、未做 `.lrc` 上传接口（避免引入 multipart 依赖）。
4. 未改 `Queue` 数据结构、未改 YouTube 播放器核心逻辑、未回滚 Spotify 搜索增量。
