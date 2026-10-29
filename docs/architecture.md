# 架构说明（spotify-demucs-lab）

> 本文描述当前**实际实现**的模块关系，不是设想。与代码不一致的地方以代码为准。

## 1. 总览

```
┌─────────────── 浏览器 ───────────────┐
│  public/index.html                   │   实验台（Spotify / 歌词 / 任务）
│  public/app.js      (ES module)      │
│  public/lib/lyrics.js                │   解析 + 定位 + 插值（纯函数）
│  public/audio-lab.html + .js         │   音频输入四路径实验
│  public/worklets/pcm-tap.js          │   AudioWorklet（128 帧 Float32）
└──────────────┬───────────────────────┘
               │  HTTP /api/*  +  SSE /events
┌──────────────▼───────────────────────┐
│  main.js  →  server.js               │   Node 原生 node:http，零 npm 依赖
│   lib/env.js       .env + 项目内缓存路径 │
│   lib/spotify.js   PKCE / client_credentials / 串行限速 │
│   lib/lyrics.js    解析器（服务端复用同一实现）│
│   data/*.json      原子写（tmp + rename）│
│   logs/*.jsonl     结构化实验日志         │
└──────────────┬───────────────────────┘
               │  stdin/stdout JSON-line（默认）
               │  或 HTTP bridge（受限环境备选）
┌──────────────▼───────────────────────┐
│  python/run_worker.py → worker.py    │   长驻进程，模型只加载一次
│  demucs.api.Separator (htdemucs)     │   torch 2.14.1+cpu
│  输出 vocals / no_vocals / drums / bass / other │
└──────────────────────────────────────┘
```

## 2. 四条数据流为什么必须分开

| 数据 | 来源 | 能否用于"消原唱" |
|---|---|---|
| **曲目元数据** | `GET /v1/search`、`GET /v1/tracks/{id}` | ❌ 只有文字与封面 |
| **播放状态** | `GET /me/player`、`currently-playing` | ❌ 只有 `progress_ms` 等 |
| **播放控制** | `PUT /me/player/play|pause`、`seek` | ❌ 只是控制指令 |
| **音频数据** | **没有任何官方接口** | 只能靠本地文件或系统级采集 |

这条分界线是整个项目的核心：**前三种已实测可用，第四种在 Spotify 侧不存在**。
因此"Karaoke"在本架构中的定位是：
- **可交付**：歌词精确跟随 Spotify 进度（用元数据 + 进度插值）；
- **只在本地音频上成立**：真正的伴奏分离（Demucs）；
- **受阻**：把 Spotify 正在播放的音频送进 Demucs。

## 3. 进程边界

### 3.1 Node 主进程
- 单进程、单端口（默认 `127.0.0.1:3000`），全部路由集中在 `server.js` 的 `handleApi()` if 链，风格对齐参考仓库 karaoke-hub。
- 统一错误体 `{error, code, ...}`；静态资源全部经 `resolveInside()` 做路径越界校验。
- JSON 持久化只用 `atomicWriteJson()`（写 `.tmp` 后 `rename`），**不复制参考仓库"全量同步写、无原子性"的问题**。

### 3.2 Python Worker
- `worker.py` 启动时 `Separator(model=...)` 加载模型一次，随后循环读 stdin 的 JSON 行。
- **stdout 只输出协议 JSON**；`sys.stdout` 被重定向到 stderr，避免 torch/tqdm 的打印污染协议。
- 协议消息：`ready / log / progress / done / error / pong / bye`。
- 失败必须显式上报：`INIT_FAILED`（依赖导入失败）、`MODEL_LOAD_FAILED`、`INPUT_NOT_FOUND`、`JOB_FAILED`。

### 3.3 受限环境下的桥接（本机实测存在的限制）
本会话的受限策略禁止 `child_process.spawn` 创建**管道**子进程（`EPERM`），因此：
- `server.js` 捕获 `spawn` 的同步异常与 `error` 事件，把 `workerState.status` 置为 `spawn-failed` 并经 `/api/health` 与 SSE 如实暴露；
- 备用方案 `scripts/worker-bridge.js`：独立进程用**继承 stdio** 拉起 Worker，对外提供 `POST /jobs`、`GET /jobs/:id`，主服务读取 `data/worker-bridge.json` 的端口；
- 在普通终端里运行本项目时不存在该限制。

