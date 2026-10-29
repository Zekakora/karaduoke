# -*- coding: utf-8 -*-
"""把用户提供的音频转成 Demucs 需要的 44.1kHz / 16-bit / stereo WAV，并切出测试片段。

用法:
    python\\venv\\Scripts\\python.exe scripts\\prepare_audio.py HS.mp3

输出(assets/audio/):
    hs_full.wav     完整 44.1k/16bit/stereo
    hs_8s.wav       8s   —— 分块实验（小于 htdemucs 的 7.8s segment 上限附近）
    hs_30s.wav      30s  —— 快速回归
    hs_180s.wav     180s —— RTF 基准（原曲不足 180s 时自动截短并如实记录）
    hs_180s.json    时长/采样率/声道/峰值等元数据
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio"


def main(src_name: str) -> int:
    src = Path(src_name)
    if not src.is_absolute():
        src = ROOT / src
    if not src.exists():
        print(f"[x] 找不到音频: {src}")
        return 1

    import numpy as np
    import torch
    import av  # PyAV 自带 FFmpeg 库，本机没有 ffmpeg.exe 也能解码容器格式

    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()

    # 1) 解码：sphn（demucs v4.1.0 自带）实测对容器格式报 "no channel"，
    #    因此改用 PyAV。这里只做解码，不改变分离管线。
    container = av.open(str(src))
    stream = container.streams.audio[0]
    source_codec = stream.codec_context.name
    source_sr = stream.codec_context.sample_rate
    chunks = [frame.to_ndarray() for frame in container.decode(stream)]
    container.close()
    pcm = np.concatenate(chunks, axis=1)  # (channels, samples)
    sample_rate = source_sr
    load_ms = int((time.perf_counter() - t0) * 1000)
    print(f"[i] 解码 {src.name}: codec={source_codec} shape={pcm.shape} sr={sample_rate} 用时={load_ms}ms")

    # sphn.read 返回 (channels, samples)；统一成 (1, ch, n) 的 torch 张量
    if pcm.ndim == 1:
        pcm = pcm[None, :]
    if pcm.shape[0] > 2:
        print(f"[!] 音频有 {pcm.shape[0]} 个声道，只保留前 2 个")
        pcm = pcm[:2]

    # 2) 重采样到 44100（模型采样率）
    target_sr = 44100
    if sample_rate != target_sr:
        import julius

        wav = torch.from_numpy(np.ascontiguousarray(pcm)).float()
        wav = julius.resample_frac(wav, sample_rate, target_sr)
        print(f"[i] 重采样 {sample_rate} -> {target_sr}: {pcm.shape} -> {tuple(wav.shape)}")
    else:
        wav = torch.from_numpy(np.ascontiguousarray(pcm)).float()

    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
        print("[i] 单声道补成双声道（复制）")

    wav = wav.unsqueeze(0)  # (1, ch, n)
    total_s = wav.shape[-1] / target_sr

    meta = {
        "source": src.name,
        "source_codec": source_codec,
        "source_load_ms": load_ms,
        "source_sample_rate": sample_rate,
        "source_shape": list(pcm.shape),
        "output_sample_rate": target_sr,
        "channels": int(wav.shape[1]),
        "duration_s": round(total_s, 3),
        "peak": round(float(wav.abs().max()), 6),
        "clip_ratio": round(float((wav.abs() > 0.999).float().mean()), 8),
        "segments": {},
    }

    # 3) 写出完整文件与切片
    def save(name: str, tensor: torch.Tensor) -> str:
        path = OUT / name
        demucs_save = __import__("demucs.api", fromlist=["save_audio"]).save_audio
        demucs_save(tensor.squeeze(0), str(path), samplerate=target_sr)
        dur = tensor.shape[-1] / target_sr
        meta["segments"][name] = {"duration_s": round(dur, 3), "bytes": path.stat().st_size}
        print(f"[+] {name}: {dur:.2f}s, {path.stat().st_size / 1024:.0f} KB")
        return name

    save("hs_full.wav", wav)
    for seg_s in (8, 30, 180):
        n = min(seg_s * target_sr, wav.shape[-1])
        save(f"hs_{seg_s}s.wav", wav[:, :, :n])

    meta["prepare_ms"] = int((time.perf_counter() - t0) * 1000)
    (OUT / "hs_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[i] 元数据 -> {OUT / 'hs_meta.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "HS.mp3"))
