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


# ---------------------------------------------------------------- 9. JSON 序列化 / CLI 辅助
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
