# -*- coding: utf-8 -*-
"""本地曲库（SQLite）。

设计：
- 以 Spotify `track_id` 为唯一键，第二次请求同一首歌直接命中，不重复下载。
- 另外用 `audio_sha256` 做内容级去重（同一音频被不同曲目引用时能发现）。

并发：
- 日志模式 WAL（`schema.sql` + `connect()` 双重保证），读写可并发。
- `PRAGMA busy_timeout=5000`：写冲突时最多等 5 秒而不是立刻 `database is locked`。
- **读写方约定**：Python 侧写、Node 侧（`node:sqlite`）只读，WAL 下互不阻塞；
  但不要在任一进程里长时间持有未提交的写事务。
- 写函数内部各自 `commit()`，保持"调用完即落盘"的简单语义（本层不做长事务）。

`schema.sql` 为建表脚本，`init_db()` 可重复执行（全部 IF NOT EXISTS）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
# 曲库位置与 Node 侧（lib/library-db.js）保持一致：优先 LIBRARY_DB 环境变量，
# 否则回退到 <项目根>/data/library.db。否则 Python 侧（测量响度、finalize）会写进
# 另一个文件，Node 读不到 —— 曾经就让响度数据"写了但永远不显示"。
DB_PATH = Path(os.environ.get("LIBRARY_DB") or (ROOT / "data" / "library.db"))
SCHEMA = Path(__file__).resolve().parent / "schema.sql"

# 状态机：new -> resolving -> resolved -> downloading -> downloaded -> separating -> separated
# 任何状态都可跳到 failed。'resolved' 也允许直接开始下载（跳过中间态）。
STATUSES = {
    "new", "resolving", "resolved", "downloading", "downloaded",
    "separating", "separated", "failed",
}

# 允许的状态迁移（用于 set_status 的健全性检查；目标状态本身不合法才抛 ValueError）。
# 这里刻意做得宽松：只拒绝"从终态回到起点"这类明显错误，避免卡住主流程。
_TRANSITIONS: dict[str, set[str]] = {
    "new": {"resolving", "resolved", "downloading", "failed"},
    "resolving": {"resolved", "downloading", "failed"},
    # 允许经 update_audio 直接 resolved -> downloaded（跳过 downloading 标记）
    "resolved": {"downloading", "downloaded", "failed"},
    "downloading": {"downloaded", "failed"},
    "downloaded": {"separating", "separated", "failed"},
    "separating": {"separated", "failed"},
    "separated": {"separating", "failed"},
    "failed": {"new", "resolving", "resolved", "downloading", "downloaded", "separating"},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    """打开连接。返回的连接已开启 WAL / 外键 / busy_timeout。"""
    path = Path(db_path) if db_path else DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


# 已有的库需要补列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
#
# 值 = 列定义。带默认值的 NOT NULL 列写成 `TEXT NOT NULL DEFAULT 'pending'`：
# SQLite 的 ADD COLUMN 允许常量默认值，所以老曲目会直接得到 'pending'，无需回填。
# 迁移可重复执行：列已存在就跳过，不会重复加列、也不会动已有数据。
_MIGRATIONS: dict[str, dict[str, str]] = {
    "tracks": {
        "album_art_path": "TEXT",
        "album_id": "TEXT",
        "release_date": "TEXT",
        "track_number": "INTEGER",
        "disc_number": "INTEGER",
        "explicit": "INTEGER",
        "popularity": "INTEGER",
        # 官方 MV（visualVideoId 系列）。与 source_video_id（音频处理用）互不相干。
        "visual_video_id": "TEXT",
        "visual_match_status": "TEXT NOT NULL DEFAULT 'pending'",
        "visual_match_score": "REAL",
        "visual_video_title": "TEXT",
        "visual_channel_title": "TEXT",
        "visual_duration": "INTEGER",
        "visual_match_reason": "TEXT",
        "visual_matched_at": "TEXT",
        "visual_candidates": "TEXT",
        # 伴奏响度（LUFS / True Peak / LRA），由 scripts/measure_loudness.py 用 ffmpeg 测出。
        # 只存测量结果，不改动音频文件 —— 播放时的增益补偿在前端 Web Audio 里实时做。
        "acc_lufs": "REAL",
        "acc_true_peak_dbfs": "REAL",
        "acc_lra": "REAL",
        "acc_loudness_measured_at": "TEXT",
        "acc_loudness_version": "INTEGER",
        "acc_loudness_source": "TEXT",
        # 同一首歌的规范化身份（歌名 + 歌手完全一致 → 同一个 canonical_id）。
        # 详见 canonical_key() / ensure_canonical()。
        "canonical_id": "TEXT",
    },
}

# 迁移补的列要能建索引（IF NOT EXISTS，可重复执行）
_MIGRATION_INDEXES: dict[str, dict[str, list[str]]] = {
    "tracks": {
        "idx_tracks_visual": ["visual_video_id"],
        "idx_tracks_canonical": ["canonical_id"],
    },
}


def _migrate(conn: sqlite3.Connection) -> list[str]:
    """给已存在的表补列。返回实际新增的列名（供日志/测试断言）。"""
    added: list[str] = []
    for table, columns in _MIGRATIONS.items():
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if not have:
            continue  # 表还不存在（首次建库），schema.sql 已经包含全部列
        for col, coltype in columns.items():
            if col in have:
                continue
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
            added.append(f"{table}.{col}")
        for index, index_cols in _MIGRATION_INDEXES.get(table, {}).items():
            conn.execute(f"CREATE INDEX IF NOT EXISTS {index} ON {table}({', '.join(index_cols)})")
    if added:
        conn.commit()
    return added


def init_db(conn: sqlite3.Connection | None = None, db_path: Path | str | None = None) -> sqlite3.Connection:
    """建表（幂等）。传 conn 则复用，否则按 db_path（或默认）新开。

    顺序很重要：**先迁移补列，再执行 schema.sql**。
    schema.sql 里有 `CREATE INDEX ... ON tracks(visual_video_id)`，而
    `CREATE TABLE IF NOT EXISTS` 不会给已存在的老表加列 —— 先跑 schema.sql 的话，
    老库会因为"没有 visual_video_id 这一列"直接建索引失败（no such column）。
    """
    conn = conn or connect(db_path)
    _migrate(conn)
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.commit()
    # schema.sql 跑完再补一次：首次建库时表是新建的，迁移那一步还没表可改，这里无事可做；
    # 老库在第一步已经补齐。保持两次调用纯粹是为了"任何入口都幂等"。
    _migrate(conn)
    _refresh_canonical_columns(conn)
    return conn


def _refresh_canonical_columns(conn: sqlite3.Connection) -> None:
    """填充 canonical_key 与 canonical_id（幂等，每次 init_db 都跑）。

    - `canonical_key` 由 canonical_key(title, artists) 算出来（规范化歌名 + 排序后的歌手）；
      写入路径（upsert_track）会显式维护它，这里只给老数据补齐，并修正改过歌名的记录。
    - `canonical_id` 先全部自指，再用 canonical_key 找出同组记录并统一指向主记录。
    """
    try:
        have = {r["name"] for r in conn.execute("PRAGMA table_info(tracks)").fetchall()}
    except sqlite3.Error:
        return
    if "canonical_id" not in have:
        return
    # canonical_key 是普通 TEXT 列（不是生成列：SQLite 不允许 ALTER TABLE 追加
    # STORED 生成列，老库会直接报 "cannot add a STORED column"）。
    if "canonical_key" not in have:
        try:
            conn.execute("ALTER TABLE tracks ADD COLUMN canonical_key TEXT")
            conn.commit()
        except sqlite3.Error as error:  # noqa: BLE001
            print(f"[library] 补 canonical_key 列失败（{error}），跳过同一首歌合并")
            return
    conn.create_function("tracks_canonical_key", 2, canonical_key)
    conn.execute(
        "UPDATE tracks SET canonical_key = tracks_canonical_key(title, artists) "
        "WHERE canonical_key IS NULL OR canonical_key = ''"
    )
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tracks_canonical ON tracks(canonical_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tracks_canonkey ON tracks(canonical_key)")
    except sqlite3.Error:
        pass
    regroup_same_songs(conn)


def regroup_same_songs(conn: sqlite3.Connection) -> int:
    """重新计算"同一首歌"的分组，返回本次合并掉的记录数。

    为什么不能只在启动时算一次：任务开始（upsert_track 建记录）和结束（写 status）
    之间可能插入别的新记录，合并关系会变。每次状态变化后都跑一遍才能保持正确 ——
    否则会出现"同一个 canonical_key 下两条记录各自 canonical_id 指向自己"。
    """
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tracks)").fetchall()}
    except sqlite3.Error:
        return 0
    if "canonical_id" not in cols or "canonical_key" not in cols:
        return 0
    try:
        conn.execute("UPDATE tracks SET canonical_id = spotify_id WHERE canonical_id IS NULL OR canonical_id = ''")
        groups = conn.execute(
            "SELECT canonical_key, group_concat(spotify_id) AS ids FROM tracks "
            "WHERE canonical_key IS NOT NULL AND canonical_key <> '' "
            "GROUP BY canonical_key HAVING COUNT(*) > 1"
        ).fetchall()
    except sqlite3.Error:
        return 0
    merged = 0
    for group in groups:
        ids = str(group["ids"]).split(",")
        rows = conn.execute(
            f"SELECT * FROM tracks WHERE spotify_id IN ({','.join('?' * len(ids))})", ids
        ).fetchall()
        # 同名同歌手还要时长接近才算同一首：按时长聚成若干簇，每簇一个主记录。
        # 簇内任意一条时长在容差范围内即可归入（与簇首比较会漏掉"簇首恰好偏差最大"的情况）。
        clusters: list[list[sqlite3.Row]] = []
        for row in rows:
            placed = False
            for cluster in clusters:
                if any(is_same_song(row["title"], row["artists"], row["duration_ms"],
                                    other["title"], other["artists"], other["duration_ms"])
                       for other in cluster):
                    cluster.append(row)
                    placed = True
                    break
            if not placed:
                clusters.append([row])
        for cluster in clusters:
            if len(cluster) < 2:
                continue
            # 组里已有明确的主记录（canonical_id 指向组内某条记录）→ 默认沿用它，保持稳定。
            known = [r["canonical_id"] for r in cluster if r["canonical_id"]]
            member_ids = [r["spotify_id"] for r in cluster]
            by_id = {r["spotify_id"]: r for r in cluster}
            primary = next((c for c in known if c in member_ids), None)
            # **例外：主记录不可播、组里却有可播记录** → 换成可播那条。
            # 前端/点歌都按主记录判断"能不能播放"，主记录选错会让整组显示未就绪，
            # 用户再点一次就触发重复下载（曾发生：主记录只有 downloaded 状态）。
            best = max(cluster, key=lambda r: _ready_score(conn, r))
            best_playable = _ready_score(conn, best)[0]
            if primary is not None and best_playable:
                if not _ready_score(conn, by_id[primary])[0]:
                    primary = best["spotify_id"]
            if primary is None:
                primary = best["spotify_id"]
            merged += sum(1 for r in cluster if r["spotify_id"] != primary or r["canonical_id"] != primary)
            conn.execute(
                f"UPDATE tracks SET canonical_id = ? WHERE spotify_id IN ({','.join('?' * len(member_ids))})",
                [primary, *member_ids],
            )
    conn.commit()
    return merged


# ---------------------------------------------------------------- 行 -> dict
def _track_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    d["artists"] = _parse_artists(d.get("artists"))
    # visual_candidates 是 JSON 字符串，解析成 list 更好用（旧库可能没有这一列）
    raw_candidates = d.pop("visual_candidates", None)
    if raw_candidates:
        try:
            parsed = json.loads(raw_candidates)
            d["visual_candidates"] = parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            d["visual_candidates"] = []
    return d


def _parse_artists(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        val = json.loads(raw)
    except (TypeError, ValueError):
        return [p.strip() for p in str(raw).split(",") if p.strip()]
    if isinstance(val, str):
        return [val]
    return [str(x) for x in val] if isinstance(val, list) else []


# ---------------------------------------------------------------- 同一首歌的规范化身份
#
# 同一首歌在 Spotify 上可能有多个 track_id：单曲 EP 版、专辑版、精选集版、不同地区版，
# **专辑不同但其实是同一首歌**。过去会被当成两首歌：下载两次、Demucs 分离两次、占两份磁盘。
#
# 判定规则（按用户要求，以 Spotify 源数据为准）：
#   **同一歌手 + 同一歌名 + 时长差 ≤ SAME_SONG_TOLERANCE_S 秒 → 同一首歌**
#   专辑**不参与**判定（EP 版和 Album 版算同一首）。
#
# 为什么必须带时长：同名歌经常是完全不同的作品（Intro / Interlude / 同名主打歌），
# 时长是最便宜可靠的区分信号。容差默认 8 秒（覆盖片尾淡出的几秒差异），
# 可用环境变量 KARAOKE_SAME_SONG_TOLERANCE_S 调整。
#
# 文本规范化只做"明显无意义"的归一化，不做模糊匹配：
#   * 全角/半角、大小写、多余空白；
#   * 弯引号 vs 直引号、各类连字符；
#   * 歌手列表排序后比较（"A, B" 与 "B, A" 视为同一组）；
#   * **不去掉** (feat. …) / - Remastered 之类的后缀 —— 那些通常是不同版本。
#
# 每组有一条"主记录"：canonical_id == 自己的 spotify_id，其余记录 canonical_id 指向它。
# 主记录的选择：已有分离产物 > 已下载音频 > id 最小（最早入库）。
# 从属记录**不复制文件**，而是用自己 spotify_id 命名的目录，里面是指向主记录产物的
# 硬链接（NTFS 同卷瞬时完成、不占额外空间），播放端所有 URL 形状保持不变。

_QUOTE_MAP = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2032": "'", "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
    "\u3000": " ",
})

# 时长容差（秒）：同一首歌在不同专辑/版本里通常差 0~3 秒（前奏/片尾多几秒），
# 8 秒足够宽松，又不会把同名但不同的歌（通常差几十秒）并进来。
SAME_SONG_TOLERANCE_S = float(os.environ.get("KARAOKE_SAME_SONG_TOLERANCE_S") or 8)


def _normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.translate(_QUOTE_MAP).lower()
    return " ".join(text.split())


def _artist_names(artists: Any) -> list[str]:
    if isinstance(artists, str):
        try:
            parsed = json.loads(artists)
            items = parsed if isinstance(parsed, list) else [parsed]
        except (TypeError, ValueError):
            items = [a.strip() for a in artists.split(",")]
    else:
        items = list(artists or [])
    return sorted({_normalize_text(a) for a in items if _normalize_text(a)})


def canonical_key(title: Any, artists: Any) -> str:
    """同一首歌的文本判定键（不含时长）：规范化歌名 + 排序后的规范化歌手集合。

    时长在比较时单独判断（见 is_same_song），因为一条键里塞不下"范围"。
    歌名或歌手为空 → 返回空串（调用方据此跳过合并，宁可重复也不要错误合并）。
    """
    name = _normalize_text(title)
    if not name:
        return ""
    names = _artist_names(artists)
    if not names:
        return ""
    return name + "\x00" + "|".join(names)


def _dur_seconds(value: Any) -> float | None:
    """时长统一成秒：库里存的是毫秒（duration_ms），调用方也可能传秒。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number / 1000.0 if number > 1000 else number


