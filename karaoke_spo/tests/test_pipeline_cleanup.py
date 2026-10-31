# -*- coding: utf-8 -*-
"""pipeline 的"成功收尾清理临时文件"测试（普通脚本，不依赖 pytest，不联网、不跑 Demucs）。

验证（对应需求 6.2 / 6.3 / 6.4）：
  * 4 个最终 MP3 齐全且合格 → 删除音频处理输入（data/library/<videoId>.wav）与旧背景 video.mp4；
  * MP3 缺失 / 太小 / 不是 MP3 → **什么都不删**（失败时保住唯一的重试输入）；
  * 别的曲目还在用同一个 audio_path → 不删；
  * 路径越界（例如 audio_path 在旧工程目录）→ 不删；
  * 清理抛异常不影响主流程（main() 里被兜住）；
  * 只跑 download（没跑 finalize）→ main() 不清理；
  * 不碰 .mp3 / 封面 / 歌词 / stems。
  * verify_final_mp3s 的基本校验（存在 / 大小 / 文件头）。

用法：
    env\\python\\Scripts\\python.exe tests\\test_pipeline_cleanup.py
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))

import library  # noqa: E402
import pipeline  # noqa: E402

TMP = ROOT / ".tmp" / f"pipeline-cleanup-{int(time.time())}-{id(object()) % 10000}"
TMP.mkdir(parents=True, exist_ok=True)
library.DB_PATH = TMP / "library.db"

# 把 pipeline 的目录常量指到临时目录，绝不碰真实的 data/ 和 assets/
UPSTREAM = TMP / "data-library"
STEMS = TMP / "assets-output-library"
UPSTREAM.mkdir(parents=True, exist_ok=True)
STEMS.mkdir(parents=True, exist_ok=True)
_orig_root = pipeline.ROOT
_orig_audio_in = pipeline.AUDIO_IN_DIR
pipeline.ROOT = TMP
pipeline.STEMS_DIR = STEMS
pipeline.AUDIO_IN_DIR = UPSTREAM

FAILS = 0


def check(name: str, fn) -> None:
    global FAILS
    try:
        fn()
        print(f"ok   {name}")
    except Exception as e:  # noqa: BLE001
        FAILS += 1
        print(f"FAIL {name}: {type(e).__name__}: {e}")


# ---------------------------------------------------------------- 夹具
MP3_HEADER = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 40000  # 40KB 的"假 MP3"（够大 + ID3 头）


def make_mp3s(dest: Path, *, skip: tuple[str, ...] = (), tiny: tuple[str, ...] = (), garbage: tuple[str, ...] = ()) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for name in pipeline.FINAL_MP3_NAMES:
        path = dest / name
        if name in skip:
            continue
        if name in tiny:
            path.write_bytes(b"ID3" + b"\x00" * 10)
        elif name in garbage:
            path.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 40000)  # JPEG 头，不是 MP3
        else:
            path.write_bytes(MP3_HEADER)


def make_track(conn, sid: str, video_id: str | None, *, audio: Path | None) -> int:
    tid = library.upsert_track(conn, {
        "spotify_id": sid, "title": f"Title {sid}", "artists": ["A"],
        "duration_ms": 200000, "uri": f"spotify:track:{sid}",
    })
    if video_id:
        library.update_source(conn, tid, source="youtube", video_id=video_id,
                              url=f"https://youtu.be/{video_id}", title="t", score=90.0, reason="r")
    if audio:
        library.update_audio(conn, tid, path=str(audio), bytes_=audio.stat().st_size, sha256="0" * 64)
    return tid


def write_wav(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"RIFF" + b"\x00" * 4096)
    return path


def args_for(sid: str, **extra):
    base = dict(spotify_id=sid, title=f"Title {sid}", artist=["A"], duration=200.0,
                model="htdemucs", bitrate="320k", keep_intermediate=False,
                keep_audio=False, provider="auto")
    base.update(extra)
    return SimpleNamespace(**base)


def reset(tmp: Path) -> None:
    """每个用例一个干净的库 + 目录。"""
    for p in (UPSTREAM, STEMS):
        if p.exists():
            shutil.rmtree(p)
        p.mkdir(parents=True, exist_ok=True)
    db = TMP / f"case-{int(time.time() * 1000) % 100000}.db"
    library.DB_PATH = db
    return library.init_db(db_path=db)


# ---------------------------------------------------------------- 用例

def case_verify_mp3s():
    d = TMP / "verify"
    make_mp3s(d)
    res = pipeline.verify_final_mp3s(d)
    assert res["ok"] is True, res
    assert len(res["files"]) == 4, res

    d2 = TMP / "verify-missing"
    make_mp3s(d2, skip=("guide.mp3",))
    res = pipeline.verify_final_mp3s(d2)
    assert res["ok"] is False and any("guide.mp3" in p for p in res["problems"]), res

    d3 = TMP / "verify-tiny"
    make_mp3s(d3, tiny=("vocals.mp3",))
    assert pipeline.verify_final_mp3s(d3)["ok"] is False

    d4 = TMP / "verify-garbage"
    make_mp3s(d4, garbage=("original.mp3",))
    res = pipeline.verify_final_mp3s(d4)
    assert res["ok"] is False and any("文件头" in p for p in res["problems"]), res


def case_cleanup_success():
    conn = reset(TMP)
    sid, vid = "AAAAAAAAAAAAAAAAAAAAAA", "abcdefghijk"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    match = UPSTREAM / f"{vid}.match.json"
    match.write_text("{}", encoding="utf-8")
    make_track(conn, sid, vid, audio=wav)
    stems = STEMS / sid
    make_mp3s(stems)
    legacy_video = stems / "video.mp4"
    legacy_video.write_bytes(b"\x00" * 1024)

    res = pipeline.step_cleanup(conn, library.get_track(conn, sid)["id"], args_for(sid))
    assert res["ok"] is True, res
    assert not wav.exists(), "音频处理输入应被删除"
    assert not legacy_video.exists(), "旧本地背景 video.mp4 应被删除"
    for name in pipeline.FINAL_MP3_NAMES:
        assert (stems / name).is_file(), f"{name} 不能被删"
    assert res["manifest"] and Path(res["manifest"]).is_file(), "应落一份删除清单"
    manifest = json.loads(Path(res["manifest"]).read_text(encoding="utf-8"))
    assert manifest["spotifyId"] == sid
    assert any(item["name"] == f"{vid}.wav" for item in manifest["removed"]), manifest


def case_cleanup_skips_when_mp3_invalid():
    conn = reset(TMP)
    sid, vid = "BBBBBBBBBBBBBBBBBBBBBB", "bbbbbbbbbbb"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    make_track(conn, sid, vid, audio=wav)
    make_mp3s(STEMS / sid, skip=("accompaniment.mp3",))

    res = pipeline.step_cleanup(conn, library.get_track(conn, sid)["id"], args_for(sid))
    assert res["ok"] is False and res.get("skipped") is True, res
    assert wav.exists(), "MP3 不完整时绝不能删音频输入"
    jobs = library.get_jobs(conn, library.get_track(conn, sid)["id"])
    assert any(j["kind"] == "cleanup" and j["status"] == "skipped" for j in jobs), jobs


def case_cleanup_keeps_shared_audio():
    conn = reset(TMP)
    vid = "ccccccccccc"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    sid_a, sid_b = "CCCCCCCCCCCCCCCCCCCCCC", "DDDDDDDDDDDDDDDDDDDDDD"
    make_track(conn, sid_a, vid, audio=wav)
    make_track(conn, sid_b, None, audio=wav)  # 另一首也引用同一个文件
    for sid in (sid_a, sid_b):
        make_mp3s(STEMS / sid)

    res = pipeline.step_cleanup(conn, library.get_track(conn, sid_a)["id"], args_for(sid_a))
    assert res["ok"] is True, res
    assert wav.exists(), "还有别的曲目在用的音频输入不能被删"


def case_cleanup_ignores_outside_paths():
    conn = reset(TMP)
    sid = "EEEEEEEEEEEEEEEEEEEEEE"
    # 旧工程目录里的 wav（databese 里还指向那边）：不在受管目录内，不许删
    outside = TMP / "legacy-project" / "data" / "library"
    outside.mkdir(parents=True, exist_ok=True)
    wav = write_wav(outside / "ddddddddddd.wav")
    make_track(conn, sid, "ddddddddddd", audio=wav)
    make_mp3s(STEMS / sid)

    res = pipeline.step_cleanup(conn, library.get_track(conn, sid)["id"], args_for(sid))
    assert res["ok"] is True, res
    assert wav.exists(), "受管目录之外的文件绝不能删"


def case_cleanup_failure_does_not_raise():
    conn = reset(TMP)
    sid, vid = "FFFFFFFFFFFFFFFFFFFFFF", "fffffffffff"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    make_track(conn, sid, vid, audio=wav)
    make_mp3s(STEMS / sid)

    original_unlink = Path.unlink

    def boom(self, *a, **k):
        raise OSError("文件被占用（模拟 Windows 句柄）")

    Path.unlink = boom
    try:
        res = pipeline.step_cleanup(conn, library.get_track(conn, sid)["id"], args_for(sid))
    finally:
        Path.unlink = original_unlink
    assert res["ok"] is True, "删除失败不应让清理整体失败"
    assert res["failed"], res
    assert wav.exists(), "删不掉就留着，不能删一半"
    for name in pipeline.FINAL_MP3_NAMES:
        assert (STEMS / sid / name).is_file(), f"{name} 不受清理失败影响"


def case_main_does_not_clean_without_finalize():
    """main() 里：只跑 download（没有成功的 finalize）→ 不清 mp4/wav。"""
    conn = reset(TMP)
    sid, vid = "GGGGGGGGGGGGGGGGGGGGGG", "ggggggggggg"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    make_track(conn, sid, vid, audio=wav)
    make_mp3s(STEMS / sid)

    cleaned = {"called": False}

    def fake_cleanup(c, t, a):
        cleaned["called"] = True
        return {"ok": True}

    orig = pipeline.step_cleanup
    orig_finalize = pipeline.step_finalize
    pipeline.step_cleanup = fake_cleanup
    pipeline.step_finalize = lambda c, t, a: {"error": "rc=3"}  # 模拟 finalize 失败
    argv = sys.argv
    try:
        sys.argv = ["pipeline.py", "--spotify-id", sid, "--title", "T", "--artist", "A",
                    "--steps", "download,separate,finalize,cleanup"]
        pipeline.step_resolve = lambda c, t, a: {"path": str(wav), "skipped": True}
        pipeline.step_separate = lambda c, t, a: {"skipped": True}
        rc = pipeline.main()
        assert rc == 0
        assert cleaned["called"] is False, "finalize 没成功时不应执行清理"
    finally:
        pipeline.step_cleanup = orig
        pipeline.step_finalize = orig_finalize
        sys.argv = argv


def case_main_cleans_after_success():
    conn = reset(TMP)
    sid, vid = "HHHHHHHHHHHHHHHHHHHHHH", "hhhhhhhhhhh"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    make_track(conn, sid, vid, audio=wav)
    make_mp3s(STEMS / sid)

    orig = {name: getattr(pipeline, name) for name in ("step_resolve", "step_separate", "step_finalize")}
    pipeline.step_resolve = lambda c, t, a: {"path": str(wav), "skipped": True}
    pipeline.step_separate = lambda c, t, a: {"skipped": True}

    def fake_finalize(c, t, a):
        # 模拟 finalize 成功（产物已在夹具里建好）
        return {"ok": True}

    pipeline.step_finalize = fake_finalize
    argv = sys.argv
    try:
        sys.argv = ["pipeline.py", "--spotify-id", sid, "--title", "T", "--artist", "A",
                    "--steps", "download,separate,finalize,cleanup"]
        rc = pipeline.main()
        assert rc == 0
        assert not wav.exists(), "finalize 成功后应删除音频处理输入"
        for name in pipeline.FINAL_MP3_NAMES:
            assert (STEMS / sid / name).is_file(), f"{name} 不能被删"
    finally:
        for name, fn in orig.items():
            setattr(pipeline, name, fn)
        sys.argv = argv


def case_main_keep_audio_flag():
    conn = reset(TMP)
    sid, vid = "IIIIIIIIIIIIIIIIIIIIII", "iiiiiiiiiii"
    wav = write_wav(UPSTREAM / f"{vid}.wav")
    make_track(conn, sid, vid, audio=wav)
    make_mp3s(STEMS / sid)

    orig = {name: getattr(pipeline, name) for name in ("step_resolve", "step_separate", "step_finalize")}
    pipeline.step_resolve = lambda c, t, a: {"path": str(wav), "skipped": True}
    pipeline.step_separate = lambda c, t, a: {"skipped": True}
    pipeline.step_finalize = lambda c, t, a: {"ok": True}
    argv = sys.argv
    try:
        sys.argv = ["pipeline.py", "--spotify-id", sid, "--title", "T", "--artist", "A",
                    "--steps", "download,separate,finalize,cleanup", "--keep-audio"]
        pipeline.main()
        assert wav.exists(), "--keep-audio 时不应删除音频输入"
    finally:
        for name, fn in orig.items():
            setattr(pipeline, name, fn)
        sys.argv = argv


def case_no_video_download_globals():
    """fetch_audio 不再有背景视频下载的入口（只剩注释说明）。"""
    import fetch_audio  # noqa: E402

    for name in ("download_video", "maybe_keep_video", "probe_streams", "video_dest", "VIDEO_FORMAT"):
        assert not hasattr(fetch_audio, name), f"fetch_audio 里不应再有 {name}"
    # 参数列表里也不能再有 --keep-video
    import argparse
    parsed_ok = True
    try:
        old = sys.argv
        sys.argv = ["fetch_audio.py", "--title", "x", "--keep-video"]
        try:
            fetch_audio.main()
            parsed_ok = False
        except SystemExit as e:
            parsed_ok = e.code != 0  # argparse 未知参数 → 退出码 2
        finally:
            sys.argv = old
    except Exception:  # noqa: BLE001
        parsed_ok = True
    assert parsed_ok, "--keep-video 应已不再是合法参数"


if __name__ == "__main__":
    try:
        check("verify_final_mp3s：齐全 / 缺失 / 太小 / 文件头不对", case_verify_mp3s)
        check("成功收尾：删音频输入 + 旧 video.mp4，MP3 全保留", case_cleanup_success)
        check("MP3 不完整 → 什么都不删（保住重试输入）", case_cleanup_skips_when_mp3_invalid)
        check("别的曲目还在用同一个 WAV → 不删", case_cleanup_keeps_shared_audio)
        check("受管目录之外的路径 → 不删", case_cleanup_ignores_outside_paths)
        check("删除失败只记日志、不抛异常、不影响 MP3", case_cleanup_failure_does_not_raise)
        check("main()：finalize 失败不清理", case_main_does_not_clean_without_finalize)
        check("main()：finalize 成功后自动清理", case_main_cleans_after_success)
        check("main()：--keep-audio 保留输入", case_main_keep_audio_flag)
        check("fetch_audio 不再下载背景视频", case_no_video_download_globals)
    finally:
        pipeline.ROOT = _orig_root
        pipeline.AUDIO_IN_DIR = _orig_audio_in
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n{'FAILED' if FAILS else 'PASS'}: {10 - FAILS}/10")
    sys.exit(1 if FAILS else 0)
