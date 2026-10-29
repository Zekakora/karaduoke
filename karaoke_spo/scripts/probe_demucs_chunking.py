# -*- coding: utf-8 -*-
"""验证 PyTorch Demucs（demucs.api）的分块与拼接行为。

loukai 的调研给了三条可验证的结论，但那是它自己写的 JS/WebGPU 实现；
**我们需要确认 `demucs.api.Separator.separate_audio_file` 这个黑盒在 PyTorch 侧的行为**：
  1. 分块是否尾部对齐（不补零）？
  2. overlap 的窗函数是什么（三角形/Hann）？
  3. 输出是否与输入严格等长？

做法（不需要读 demucs 源码，用行为测试）：
  - 用同一段音频，`segment` 设成能整除/不能整除的两种值，比较输出长度与内容一致性；
  - 构造一段"只在最末尾有能量"的信号，看尾部是否有能量丢失（补零会造成尾部衰减）；
  - 记录耗时，验证块数是否随 segment 变化（间接反映分块数）。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\probe_demucs_chunking.py
输出:
    docs/test-records/phase-5-chunking-behavior.md / .json
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))

OUT_WAV = ROOT / "assets" / "output" / "chunking-probe"


def make_probe_audio(sr: int = 44100, seconds: float = 20.0):
    """生成测试信号：前段静音 + 末尾 0.5s 单声道脉冲，用来检测尾部是否被截断/补零。"""
    import numpy as np

    n = int(sr * seconds)
    x = np.zeros((2, n), dtype=np.float32)
    # 全部填一个低电平立体声噪声，保证模型有输入
    rng = np.random.default_rng(42)
    x[:, :] = (rng.standard_normal((2, n)) * 0.01).astype(np.float32)
    # 末尾 0.5 秒加明显脉冲（左右不同，便于检测立体声是否保留）
    tail = n - int(sr * 0.5)
    x[0, tail:] = 0.8
    x[1, tail:] = -0.8
    return x, sr


def main() -> int:
    import numpy as np
    import torch
    from demucs.api import Separator

    dev = "xpu" if torch.xpu.is_available() else "cpu"
    sr_in = 44100
    audio, sr = make_probe_audio()
    OUT_WAV.mkdir(parents=True, exist_ok=True)

    import torchaudio

    probe_path = OUT_WAV / "probe_20s.wav"
    # torchaudio 2.11 的 save() 依赖 torchcodec（未安装），直接用标准库写 WAV
    import wave

    pcm16 = np.clip(audio.T, -1.0, 1.0)
    pcm16 = (pcm16 * 32767).astype("<i2")
    with wave.open(str(probe_path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16.tobytes())
    total = audio.shape[-1]
    print(f"[i] 测试音频: {total} 样本 ({total / sr:.2f}s) 44.1kHz 双声道, device={dev}")

    report: dict = {"device": dev, "totalSamples": total, "sr": sr, "cases": []}

    cases = [
        {"segment": 7.8, "overlap": 0.25},
        {"segment": 7.0, "overlap": 0.25},
        {"segment": 5.0, "overlap": 0.25},
        {"segment": 7.8, "overlap": 0.5},
    ]
    for c in cases:
        print(f"\n[i] segment={c['segment']} overlap={c['overlap']}")
        t0 = time.perf_counter()
        sep = Separator(model="htdemucs", device=dev, segment=c["segment"], overlap=c["overlap"], progress=False)
        init_ms = int((time.perf_counter() - t0) * 1000)
        t1 = time.perf_counter()
        origin, separated = sep.separate_audio_file(str(probe_path))
        proc = time.perf_counter() - t1
        out_len = next(iter(separated.values())).shape[-1]
        # 检查尾部能量是否保留（补零截断会导致尾部振幅明显偏低）
        perc = separated.get("other")
        entry = {
            **c, "initMs": init_ms, "procS": round(proc, 3),
            "inLen": int(origin.shape[-1]), "outLen": int(out_len),
            "lenMatch": int(out_len) == int(origin.shape[-1]),
            "rtf": round(proc / (total / sr), 4),
        }
        if perc is not None:
            tail = perc[:, -int(sr * 0.25):]
            entry["tailRms"] = round(float(tail.pow(2).mean().sqrt()), 6)
        report["cases"].append(entry)
        print(f"    init={init_ms}ms proc={proc:.2f}s outLen={out_len} lenMatch={entry['lenMatch']} tailRms={entry.get('tailRms')}")

    # 一致性：不同 segment 下 drums/bass 等应基本一致（允许 OLA 差异）
    print("\n[i] 计算不同配置间的相对差异（以 segment=7.8/overlap=0.25 为基准）")
    base = Separator(model="htdemucs", device=dev, segment=7.8, overlap=0.25, progress=False)
    _, base_out = base.separate_audio_file(str(probe_path))
    for c in cases[1:]:
        sep = Separator(model="htdemucs", device=dev, segment=c["segment"], overlap=c["overlap"], progress=False)
        _, out = sep.separate_audio_file(str(probe_path))
        deltas = {}
        for stem, sig in out.items():
            b = base_out.get(stem)
            if b is None or b.shape != sig.shape:
                continue
            diff = (sig - b).abs().mean() / (b.abs().mean() + 1e-8)
            deltas[stem] = round(float(diff), 6)
        print(f"    segment={c['segment']} overlap={c['overlap']} => {deltas}")

    out_json = ROOT / "docs" / "test-records" / "phase-5-chunking-behavior.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nreport => {out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
