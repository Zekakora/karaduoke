# -*- coding: utf-8 -*-
"""给**已有曲目**补 720p MP4 视频（无音轨）。

产物：`assets/output/library/<spotifyId>/video.mp4`（1280x720、H.264、无音频流）

来源：曲库里 `tracks.source_video_id`（下载音频时定下来的 YouTube ID）。
没有 source_video_id 的曲目**跳过并报告**——不去猜，避免画面和音频对不上。

用法:
    # 单首
    python\\.venv-xpu\\Scripts\\python.exe scripts\\add_video.py --spotify-id 2JiDi0qAXsPwhPqA2qaKGt
    # 全部
    python\\.venv-xpu\\Scripts\\python.exe scripts\\add_video.py --all
    # 已有也重下
    python\\.venv-xpu\\Scripts\\python.exe scripts\\add_video.py --all --force

退出码：0 全部成功（含跳过）；1 有失败；2 参数错误。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("TMP", str(ROOT / ".tmp"))
os.environ.setdefault("TEMP", str(ROOT / ".tmp"))

import library  # noqa: E402
import fetch_audio  # noqa: E402

LIBRARY_DIR = ROOT / "assets" / "output" / "library"


def dir_size(path: Path) -> int:
    """曲库目录的**可见产物**体积。

    注意：分离过程中的 voclas/drums/bass/other .wav 是另一条流水线（Demucs）的中间件，
    可能正在被别的进程写入（本脚本跑的时候实测就有），计入会让"总体积变化"忽大忽小，
    所以只统计对外产物：mp3 / mp4 / json。
    """
    if not path.exists():
        return 0
    return sum(p.stat().st_size for p in path.rglob("*")
               if p.is_file() and p.suffix.lower() in (".mp3", ".mp4", ".json"))


def process(track: dict, *, force: bool) -> dict:
    """处理单首曲目，返回结果 dict（ok / skipped / error）。"""
    sid = track["spotify_id"]
    title = track.get("title") or "?"
    vid = (track.get("source_video_id") or "").strip()
    dest = LIBRARY_DIR / sid / "video.mp4"

    base = {"spotify_id": sid, "title": title, "source_video_id": vid or None, "path": str(dest)}
    print(f"\n=== {title}  ({sid})  videoId={vid or '(空)'}")

    if not vid:
        print("[!] 曲目没有 source_video_id，跳过（不猜）")
        return {**base, "ok": False, "skipped": True, "reason": "缺少 source_video_id"}

    if dest.exists() and not force:
        try:
            stream = fetch_audio.probe_streams(dest)
        except Exception as e:  # noqa: BLE001
            print(f"[!] 已有视频但探测失败（{e}），重新下载")
        else:
            print(f"[=] 已有视频，跳过：{dest.stat().st_size / 1024 / 1024:.1f} MB "
                  f"{stream['width']}x{stream['height']} 音轨={stream['has_audio']}")
            return {**base, "ok": True, "skipped": True, "bytes": dest.stat().st_size, **stream}

    before = dir_size(LIBRARY_DIR / sid)
    try:
        res = fetch_audio.download_video(vid, dest, force=True)
    except Exception as e:  # noqa: BLE001
        print(f"[x] 失败：{e}")
        if os.environ.get("ADD_VIDEO_DEBUG"):
            traceback.print_exc()
        return {**base, "ok": False, "reason": str(e)}
    after = dir_size(LIBRARY_DIR / sid)
    return {**base, "ok": True, **res, "dir_bytes_before": before, "dir_bytes_after": after}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="给已有曲目补 720p MP4 视频（无音轨）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--spotify-id", action="append", default=None,
                   help="只处理指定 Spotify track id（可重复）")
    g.add_argument("--all", action="store_true", help="处理曲库里所有曲目")
    ap.add_argument("--force", action="store_true", help="已有 video.mp4 也重新下载")
    ap.add_argument("--json", action="store_true", help="把结果以 JSON 输出到 stdout 末尾")
    args = ap.parse_args(argv)

    conn = library.init_db()
    if args.all:
        tracks = library.list_tracks(conn, limit=1000)
        tracks.sort(key=lambda t: t["id"])
    else:
        tracks = []
        for sid in args.spotify_id:
            row = library.get_track(conn, sid)
            if not row:
                print(f"[x] 曲库里没有 {sid}")
            else:
                tracks.append(row)

    if not tracks:
        print("[x] 没有需要处理的曲目")
        return 2

    overall_before = dir_size(LIBRARY_DIR)
    results = [process(t, force=args.force) for t in tracks]
    overall_after = dir_size(LIBRARY_DIR)

    print("\n=== 汇总 ===", flush=True)
    print(f"{'spotifyId':<24} {'状态':<8} {'体积':>9} {'耗时':>7}  分辨率 / 说明", flush=True)
    for r in results:
        if r.get("ok") and not r.get("skipped"):
            status = "下载"
            size = f"{r['bytes'] / 1024 / 1024:.1f} MB"
            took = f"{r['elapsed_s']:.1f}s"
            note = f"{r['width']}x{r['height']} {r['video_codec']} 无音轨={not r['has_audio']}"
        elif r.get("ok"):
            status = "已存在"
            size = f"{r.get('bytes', 0) / 1024 / 1024:.1f} MB"
            took = "-"
            note = f"{r.get('width')}x{r.get('height')} {r.get('video_codec')}"
        else:
            status = "跳过" if r.get("skipped") else "失败"
            size, took = "-", "-"
            note = r.get("reason", "")
        print(f"{r['spotify_id']:<24} {status:<8} {size:>9} {took:>7}  {note}")

    failed = [r for r in results if not r.get("ok") and not r.get("skipped")]
    skipped = [r for r in results if r.get("skipped")]
    done = [r for r in results if r.get("ok") and not r.get("skipped")]
    print(f"\n成功下载 {len(done)} / 已存在 {len(results) - len(done) - len(failed) - len(skipped)} / "
          f"跳过 {len(skipped)} / 失败 {len(failed)}")
    print(f"assets/output/library 总体积：{overall_before / 1024 / 1024:.1f} MB → "
          f"{overall_after / 1024 / 1024:.1f} MB（+{(overall_after - overall_before) / 1024 / 1024:.1f} MB）")

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
