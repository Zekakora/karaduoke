# -*- coding: utf-8 -*-
"""歌词抓取：lrclib.net（同步歌词）+ 本地 LRC 回退。

lrclib 无需鉴权，接口实测可用：
    GET https://lrclib.net/api/get?track_name=&artist_name=&duration=
    GET https://lrclib.net/api/search?q=

返回字段要点：`syncedLyrics`（LRC）、`plainLyrics`、`duration`、`instrumental`。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://lrclib.net/api"
UA = "spotify-demucs-lab/0.1 (personal verification project)"


def _get(url: str, timeout: int = 15) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _qq_via_node(title: str, artist: str, duration_s: float | None) -> dict | None:
    """走 QQ 音乐逐字歌词（QRC）。

    实现复用 Node 侧已验证的 lib/qq-lyrics.js（含 QRC 解密、解析、制作信息过滤），
    Python 这边只负责调 CLI 并翻译成统一的歌词结构。
    拿不到就返回 None，调用方回退 lrclib。
    """
    node = os.environ.get("NODE_EXE", "").strip()
    if not node or not Path(node).exists():
        node = shutil.which("node") or "node"
    args = [node, str(ROOT / "lib" / "qq-lyrics.js"), "--title", title]
    if artist:
        args += ["--artist", artist]
    if duration_s:
        args += ["--duration", str(int(round(duration_s)))]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=90, cwd=str(ROOT),
            encoding="utf-8", errors="replace",
        )
    except Exception:
        return None
    out = (proc.stdout or "").strip()
    if not out:
        return None
    payload = None
    for line in reversed(out.splitlines()):
        line = line.strip().lstrip("\ufeff")
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except ValueError:
                payload = None
            break
    if not payload or not payload.get("ok"):
        return None
    return {
        "provider": payload.get("provider") or "qqmusic",
        "provider_id": str((payload.get("match") or {}).get("songMid") or ""),
        "synced": True,
        "format": payload.get("format") or "qrc",
        "language": None,
        # 逐字时存**原始 QRC XML**：服务端解析后才能拿到 chars（逐字时间轴）。
        # 早先这里存的是拼好的纯文本，逐字信息就丢了。
        "content": payload.get("qrcXml") or payload.get("lrc") or "",
        "lines": payload.get("lines") or [],
        "translation": payload.get("translation"),
        "char_count": payload.get("charCount") or 0,
        "plain": payload.get("lrc") or "",
        "instrumental": False,
        "title": title,
        "artist": artist,
        "duration_s": duration_s,
    }


def _netease_via_node(title: str, artist: str, duration_s: float | None) -> dict | None:
    """走网易云歌词（有 YRC 就用逐字，否则行级 LRC）。QQ 限流时的兜底。"""
    node = os.environ.get("NODE_EXE", "").strip()
    if not node or not Path(node).exists():
        node = shutil.which("node") or "node"
    args = [node, str(ROOT / "lib" / "netease-lyrics.js"), "--title", title]
    if artist:
        args += ["--artist", artist]
    if duration_s:
        args += ["--duration", str(int(round(duration_s)))]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=60, cwd=str(ROOT),
            encoding="utf-8", errors="replace",
        )
    except Exception:
        return None
    out = (proc.stdout or "").strip()
    if not out:
        return None
    payload = None
    for line in reversed(out.splitlines()):
        line = line.strip().lstrip("\ufeff")
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except ValueError:
                payload = None
            break
    if not payload or not payload.get("ok"):
        return None
    # 网易云现在优先返回 YRC（逐字）。format 必须跟着 payload 走：
    # 以前这里硬编码成 "lrc"，把 YRC 原文存成 lrc，Node 侧解析出 0 行，
    # 播放时只好临时联网查歌词，大屏要等几十秒。
    fmt = payload.get("format") or "lrc"
    content = payload.get("content") or payload.get("lrc") or ""
    plain = payload.get("plainText") or (content if fmt != "yrc" else "")
    return {
        "provider": "netease",
        "provider_id": str((payload.get("match") or {}).get("songId") or ""),
        "synced": True,
        "format": fmt,
        "language": None,
        "content": content,
        "lines": [],
        "translation": payload.get("translation"),
        "char_count": 0,
        "plain": plain,
        "instrumental": False,
        "title": title,
        "artist": artist,
        "duration_s": duration_s,
    }


def fetch_lyrics(title: str, artist: str, duration_s: float | None = None, provider: str = "auto") -> dict | None:
    """抓歌词。

    provider:
      auto (默认) — **QQ 逐字 → 网易云 → lrclib** 依次尝试。
                    以前只查 lrclib，所以曲库歌词永远显示 lrclib、只有行级。
      qq          — 只查 QQ（逐字）
      netease     — 只查网易云（行级）
      lrclib      — 只查 lrclib（行级）
    """
    if provider in ("auto", "qq"):
        qq = _qq_via_node(title, artist, duration_s)
        if qq:
            return qq
        if provider == "qq":
            return None
    if provider in ("auto", "netease"):
        ne = _netease_via_node(title, artist, duration_s)
        if ne:
            return ne
        if provider == "netease":
            return None
    return _fetch_lrclib(title, artist, duration_s)


def _fetch_lrclib(title: str, artist: str, duration_s: float | None = None) -> dict | None:
    """先精确匹配（get），失败再搜索（search）取时长最接近且有 syncedLyrics 的。"""
    params = {"track_name": title, "artist_name": artist}
    if duration_s:
        params["duration"] = str(int(round(duration_s)))
    try:
        data = _get(f"{BASE}/get?{urllib.parse.urlencode(params)}")
        if data and (data.get("syncedLyrics") or data.get("plainLyrics")):
            return _norm(data)
    except urllib.error.HTTPError:
        pass  # 404 = 没有精确匹配，走搜索
    except Exception:
        pass

    q = urllib.parse.urlencode({"q": f"{artist} {title}"})
    try:
        results = _get(f"{BASE}/search?{q}")
    except Exception:
        return None
    if not isinstance(results, list) or not results:
        return None

    def rank(item: dict) -> tuple[int, float]:
        synced = 1 if item.get("syncedLyrics") else 0
        diff = abs((item.get("duration") or 0) - (duration_s or 0)) if duration_s else 0
        return (-synced, diff)

    results.sort(key=rank)
    return _norm(results[0]) if (results[0].get("syncedLyrics") or results[0].get("plainLyrics")) else None


def _norm(item: dict) -> dict:
    synced = item.get("syncedLyrics") or ""
    plain = item.get("plainLyrics") or ""
    return {
        "provider": "lrclib",
        "provider_id": str(item.get("id") or ""),
        "synced": bool(synced),
        "format": "lrc" if synced else "plain",
        "language": None,
        "content": synced or plain,
        "plain": plain,
        "instrumental": bool(item.get("instrumental")),
        "title": item.get("trackName"),
        "artist": item.get("artistName"),
        "duration_s": item.get("duration"),
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("用法: python scripts\\fetch_lyrics.py <title> <artist> [duration]")
        raise SystemExit(1)
    d = float(sys.argv[3]) if len(sys.argv) > 3 else None
    started = time.perf_counter()
    res = fetch_lyrics(sys.argv[1], sys.argv[2], d)
    print(f"耗时 {int((time.perf_counter() - started) * 1000)}ms")
    if not res:
        print("没有找到歌词")
        raise SystemExit(2)
    print(json.dumps({k: v for k, v in res.items() if k not in ("content", "plain")}, ensure_ascii=False, indent=2))
    print("--- content 前 400 字 ---")
    print(res["content"][:400])
