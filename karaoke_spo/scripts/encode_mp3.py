# -*- coding: utf-8 -*-
"""把 WAV stem 转成 MP3 以节省空间，并记录压缩前后的大小与耗时。

为什么用 MP3：
  - htdemucs 输出是 44.1kHz/16bit/stereo WAV，**每分钟约 10.6 MB**；
  - 一首 6 分钟的歌，4 轨 WAV 共约 254 MB；
  - MP3 320kbps 每分钟约 2.4 MB，**体积降到约 1/4.5**，且对分离结果的听感几乎无损。

为什么用 320kbps 而不是默认 128kbps：
  分离后的 stem（尤其 other/vocals）频谱更"空"，低码率下预回声（pre-echo）更明显；
  既然是本地个人曲库，用 320 换体积完全值得。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts/encode_mp3.py --dir assets\\output\\library\\<id>
    python\\.venv-xpu\\Scripts\\python.exe scripts/encode_mp3.py --track <spotifyId> --bitrate 320k --keep-wav
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
FFMPEG = Path(os.environ.get("KARAOKE_FFMPEG") or (Path(os.environ.get("KARAOKE_ENV_DIR") or (ROOT / "env")) / "bin" / "ffmpeg.exe"))
FFPROBE = Path(os.environ.get("KARAOKE_FFPROBE") or (Path(os.environ.get("KARAOKE_ENV_DIR") or (ROOT / "env")) / "bin" / "ffprobe.exe"))


def probe(path: Path) -> dict:
    out = subprocess.run(
        [str(FFPROBE), "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels,bit_rate,duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return json.loads(out.stdout)["streams"][0]
    except Exception:
        return {}


def encode(src: Path, dst: Path, bitrate: str) -> dict:
    t0 = time.perf_counter()
    proc = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(src), "-codec:a", "libmp3lame", "-b:a", bitrate,
         "-map_metadata", "-1", str(dst)],
        capture_output=True, text=True, timeout=600,
    )
    ms = int((time.perf_counter() - t0) * 1000)
    if proc.returncode != 0:
        return {"ok": False, "error": proc.stderr.strip()[:400], "ms": ms}
    info = probe(dst)
    return {
        "ok": True,
        "ms": ms,
        "srcBytes": src.stat().st_size,
        "dstBytes": dst.stat().st_size,
        "ratio": round(dst.stat().st_size / max(1, src.stat().st_size), 4),
        "sampleRate": info.get("sample_rate"),
        "channels": info.get("channels"),
        "bitRate": info.get("bit_rate"),
        "duration": info.get("duration"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=None, help="包含 *.wav 的目录")
    ap.add_argument("--track", default=None, help="Spotify track id（从曲库查询 stems 目录）")
    ap.add_argument("--bitrate", default="320k")
    ap.add_argument("--keep-wav", action="store_true", help="保留原始 WAV")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not FFMPEG.exists():
        print(f"[x] 找不到 ffmpeg: {FFMPEG}")
        return 2

    target = None
    if args.dir:
        target = Path(args.dir)
    elif args.track:
        import library

        conn = library.init_db()
        t = library.get_track(conn, args.track)
        if not t:
            print(f"[x] 曲库里没有 {args.track}")
            return 3
        rows = library.get_stems(conn, t["id"])
        if not rows:
            print("[x] 没有分离结果")
            return 3
        target = Path(rows[0]["out_dir"])
    else:
        print("[x] 需要 --dir 或 --track")
        return 1

    if not target.is_dir():
        print(f"[x] 目录不存在: {target}")
        return 3

    wavs = sorted(p for p in target.glob("*.wav") if not p.name.startswith("."))
    if not wavs:
        print(f"[i] {target} 下没有 WAV，跳过")
        return 0

    print(f"[i] {len(wavs)} 个 WAV, bitrate={args.bitrate}, keepWav={args.keep_wav}")
    results = {}
    total_src = total_dst = 0
    for src in wavs:
        dst = src.with_suffix(".mp3")
        if dst.exists() and dst.stat().st_size > 0:
            print(f"[=] 已存在 {dst.name}，跳过")
            continue
        if args.dry_run:
            print(f"[dry] {src.name} -> {dst.name} ({src.stat().st_size / 1024 / 1024:.1f} MB)")
            continue
        r = encode(src, dst, args.bitrate)
        if not r["ok"]:
            print(f"[x] {src.name} 编码失败: {r['error']}")
            results[src.name] = r
            continue
        total_src += r["srcBytes"]
        total_dst += r["dstBytes"]
        results[src.name] = r
        print(f"[+] {src.name} -> {dst.name}: {r['srcBytes'] / 1024 / 1024:.1f} MB -> "
              f"{r['dstBytes'] / 1024 / 1024:.1f} MB ({r['ratio']:.1%}), {r['ms']}ms, "
              f"{r['sampleRate']}Hz/{r['channels']}ch/{int(r['bitRate']) // 1000}kbps")
        if not args.keep_wav:
            src.unlink()

    if total_src:
        print(f"\n[=] 总计 {total_src / 1024 / 1024:.1f} MB -> {total_dst / 1024 / 1024:.1f} MB "
              f"({total_dst / total_src:.1%})，节省 {100 - total_dst / total_src * 100:.0f}%")

    (target / "encode-report.json").write_text(
        json.dumps({"bitrate": args.bitrate, "keepWav": args.keep_wav, "results": results}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
