# -*- coding: utf-8 -*-
"""离线 RTF 基准：多次运行同一份音频，输出可复现的 CSV。

用法:
    python\\venv\\Scripts\\python.exe scripts\\bench_rtf.py --inputs assets\\audio\\hs_30s.wav assets\\audio\\hs_180s.wav --repeats 3 --model htdemucs

输出: docs/test-records/phase-3-rtf.csv（追加写入，含时间戳，便于复跑对比）
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))


def peak_rss_mb() -> str:
    """Windows 上读当前进程峰值工作集（不依赖 psutil / resource）。"""
    if os.name != "nt":
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_uint32),
                ("PageFaultCount", ctypes.c_uint32),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(handle), ctypes.byref(counters), counters.cb):
            return round(counters.PeakWorkingSetSize / 1024 / 1024, 1)
    except Exception:
        pass
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", nargs="+", required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--segment", type=float, default=7.8)
    parser.add_argument("--out", default=str(ROOT / "docs" / "test-records" / "phase-3-rtf.csv"))
    args = parser.parse_args()

    import torch
    from demucs.api import Separator

    device = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.perf_counter()
    separator = Separator(model=args.model, device=device, segment=args.segment, progress=False)
    init_ms = int((time.perf_counter() - t0) * 1000)
    print(f"[i] model={args.model} device={device} init={init_ms}ms threads={torch.get_num_threads()}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    new_file = not out.exists()
    rows = []
    with out.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        if new_file:
            writer.writerow([
                "run_at", "model", "device", "segment_s", "init_ms", "input", "input_s",
                "runs", "proc_mean_s", "proc_min_s", "proc_max_s", "rtf_mean", "rtf_min", "rtf_max",
                "rtf_stddev", "peak_rss_mb", "torch_threads",
            ])
        for rel in args.inputs:
            path = Path(rel)
            if not path.is_absolute():
                path = ROOT / path
            if not path.exists():
                print(f"[x] 跳过不存在的文件 {path}")
                continue
            _, separated = separator.separate_audio_file(str(path))  # 预热一次（不计入）
            sr = separator.samplerate
            input_s = next(iter(separated.values())).shape[-1] / sr
            times = []
            for i in range(args.repeats):
                started = time.perf_counter()
                separator.separate_audio_file(str(path))
                elapsed = time.perf_counter() - started
                times.append(elapsed)
                print(f"    {path.name} run {i + 1}/{args.repeats}: {elapsed:.2f}s (rtf={elapsed / input_s:.3f})")
            rtfs = [t / input_s for t in times]
            peak_mb = peak_rss_mb()
            row = [
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
                args.model,
                device,
                args.segment,
                init_ms,
                path.name,
                round(input_s, 3),
                args.repeats,
                round(statistics.mean(times), 3),
                round(min(times), 3),
                round(max(times), 3),
                round(statistics.mean(rtfs), 4),
                round(min(rtfs), 4),
                round(max(rtfs), 4),
                round(statistics.stdev(rtfs), 4) if len(rtfs) > 1 else 0.0,
                peak_mb,
                torch.get_num_threads(),
            ]
            writer.writerow(row)
            rows.append(row)
            print(f"[+] {path.name}: rtf_mean={row[11]} (min {row[12]} / max {row[13]})")

    print(f"\nCSV => {out}")
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