def is_same_song(title_a: Any, artists_a: Any, duration_a: Any,
                 title_b: Any, artists_b: Any, duration_b: Any,
                 tolerance: float | None = None) -> bool:
    """两首 Spotify 曲目是否**同一首歌**：同名 + 同歌手 + 时长差在容差内。

    时长单位统一成秒再比较 —— 库里是毫秒，调用方偶尔传秒，
    以前直接相减会把 297090(ms) 和 297127(ms) 算成"差 37 秒"。
    任一侧时长为空 → 只要文本键相同就认为同一首（拿不到时长时没有更好的依据）。
    专辑不参与判断：EP 版和 Album 版视为同一首。
    """
    key_a = canonical_key(title_a, artists_a)
    key_b = canonical_key(title_b, artists_b)
    if not key_a or key_a != key_b:
        return False
    tol = SAME_SONG_TOLERANCE_S if tolerance is None else float(tolerance)
    da = _dur_seconds(duration_a)
    db = _dur_seconds(duration_b)
    if da is None or db is None:
        return True
    return abs(da - db) <= tol


def _ready_score(conn: sqlite3.Connection, row: sqlite3.Row) -> tuple:
    """主记录排序键（越大越好）。

    优先级：**真正可播放（有 vocals + accompaniment 两个成品）** > 有分离产物 >
    状态靠后（separated 优先于 downloaded） > 有音频 > id 小。

    为什么必须是"真正可播放"排第一：曾经把状态 downloaded（只下载了原始 WAV、
    还没分离）的记录选成主记录，前端按主记录判断能不能播 → 判定不可播 →
    又触发一次下载；而组里其实有一条已分离好的记录。主记录选错会让整组都"不可播"。
    """
    try:
        row_ready = conn.execute(
            "SELECT (s.vocals_path IS NOT NULL AND s.vocals_path <> '' "
            "AND s.no_vocals_path IS NOT NULL AND s.no_vocals_path <> '') AS ok "
            "FROM stems s WHERE s.track_id = ? ORDER BY s.id DESC LIMIT 1", (row["id"],)
        ).fetchone()
    except sqlite3.Error:
        row_ready = None
    playable = 1 if (row_ready and row_ready["ok"]) else 0
    try:
        stems = conn.execute("SELECT COUNT(*) AS n FROM stems s WHERE s.track_id = ?", (row["id"],)).fetchone()["n"]
    except sqlite3.Error:
        stems = 0
    status = str(row["status"] or "")
    status_rank = {"separated": 3, "separating": 2, "downloaded": 1}.get(status, 0)
    has_audio = 1 if row["audio_path"] else 0
    return (playable, 1 if stems else 0, status_rank, has_audio, -int(row["id"]))


