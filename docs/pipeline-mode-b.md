# 模式 B 流水线

## 一条命令

```powershell
cd D:\Projects\Karaduoke\karaoke_spo
$env:PYTHONIOENCODING='utf-8'

..\env\python\Scripts\python.exe scripts\pipeline.py `
  --spotify-id 3n3Ppam7vgaVa1iaRUc9Lp `
  --steps metadata,download,lyrics,separate,finalize,cleanup
```

所有步骤**幂等**（重复跑不会重做已完成的部分）。

## 六个步骤

| 步骤 | 做什么 | 产出 |
| --- | --- | --- |
| `metadata` | Spotify Web API 取歌名/歌手/专辑/时长/封面 | `tracks` 行 + `assets/covers/<id>.jpg` |
| `download` | YouTube 匹配 → 下载媒体 → **ffmpeg 抽成 44.1k/16bit/stereo WAV** | `data/library/<videoId>.wav` + `.match.json` |
| `lyrics` | QQ QRC → 网易云 → lrclib 降级 | `lyrics` 表 + `assets/lyrics/<id>.lrc` |
| `separate` | Demucs htdemucs on XPU | `assets/output/library/<id>/` 下 4 轨临时 WAV |
| `finalize` | 混音 + 320k MP3 编码 + **清理中间轨** | **4 个 MP3**（最终产物） |
| `cleanup` | 确认 4 个 MP3 合格后，删除**音频处理输入**与下载中间文件 | 释放 ~30–60 MB/首 |

`download` 和 `lyrics` 互不依赖，默认**并行**执行（`--no-parallel-steps` 可退回串行）。
两个线程各开自己的 SQLite 连接；WAL + busy_timeout=5000 保证写操作排队。

> **MV 不在这个流水线里。** 官方 MV（`visual_video_id`）由 Node 侧的
> `lib/official-mv.js` 单独匹配、经 YouTube IFrame 在线播放，不下载、不落盘。
> 详见 [official-mv.md](./official-mv.md)。

## 临时文件的生命周期（重点）

| 文件 | 谁产生 | 谁消费 | 成功之后 |
| --- | --- | --- | --- |
| `data/library/<videoId>.wav` | `download`（yt-dlp/spotDL 取媒体 → ffmpeg 重采样） | `separate`（Demucs 输入） | **删除**（`cleanup`） |
| `data/library/<videoId>.match.json` | `download`（匹配记录） | 无（内容已写进 DB） | **删除** |
| `data/library/__pipeline_<id>.match.json` | `download` 失败时 | 排查用 | 删除 |
| `.tmp/spotdl-out/*` | spotDL | `download` | 清空后删目录 |
| 4 轨 WAV | `separate` | `finalize` | 删除（`finalize` 已有逻辑） |
| **4 个 MP3** | `finalize` | **KaraokeMixer** | **永久保留** |
| `video.mp4`（旧版遗留） | 已移除的旧管线 | 无 | `cleanup` 顺手删除 |

`cleanup` 的安全规则（`scripts/pipeline.py` 的 `step_cleanup`）：

1. **先校验，后删除**：4 个 MP3 必须都在、>16 KB、文件头是 ID3 或 MPEG 帧同步。
   任何一项不过 → **什么都不删**，`jobs` 里记一条 `cleanup/skipped`（失败时那份 WAV
   往往是唯一能重试的输入）。
2. **只在成功路径跑**：`main()` 只在 `finalize` 成功后才执行；只跑 `--steps download`
   的调试流程不会清。
3. **只删本曲目的文件**：路径必须落在 `data/library/` 或本曲目的输出目录内；
   同一个 `audio_path` 还被别的曲目引用时跳过。
4. **异常安全**：单个文件删不掉（Windows 句柄）只记日志，不影响已生成的 MP3；
   删除清单落盘到 `data/cleanup-<spotifyId>-<时间>.json`。
5. `--keep-audio` 可以保留输入（排查问题、需要重跑 `separate` 时用）。

## 并发与跨进程锁

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

## 关键实现细节

### 1. 防削波

统一增益：按 `max(original, accompaniment, vocals)` 的峰值定标到 0.89，
所有轨乘**同一个系数**（保持轨间比例），guide 超峰时单独再压一次。

### 2. 长度对齐

四轨样本数可能差几十个样本（实测 15851540 vs 15851567），取最小值统一裁齐再混。

### 3. `rtf` 不会被 finalize 覆盖

`finalize` 写库时 `device/segment/rtf/processing_s` 传 `None`，
库层用 `COALESCE(excluded.x, stems.x)` 保留分离阶段的真实值。

### 4. 清理是幂等的

`_cleanup_intermediates()` 可重复调用：4 个 MP3 已存在时也会顺带把残留的 4 轨 WAV 删掉。

### 5. MP3 解码回 WAV

如果源轨是 MP3 而非 WAV（中间态），先 `ffmpeg -ac 2 -ar 44100 -sample_fmt s16` 解回 WAV 再计算。

## 本地播放入口

`server.js` 的 `/media/` 路由（支持 Range 206）指向项目根 `assets/`：

```
/media/output/library/<spotifyId>/accompaniment.mp3
/media/lyrics/<spotifyId>.lrc
/media/covers/<spotifyId>.jpg
```

只允许 `output/` `lyrics/` `covers/` 三棵子树，其余 404，路径穿越 400 `BAD_PATH`。
**.mp4 已不再服务**（没有本地视频了）。

## 测试

```powershell
..\env\python\Scripts\python.exe tests\test_library.py            # 11 passed
..\env\python\Scripts\python.exe tests\test_pipeline_cleanup.py   # 10 passed（临时文件清理）
..\env\python\Scripts\python.exe tests\test_pipeline_parallel.py  # 4 passed
node tests\official-mv.test.js                                     # 23 passed（MV 匹配）
node tests\official-mv-api.test.js                                 # 14 passed（MV 管理接口）
node tests\video-lyrics-mv.test.js                                 # 20 passed（播放器）
```
