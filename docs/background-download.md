# 后台下载与曲库管理（第二批核心）

> 2026-10-29 需求澄清。**下载是曲库资产建设，不是点歌的附属动作。**

## 一句话

用户点歌 → 立即返回 → 后台下载+分离 → 做完就成了曲库里的歌。
**用户取消点歌，下载照样做完。** 因为产物是曲库资产，不是队列的临时文件。

## 需求原文（用户口述）

> 入队后立刻下载然后挂在后台做卡拉OK处理之类的，用户即使取消了也挂着作为本地曲库。
> 用户界面点歌返回搜索结果的时候只有个点歌，点完之后在队列里面可以看到准备中和已就绪，
> 但DJ控制台的曲库管理选项卡里面可以看到更详细状态，比如已处理，处理中等等。

## 三层状态可见性

| 位置 | 显示什么 |
| --- | --- |
| **搜索结果** | 只有「点歌」按钮。**不显示任何状态徽标，不禁用** |
| **用户点歌页队列** | 粗粒度两种：`准备中` / `已就绪`（失败显示 `准备失败` + 可删） |
| **DJ 控制台 → 曲库管理** | 详细：`已处理` / `处理中（下载中/分离中/…）` / `待处理` / `处理失败`，含耗时、文件大小、匹配分、失败原因 |

## 数据流

```
用户在搜索里点「点歌」
   ↓
POST /api/queue  → 201，队列项 status='preparing'
   ↓  同时
prepare-queue 入队（最多 3 首并行；GPU 分离用跨进程锁串行）
   ↓
spawn: python pipeline.py --spotify-id <id> \
        --steps metadata,download,lyrics,separate,finalize
   ↓
同一首内：metadata →（download ∥ lyrics）→ separate（等 GPU 锁）→ finalize
   ↓
阶段推进（解析 stdout）
   metadata → download → lyrics → separate → finalize
   ↓
成功：tracks.status = 'separated'，队列项 status='queued'
失败：tracks.status = 'failed'，队列项 status='prepare_failed' + error
```

## 关键设计决策

### 1. 任务不随队列项取消

- 用户删歌 → **只删队列项**
- 子进程继续跑完，产物进曲库
- Web UI **不提供**「取消下载」
- 只有 DJ 控制台可以操作（删曲库条目）

**理由**：算力已经花出去了（分离一首约 25–30s XPU），中途放弃就是纯浪费。
而且这首歌用户不要，别人可能还要。

### 2. 并行：3 首一起做，但 GPU 分离串行

**结论：同时跑 3 首 pipeline（`KARAOKE_PREPARE_CONCURRENCY`，默认 3，范围 1–4）。**

实测环境：Intel Arc B390（核显，共享内存）/ Ultra X7 358H / 32GB。

| 阶段 | 单首耗时 | 资源 | 并发策略 |
| --- | --- | --- | --- |
| metadata | ~2s | Spotify API | 不限 |
| download | ~20s（官方 API）/ ~60s（匿名客户端） | 网络 + CPU | 不限 |
| lyrics | ~5s（QQ 正常）/ ~25s（QQ 限流回退网易云） | 网络 | 不限 |
| separate | ~24–28s | GPU + 4.5GB 内存 | **跨进程锁，1 个** |
| finalize | ~14s → **~5s**（4 个 MP3 并行编码） | 1 个 ≈900MB | **跨进程锁，1 个** |

- 单首串行约 52s（下载/歌词并行后）。3 首一起时 GPU 分离是最硬的瓶颈：
  3 × 25s = 75s，所以 3 首总耗时约 85–105s（约 28–35s/首），并行本身约 **1.5–1.8 倍**。
  之所以不是 3 倍：单首里 45% 的时间是 GPU 分离，它不能并行。
- 相对改动前的严格串行（匿名 spotDL，约 130s/首），整体约 **3.5–4 倍**：
  凭证修复（下载 60s→20s）+ 成片并行编码（14s→5s）+ 歌曲级并行。
- **为什么不并行跑 Demucs**：2 个进程同时分离时每个耗时 ×1.8（48s vs 27s），
  2 首总耗时 58s vs 串行 72s，只快 ~20%，却要多占 4.5GB 内存。所以 GPU 用
  `scripts/gpu_lock.py` 的**系统级文件锁**串行化；进程崩溃时锁由系统自动释放。
- finalize 也串行：每个进程读 4 轨 WAV 到 numpy 约 900MB，3 个同时跑会白吃 2.7GB；
  而 finalize（5s）远小于 GPU 分离（25s），串行不会成为瓶颈。
- 单首内 `download` 和 `lyrics` 并行（互不依赖），省掉歌词那 5–25s。

