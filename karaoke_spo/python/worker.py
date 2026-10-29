# -*- coding: utf-8 -*-
"""Demucs 长驻 Worker：一次加载模型，反复处理任务。

通信协议（Node ↔ Python，按行分隔的 JSON，走 stdin/stdout）：
    请求  {"id":"job-1","type":"job","input":"<abs wav>","outputDir":"<abs dir>","model":"htdemucs","segment":7.8}
    请求  {"id":"ping","type":"ping"}
    请求  {"id":"quit","type":"quit"}
    响应  {"type":"ready","model":...,"device":...,"torch":...,"initMs":...}
    响应  {"type":"log","id":...,"message":...}
    响应  {"type":"progress","id":...,"segment":3,"total":42,"elapsedMs":...}
    响应  {"type":"done","id":...,"outDir":...,"files":{...},"inputDurationS":...,"processingS":...,"rtf":...}
    响应  {"type":"error","id":...,"code":...,"message":...}

注意：stdout 只写协议 JSON；torch/demucs 的打印会被重定向到 stderr，避免污染协议。
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

# --- 把一切非协议输出导向 stderr ---------------------------------------------
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr  # 之后所有 print() 都进 stderr


def pick_device(torch) -> str:
    """按优先级选设备：环境变量优先，其次 CUDA → XPU（Intel Arc）→ CPU。

    注意：Intel 显卡走的是 torch.xpu 后端，不是 CUDA。只判断 cuda.is_available()
    会漏掉 Intel Arc，从而误判为"只能 CPU"。
    """
    forced = os.environ.get("DEMUCS_DEVICE")
    if forced:
        return forced
    try:
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    try:
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            return "xpu"
    except Exception:
        pass
    return "cpu"


def emit(obj: dict) -> None:
    _PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def main() -> int:
    t0 = time.perf_counter()
    try:
        import torch
        from demucs.api import Separator, save_audio
    except Exception as e:  # 模型/依赖初始化失败必须显式上报，而不是静默退出
        emit({"type": "error", "id": None, "code": "INIT_FAILED", "message": f"{type(e).__name__}: {e}"})
        return 2

    model_name = os.environ.get("DEMUCS_MODEL", "htdemucs")
    device = pick_device(torch)
    try:
        separator = Separator(model=model_name, device=device, progress=False)
    except Exception as e:
        emit({
            "type": "error",
            "id": None,
            "code": "MODEL_LOAD_FAILED",
            "message": f"{type(e).__name__}: {e}",
            "trace": traceback.format_exc(limit=5),
        })
        return 3

    emit({
        "type": "ready",
        "pid": os.getpid(),
        "model": model_name,
        "device": device,
        "torch": torch.__version__,
        "torchThreads": int(torch.get_num_threads()),
        "samplerate": separator.samplerate,
        "audioChannels": separator.audio_channels,
        "initMs": int((time.perf_counter() - t0) * 1000),
    })

    for line in sys.stdin:
        line = line.strip().lstrip("\ufeff")
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"type": "error", "id": None, "code": "BAD_REQUEST", "message": str(e)})
            continue

        req_type = req.get("type", "job")
        if req_type == "quit":
            emit({"type": "bye"})
            return 0
        if req_type == "ping":
            emit({"type": "pong", "id": req.get("id"), "pid": os.getpid()})
            continue
        if req_type != "job":
            emit({"type": "error", "id": req.get("id"), "code": "UNKNOWN_TYPE", "message": req_type})
            continue

        job_id = req.get("id")
        try:
            handle_job(separator, save_audio, req)
        except FileNotFoundError as e:
            emit({"type": "error", "id": job_id, "code": "INPUT_NOT_FOUND", "message": str(e)})
        except MemoryError:
            emit({"type": "error", "id": job_id, "code": "OUT_OF_MEMORY", "message": "out of memory"})
        except Exception as e:
            emit({
                "type": "error",
                "id": job_id,
                "code": "JOB_FAILED",
                "message": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc(limit=6),
            })
    return 0


def handle_job(separator, save_audio, req: dict) -> None:
    job_id = req["id"]
    input_path = Path(req["input"]).resolve()
    out_dir = Path(req["outputDir"]).resolve()
    if not input_path.is_file():
        raise FileNotFoundError(str(input_path))
    out_dir.mkdir(parents=True, exist_ok=True)

    if req.get("segment"):
        separator.update_parameter(segment=float(req["segment"]))
    separator.update_parameter(progress=False)

    started = time.perf_counter()
    emit({"type": "log", "id": job_id, "message": f"separate start input={input_path.name}"})
    origin, separated = separator.separate_audio_file(str(input_path))
    processing_s = time.perf_counter() - started

    files = {}
    for stem, source in separated.items():
        path = out_dir / f"{stem}.wav"
        save_audio(source, str(path), samplerate=separator.samplerate)
        files[stem] = str(path)

    # 伴奏 = 非人声轨求和（两轨模式已是 (no_vocals, vocals)，四轨模式需自行相加）
    if "no_vocals" not in files and "vocals" in separated:
        import torch

        accomp = None
        for stem, source in separated.items():
            if stem == "vocals":
                continue
            accomp = source if accomp is None else accomp + source
        if accomp is not None:
            path = out_dir / "no_vocals.wav"
            save_audio(accomp, str(path), samplerate=separator.samplerate)
            files["no_vocals"] = str(path)

    sr = separator.samplerate
    input_duration_s = origin.shape[-1] / sr
    out_duration_s = next(iter(separated.values())).shape[-1] / sr
    emit({
        "type": "done",
        "id": job_id,
        "outDir": str(out_dir),
        "files": files,
        "sampleRate": sr,
        "inputDurationS": round(input_duration_s, 3),
        "outputDurationS": round(out_duration_s, 3),
        "processingS": round(processing_s, 3),
        "rtf": round(processing_s / input_duration_s, 4) if input_duration_s else None,
        "model": separator._model.__class__.__name__ if hasattr(separator, "_model") else None,
    })


if __name__ == "__main__":
    sys.exit(main())
