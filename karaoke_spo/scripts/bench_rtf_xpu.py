# -*- coding: utf-8 -*-
"""在 Intel XPU 上跑 Demucs，测真实 RTF。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\bench_rtf_xpu.py --inputs assets\\audio\\hs_30s.wav --repeats 2

输出: docs/test-records/phase-3-rtf-xpu.csv
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
    if os.name != "nt":
        return ""
    try:
        import ctypes

        class PMC(ctypes.Structure):
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

        c = PMC()
        c.cb = ctypes.sizeof(PMC)
        h = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(h), ctypes.byref(c), c.cb):
            return round(c.PeakWorkingSetSize / 1024 / 1024, 1)
    except Exception:
        pass
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", nargs="+", required=True)
    ap.add_argument("--repeats", type=int, default=2)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--segment", type=float, default=7.8)
    ap.add_argument("--device", default="xpu")
    ap.add_argument("--out", default=str(ROOT / "docs" / "test-records" / "phase-3-rtf-xpu.csv"))
    args = ap.parse_args()

    import torch
    from demucs.api import Separator

    dev_ok = torch.xpu.is_available() if args.device == "xpu" else True
    print(f"[i] torch={torch.__version__} xpu_available={torch.xpu.is_available()}")
    if args.device == "xpu" and not dev_ok:
        print("[x] XPU 不可用，退出")
        return 2
    if torch.xpu.is_available():
        props = torch.xpu.get_device_properties(0)
        print(f"[i] device={props.name} total_mem={props.total_memory / 1024 ** 3:.2f}GB")

    t0 = time.perf_counter()
    separator = Separator(model=args.model, device=args.device, segment=args.segment, progress=False)
    init_ms = int((time.perf_counter() - t0) * 1000)
    print(f"[i] model={args.model} device={args.device} segment={args.segment} init={init_ms}ms")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    new_file = not out.exists()
    rows = []
    with out.open("a", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        if new_file:
            w.writerow([
                "run_at", "model", "device", "segment_s", "init_ms", "input", "input_s",
                "runs", "proc_mean_s", "proc_min_s", "proc_max_s", "rtf_mean", "rtf_min",
                "rtf_max", "rtf_stddev", "peak_rss_mb", "device_name", "device_mem_gb",
            ])
        dev_name = ""
        dev_mem = ""
        if torch.xpu.is_available():
            p = torch.xpu.get_device_properties(0)
            dev_name = p.name
            dev_mem = round(p.total_memory / 1024 ** 3, 2)

        for rel in args.inputs:
            path = Path(rel)
            if not path.is_absolute():
                path = ROOT / path
            if not path.exists():
                print(f"[x] 跳过 {path}")
                continue
            print(f"  warmup {path.name} ...")
            separator.separate_audio_file(str(path))  # 预热：含首次编译/权重上卡
            sr = separator.samplerate
            times = []
            input_s = None
            for i in range(args.repeats):
                st = time.perf_counter()
                origin, separated = separator.separate_audio_file(str(path))
                el = time.perf_counter() - st
                input_s = origin.shape[-1] / sr
                times.append(el)
                print(f"    {path.name} run {i + 1}/{args.repeats}: {el:.2f}s (rtf={el / input_s:.4f})")
            rtfs = [t / input_s for t in times]
            row = [
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
                args.model, args.device, args.segment, init_ms, path.name, round(input_s, 3),
                args.repeats, round(statistics.mean(times), 4), round(min(times), 4),
                round(max(times), 4), round(statistics.mean(rtfs), 4), round(min(rtfs), 4),
                round(max(rtfs), 4), round(statistics.stdev(rtfs), 4) if len(rtfs) > 1 else 0.0,
                peak_rss_mb(), dev_name, dev_mem,
            ]
            w.writerow(row)
            rows.append(row)
            print(f"[+] {path.name}: rtf_mean={row[11]} (min {row[12]} / max {row[13]})")

    print(f"\nCSV => {out}")
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
