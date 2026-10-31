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
    },
}

# 迁移补的列要能建索引（IF NOT EXISTS，可重复执行）
_MIGRATION_INDEXES: dict[str, dict[str, list[str]]] = {
    "tracks": {"idx_tracks_visual": ["visual_video_id"]},
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
    return conn


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
                            duration_ms, uri, isrc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            now(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM tracks WHERE spotify_id = ?", (meta["spotify_id"],)).fetchone()
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


def mark_failed(conn: sqlite3.Connection, track_id: int, error: str) -> None:
    """标记失败并记录原因（绕过迁移检查：任何状态都可能失败）。"""
    conn.execute(
        "UPDATE tracks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
        (str(error)[:2000], now(), track_id),
    )
    conn.commit()


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
VISUAL_STATUSES = {"pending", "auto_matched", "manually_confirmed", "not_found", "unavailable"}
# 这些状态代表"管理员已经明确拍板"：自动匹配不允许覆盖它们。
VISUAL_LOCKED_STATUSES = {"manually_confirmed"}
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
