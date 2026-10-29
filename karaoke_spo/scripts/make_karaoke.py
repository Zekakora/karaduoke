# -*- coding: utf-8 -*-
"""用"人声最干净"的方式生成卡拉OK伴奏，并与 mix - vocals 做客观对比。

为什么要单独做这一步：
  Demucs 输出的 `vocals` 是**估计**，不是人声的精确掩码。
  直接 `mix - vocals` 会在人声被轻微低估/高估的位置留下残留或相位抵消（音色变薄）。
  Karafun / 专业卡拉OK 通常采用"**非人声四轨求和**"再做人声泄漏抑制。

本脚本给出三种伴奏并量化对比：
  A. sum_non_vocals = drums + bass + other            ← 推荐（loukai 同类做法）
  B. mix - vocals                                      ← 常见但易留残留
  C. soft_mask：基于 STFT 能量比做软掩码               ← 实验项

指标（越高越好 = 人声残留越少）：
  - vocal_leak_db  = (伴奏里仍含人声能量) / (原始人声能量)，dB
  - 数值越低越好
  用"vocals.wav"作为人声能量的代理（虽不精确，但三种伴奏可比）。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts/make_karaoke.py --track 2JiDi0qAXsPwhPqA2qaKGt
    python\\.venv-xpu\\Scripts\\python.exe scripts/make_karaoke.py --stems-dir assets\\output\\library\\2JiDi...
"""
from __future__ import annotations

import argparse
import json
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))


def read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        n = w.getnframes()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    data = data.reshape(-1, ch).T
    return data, sr


def write_wav(path: Path, data, sr: int) -> None:
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(data.T, -1.0, 1.0)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def rms(x) -> float:
    import numpy as np

    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def vocal_leak_db(accomp, vocals) -> float:
    """伴奏里残留的人声能量 vs 原始人声能量（dB，越低越好）。

    做法：用带通 200-4000Hz 估计人声频段能量（粗略），比较伴奏与原人声在该频段的能量比。
    """
    import numpy as np

    n = min(accomp.shape[-1], vocals.shape[-1])
    a = accomp[:, :n].mean(axis=0)
    v = vocals[:, :n].mean(axis=0)
    if v.size < 4096:
        return float("nan")
    win = np.hanning(2048)
    hop = 1024
    freqs = np.fft.rfftfreq(2048, 1 / 44100)
    band = (freqs >= 200) & (freqs <= 4000)
    ea = ev = 0.0
    for i in range(0, len(a) - 2048, hop):
        A = np.abs(np.fft.rfft(a[i:i + 2048] * win))[band]
        V = np.abs(np.fft.rfft(v[i:i + 2048] * win))[band]
        ea += float((A ** 2).sum())
        ev += float((V ** 2).sum())
    return round(10 * np.log10((ea + 1e-12) / (ev + 1e-12)), 2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--track", default=None, help="Spotify track id，从曲库取 stems 目录")
    ap.add_argument("--stems-dir", default=None)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    import numpy as np

    stems_dir = None
    track_id = args.track
    if args.stems_dir:
        stems_dir = Path(args.stems_dir)
    elif args.track:
        import library

        conn = library.init_db()
        rows = library.get_stems(conn, library.get_track(conn, args.track)["id"])
        hit = [r for r in rows if r["model"] == args.model]
        if not hit:
            print(f"[x] 曲库里没有 {args.model} 的分离结果")
            return 2
        stems_dir = Path(hit[0]["out_dir"])
        print(f"[i] stems 目录: {stems_dir}")
    else:
        print("[x] 需要 --track 或 --stems-dir")
        return 1

    need = ["drums", "bass", "other", "vocals"]
    missing = [s for s in need if not (stems_dir / f"{s}.wav").exists()]
    if missing:
        print(f"[x] 缺少 stem: {missing}")
        return 3

    data = {}
    sr = None
    for s in need:
        d, sr = read_wav(stems_dir / f"{s}.wav")
        data[s] = d
        print(f"[i] {s}: shape={d.shape} sr={sr} rms={rms(d):.5f}")

    length = min(v.shape[-1] for v in data.values())
    for k in data:
        data[k] = data[k][:, :length]

    mix = sum(data[k] for k in need)
    non_vocals = data["drums"] + data["bass"] + data["other"]

    out_dir = Path(args.out) if args.out else stems_dir
    results = {}

    # A. 非人声四轨求和（推荐）
    write_wav(out_dir / "karaoke_sum_non_vocals.wav", non_vocals, sr)
    results["sum_non_vocals"] = {
        "file": str(out_dir / "karaoke_sum_non_vocals.wav"),
        "rms": round(rms(non_vocals), 5),
        "vocal_leak_db": vocal_leak_db(non_vocals, data["vocals"]),
    }

    # B. mix - vocals
    sub = mix - data["vocals"]
    write_wav(out_dir / "karaoke_mix_minus_vocals.wav", sub, sr)
    results["mix_minus_vocals"] = {
        "file": str(out_dir / "karaoke_mix_minus_vocals.wav"),
        "rms": round(rms(sub), 5),
        "vocal_leak_db": vocal_leak_db(sub, data["vocals"]),
    }

    # C. 单纯 drums+bass+other 与 A 相同，这里改为"去掉人声残留的 other 加权版"
    #    用能量比做软掩码：在 other 上压制与人声频谱高度重合的帧
    ov = data["other"].mean(axis=0)
    vv = data["vocals"].mean(axis=0)
    win = np.hanning(2048)
    hop = 1024
    out = np.zeros_like(data["other"])
    for ch in range(data["other"].shape[0]):
        src = data["other"][ch]
        mask = np.ones(len(src), dtype=np.float32)
        for i in range(0, len(src) - 2048, hop):
            O = np.abs(np.fft.rfft(src[i:i + 2048] * win))
            V = np.abs(np.fft.rfft(vv[i:i + 2048] * win))
            ratio = (V + 1e-8) / (V + O + 1e-8)
            # 人声占比越高的频段越压制
            gain = float(np.clip(1.0 - 0.7 * ratio.mean(), 0.3, 1.0))
            mask[i:i + 2048] = np.minimum(mask[i:i + 2048], gain)
        out[ch] = src * mask
    soft = out + data["drums"] + data["bass"]
    write_wav(out_dir / "karaoke_soft_mask.wav", soft, sr)
    results["soft_mask"] = {
        "file": str(out_dir / "karaoke_soft_mask.wav"),
        "rms": round(rms(soft), 5),
        "vocal_leak_db": vocal_leak_db(soft, data["vocals"]),
    }

    print("\n=== 伴奏对比（vocal_leak_db 越低 = 人声残留越少）===")
    for name, r in sorted(results.items(), key=lambda kv: kv[1]["vocal_leak_db"]):
        print(f"  {name:22s} leak={r['vocal_leak_db']:>7} dB  rms={r['rms']}")

    meta = {"stemsDir": str(stems_dir), "sr": sr, "samples": length, "results": results}
    (out_dir / "karaoke-compare.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nreport => {out_dir / 'karaoke-compare.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
