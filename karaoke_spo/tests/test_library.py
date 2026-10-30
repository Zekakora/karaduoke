# -*- coding: utf-8 -*-
"""python/library.py 的测试（普通脚本，不依赖 pytest）。

用法（Windows）：
    python/.venv-xpu/Scripts/python.exe tests/test_library.py

全部使用 tempfile.mkdtemp() 下的临时库，不碰 data/library.db。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import library  # noqa: E402

TMP_DIR = tempfile.mkdtemp(prefix="libtest-", dir=str(ROOT / ".tmp") if (ROOT / ".tmp").exists() else None)
DB = Path(TMP_DIR) / "test-library.db"

_results: list[tuple[str, bool, str]] = []


def case(fn):
    try:
        fn()
        _results.append((fn.__name__, True, ""))
        print(f"ok   {fn.__name__}")
    except Exception as e:  # noqa: BLE001
        _results.append((fn.__name__, False, f"{type(e).__name__}: {e}"))
        print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
        if os.environ.get("VERBOSE"):
            traceback.print_exc()
    return fn


def fresh_conn() -> "library.sqlite3.Connection":
    """每个 case 用独立 db 文件，互不干扰。"""
    path = Path(tempfile.mkdtemp(prefix="case-", dir=TMP_DIR)) / "lib.db"
    return library.init_db(db_path=path)


def meta(sid="sp1", title="Song One", artists=("Artist A", "Artist B")) -> dict:
    return {
        "spotify_id": sid,
        "title": title,
        "artists": list(artists),
        "album": "Album X",
        "album_art": "http://img/x.jpg",
        "duration_ms": 200000,
        "uri": f"spotify:track:{sid}",
    }


# ---------------------------------------------------------------- 1. 建库幂等
@case
def test_init_db_idempotent():
    conn = fresh_conn()
    tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"tracks", "stems", "lyrics", "jobs"} <= tables, tables
    # 再跑两次不应报错
    library.init_db(conn)
    library.init_db(conn)
    # 默认路径也应当幂等（用临时目录，避免污染真实库）
    p2 = Path(TMP_DIR) / "twice.db"
    c1 = library.init_db(db_path=p2)
    c1.close()
    c2 = library.init_db(db_path=p2)
    assert {r["name"] for r in c2.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= {"tracks"}
    # PRAGMA 生效
    assert c2.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert c2.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    assert c2.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


# ---------------------------------------------------------------- 2. upsert 幂等 + 字段更新
@case
def test_upsert_track_idempotent_and_updates():
    conn = fresh_conn()
    tid1 = library.upsert_track(conn, meta())
    tid2 = library.upsert_track(conn, meta(title="Song One (Remastered)"))
    assert tid1 == tid2, (tid1, tid2)
    n = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    assert n == 1, n
    t = library.get_track(conn, "sp1")
    assert t is not None
    assert t["title"] == "Song One (Remastered)", t["title"]
    assert t["artists"] == ["Artist A", "Artist B"], t["artists"]
    assert isinstance(t["artists"], list)
    # 缺省字段不应把已有值抹成 NULL
    tid3 = library.upsert_track(conn, {"spotify_id": "sp1", "title": "T2"})
    assert tid3 == tid1
    t = library.get_track(conn, "sp1")
    assert t["album"] == "Album X", t["album"]
    assert t["artists"] == [], t["artists"]  # artists 显式更新为空是允许的
    # 字符串形式的 artists 也能规范化
    library.upsert_track(conn, {"spotify_id": "sp2", "title": "Solo", "artists": "One Person"})
    assert library.get_track(conn, "sp2")["artists"] == ["One Person"]
    # 不存在的返回 None
    assert library.get_track(conn, "nope") is None


# ---------------------------------------------------------------- 3. 去重
@case
def test_dedup_by_spotify_id_and_sha():
    conn = fresh_conn()
    library.upsert_track(conn, meta("sp1"))
    library.upsert_track(conn, meta("sp1"))
    library.upsert_track(conn, meta("sp2", title="Other"))
    n = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    assert n == 2, n

    sha = "a" * 64
    tid = library.upsert_track(conn, meta("sp1"))
    library.update_audio(conn, tid, path="assets/audio/x.wav", bytes_=1234, sha256=sha)
    hit = library.get_track_by_sha(conn, sha)
    assert hit is not None and hit["spotify_id"] == "sp1", hit
    assert library.get_track_by_sha(conn, "b" * 64) is None
    assert library.get_track_by_sha(conn, "") is None
    # update_audio 顺带把状态推进到 downloaded
    assert hit["status"] == "downloaded", hit["status"]
    assert hit["audio_bytes"] == 1234
    assert hit["audio_path"].endswith("x.wav")
    # 第二个曲目引用同一 sha：产生两行，但 sha 能查到
    tid2 = library.upsert_track(conn, meta("sp2", title="Other"))
    library.update_audio(conn, tid2, path="assets/audio/y.wav", bytes_=1234, sha256=sha)
    assert conn.execute("SELECT COUNT(*) FROM tracks WHERE audio_sha256=?", (sha,)).fetchone()[0] == 2


# ---------------------------------------------------------------- 4. 状态机
@case
def test_status_machine():
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    assert library.get_track(conn, "sp1")["status"] == "new"
    for st in ("resolved", "downloaded", "separated"):
        library.set_status(conn, tid, st)
        assert library.get_track(conn, "sp1")["status"] == st
    # 完整链路 new -> resolved -> downloaded -> separating -> separated 也走一遍
    tid2 = library.upsert_track(conn, meta("sp2", title="Two"))
    for st in ("resolving", "resolved", "downloading", "downloaded", "separating", "separated"):
        library.set_status(conn, tid2, st)
    assert library.get_track(conn, "sp2")["status"] == "separated"

    # 非法状态 -> ValueError
    for bad in ("separting", "bogus", "", None):
        try:
            library.set_status(conn, tid, bad)  # type: ignore[arg-type]
        except ValueError:
            pass
        else:
            raise AssertionError(f"应当对非法状态抛 ValueError: {bad!r}")
    # 非法迁移 -> ValueError（separated 不能直接回到 new）
    try:
        library.set_status(conn, tid, "new")
    except ValueError:
        pass
    else:
        raise AssertionError("separated -> new 应当被拒绝")
    # 不存在的 track_id -> ValueError
    try:
        library.set_status(conn, 999999, "resolved")
    except ValueError:
        pass
    else:
        raise AssertionError("不存在的曲目应当抛 ValueError")

    # mark_failed 从任意状态都可用，并记录 error
    library.mark_failed(conn, tid, "demucs OOM")
    t = library.get_track(conn, "sp1")
    assert t["status"] == "failed" and t["error"] == "demucs OOM", t
    # 错误状态下 list_tracks 可按状态过滤
    assert [x["spotify_id"] for x in library.list_tracks(conn, status="failed")] == ["sp1"]

    # update_source 写入匹配信息
    library.update_source(
        conn, tid, source="youtube", video_id="vid123", url="https://youtu.be/vid123",
        title="YT title", score=87.5, reason="duration+title match",
    )
    t = library.get_track(conn, "sp1")
    assert t["source"] == "youtube" and t["source_video_id"] == "vid123"
    assert abs(t["match_score"] - 87.5) < 1e-9


# ---------------------------------------------------------------- 5. stems upsert
@case
def test_add_stem_upsert_on_conflict():
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    library.add_stem(conn, tid, {"model": "htdemucs", "out_dir": "assets/output/a", "device": "xpu", "rtf": 0.3})
    library.add_stem(conn, tid, {"model": "htdemucs", "out_dir": "assets/output/b", "device": "cpu", "rtf": 0.9})
    stems = library.get_stems(conn, tid)
    assert len(stems) == 1, stems
    assert stems[0]["out_dir"] == "assets/output/b"
    assert stems[0]["device"] == "cpu"
    assert abs(stems[0]["rtf"] - 0.9) < 1e-9
    # 不同模型 -> 新行
    library.add_stem(conn, tid, {"model": "htdemucs_ft", "out_dir": "assets/output/c"})
    assert {s["model"] for s in library.get_stems(conn, tid)} == {"htdemucs", "htdemucs_ft"}
    # 不存在的 track_id -> 外键失败
    try:
        library.add_stem(conn, 999999, {"model": "htdemucs", "out_dir": "x"})
    except library.sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("外键约束应当生效")


# ---------------------------------------------------------------- 6. lyrics upsert
@case
def test_add_lyrics_upsert_on_conflict():
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    library.add_lyrics(conn, tid, {"provider": "lrclib", "synced": False, "format": "plain", "content": "a\nb", "plain": "a\nb"})
    library.add_lyrics(conn, tid, {"provider": "lrclib", "synced": True, "format": "lrc", "content": "[00:01.00]a", "plain": "a", "provider_id": "42", "offset_ms": 120})
    assert conn.execute("SELECT COUNT(*) FROM lyrics").fetchone()[0] == 1
    ly = library.get_lyrics(conn, tid)
    assert ly is not None
    assert ly["synced"] == 1 and ly["format"] == "lrc" and ly["provider_id"] == "42"
    assert ly["offset_ms"] == 120
    # provider 精确查询
    assert library.get_lyrics(conn, tid, "lrclib")["format"] == "lrc"
    assert library.get_lyrics(conn, tid, "nope") is None
    # 第二个 provider -> 新行；无 provider 查询优先返回 synced
    library.add_lyrics(conn, tid, {"provider": "local", "synced": False, "format": "plain", "content": "z"})
    assert conn.execute("SELECT COUNT(*) FROM lyrics").fetchone()[0] == 2
    assert library.get_lyrics(conn, tid)["provider"] == "lrclib"
    assert library.get_lyrics(conn, 999999) is None


# ---------------------------------------------------------------- 7. list_tracks 过滤与分页
@case
def test_list_tracks_filter_and_paging():
    conn = fresh_conn()
    assert library.list_tracks(conn) == []
    ids = []
    for i in range(10):
        t = library.upsert_track(conn, meta(f"sp{i:02d}", title=f"Song {i}"))
        ids.append(t)
        if i % 2 == 0:
            library.set_status(conn, t, "resolved")
    assert len(library.list_tracks(conn)) == 10
    resolved = library.list_tracks(conn, status="resolved")
    assert len(resolved) == 5, len(resolved)
    assert all(t["status"] == "resolved" for t in resolved)
    page1 = library.list_tracks(conn, limit=3)
    page2 = library.list_tracks(conn, limit=3, offset=3)
    assert len(page1) == 3 and len(page2) == 3
    assert not ({t["id"] for t in page1} & {t["id"] for t in page2}), "分页结果不应重叠"
    seen = set()
    for off in range(0, 10, 4):
        for t in library.list_tracks(conn, limit=4, offset=off):
            assert t["id"] not in seen, "分页出现重复行"
            seen.add(t["id"])
    assert len(seen) == 10
    assert library.list_tracks(conn, offset=100) == []
    assert library.list_tracks(conn, status="failed") == []
    # 非法状态/极限值
    try:
        library.list_tracks(conn, status="separting")
    except ValueError:
        pass
    else:
        raise AssertionError("list_tracks 应当拒绝未知状态")
    assert len(library.list_tracks(conn, limit=9999)) == 10  # limit 被夹到 1000
    # 汇总
    s = library.library_summary(conn)
    assert s["tracks"] == 10 and s["byStatus"]["resolved"] == 5, s
    assert s["withStems"] == 0 and s["withLyrics"] == 0


# ---------------------------------------------------------------- 8. 外键级联
@case
def test_foreign_key_cascade():
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    library.add_stem(conn, tid, {"model": "htdemucs", "out_dir": "out"})
    library.add_lyrics(conn, tid, {"provider": "lrclib", "content": "x"})
    library.log_job(conn, tid, "separate", "ok", "done", 1234)
    assert conn.execute("SELECT COUNT(*) FROM stems").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM lyrics").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    conn.execute("DELETE FROM tracks WHERE id = ?", (tid,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM stems").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM lyrics").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    # jobs.track_id 可为 NULL（不关联曲目的任务）
    library.log_job(conn, None, "resolve", "failed", "no match")
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


# ---------------------------------------------------------------- 9. 官方 MV 字段（迁移 / 读写）
@case
def test_visual_migration_idempotent():
    """老库（没有 visual_* 列）启动时自动补列；重复迁移不会重复加列、不会动已有数据。"""
    path = Path(tempfile.mkdtemp(prefix="legacy-", dir=TMP_DIR)) / "legacy.db"
    conn = library.connect(path)
    # 模拟老库：只有最老的一批列
    conn.executescript("""
        CREATE TABLE tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          spotify_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          artists TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'new',
          source_video_id TEXT,
          duration_ms INTEGER
        );
    """)
    conn.execute(
        "INSERT INTO tracks (spotify_id, title, artists, status, source_video_id) VALUES (?,?,?,?,?)",
        ("legacy000000000000000001", "Old Song", '["Old Artist"]', "separated", "legacyVideo"),
    )
    conn.commit()

    added = library._migrate(conn)
    assert "tracks.visual_video_id" in added, added
    assert "tracks.visual_match_status" in added, added
    # 老歌自动进入待匹配状态，其它字段不变
    row = library.get_track(conn, "legacy000000000000000001")
    assert row["visual_match_status"] == "pending", row
    assert row["visual_video_id"] is None
    assert row["source_video_id"] == "legacyVideo", "音频来源不能被动到"
    assert row["title"] == "Old Song"

    # 再迁移两次：不新增列、数据不变（幂等）
    assert library._migrate(conn) == []
    assert library._migrate(conn) == []
    row2 = library.get_track(conn, "legacy000000000000000001")
    assert row2["visual_match_status"] == "pending"
    assert row2["source_video_id"] == "legacyVideo"


@case
def test_visual_update_and_source_independence():
    """visual_video_id 与 source_video_id 完全独立：写一个不会覆盖另一个。"""
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    library.update_source(conn, tid, source="youtube", video_id="audioSource1",
                          url="u", title="t", score=88.0, reason="r")

    v = library.update_visual(conn, "sp1", status="auto_matched", video_id="dQw4w9WgXcQ",
                              video_title="MV title", channel_title="VEVO", duration=201,
                              score=92.5, reason="高分", candidates=[{"videoId": "dQw4w9WgXcQ"}],
                              force=True)
    assert v["visual_video_id"] == "dQw4w9WgXcQ", v
    assert v["visual_match_status"] == "auto_matched"
    assert abs(v["visual_match_score"] - 92.5) < 1e-9
    assert v["visual_matched_at"], v
    assert v["candidates"] and v["candidates"][0]["videoId"] == "dQw4w9WgXcQ"
    t = library.get_track(conn, "sp1")
    assert t["source_video_id"] == "audioSource1", "音频来源 ID 被 MV 覆盖了"
    assert t["visual_video_id"] == "dQw4w9WgXcQ"
    assert isinstance(t["visual_candidates"], list), "candidates 应解析成 list"

    # 非法状态 → ValueError；非法 videoId 被忽略（不写坏值）
    for bad in ("bogus", ""):
        try:
            library.update_visual(conn, "sp1", status=bad, force=True)
        except ValueError:
            pass
        else:
            raise AssertionError(f"非法状态应当 ValueError: {bad!r}")
    assert library.update_visual(conn, "sp1", video_id="short", status="auto_matched",
                                 force=True)["visual_video_id"] == "dQw4w9WgXcQ"

    # 不 force 时不能覆盖 manually_confirmed
    library.update_visual(conn, "sp1", status="manually_confirmed", video_id="kJQP7kiw5Fk", force=True)
    same = library.update_visual(conn, "sp1", status="auto_matched", video_id="aaaaaaaaaaa")
    assert same["visual_video_id"] == "kJQP7kiw5Fk", "手动确认被自动结果覆盖"
    assert same["visual_match_status"] == "manually_confirmed"
    # 但 unavailable 总是允许写（视频挂了必须记下来，否则每次播放都会重试它）
    gone = library.update_visual(conn, "sp1", status="unavailable", reason="已删除")
    assert gone["visual_match_status"] == "unavailable"
    assert gone["visual_video_id"] is None, "不可用时清掉 videoId，避免反复加载"

    # 清除：全部回到 pending
    cleared = library.update_visual(conn, "sp1", clear=True, force=True)
    assert cleared["visual_video_id"] is None
    assert cleared["visual_match_status"] == "pending"
    assert cleared["candidates"] == []
    assert library.get_track(conn, "sp1")["source_video_id"] == "audioSource1"


# ---------------------------------------------------------------- 10. JSON 序列化 / CLI 辅助
@case
def test_rows_are_json_serializable():
    conn = fresh_conn()
    tid = library.upsert_track(conn, meta())
    library.add_stem(conn, tid, {"model": "htdemucs", "out_dir": "out"})
    library.add_lyrics(conn, tid, {"provider": "lrclib", "content": "x"})
    payload = {
        "track": library.get_track(conn, "sp1"),
        "stems": library.get_stems(conn, tid),
        "lyrics": library.get_lyrics(conn, tid),
        "summary": library.library_summary(conn),
        "list": library.list_tracks(conn),
    }
    dump = json.dumps(payload, ensure_ascii=False)
    assert "Artist A" in dump


def main() -> int:
    ok = sum(1 for _, p, _ in _results if p)
    bad = len(_results) - ok
    print(f"\n{ok} passed, {bad} failed  (tmp={TMP_DIR})")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
