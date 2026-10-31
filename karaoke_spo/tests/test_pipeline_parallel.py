# -*- coding: utf-8 -*-
"""pipeline.run_download_lyrics 的并发测试（普通脚本，不依赖 pytest）。

用法：
    env\\python\\Scripts\\python.exe tests\\test_pipeline_parallel.py

验证：
- download + lyrics 同时请求时真的并行（总耗时 ≈ 较慢那个，而不是两者相加）
- 两个步骤各用独立的 SQLite 连接（sqlite3 连接不能跨线程共享）
- 只请求一个步骤时走串行、不额外开连接
- --no-parallel-steps 退回串行
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))

import library  # noqa: E402
import pipeline  # noqa: E402

# 临时库放项目根的 .tmp（沙箱/受限环境里系统临时目录未必能开 SQLite）。
# 注意用 Path.mkdir 而不是 tempfile.mkdtemp：后者在 Windows 沙箱里创建的目录
# 不会继承工作区的写权限。
_ENV_TMP = os.environ.get("KARAOKE_TEST_TMP")
if _ENV_TMP and Path(_ENV_TMP).is_dir():
    BASE_TMP = Path(_ENV_TMP)
elif (ROOT.parent / ".tmp").is_dir():
    BASE_TMP = ROOT.parent / ".tmp"
else:
    BASE_TMP = Path(tempfile.mkdtemp(prefix="karaoke-test-"))
TMP = BASE_TMP / f"pipeline-parallel-{os.getpid()}-{int(time.time())}"
TMP.mkdir(parents=True, exist_ok=True)
library.DB_PATH = TMP / "library.db"

FAILS = 0


def check(name: str, fn) -> None:
    global FAILS
    try:
        fn()
        print(f"ok   {name}")
    except Exception as e:  # noqa: BLE001
        FAILS += 1
        print(f"FAIL {name}: {type(e).__name__}: {e}")


calls: list[tuple[str, int, float]] = []


def fake_resolve(conn, track_id, args):
    calls.append(("download", id(conn), time.monotonic()))
    time.sleep(0.35)
    return {"ok": True}


def fake_lyrics(conn, track_id, args, quiet: bool = False):
    calls.append(("lyrics", id(conn), time.monotonic()))
    time.sleep(0.2)
    return {"provider": "fake", "synced": True, "quiet": quiet}


def timed(fn):
    t0 = time.monotonic()
    out = fn()
    return out, time.monotonic() - t0


def case_parallel() -> None:
    calls.clear()
    conn = library.init_db()
    args = SimpleNamespace(no_parallel_steps=False)
    out, dt = timed(lambda: pipeline.run_download_lyrics(conn, 1, args, ["download", "lyrics"]))
    conn.close()
    assert set(out) == {"download", "lyrics"}, out
    assert len(calls) == 2, calls
    kinds = {c[0] for c in calls}
    assert kinds == {"download", "lyrics"}, kinds
    # 并行：总耗时应接近 max(0.35, 0.2)，明显小于 0.55
    assert 0.3 <= dt < 0.5, f"并发耗时 {dt:.2f}s（串行应约 0.55s）"
    # 两个线程不能共用同一条 sqlite 连接
    assert calls[0][1] != calls[1][1], "两个步骤用了同一条 SQLite 连接"
    assert out["lyrics"]["quiet"] is True, "并行时歌词步骤应 quiet"


def case_serial_flag() -> None:
    calls.clear()
    conn = library.init_db()
    args = SimpleNamespace(no_parallel_steps=True)
    out, dt = timed(lambda: pipeline.run_download_lyrics(conn, 1, args, ["download", "lyrics"]))
    conn.close()
    assert set(out) == {"download", "lyrics"}, out
    assert len(calls) == 2, calls
    assert dt >= 0.5, f"--no-parallel-steps 应该串行（{dt:.2f}s）"
    # 串行时复用调用方传进来的同一条连接
    assert calls[0][1] == calls[1][1], "串行模式不应另开连接"


def case_only_download() -> None:
    calls.clear()
    conn = library.init_db()
    args = SimpleNamespace(no_parallel_steps=False)
    out, _ = timed(lambda: pipeline.run_download_lyrics(conn, 1, args, ["download"]))
    conn.close()
    assert set(out) == {"download"}, out
    assert [c[0] for c in calls] == ["download"], calls


def case_only_lyrics() -> None:
    calls.clear()
    conn = library.init_db()
    args = SimpleNamespace(no_parallel_steps=False)
    out, _ = timed(lambda: pipeline.run_download_lyrics(conn, 1, args, ["lyrics"]))
    conn.close()
    assert set(out) == {"lyrics"}, out
    assert [c[0] for c in calls] == ["lyrics"], calls


if __name__ == "__main__":
    pipeline.step_resolve = fake_resolve
    pipeline.step_lyrics = fake_lyrics
    try:
        check("download ∥ lyrics 真的并行", case_parallel)
        check("--no-parallel-steps 退回串行", case_serial_flag)
        check("只跑 download 时不碰 lyrics", case_only_download)
        check("只跑 lyrics 时不碰 download", case_only_lyrics)
    finally:
        import shutil

        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n{'FAILED' if FAILS else 'PASS'}: {4 - FAILS}/4")
    sys.exit(1 if FAILS else 0)
