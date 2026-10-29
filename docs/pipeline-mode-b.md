# 模式 B 流水线（阶段 1，已跑通）

## 一条命令

```powershell
cd D:\Projects\spotify
$env:PYTHONIOENCODING='utf-8'
$env:TORCH_HOME='D:\Projects\spotify\.cache\torch'
$env:HF_HOME='D:\Projects\spotify\.cache\huggingface'

python\.venv-xpu\Scripts\python.exe scripts\pipeline.py `
  --spotify-id 3n3Ppam7vgaVa1iaRUc9Lp `
  --title "Mr. Brightside" --artist "The Killers" --duration 222 `
  --steps download,lyrics,separate,finalize
```

四个步骤全部串起来了，**幂等**（重复跑不会重做已完成的部分）。

## 四个步骤

| 步骤 | 做什么 | 产出 |
| --- | --- | --- |
| `download` | YouTube 匹配 + yt-dlp 下载 | `data/library/<videoId>.wav` + `.match.json` |
| `lyrics` | lrclib → QQ 降级 | `lyrics` 表 + `assets/lyrics/<id>.lrc` |
| `separate` | Demucs htdemucs on XPU | 4 轨临时 WAV |
| `finalize` | 混音 + MP3 编码 + **清理中间产物** | **4 个 MP3**（最终产物） |

`download` 和 `lyrics` 互不依赖，默认**并行**执行（`--no-parallel-steps` 可退回串行）。
两个线程各开自己的 SQLite 连接；WAL + busy_timeout=5000 保证写操作排队。

## 并发与跨进程锁（2026-10-29）

后台队列默认同时制作 **3 首**（`KARAOKE_PREPARE_CONCURRENCY=1..4`），
所以 pipeline.py 可能同时有多个实例在跑。两个重资源阶段用
`scripts/gpu_lock.py` 的系统级文件锁跨进程串行：

| 锁 | 保护什么 | 并发 | 为什么 |
| --- | --- | --- | --- |
| `demucs` | GPU 分离 + 模型加载 | 1 | 2 个 Demucs 各慢 1.8 倍、各 4.5GB，吞吐只快 20% |
| `finalize` | 读 4 轨 + 混音 + 编码 | 1 | 每个 ≈900MB numpy；串行不拖慢整体（5s < 分离 25s） |

锁文件在 `<项目根>/.tmp/*.lock`，进程崩溃时由 Windows 自动释放；
`KARAOKE_LOCKS=0` 可临时关掉（基准测试用）。

finalize 里的 4 个 MP3 改为**并行编码**（4 个 ffmpeg），276s 的歌从 13.7s 降到 5.0s，
输出与串行编码**逐字节一致**（SHA-256 已对比）。

单首内并行后，一首歌的耗时大致是：
`元数据 2s` → `max(下载 20s, 歌词 5s)` → `等锁 + 分离 25s` → `成片 5s` ≈ 52s（不含等锁）。
3 首并行时 GPU 必须排队（3×25s），3 首总耗时约 85–105s，即约 1.5–1.8 倍；
GPU 始终有活干，但 GPU 分离本身不能并行。

单独重跑某一步：改 `--steps`，例如 `--steps separate,finalize`。

## 最终产物：每首歌只有 4 个 MP3

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `accompaniment.mp3` | drums + bass + other | 纯伴奏 |
| `vocals.mp3` | vocals | 纯人声（和声/对唱/参考） |
| `guide.mp3` | 伴奏 + 人声 **-12dB** | 引导版，原唱带唱 |
| `original.mp3` | 四轨求和 | 原曲 / A/B 对照 |

位置：`assets/output/library/<spotifyId>/`

**不再保存 4 轨中间文件**。伴奏是实时求和的，播放时在原唱音量上切换即可。

### 为什么不单独存 4 轨

实测证明 Demucs 四轨**严格加性**：`drums+bass+other+vocals ≈ mix`，
因此 `drums+bass+other ≡ mix - vocals`（vocal_leak 0.72dB、rms 0.13262 两者完全一致）。

存 4 轨要 634.6 MB，存 4 个 MP3 只要 54.9 MB —— **省 91%**。

## 实测数据

| 歌曲 | 时长 | 分离耗时 | RTF | 设备 | 产物 |
| --- | --- | --- | --- | --- | --- |
| Bohemian Rhapsody | 359.4s | 34.9s | 0.0972 | xpu | 54.9 MB |
| Mr. Brightside | 222.2s | 24.9s | 0.1122 | xpu | 33.9 MB |

- 冷启 init ~2.6-2.9s
- 音频参数：全部 44100Hz / 2ch / 320kbps
- 四轨时长完全对齐（差 0ms）

## 关键实现细节

### 1. 防削波
`guide` 和 `original` 混音后峰值可能超 1.0，自动按 `0.99/peak` 缩放。
`accompaniment` 和 `vocals` **不缩放**，保持原始电平。

### 2. 长度对齐
四轨样本数可能差几十个样本（实测 15851540 vs 15851567），取最小值统一裁齐再混。

### 3. `rtf` 不会被 finalize 覆盖（已修 bug）
`finalize` 写库时 `device/segment/rtf/processing_s` 传 `None`，
库层用 `COALESCE(excluded.x, stems.x)` 保留分离阶段的真实值。

**修复前**：finalize 一跑，`rtf` 变成 NULL，性能数据全丢。

### 4. 清理是幂等的（已修 bug）
`_cleanup_intermediates()` 可重复调用。
**修复前**：4 个 MP3 已存在时提前 `return`，残留的 4 轨 WAV（183 MB）不会被删。

### 5. MP3 解码回 WAV
如果源轨是 MP3 而非 WAV（中间态），先 `ffmpeg -ac 2 -ar 44100 -sample_fmt s16` 解回 WAV 再计算，
保证四轨采样率/声道一致。

## 本地播放入口

`karaoke-hub` 新增 `/media/` 静态路由（支持 Range 206），指向项目根 `assets/`：

```
/media/output/library/<spotifyId>/accompaniment.mp3
/media/lyrics/<spotifyId>.lrc
```

只允许 `output/` 和 `lyrics/` 两棵子树，其余返回 404，路径穿越返回 400 `BAD_PATH`。

预览页：`http://127.0.0.1:3901/lyrics-preview.html`
- 用本地 MP3 演示歌词画面，不依赖 YouTube
- 底部工具条可实时切换 原曲 / 引导 / 伴奏，**保持播放位置**

## 测试

```powershell
python\.venv-xpu\Scripts\python.exe tests\test_library.py   # 9 passed
karaoke-hub: node tests\playback-lyrics.test.js              # 15 passed
```

## 剩余（阶段 2，整合进控制台）

见 `docs/HANDOFF.md` 第 7.4 节。核心是把 `sourceMode` 开关 + Spotify 搜索 + 这套流水线接进
`karaoke-hub`，让控制台点歌时自动触发。
