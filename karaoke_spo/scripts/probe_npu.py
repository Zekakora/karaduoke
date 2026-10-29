# -*- coding: utf-8 -*-
"""NPU 调研探针：确认 Intel NPU 在 OpenVINO 下可用，并用一个真实的小模型测推理延迟。

思路：用 torch 构造一个小 CNN（含 conv/pool/matmul），导出 ONNX，再分别编译到
NPU / GPU / CPU，测单次推理耗时，给出"NPU 能跑什么规模模型"的实测边界。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\probe_npu.py
输出:
    docs/test-records/phase-npu-probe.json
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("OV_TELEMETRY_DISABLED", "1")


def build_onnx(path: Path, shape=(1, 2, 44100)):
    """一个和音频分离有点相似的小模型：逐声道 conv 堆叠 + 输出等长。"""
    import torch

    class TinySep(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.net = torch.nn.Sequential(
                torch.nn.Conv1d(2, 32, 8, stride=2, padding=3),
                torch.nn.ELU(),
                torch.nn.Conv1d(32, 64, 8, stride=2, padding=3),
                torch.nn.ELU(),
                torch.nn.Conv1d(64, 32, 4, stride=1, padding=2),
                torch.nn.ELU(),
                torch.nn.Conv1d(32, 4, 4, stride=1, padding=2),
                torch.nn.Sigmoid(),
            )

        def forward(self, x):
            return self.net(x)

    m = TinySep().eval()
    dummy = torch.randn(*shape)
    torch.onnx.export(
        m, dummy, str(path),
        input_names=["mix"], output_names=["mask"],
        dynamic_axes={"mix": {2: "len"}, "mask": {2: "len"}},
        opset_version=17,
        dynamo=False,
    )
    return shape


def main() -> int:
    import numpy as np
    import openvino as ov

    core = ov.Core()
    report = {"openvino": ov.__version__, "devices": {}, "results": []}
    for d in core.available_devices:
        try:
            report["devices"][d] = core.get_property(d, "FULL_DEVICE_NAME")
        except Exception as e:
            report["devices"][d] = f"ERR {e}"
    print("devices:", json.dumps(report["devices"], ensure_ascii=False))

    out_dir = ROOT / "assets" / "output" / "npu-probe"
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "tiny_sep.onnx"
    shape = build_onnx(onnx_path)
    print(f"[i] 导出 ONNX: {onnx_path} shape={shape} size={onnx_path.stat().st_size / 1024:.0f}KB")

    model = core.read_model(str(onnx_path))
    x = np.random.randn(*shape).astype(np.float32)

    for dev in ["NPU", "GPU", "CPU"]:
        if dev not in core.available_devices and dev != "CPU":
            report["results"].append({"device": dev, "skipped": "not available"})
            continue
        try:
            t0 = time.perf_counter()
            compiled = core.compile_model(model, dev)
            compile_ms = int((time.perf_counter() - t0) * 1000)
            req = compiled.create_infer_request()
            # 预热 2 次
            for _ in range(2):
                req.infer({0: x})
            times = []
            for _ in range(5):
                st = time.perf_counter()
                req.infer({0: x})
                times.append((time.perf_counter() - st) * 1000)
            times.sort()
            audio_s = shape[2] / 44100
            rtf = (sum(times) / len(times) / 1000) / audio_s
            entry = {
                "device": dev,
                "full_name": report["devices"].get(dev),
                "compile_ms": compile_ms,
                "infer_ms_median": round(times[len(times) // 2], 3),
                "infer_ms_min": round(times[0], 3),
                "infer_ms_max": round(times[-1], 3),
                "audio_s": audio_s,
                "rtf": round(rtf, 5),
            }
            report["results"].append(entry)
            print(f"[+] {dev:4s} compile={compile_ms}ms infer_median={entry['infer_ms_median']}ms rtf={entry['rtf']}")
        except Exception as e:
            report["results"].append({"device": dev, "error": f"{type(e).__name__}: {e}"})
            print(f"[x] {dev} 失败: {type(e).__name__}: {e}")

    out = ROOT / "docs" / "test-records" / "phase-npu-probe.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"report => {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
