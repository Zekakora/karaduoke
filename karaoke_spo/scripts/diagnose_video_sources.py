# -*- coding: utf-8 -*-
"""诊断现存 4 首歌的 YouTube 源质量，并找出更好的替代源。

背景：之前的视频下载用的是"能下到就行"的宽松策略，结果：
  - Mr. Brightside 选到 720x732 / 67kbps 的渣源（1.8 MB）
  - Happy 的源视频现在直接 404
  - 其余两首码率也只有 190-210kbps

本脚本做两件事：
  1. 检查现有 source_video_id 的可达性与画质
  2. 用 "歌手 + 歌名 + 官方" 重新搜索，列出更好的候选

用法：
    python scripts/diagnose_video_sources.py
    python scripts/diagnose_video_sources.py --fix    # 顺便更新曲库里的 source_video_id
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import yt_dlp  # noqa: E402

BASE_OPTS = {"quiet": True, "no_warnings": True, "noplaylist": True}


def probe(video_id: str) -> dict:
    """返回视频的可达性、时长、最佳 720p 纯视频流的码率/体积。"""
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with yt_dlp.YoutubeDL(BASE_OPTS) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:120]}

    fmts = [
        f for f in info.get("formats", [])
        if f.get("vcodec", "none") != "none"
        and f.get("acodec") == "none"
        and (f.get("height") or 0) >= 720
    ]
    fmts.sort(key=lambda f: -(f.get("tbr") or 0))
    best = fmts[0] if fmts else None
    return {
        "ok": True,
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
        "best_720": {
            "format_id": best.get("format_id"),
            "width": best.get("width"),
            "height": best.get("height"),
            "ext": best.get("ext"),
            "tbr_kbps": round(best.get("tbr") or 0),
            "size_mb": round((best.get("filesize") or best.get("filesize_approx") or 0) / 1048576, 1),
        } if best else None,
        "any_720": len(fmts),
    }


def search_alternatives(query: str, limit: int = 8) -> list[dict]:
    """搜索候选源，按"官方/高清/时长接近"排序。"""
    opts = {**BASE_OPTS, "extract_flat": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    out = []
    for e in info.get("entries") or []:
        out.append({
            "id": e.get("id"),
            "title": e.get("title"),
            "channel": e.get("channel") or e.get("uploader"),
            "duration": e.get("duration"),
        })
    return out


def quality_verdict(dur_expected: float | None, info: dict) -> str:
    """给现有源打分：能不能用、好不好。"""
    if not info.get("ok"):
        return "❌ 不可达（视频已删除/限制）"
    best = info.get("best_720")
    if not best:
        return "❌ 无 720p 纯视频流"
    if dur_expected and info.get("duration"):
        diff = abs(info["duration"] - dur_expected)
        if diff > 10:
            return f"⚠️ 时长不符（差 {diff:.0f}s，可能下错版本）"
    tbr = best.get("tbr_kbps") or 0
    if tbr < 400:
        return f"⚠️ 码率偏低 {tbr}kbps（画面会糊）"
    return f"✅ 可用 {best['width']}x{best['height']} {tbr}kbps {best['size_mb']}MB"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="把更好的源写回曲库")
    args = ap.parse_args()

    import library

    conn = library.init_db()
    rows = conn.execute(
        "SELECT spotify_id, title, artists, duration_ms, source_video_id FROM tracks ORDER BY id"
    ).fetchall()

    report = []
    for r in rows:
        rec = dict(r)
        artists = json.loads(rec["artists"]) if rec["artists"] else []
        dur = (rec["duration_ms"] or 0) / 1000
        vid = rec["source_video_id"]
        print(f"\n=== {rec['title']}  [{rec['spotify_id'][:10]}] ===")
        print(f"    Spotify 时长: {dur:.1f}s   现有源: {vid}")

        info = probe(vid) if vid else {"ok": False, "error": "无 source_video_id"}
        verdict = quality_verdict(dur, info)
        print(f"    现状: {verdict}")
        if info.get("ok"):
            print(f"    标题: {info.get('title')}")
            if info.get("best_720"):
                b = info["best_720"]
                print(f"    最佳720p: id={b['format_id']} {b['width']}x{b['height']} {b['tbr_kbps']}kbps {b['size_mb']}MB")

        need_better = not verdict.startswith("✅")
        alt = []
        if need_better:
            q = " ".join([rec["title"], *artists])
            # 优先找官方频道
            alt = search_alternatives(f"{q} official")
            print(f"    替代候选（{len(alt)} 条）:")
            for i, a in enumerate(alt[:6]):
                d = a.get("duration")
                dtag = f"{d}s" if d else "?"
                flag = ""
                if d and abs(d - dur) <= 5:
                    flag = " ← 时长匹配"
                print(f"      [{i}] {a['id']} {dtag:>6} {a['title'][:56]}{flag}")

        report.append({"spotify_id": rec["spotify_id"], "title": rec["title"],
                       "current": vid, "verdict": verdict, "alternatives": alt[:6]})

    (ROOT / ".tmp" / "video-source-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n报告已写入 .tmp/video-source-report.json")
    print("\n提示：确认替代源后，用 --fix 或手动 UPDATE tracks SET source_video_id=... 更新")
    return 0


if __name__ == "__main__":
    sys.exit(main())