> 分离阶段之所以慢，主要是 **spotDL 匿名客户端**：`Song.from_url()` 要 40s+。
> 启动器会把控制面板里的 Spotify client_id/secret 注入进程环境，Python 现在优先读
> 环境变量（`scripts/fetch_audio.py`），有官方凭证时这一步只要 ~3s。
> 直接 `node server.js` 调试且 `.env` 没填凭证时，仍会回退匿名客户端。

### 3. 任务持久化

写到 `data/prepare-jobs.json`（原子写，参考 server.js 的 `writeStateAtomic`）。
进程重启后恢复未完成任务。

### 4. 幂等

- 同一 `spotifyId` 已在准备队列 → 不重复入队，返回已有任务状态
- 已在曲库且 `ready` → 不下载
- 已在曲库但 `failed` → 允许重试

## 接口设计

### 队列（用户侧）

`POST /api/queue` 对 local 曲目：

```js
// 已 ready
{ status: 'queued' }

// 未 ready（需下载）
{ status: 'preparing', progress: { stage: 'queued' } }
```

两种情况都返回 **201**。

### 曲库管理（DJ 侧，需 admin 鉴权）

`GET /api/library/admin?status=&q=`

返回每首歌的详细状态：

```json
{
  "items": [
    {
      "spotifyId": "2JiDi0qAXsPwhPqA2qaKGt",
      "title": "Bohemian Rhapsody",
      "artists": ["Queen"],
      "album": "A Night At The Opera",
      "cover": "/media/covers/xxx.jpg",
      "status": "separated",
      "statusText": "已处理",
      "stage": null,
      "processingS": 34.9,
      "rtf": 0.0972,
      "audioBytes": 14380973,
      "matchScore": 91.8,
      "error": null,
      "createdAt": "2026-10-28 17:20:05"
    }
  ]
}
```

`status` → `statusText` 映射：

| tracks.status | statusText | 说明 |
| --- | --- | --- |
| `new` / `resolving` | 待处理 | |
| `resolved` / `downloading` | 处理中 · 下载中 | |
| `downloaded` / `separating` | 处理中 · 分离中 | |
| `separated` | **已处理** | 可播放 |
| `failed` | 处理失败 | 带 error |

### 前端

**点歌页（join）**
- 队列项 `preparing` → 「准备中」
- `queued` / `playing` → 正常显示
- `prepare_failed` → 「准备失败」+ 删除按钮

**DJ 控制台（admin）**
- 新增标签页「曲库管理」
- 表格：封面 / 曲名 / 歌手 / 状态 / 耗时 / 大小 / 匹配分
- 可按状态筛选
- 处理中的项实时刷新（SSE 或轮询）

## 实施注意

1. **不要改动 pipeline.py 的算法**（`finalize_track.py` 有 `ALGORITHM_VERSION` 守卫）
2. **已有 4 首歌的产物不能损坏**（备份在 `.tmp\backup\library.db`）
3. python 进程需要环境变量：`PYTHONIOENCODING`、`TORCH_HOME`、`HF_HOME`、`TMP`
4. 阶段识别用宽��正则匹配 stdout，容忍 pipeline 输出格式变化

## 验证清单

- [ ] 点一首未下载的歌 → 201，队列项 `preparing`
- [ ] 后台跑完 → `tracks.status='separated'`，4 个 mp3 生成
- [ ] 队列项变 `queued`，可以播放
- [ ] **前面的歌还在 `preparing` 时，后面点歌 / 切歌不会插队播放**（按队列顺序等它做完；
      队首是 `prepare_failed` 时跳过，不卡死整条队列）
- [ ] **DJ 的「切歌」可以跳过正在制作的队首**：只解除队列占位，后台任务继续跑完进曲库
- [ ] **用户端上移/下移对 `preparing` 的歌也生效**；把 ready 的歌移到它前面会立即开播
      （调序是「移动」不是「交换」，不会打乱中间其他用户的相对顺序）
- [ ] **删掉队列项 → 后台任务仍跑完，产物仍在曲库**
- [ ] 失败情况 → `prepare_failed` + 真实错误原因
- [ ] `/api/library/admin` 字段完整、状态正确
- [ ] 并发验证：连点 5 首，确认同时最多 3 个 python 进程；DJ 控制台能看到 3 个「处理中」
- [ ] GPU 串行验证：`logs\prepare-*.log` 里出现「等待 GPU 分离锁 Ns」，同一时刻只有 1 个 Demucs
- [ ] 回归：`node tests\prepare-queue.test.js`（并发/取消/重启恢复）
- [ ] 回归：`python tests\test_pipeline_parallel.py`（下载 ∥ 歌词、独立 SQLite 连接）
- [ ] 回归：`playback-lyrics` 15/15、`library-mode` 13/13
