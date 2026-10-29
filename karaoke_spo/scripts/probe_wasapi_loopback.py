# -*- coding: utf-8 -*-
"""WASAPI loopback 探针：直接采系统输出设备的 PCM（不经过浏览器、不受 EME 影响）。

这是"把 Spotify 正在播放的音频喂给 Demucs"最确定的一条路径：
Spotify 桌面客户端 / 浏览器 → 系统混音输出 → WASAPI loopback → PCM → WAV。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\probe_wasapi_loopback.py --seconds 10

输出:
    assets/output/loopback/probe-<ts>.wav
    docs/test-records/phase-4-wasapi-loopback.json

说明：Windows 上 WasapiSettings(loopback=True) 只能用于"输入流"，
即把某个**输出设备**当输入来读它的混音结果。
"""
from __future__ import annotations

import argparse
import json
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def list_devices() -> list[dict]:
    import sounddevice as sd

    out = []
    for idx, d in enumerate(sd.query_devices()):
        out.append({
            "index": idx,
            "name": d["name"],
            "hostapi": sd.query_hostapis(d["hostapi"])["name"],
            "max_input_channels": d["max_input_channels"],
            "max_output_channels": d["max_output_channels"],
            "default_samplerate": d["default_samplerate"],
        })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--device", type=int, default=None, help="输出设备索引（默认用系统默认输出）")
    ap.add_argument("--samplerate", type=int, default=None)
    ap.add_argument("--channels", type=int, default=2)
    args = ap.parse_args()

    import numpy as np
    import sounddevice as sd

    report: dict = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    devices = list_devices()
    report["hostapis"] = [h["name"] for h in sd.query_hostapis()]
    report["devices"] = devices
    print("hostapis:", report["hostapis"])

    # 找默认输出设备
    try:
        default_out = sd.default.device[1]
    except Exception:
        default_out = None
    report["default_output"] = default_out
    dev_index = args.device if args.device is not None else default_out
    if dev_index is None or dev_index < 0:
        print("[x] 找不到默认输出设备")
        return 2

    info = sd.query_devices(dev_index)
    sr = args.samplerate or int(info["default_samplerate"])
    print(f"[i] 目标输出设备 #{dev_index}: {info['name']} (sr={sr})")
    report["target_device"] = {"index": dev_index, "name": info["name"], "samplerate": sr}

    # 采集方案选择：
    #  - sounddevice 0.5.6 捆绑的 PortAudio 没有 WASAPI loopback 开关
    #    （WasapiSettings 只有 exclusive/auto_convert/explicit_sample_format 三个参数），
    #    所以走 **WDM-KS 的 "Stereo Mix" 环回设备**（等价于 WASAPI loopback 的效果）。
    #  - 若找不到 Stereo Mix，可改用 naudiodon / WASAPI 原生调用，但需要额外依赖。
    wasapi = None
    loopback_index = args.device
    if loopback_index is None:
        for d in devices:
            if d["max_input_channels"] >= 2 and "stereo mix" in d["name"].lower():
                loopback_index = d["index"]
                break
    if loopback_index is None:
        print("[x] 没有找到 Stereo Mix / loopback 采集设备")
        report["error"] = "no loopback device"
        _write(report)
        return 3
    dev_index = loopback_index
    info = sd.query_devices(dev_index)
    sr = args.samplerate or int(info["default_samplerate"])
    print(f"[i] loopback 设备 #{dev_index}: {info['name']} (sr={sr})")
    report["loopback_source"] = {"index": dev_index, "name": info["name"], "samplerate": sr}

    frames = int(args.seconds * sr)
    chunks = []
    try:
        # 注意：WDM-KS 后端不支持 blocking read（"Blocking API not supported yet"），
        # 所以必须用回调模式 accumulate。
        print(f"[i] 开始采集 {args.seconds:.1f}s，请确保系统正在播放声音…")
        started = time.perf_counter()

        def _cb(indata, fcount, tinfo, status):  # noqa: ANN001
            if status:
                report.setdefault("status_flags", []).append(str(status))
            chunks.append(indata.copy())
            if sum(len(c) for c in chunks) >= frames:
                raise sd.CallbackStop()

        with sd.InputStream(
            device=dev_index,
            channels=args.channels,
            samplerate=sr,
            dtype="float32",
            blocksize=1024,
            extra_settings=wasapi,
            callback=_cb,
        ):
            deadline = started + args.seconds + 5
            while sum(len(c) for c in chunks) < frames and time.perf_counter() < deadline:
                time.sleep(0.05)
        elapsed = time.perf_counter() - started
    except Exception as e:
        print(f"[x] 采集失败: {type(e).__name__}: {e}")
        report["error"] = f"{type(e).__name__}: {e}"
        _write(report)
        return 4

    audio = np.concatenate(chunks, axis=0)
    peak = float(np.abs(audio).max())
    rms = float(np.sqrt((audio.astype(np.float64) ** 2).mean()))
    report.update({
        "collected_frames": int(len(audio)),
        "elapsed_s": round(elapsed, 3),
        "sample_rate": sr,
        "channels": int(audio.shape[1]),
        "peak": round(peak, 6),
        "rms": round(rms, 6),
        "silent": peak < 1e-4,
    })

    out_dir = ROOT / "assets" / "output" / "loopback"
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = out_dir / f"probe-{int(time.time())}.wav"
    pcm16 = np.clip(audio, -1.0, 1.0)
    pcm16 = (pcm16 * 32767).astype("<i2")
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(audio.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16.tobytes())
    report["wav"] = str(wav_path)
    report["wav_bytes"] = wav_path.stat().st_size

    print(f"[+] 采集 {len(audio) / sr:.2f}s peak={peak:.4f} rms={rms:.4f} silent={report['silent']}")
    if report["silent"]:
        print("[!] 采集到的是**静音**：说明系统当前没有声音（请先播放音乐再跑），或该设备不支持 loopback")
    print(f"[+] WAV => {wav_path}")
    _write(report)
    return 0


def _write(report: dict) -> None:
    out = ROOT / "docs" / "test-records" / "phase-4-wasapi-loopback.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"report => {out}")


if __name__ == "__main__":
    raise SystemExit(main())
