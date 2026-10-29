# -*- coding: utf-8 -*-
"""用已分离的 stem 合成"带引导人声"的卡拉OK混音。

场景（正是用户要的）：
  - 完全关掉原唱：伴奏 = drums + bass + other
  - **原唱很小声做引导**：accompaniment + vocals * guideGain（比如 -12 dB）
  - 中间态：滑块 0..1 实时控制人声比例

设计要点：
  1. 人声轨道**必须保留**（不压缩、或单独存高码率），否则引导音量一改就会出现编码损失叠加；
  2. 混音在**播放时**做，不预渲染多个版本（省空间）；
  3. 增益用 dB 表达，线性换算 `10^(db/20)`，与 loukai 的 `dbToLinear` 一致。

用法:
    # 直接生成一个"引导音量 -12dB"的成品
    python\\.venv-xpu\\Scripts\\python.exe scripts/mix_karaoke.py --track <spotifyId> --vocal-db -12 --out karaoke_guide12.mp3
    # 只打印可选增益方案（不生成文件）
    python\\.venv-xpu\\Scripts\\python.exe scripts/mix_karaoke.py --track <spotifyId> --list-presets
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
FFMPEG = Path(os.environ.get("KARAOKE_FFMPEG") or (Path(os.environ.get("KARAOKE_ENV_DIR") or (ROOT / "env")) / "bin" / "ffmpeg.exe"))

# 常用预设（dB）：0 = 原唱全开，-inf = 完全消音
PRESETS = {
    "off": (None, "完全消音（纯伴奏）"),
    "guide_mute": (-24.0, "极弱引导，几乎听不到"),
    "guide_soft": (-18.0, "弱引导，适合已熟悉旋律"),
    "guide_normal": (-12.0, "标准 Karaoke 引导音量"),
    "guide_loud": (-6.0, "强引导，适合学新歌"),
    "full": (0.0, "原唱全开"),
}


def read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return data.reshape(-1, ch).T, sr


def db_to_linear(db: float | None) -> float:
    if db is None:
        return 0.0
    return 10.0 ** (db / 20.0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", default=None)
    ap.add_argument("--stems-dir", default=None)
    ap.add_argument("--vocal-db", type=float, default=-12.0, help="人声增益 dB（-inf 用 --mute）")
    ap.add_argument("--mute", action="store_true")
    ap.add_argument("--out", default=None, help="输出文件名（默认 karaoke_guide<db>.wav）")
    ap.add_argument("--mp3", default="320k", help="同时编码 MP3，传空字符串跳过")
    ap.add_argument("--list-presets", action="store_true")
    args = ap.parse_args()

    if args.list_presets:
        for k, (db, desc) in PRESETS.items():
            label = "静音" if db is None else f"{db:+.0f} dB"
            print(f"  {k:14s} {label:>8s}  {desc}")
        return 0

    import numpy as np

    stems_dir = Path(args.stems_dir) if args.stems_dir else None
    if stems_dir is None and args.track:
        import library

        conn = library.init_db()
        t = library.get_track(conn, args.track)
        if not t:
            print(f"[x] 曲库没有 {args.track}")
            return 2
        rows = library.get_stems(conn, t["id"])
        if not rows:
            print("[x] 没有分离结果")
            return 2
        stems_dir = Path(rows[0]["out_dir"])
    if stems_dir is None:
        print("[x] 需要 --track 或 --stems-dir")
        return 1

    parts = {}
    sr = None
    for name in ("drums", "bass", "other", "vocals"):
        p = stems_dir / f"{name}.wav"
        if not p.exists():
            print(f"[x] 缺少 {p}")
            return 3
        parts[name], sr = read_wav(p)
    length = min(v.shape[-1] for v in parts.values())
    for k in parts:
        parts[k] = parts[k][:, :length]

    accomp = parts["drums"] + parts["bass"] + parts["other"]
    gain = 0.0 if args.mute else db_to_linear(args.vocal_db)
    mix = accomp + parts["vocals"] * gain
    peak = float(np.abs(mix).max())
    if peak > 1.0:
        print(f"[!] 峰值 {peak:.3f} 超过 1.0，按 {1 / peak:.3f} 缩放以避免削波")
        mix = mix * (0.99 / peak)

    out_name = args.out or (f"karaoke_mute.wav" if args.mute else f"karaoke_guide{abs(args.vocal_db):.0f}.wav")
    out_path = stems_dir / out_name
    pcm = (np.clip(mix.T, -1, 1) * 32767).astype("<i2")
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(mix.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"[+] WAV => {out_path} ({out_path.stat().st_size / 1024 / 1024:.1f} MB)")

    result = {
        "stemsDir": str(stems_dir),
        "vocalGainDb": None if args.mute else args.vocal_db,
        "vocalLinear": gain,
        "peakBefore": round(peak, 4),
        "wav": str(out_path),
        "sr": sr,
        "durationS": round(length / sr, 2),
    }

    if args.mp3:
        mp3 = out_path.with_suffix(".mp3")
        r = subprocess.run(
            [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(out_path),
             "-codec:a", "libmp3lame", "-b:a", args.mp3, str(mp3)],
            capture_output=True, text=True, timeout=600,
        )
        if r.returncode == 0:
            result["mp3"] = str(mp3)
            result["mp3Bytes"] = mp3.stat().st_size
            print(f"[+] MP3 => {mp3} ({mp3.stat().st_size / 1024 / 1024:.1f} MB)")
        else:
            result["mp3Error"] = r.stderr.strip()[:300]
            print(f"[x] MP3 编码失败: {result['mp3Error']}")

    (stems_dir / "karaoke-mix.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
