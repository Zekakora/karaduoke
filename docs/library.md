# 本地曲库数据层（`python/library.py` + `data/library.db`）

SQLite 单文件库，Python 侧**写**，Node 侧（`server.js`）平时**只读**；
只有 DJ 在曲库管理里删除歌曲时，Node 会用一条独立的短连接写一次
（`lib/library-db.js` 的 `deleteTrack`）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `python/schema.sql` | 建表脚本（`tracks / stems / lyrics / jobs`），全部 `IF NOT EXISTS` |
| `python/library.py` | 数据访问层 + CLI |
| `data/library.db` | 实际库文件（WAL：伴随 `-wal` / `-shm`） |
| `tests/test_library.py` | 测试（普通脚本，不依赖 pytest） |

## 并发模型

- `journal_mode = WAL`：读写可并发，Node 读不阻塞 Python 写。
- `busy_timeout = 5000`：写冲突最多等 5 秒，而非立刻 `database is locked`。
- `foreign_keys = ON`：删除 track 时 stems / lyrics / jobs 级联删除。
- 约定：Python 写、Node 平时只读；DJ 删除曲目时 Node 用独立短连接写
  （`BEGIN IMMEDIATE` + `busy_timeout`），不要在任一进程里长时间持有未提交事务。
- 删除曲目：`DELETE /api/library/admin/tracks/:id` 会先停掉对应制作任务，
  再删 `tracks / stems / lyrics / jobs` 记录和 `assets/output/library/<id>`、
  封面、歌词、原始 WAV；被其他曲目复用的原始 WAV/封面会跳过。

## Python API

```python
from library import connect, init_db, upsert_track, get_track

conn = init_db()                                  # 幂等建表
tid  = upsert_track(conn, {"spotify_id": "...", "title": "...", "artists": ["A"]})
t    = get_track(conn, "...")                     # dict，artists 已解析为 list
```

| 函数 | 说明 |
| --- | --- |
| `connect(db_path=None)` | 开连接（WAL / FK / busy_timeout） |
| `init_db(conn=None, db_path=None)` | 执行 schema.sql，可重复调用 |
| `upsert_track(conn, meta) -> int` | 按 `spotify_id` 幂等；缺省字段用 `COALESCE` 保留旧值 |
| `get_track(conn, spotify_id)` / `get_track_by_id` | 返回 dict 或 None |
| `get_track_by_sha(conn, sha256)` | 内容级去重 |
| `set_status(conn, id, status, error=None)` | 状态机校验，非法状态/迁移抛 `ValueError` |
| `mark_failed(conn, id, error)` | 任意状态 → `failed` |
| `update_source(...)` / `update_audio(...)` | 写入来源匹配信息 / 下载结果（后者顺带置 `downloaded`） |
| `add_stem` / `get_stems` | 同 `(track_id, model)` 为 UPDATE |
| `add_lyrics` / `get_lyrics` | 同 `(track_id, provider)` 为 UPDATE；不指定 provider 时优先返回带时间轴的那份 |
| `list_tracks(conn, status=None, limit=100, offset=0)` | 过滤 + 分页，按 `updated_at DESC, id DESC` |
| `count_tracks` / `library_summary` / `log_job` / `get_jobs` | 统计与日志 |

### 状态机

```
new → resolving → resolved → downloading → downloaded → separating → separated
  ↘ 任意状态 → failed（mark_failed）
```

`set_status` 对未知状态、不存在的 track、明显倒退的迁移（如 `separated → new`）抛 `ValueError`。

## CLI

```powershell
python\.venv-xpu\Scripts\python.exe python\library.py init
python\.venv-xpu\Scripts\python.exe python\library.py summary
python\.venv-xpu\Scripts\python.exe python\library.py list --status separated --limit 20
python\.venv-xpu\Scripts\python.exe python\library.py add-demo
```

## HTTP 只读接口

| 路由 | 返回 |
| --- | --- |
| `GET /api/library/summary` | `{tracks, byStatus, withStems, withLyrics, withSyncedLyrics, withAudio, audioBytes}` |
| `GET /api/library/tracks?status=&limit=&offset=` | `{total, limit, offset, status, tracks[]}`；非法 status → 400 `BAD_STATUS` |
| `GET /api/library/tracks/:spotifyId` | `{track, stems[], lyrics, jobs[]}`；不存在 → 404 `NOT_FOUND` |

实现：`server.js` 用 Node 24 内置 `node:sqlite` 的 `DatabaseSync` 以**只读**方式打开同一个 `data/library.db`。
不 spawn 子进程（受限环境 `spawn` 会 `EPERM`，`node --test` 因此也不可用，改用 `node tests\run.js`）。

库文件不存在或 `node:sqlite` 不可用时返回 503（`LIBRARY_NOT_INITIALIZED` / `LIBRARY_UNAVAILABLE`），不会伪造数据。

## 测试

```powershell
$env:PYTHONIOENCODING='utf-8'
python\.venv-xpu\Scripts\python.exe tests\test_library.py
```

测试全部使用 `tempfile.mkdtemp()` 下的临时库，不污染 `data/library.db`。
