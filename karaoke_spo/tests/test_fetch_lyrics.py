# -*- coding: utf-8 -*-
"""fetch_lyrics.py 的回归测试（普通脚本，不依赖 pytest）。

覆盖：网易云返回 YRC 时，format 不能再被硬编码成 lrc ——
否则 YRC 原文被存成 lrc，Node 侧按 LRC 解析出 0 行，播放时只能临时联网，
大屏要等几十秒才出歌词。

用法（Windows）：
    python\\Scripts\\python.exe tests\\test_fetch_lyrics.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

import fetch_lyrics  # noqa: E402

_results: list[tuple[str, bool, str]] = []


def case(fn):
    try:
        fn()
        _results.append((fn.__name__, True, ""))
        print(f"ok   {fn.__name__}")
    except Exception as e:  # noqa: BLE001
        _results.append((fn.__name__, False, f"{type(e).__name__}: {e}"))
        print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    return fn


def fake_node(payload: dict):
    stdout = "some debug line\n" + json.dumps(payload, ensure_ascii=False) + "\n"

    def run(*args, **kwargs):  # noqa: ANN001
        return SimpleNamespace(stdout=stdout, stderr="", returncode=0)

    return run


@case
def netease_yrc_keeps_format():
    yrc = "[0,1000](0,500,0)Hello (500,500,0)world"
    payload = {
        "ok": True,
        "format": "yrc",
        "lrc": yrc,
        "content": yrc,
        "plainText": "Hello world",
        "translation": None,
        "match": {"songId": 1},
    }
    original = fetch_lyrics.subprocess.run
    fetch_lyrics.subprocess.run = fake_node(payload)
    try:
        res = fetch_lyrics._netease_via_node("Song", "Artist", 180)
    finally:
        fetch_lyrics.subprocess.run = original
    assert res is not None
    assert res["format"] == "yrc", res["format"]
    assert res["content"] == yrc
    assert res["plain"] == "Hello world"


@case
def netease_lrc_stays_lrc():
    lrc = "[00:01.00]Hello\n[00:02.00]World"
    payload = {"ok": True, "format": "lrc", "lrc": lrc, "content": lrc, "plainText": lrc}
    original = fetch_lyrics.subprocess.run
    fetch_lyrics.subprocess.run = fake_node(payload)
    try:
        res = fetch_lyrics._netease_via_node("Song", "Artist", 180)
    finally:
        fetch_lyrics.subprocess.run = original
    assert res is not None
    assert res["format"] == "lrc"
    assert res["content"] == lrc


passed = sum(1 for _, ok, _ in _results if ok)
failed = len(_results) - passed
print(f"\nPASS：{passed}/{len(_results)} 通过，{failed} 失败")
if failed:
    raise SystemExit(1)