def same_song_members(conn: sqlite3.Connection, title: Any, artists: Any,
                      duration_ms: Any = None) -> list[sqlite3.Row]:
    """找出曲库里和给定 Spotify 曲目"同一首歌"的所有记录（含主记录）。

    先按文本键取候选，再用时长容差过滤（EP 版 / 专辑版时长接近 → 同一首）。
    """
    key = canonical_key(title, artists)
    if not key:
        return []
    try:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE canonical_key = ?", (key,)
        ).fetchall()
    except sqlite3.Error:
        rows = []
    target = _dur_seconds(duration_ms)
    if target is None:
        return list(rows)
    kept = []
    for row in rows:
        other = _dur_seconds(row["duration_ms"])
        if other is None or abs(other - target) <= SAME_SONG_TOLERANCE_S:
            kept.append(row)
    return kept


def find_same_song(conn: sqlite3.Connection, title: Any, artists: Any,
                   duration_ms: Any = None,
                   exclude_spotify_id: str | None = None) -> sqlite3.Row | None:
    """在曲库里找"同一首歌"里最合适的记录（同名 + 同歌手 + 时长接近）。

    返回最适合当作主记录的那一行，没有就返回 None。只查数据库，不做文件操作。
    """
    rows = same_song_members(conn, title, artists, duration_ms)
    rows = [r for r in rows if str(r["spotify_id"]) != str(exclude_spotify_id or "")]
    if not rows:
        return None
    rows.sort(key=lambda r: _ready_score(conn, r), reverse=True)
    return rows[0]


