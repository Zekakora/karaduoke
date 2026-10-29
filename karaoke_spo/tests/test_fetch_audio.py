# -*- coding: utf-8 -*-
"""scripts/fetch_audio.py 的时长校验测试（普通脚本，不依赖 pytest，不联网）。

用法（Windows）：
    python/.venv-xpu/Scripts/python.exe tests/test_fetch_audio.py

只测**纯本地**的逻辑：时长校验、打分、match.json 结构。
真实下载（spotdl / ytdlp）不在单元测试里跑，需要手工/集成验证。
"""
from __future__ import annotations

import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_audio as fa  # noqa: E402

TMP_DIR = Path(tempfile.mkdtemp(
    prefix="fetchtest-", dir=str(ROOT / ".tmp") if (ROOT / ".tmp").exists() else None
))
_results: list[tuple[str, bool, str]] = []


def case(fn):
    try:
        fn()
    except AssertionError as e:
        _results.append((fn.__name__, False, str(e) or "assert failed"))
    except Exception as e:  # noqa: BLE001
        _results.append((fn.__name__, False, f"{type(e).__name__}: {e}"))
    else:
        _results.append((fn.__name__, True, ""))
    return fn


def write_wav(path: Path, seconds: float, sr: int = 44100) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00\x00\x00" * int(sr * seconds))
    return path


@case
def test_duration_within_tolerance():
    p = write_wav(TMP_DIR / "ok.wav", 10.0)
    res = fa.check_duration(p, 10.0, 5.0)
    assert res["ok"] is True, res
    assert res["diff_s"] is not None and res["diff_s"] < 0.01, res


@case
def test_duration_outside_tolerance_rejected():
    # Live Aid 165s vs 录音室 355s 这类场景
    p = write_wav(TMP_DIR / "live.wav", 165.0)
    res = fa.check_duration(p, 355.0, 5.0)
    assert res["ok"] is False, res
    assert res["diff_s"] == 190.0, res


@case
def test_duration_missing_expected_rejected():
    """没有 Spotify 时长就无法校验 —— 必须判失败，不能当通过。"""
    p = write_wav(TMP_DIR / "noexp.wav", 10.0)
    res = fa.check_duration(p, None, 5.0)
    assert res["ok"] is False, res


@case
def test_duration_tolerance_boundary():
    p = write_wav(TMP_DIR / "edge.wav", 20.0)
    assert fa.check_duration(p, 24.5, 5.0)["ok"] is True
    assert fa.check_duration(p, 25.5, 5.0)["ok"] is False


@case
def test_score_live_version_penalised():
    """带 live 的候选必须被负向词扣分，且比干净版本低。"""
    clean, _ = fa.score_candidate(
        "Carly Rae Jepsen - Cut To The Feeling", 206, "Cut To The Feeling", ["Carly Rae Jepsen"], 208
    )
    live, reasons = fa.score_candidate(
        "Carly Rae Jepsen Cut To The Feeling LIVE", 206, "Cut To The Feeling", ["Carly Rae Jepsen"], 208
    )
    assert live < clean, (live, clean)
    assert any("负向词" in r for r in reasons), reasons


@case
def test_build_match_records_provider_and_duration():
    class A:
        title = "X"
        artist = ["Y"]
        duration = 100.0

    result = {
        "ok": True,
        "used_provider": "spotdl",
        "chosen": {"id": "abc", "score": 100.0},
        "duration_check": {"ok": True, "reason": "ok"},
        "path": str(TMP_DIR / "abc.wav"),
        "timings": {"search_s": 1.0},
    }
    m = fa.build_match("auto", result, A(), "sid123")
    assert m["provider"] == "auto", m
    assert m["used_provider"] == "spotdl", m
    assert m["duration_check"]["ok"] is True, m
    assert m["spotify_id"] == "sid123", m
    assert "timings" in m and "candidates" in m, m


def main() -> int:
    ok = sum(1 for _, passed, _ in _results if passed)
    for name, passed, msg in _results:
        print(f"[{'ok' if passed else 'FAIL'}] {name}" + (f" — {msg}" if msg else ""))
    print(f"\n{ok}/{len(_results)} 通过")
    return 0 if ok == len(_results) else 1


if __name__ == "__main__":
    sys.exit(main())