## 4. 歌词同步的时钟设计

状态机（前端）：

```
anchor = { positionMs, wallMs, playing, trackId }
每帧： predicted = anchor.playing
        ? anchor.positionMs + (performance.now() - anchor.wallMs)
        : anchor.positionMs
高亮行 = findLineIndex(lines, predicted)
```

- `anchor` 只在**收到真实进度**时更新（Spotify 轮询结果，或本地 `<audio>.currentTime`）；
- 暂停时 `predicted` 冻结在 `positionMs`；
- 跳转/换曲时无需特殊处理：下一次真实进度一到，`anchor` 被覆盖，**误差不累积**；
- `interpolate()` 用 `durationMs` 做上限裁剪，避免越界。

实测锚点精度：**P95 ≈ 75ms**（见 `docs/test-records/phase-2-spotify-sync.md`）。

## 5. 任务队列

```
POST /api/audio/jobs  →  submitJob()
    ├─ resolveInside(assets/audio, input)     ← 防目录穿越
    ├─ 幂等：同文件 + 同模型 + 状态 ∈ {queued, processing, completed} → 直接复用
    └─ queues<inputPath> 队列（同一输入串行，避免同文件并发抢 CPU）
         └─ processQueue() → workerState.status === 'ready' → runJobOnWorker()
               └─ 600s 超时 / Worker 退出 → 任务 failed 并记录 code
状态机：queued → processing → completed | failed
记录：createdAt / startedAt / finishedAt / inputDurationS / processingS / rtf / files
```

## 6. 出站 HTTP 的限速策略

`lib/spotify.js` 内建**全局串行队列**：

- 所有 Spotify 调用（GET 与 PUT）共用一条 Promise 链，相邻请求间隔 ≥ 400ms（`SPOTIFY_MIN_INTERVAL_MS` 可调）；
- 429 时按 `Retry-After` 单次退避；
- `/search` 的 `limit` 强制 ≤10（2026 Dev Mode 上限）。

实测 5 个并发请求在服务端被串行化（总耗时 2691ms ≥ 5×400ms），**不会向 Spotify 发出突发流量**。

## 7. 音频输入路径（阶段 4）

| 路径 | 机制 | 拿到的数据 | 结论 |
|---|---|---|---|
| A | Spotify Web API / SDK | 元数据、播放进度 | **无 PCM** |
| B | `<audio>` + `MediaStreamDestination` + AudioWorklet | Float32 PCM（`AudioContext.sampleRate`） | 本项目自有音频可行 |
| C | `getDisplayMedia({audio:true})` | 标签页/窗口音频 → PCM | 需用户勾选共享音频；不能保证 |
| D | 本地 WAV 文件 → `decodeAudioData` | AudioBuffer → 16-bit PCM WAV | **基线，最可靠** |

`chrome.tabCapture` 不属于网页 API（仅扩展、需手势、MV3 需 offscreen document），单独说明，未实现。

## 8. 关键文件

| 文件 | 作用 |
|---|---|
| `main.js` | 入口：加载 `.env` → `server.start()` |
| `server.js` | HTTP + SSE + 路由 + 任务队列 + Worker 管理 |
| `lib/spotify.js` | 认证（PKCE / client_credentials）、搜索、播放状态/控制、限速 |
| `lib/lyrics.js` / `public/lib/lyrics.js` | LRC / Lyricify Lines 解析、行定位、时钟插值 |
| `python/worker.py` | 长驻 Demucs Worker（JSON-line 协议） |
| `python/run_worker.py` | 包装层：设置 `TORCH_HOME`/`HF_HOME` 到项目内 |
| `scripts/prepare_audio.py` | MP3/M4A → 44.1k/16bit/stereo WAV + 切片（PyAV 解码） |
| `scripts/bench_rtf.py` | 可复现 RTF 基准，写 CSV |
| `scripts/probe-spotify.js` / `probe-user-player.js` | 端点探针（输出真实状态码） |
| `scripts/measure-drift.js` | 播放进度锚点漂移测量 |
| `scripts/worker-bridge.js` | 受限环境下的 HTTP 桥 |
| `public/worklets/pcm-tap.js` | AudioWorklet PCM 采集 |