def find_same_song(conn: sqlite3.Connection, title: Any, artists: Any,
                   exclude_spotify_id: str | None = None) -> sqlite3.Row | None:
    """在曲库里找"同一首歌"（歌名 + 歌手完全一致）里最合适的记录。

    返回主记录所在的整组里**最适合当作主记录**的那一行（sqlite3.Row），没有就返回 None。
    只查数据库，不做任何文件操作。
    """
    key = canonical_key(title, artists)
    if not key:
        return None
    try:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE canonical_key IS NOT NULL AND canonical_key = ?",
            (key,),
        ).fetchall()
    except sqlite3.Error:
        return None
    rows = [r for r in rows if str(r["spotify_id"]) != str(exclude_spotify_id or "")]
    if not rows:
        return None
    rows.sort(key=lambda r: _ready_score(conn, r), reverse=True)
    return rows[0]


def ensure_canonical(conn: sqlite3.Connection, spotify_id: str) -> str | None:
    """给一首歌确定 canonical_id（幂等，每次调用都会重新归组）。

    返回当前记录的 canonical_id（通常是主记录的 spotify_id）。
    """
    row = conn.execute(
        "SELECT * FROM tracks WHERE spotify_id = ?", (spotify_id,)
    ).fetchone()
    if row is None:
        return None
    key = canonical_key(row["title"], row["artists"])
    if not key:
        return None
    if not row["canonical_key"]:
        conn.execute("UPDATE tracks SET canonical_key = ? WHERE id = ?", (key, row["id"]))
        conn.commit()
    # 统一交给 regroup_same_songs：它会按时长聚簇、沿用已有主记录、并把整组指向主记录。
    # 以前这里只在 canonical_id 为空时才动手，导致"任务跑完后新建的记录"永远不归组。
    regroup_same_songs(conn)
    current = conn.execute(
        "SELECT canonical_id FROM tracks WHERE spotify_id = ?", (spotify_id,)
    ).fetchone()
    return str((current["canonical_id"] if current else None) or spotify_id)


def find_primary(conn: sqlite3.Connection, spotify_id: str) -> dict[str, Any] | None:
    """返回这首歌"真正存放文件的那条记录"（主记录）。没有合并关系时就是它自己。"""
    row = conn.execute(
        "SELECT * FROM tracks WHERE spotify_id = ?", (spotify_id,)
    ).fetchone()
    if row is None:
        return None
    canonical = row["canonical_id"] or row["spotify_id"]
    if canonical == row["spotify_id"]:
        return _track_dict(row)
    try:
        primary = conn.execute(
            "SELECT * FROM tracks WHERE spotify_id = ?", (canonical,)
        ).fetchone()
    except sqlite3.Error:
        primary = None
    return _track_dict(primary or row)


# ---------------------------------------------------------------- tracks
def upsert_track(conn: sqlite3.Connection, meta: dict[str, Any]) -> int:
    """插入或更新 Spotify 曲目元数据（按 spotify_id 幂等）；返回内部 id。"""
    artists = meta.get("artists") or []
    if isinstance(artists, str):
        artists = [artists]
    conn.execute(
        """
        INSERT INTO tracks (spotify_id, title, artists, album, album_art, album_art_path, album_id,
                            release_date, track_number, disc_number, explicit, popularity,
                            duration_ms, uri, isrc, canonical_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(spotify_id) DO UPDATE SET
            title=excluded.title,
            artists=excluded.artists,
            album=COALESCE(excluded.album, tracks.album),
            album_art=COALESCE(excluded.album_art, tracks.album_art),
            album_art_path=COALESCE(excluded.album_art_path, tracks.album_art_path),
            album_id=COALESCE(excluded.album_id, tracks.album_id),
            release_date=COALESCE(excluded.release_date, tracks.release_date),
            track_number=COALESCE(excluded.track_number, tracks.track_number),
            disc_number=COALESCE(excluded.disc_number, tracks.disc_number),
            explicit=COALESCE(excluded.explicit, tracks.explicit),
            popularity=COALESCE(excluded.popularity, tracks.popularity),
            duration_ms=COALESCE(excluded.duration_ms, tracks.duration_ms),
            uri=COALESCE(excluded.uri, tracks.uri),
            isrc=COALESCE(excluded.isrc, tracks.isrc),
            -- 歌名/歌手可能变了（Spotify 改名）：键要跟着变，否则会卡在旧分组里
            canonical_key=CASE
                WHEN tracks.canonical_key IS NULL OR tracks.canonical_key = ''
                  OR tracks.title <> excluded.title OR tracks.artists <> excluded.artists
                THEN excluded.canonical_key ELSE tracks.canonical_key END,
            updated_at=?
        """,
        (
            meta["spotify_id"],
            meta["title"],
            json.dumps(artists, ensure_ascii=False),
            meta.get("album"),
            meta.get("album_art"),
            meta.get("album_art_path"),
            meta.get("album_id"),
            meta.get("release_date"),
            meta.get("track_number"),
            meta.get("disc_number"),
            None if meta.get("explicit") is None else int(bool(meta["explicit"])),
            meta.get("popularity"),
            meta.get("duration_ms"),
            meta.get("uri"),
            meta.get("isrc"),
            canonical_key(meta["title"], artists),
            now(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM tracks WHERE spotify_id = ?", (meta["spotify_id"],)).fetchone()
    # 新记录一建出来就归组：这样它从一开始就和"同一首歌"的其他版本共用成品，
    # 不会出现"任务跑完了还是一条独立记录"的情况（列表里就不会多出一首）。
    try:
        regroup_same_songs(conn)
    except sqlite3.Error as error_:  # noqa: BLE001
        print(f"[library] 新记录归组失败（忽略，下次启动会补）：{error_}")
    return int(row["id"])


def get_track(conn: sqlite3.Connection, spotify_id: str) -> dict[str, Any] | None:
    """按 spotify_id 查曲目；`artists` 已解析为 list。"""
    row = conn.execute("SELECT * FROM tracks WHERE spotify_id = ?", (spotify_id,)).fetchone()
    return _track_dict(row)


def get_track_by_id(conn: sqlite3.Connection, track_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    return _track_dict(row)


def get_track_by_sha(conn: sqlite3.Connection, sha256: str) -> dict[str, Any] | None:
    """内容级去重：同一段音频是否已被别的曲目下载过。"""
    if not sha256:
        return None
    row = conn.execute(
        "SELECT * FROM tracks WHERE audio_sha256 = ? ORDER BY id LIMIT 1", (sha256,)
    ).fetchone()
    return _track_dict(row)


def set_status(conn: sqlite3.Connection, track_id: int, status: str, error: str | None = None) -> None:
    """更新状态。未知状态抛 ValueError；明显倒退的迁移抛 ValueError。"""
    if status not in STATUSES:
        raise ValueError(f"未知状态: {status!r}（可选: {', '.join(sorted(STATUSES))}）")
    row = conn.execute("SELECT status FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if row is None:
        raise ValueError(f"曲目不存在: track_id={track_id}")
    current = row["status"]
    if current != status and status not in _TRANSITIONS.get(current, set()):
        raise ValueError(f"非法状态迁移: {current} -> {status}")
    # 成功状态清掉旧错误；failed 状态必须带原因（可为空字符串）
    conn.execute(
        "UPDATE tracks SET status = ?, error = ?, updated_at = ? WHERE id = ?",
        (status, error, now(), track_id),
    )
    conn.commit()
    # 这条记录可能刚被建成"另一张专辑的同名歌"，状态一变就重新归组一次，
    # 否则它会一直自成一个 canonical 组，列表里就多出一首重复的歌。
    try:
        regroup_same_songs(conn)
    except sqlite3.Error as error_:  # noqa: BLE001
        print(f"[library] 重新分组失败（忽略，下次启动会补）：{error_}")


def mark_failed(conn: sqlite3.Connection, track_id: int, error: str) -> None:
    """标记失败并记录原因（绕过迁移检查：任何状态都可能失败）。"""
    conn.execute(
        "UPDATE tracks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        (str(error)[:2000], now(), track_id),
    )
    conn.commit()
    try:
        regroup_same_songs(conn)
    except sqlite3.Error:  # noqa: BLE001
        pass


def update_source(
    conn: sqlite3.Connection,
    track_id: int,
    *,
    source: str,
    video_id: str | None,
    url: str | None,
    title: str | None,
    score: float | None,
    reason: str | None,
) -> None:
    conn.execute(
        """UPDATE tracks SET source=?, source_video_id=?, source_url=?, source_title=?,
           match_score=?, match_reason=?, updated_at=? WHERE id=?""",
        (source, video_id, url, title, score, reason, now(), track_id),
    )
    conn.commit()


def update_audio(
    conn: sqlite3.Connection,
    track_id: int,
    *,
    path: str,
    bytes_: int,
    sha256: str,
) -> None:
    conn.execute(
        "UPDATE tracks SET audio_path=?, audio_bytes=?, audio_sha256=?, status='downloaded', updated_at=? WHERE id=?",
        (path, bytes_, sha256, now(), track_id),
    )
    conn.commit()


# ---------------------------------------------------------------- 官方 MV（visualVideoId）
#
# 与 update_source() 完全分开：source_video_id 是**音频处理**用的 YouTube 视频，
# visual_video_id 是**画面**用的官方 MV。两者独立存储、独立更新，任何一方都不会覆盖另一方。
# 状态机见 docs/official-mv.md：
#   pending（默认，等待匹配/管理员确认） → auto_matched（高置信度自动匹配）
#                                         → manually_confirmed（管理员确认/手填）
#                                         → not_found（没找到合适的）
#                                         → unavailable（视频不可用/不允许嵌入）
#                                         → cover_only（管理员主动选择「用模糊封面」，不播 MV）
VISUAL_STATUSES = {"pending", "auto_matched", "manually_confirmed", "not_found", "unavailable", "cover_only"}
# 这些状态代表"管理员已经明确拍板"：自动匹配不允许覆盖它们。
VISUAL_LOCKED_STATUSES = {"manually_confirmed", "cover_only"}
# 这些状态下已有可用的 visual_video_id，播放时直接复用，不再调 YouTube 搜索。
VISUAL_REUSABLE_STATUSES = {"auto_matched", "manually_confirmed"}


def valid_video_id(video_id: Any) -> str | None:
    """校验 YouTube videoId（11 位 base64url 字符）；不合法返回 None。"""
    text = str(video_id or "").strip()
    if not text:
        return None
    return text if re.fullmatch(r"[A-Za-z0-9_-]{11}", text) else None


# 旧名字保留（内部/测试可能引用）
_valid_video_id = valid_video_id


def get_visual(conn: sqlite3.Connection, spotify_id: str) -> dict[str, Any] | None:
    """读一首歌的官方 MV 匹配结果（没有记录返回 None）。"""
    row = conn.execute(
        """SELECT visual_video_id, visual_match_status, visual_match_score, visual_video_title,
                  visual_channel_title, visual_duration, visual_match_reason, visual_matched_at,
                  visual_candidates
             FROM tracks WHERE spotify_id = ?""",
        (spotify_id,),
    ).fetchone()
    if row is None:
        return None
    return _visual_dict(row)


def _visual_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    raw_candidates = d.pop("visual_candidates", None)
    candidates: list = []
    if raw_candidates:
        try:
            parsed = json.loads(raw_candidates)
            candidates = parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            candidates = []
    d["candidates"] = candidates
    return d


def update_visual(
    conn: sqlite3.Connection,
    spotify_id: str,
    *,
    status: str | None = None,
    video_id: str | None = None,
    video_title: str | None = None,
    channel_title: str | None = None,
    duration: int | None = None,
    score: float | None = None,
    reason: str | None = None,
    candidates: list | None = None,
    clear: bool = False,
    force: bool = False,
) -> dict[str, Any] | None:
    """写入官方 MV 匹配结果。

    - `status` 必须是 VISUAL_STATUSES 之一；
    - `clear=True`：清空 visual_video_id 及元数据，状态回到 pending（管理员"清除 MV"）；
    - `force=False`（默认）：**不覆盖** manually_confirmed。重复自动搜索时，
      管理员已经确认过的结果保持原样（返回原记录）。管理员主动改/确认时传 force=True；
        `status='unavailable'` 也总是允许写入 —— 视频挂了必须记下来，否则每次播放都会重试它。
    - 成功状态带时间戳 visual_matched_at。

    返回写入后的记录。
    """
    sid = str(spotify_id or "").strip()
    row = conn.execute("SELECT id, visual_match_status FROM tracks WHERE spotify_id = ?", (sid,)).fetchone()
    if row is None:
        return None
    current = row["visual_match_status"] or "pending"
    track_id = int(row["id"])

    if status is not None and status not in VISUAL_STATUSES:
        raise ValueError(f"未知 MV 状态: {status!r}（可选: {', '.join(sorted(VISUAL_STATUSES))}）")

    if not force and status != "unavailable" and current in VISUAL_LOCKED_STATUSES:
        # 管理员已经确认过：自动匹配不得覆盖
        return get_visual(conn, sid)

    stamp = now()
    if clear:
        conn.execute(
            """UPDATE tracks SET visual_video_id = NULL, visual_match_status = 'pending',
                      visual_match_score = NULL, visual_video_title = NULL, visual_channel_title = NULL,
                      visual_duration = NULL, visual_match_reason = NULL, visual_matched_at = NULL,
                      visual_candidates = NULL, updated_at = ?
                WHERE id = ?""",
            (stamp, track_id),
        )
        conn.commit()
        return get_visual(conn, sid)

    video_id = _valid_video_id(video_id)
    fields: list[str] = []
    params: list[Any] = []
    for col, value in (
        ("visual_video_id", video_id),
        ("visual_video_title", video_title),
        ("visual_channel_title", channel_title),
        ("visual_duration", int(duration) if duration is not None else None),
        # 保留两位小数：评分是给人看的，不需要浮点噪声
        ("visual_match_score", round(float(score), 2) if score is not None else None),
        ("visual_match_reason", reason),
    ):
        if value is not None:
            fields.append(f"{col} = ?")
            params.append(value)
    if candidates is not None:
        fields.append("visual_candidates = ?")
        params.append(json.dumps(candidates, ensure_ascii=False)[:200_000])
    if status == "unavailable" and video_id is None:
        # 明确"这个视频不可用且没有替代"：清掉 id，避免播放端反复加载同一个坏视频。
        # （放在下面赋值之前：status 为 None 时这里的 reason 已经写进 params）
        fields.append("visual_video_id = NULL")
        if reason is not None:
            fields.append("visual_match_reason = ?")
            params.append(reason)
    if status is not None:
        fields.append("visual_match_status = ?")
        params.append(status)
        fields.append("visual_matched_at = ?")
        params.append(stamp)
    elif reason is not None and "visual_video_id = NULL" not in fields:
        # 只更新元数据（比如管理员手填 videoId 但状态另给）时，也刷新时间戳
        fields.append("visual_matched_at = ?")
        params.append(stamp)
    if not fields:
        return get_visual(conn, sid)
    fields.append("updated_at = ?")
    params.append(stamp)
    params.append(track_id)
    conn.execute(f"UPDATE tracks SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
    return get_visual(conn, sid)


def find_by_sha(conn: sqlite3.Connection, sha256: str) -> tuple | None:
    """兼容旧调用：返回原始 Row（新代码请用 get_track_by_sha 拿 dict）。"""
    return conn.execute(
        "SELECT * FROM tracks WHERE audio_sha256 = ? LIMIT 1", (sha256,)
    ).fetchone()


def list_tracks(
    conn: sqlite3.Connection,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """按状态过滤 + 分页，返回 dict 列表（artists 已解析）。"""
    if status is not None and status not in STATUSES:
        raise ValueError(f"未知状态: {status!r}")
    limit = max(1, min(int(limit), 1000))
    offset = max(0, int(offset))
    if status:
        rows = conn.execute(
            "SELECT * FROM tracks WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
            (status, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM tracks ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_track_dict(r) for r in rows]


def count_tracks(conn: sqlite3.Connection, status: str | None = None) -> int:
    if status:
        return int(conn.execute("SELECT COUNT(*) AS n FROM tracks WHERE status = ?", (status,)).fetchone()["n"])
    return int(conn.execute("SELECT COUNT(*) AS n FROM tracks").fetchone()["n"])


# ---------------------------------------------------------------- 伴奏响度
#
# 与 update_visual / update_source 一样是**独立的一段**：它只描述"这首伴奏听起来多响"，
# 不参与音频处理，也不改任何文件。播放端（Web Audio GainNode）按需用它算增益。
LOUDNESS_COLUMNS = (
    "acc_lufs",
    "acc_true_peak_dbfs",
    "acc_lra",
    "acc_loudness_measured_at",
    "acc_loudness_version",
    "acc_loudness_source",
)


def get_loudness(conn: sqlite3.Connection, spotify_id: str) -> dict[str, Any] | None:
    """读一首歌的伴奏响度；没测过返回 None（老库缺列时也返回 None）。"""
    try:
        row = conn.execute(
            f"SELECT {', '.join(LOUDNESS_COLUMNS)} FROM tracks WHERE spotify_id = ?",
            (spotify_id,),
        ).fetchone()
    except sqlite3.OperationalError:
        return None  # 还没迁移出这几列
    if row is None:
        return None
    d = dict(row)
    return {
        "lufs": d.get("acc_lufs"),
        "truePeakDbfs": d.get("acc_true_peak_dbfs"),
        "lra": d.get("acc_lra"),
        "measuredAt": d.get("acc_loudness_measured_at"),
        "version": d.get("acc_loudness_version"),
        "source": d.get("acc_loudness_source"),
    }


def update_loudness(
    conn: sqlite3.Connection,
    spotify_id: str,
    values: dict[str, Any],
    *,
    force: bool = False,
) -> bool:
    """写入伴奏响度测量结果。返回是否真的写了。

    force=False（默认）：已经有测量值时**跳过**（返回 False），
    免得每首歌每次跑流水线都重测一遍（一次 ffmpeg 分析几秒钟）。
    """
    if not force:
        existing = get_loudness(conn, spotify_id)
        if existing and existing.get("lufs") is not None:
            return False
    try:
        cur = conn.execute(
            """UPDATE tracks
                  SET acc_lufs=?, acc_true_peak_dbfs=?, acc_lra=?,
                      acc_loudness_measured_at=?, acc_loudness_version=?, acc_loudness_source=?,
                      updated_at=?
                WHERE spotify_id=?""",
            (
                values.get("lufs"),
                values.get("true_peak_dbfs"),
                values.get("lra"),
                now(),
                values.get("version"),
                values.get("source"),
                now(),
                spotify_id,
            ),
        )
    except sqlite3.OperationalError:
        return False  # 老库还没这几列（理论上迁移会先跑，兜个底）
    conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------- stems
def add_stem(conn: sqlite3.Connection, track_id: int, row: dict[str, Any]) -> None:
    """同一 (track_id, model) 重复写入 = 覆盖更新，不报错。"""
    conn.execute(
        """
        INSERT INTO stems (track_id, model, device, segment, out_dir, vocals_path, no_vocals_path,
                           drums_path, bass_path, other_path, input_duration_s, processing_s, rtf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id, model) DO UPDATE SET
            device=COALESCE(excluded.device, stems.device),
            segment=COALESCE(excluded.segment, stems.segment),
            out_dir=excluded.out_dir,
            vocals_path=COALESCE(excluded.vocals_path, stems.vocals_path),
            no_vocals_path=COALESCE(excluded.no_vocals_path, stems.no_vocals_path),
            drums_path=COALESCE(excluded.drums_path, stems.drums_path),
            bass_path=COALESCE(excluded.bass_path, stems.bass_path),
            other_path=COALESCE(excluded.other_path, stems.other_path),
            input_duration_s=COALESCE(excluded.input_duration_s, stems.input_duration_s),
            processing_s=COALESCE(excluded.processing_s, stems.processing_s),
            rtf=COALESCE(excluded.rtf, stems.rtf)
        """,
        (
            track_id, row["model"], row.get("device"), row.get("segment"), row["out_dir"],
            row.get("vocals_path"), row.get("no_vocals_path"), row.get("drums_path"),
            row.get("bass_path"), row.get("other_path"), row.get("input_duration_s"),
            row.get("processing_s"), row.get("rtf"),
        ),
    )
    conn.commit()


def get_stems(conn: sqlite3.Connection, track_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM stems WHERE track_id = ? ORDER BY id", (track_id,)
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- lyrics
def add_lyrics(conn: sqlite3.Connection, track_id: int, row: dict[str, Any]) -> None:
    """同一 (track_id, provider) 重复写入 = 覆盖更新，不报错。"""
    conn.execute(
        """
        INSERT INTO lyrics (track_id, provider, synced, format, language, content, plain, provider_id, offset_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id, provider) DO UPDATE SET
            synced=excluded.synced, format=excluded.format, language=excluded.language,
            content=excluded.content, plain=excluded.plain, provider_id=excluded.provider_id,
            offset_ms=excluded.offset_ms,
            fetched_at=datetime('now')
        """,
        (
            track_id, row["provider"], 1 if row.get("synced") else 0, row.get("format"),
            row.get("language"), row.get("content"), row.get("plain"), row.get("provider_id"),
            row.get("offset_ms") or 0,
        ),
    )
    conn.commit()


def get_lyrics(conn: sqlite3.Connection, track_id: int, provider: str | None = None) -> dict[str, Any] | None:
    """取歌词：优先 provider，否则优先带时间轴（synced=1）的那份，再按 id。"""
    if provider:
        row = conn.execute(
            "SELECT * FROM lyrics WHERE track_id = ? AND provider = ?", (track_id, provider)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM lyrics WHERE track_id = ? ORDER BY synced DESC, id LIMIT 1", (track_id,)
        ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------- jobs
def log_job(
    conn: sqlite3.Connection,
    track_id: int | None,
    kind: str,
    status: str,
    message: str = "",
    duration_ms: int | None = None,
) -> None:
    conn.execute(
        "INSERT INTO jobs (track_id, kind, status, message, duration_ms) VALUES (?, ?, ?, ?, ?)",
        (track_id, kind, status, message, duration_ms),
    )
    conn.commit()


def get_jobs(conn: sqlite3.Connection, track_id: int, limit: int = 50) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM jobs WHERE track_id = ? ORDER BY id DESC LIMIT ?", (track_id, limit)
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 汇总
def library_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute("SELECT status, COUNT(*) AS n FROM tracks GROUP BY status").fetchall()
    by_status = {r["status"]: r["n"] for r in rows}
    stems = conn.execute("SELECT COUNT(*) AS n FROM stems").fetchone()["n"]
    lyr = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(synced), 0) AS synced FROM lyrics").fetchone()
    audio = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(audio_bytes), 0) AS bytes FROM tracks WHERE audio_path IS NOT NULL"
    ).fetchone()
    return {
        "dbPath": str(DB_PATH),
        "tracks": sum(by_status.values()),
        "byStatus": by_status,
        "withStems": stems,
        "withLyrics": lyr["n"] or 0,
        "withSyncedLyrics": lyr["synced"] or 0,
        "withAudio": audio["n"] or 0,
        "audioBytes": audio["bytes"] or 0,
    }


# ---------------------------------------------------------------- CLI
_DEMO = {
    "spotify_id": "demo0000000000000000001",
    "title": "Demo Track",
    "artists": ["Demo Artist", "Feat. Someone"],
    "album": "Demo Album",
    "album_art": "https://example.invalid/cover.jpg",
    "duration_ms": 213000,
    "uri": "spotify:track:demo0000000000000000001",
}


def _cmd_init(args: argparse.Namespace) -> int:
    conn = init_db(db_path=args.db)
    s = library_summary(conn)
    print(f"db => {args.db or DB_PATH}")
    print(f"ok: tables ready, tracks={s['tracks']}")
    return 0


def _cmd_summary(args: argparse.Namespace) -> int:
    conn = init_db(db_path=args.db)
    s = library_summary(conn)
    if args.db:
        s["dbPath"] = str(args.db)
    print(json.dumps(s, ensure_ascii=False, indent=2))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    conn = init_db(db_path=args.db)
    items = list_tracks(conn, status=args.status, limit=args.limit, offset=args.offset)
    if args.json:
        print(json.dumps(items, ensure_ascii=False, indent=2))
    else:
        for t in items:
            print(f"{t['id']:>4}  {t['status']:<11} {t['spotify_id']:<24} {t['title'][:40]}  — {', '.join(t['artists'])}")
        print(f"-- {len(items)} row(s), total={count_tracks(conn, args.status)}")
    return 0


def _cmd_add_demo(args: argparse.Namespace) -> int:
    conn = init_db(db_path=args.db)
    tid = upsert_track(conn, _DEMO)
    print(json.dumps(get_track_by_id(conn, tid), ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="library.py", description="本地曲库 CLI")
    p.add_argument("--db", default=None, help="数据库路径（默认 data/library.db）")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("init", help="建表（幂等）")
    sub.add_parser("summary", help="库统计")
    pl = sub.add_parser("list", help="列出曲目")
    pl.add_argument("--status", default=None, help="按状态过滤")
    pl.add_argument("--limit", type=int, default=100)
    pl.add_argument("--offset", type=int, default=0)
    pl.add_argument("--json", action="store_true")
    sub.add_parser("add-demo", help="插入一条演示曲目")
    args = p.parse_args(argv)
    if args.cmd == "init":
        return _cmd_init(args)
    if args.cmd == "summary":
        return _cmd_summary(args)
    if args.cmd == "list":
        return _cmd_list(args)
    if args.cmd == "add-demo":
        return _cmd_add_demo(args)
    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
