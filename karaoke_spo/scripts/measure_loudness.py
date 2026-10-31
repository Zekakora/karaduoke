# -*- coding: utf-8 -*-
"""测量一首歌**伴奏**的响度（LUFS / True Peak / LRA），写回曲库。

为什么要测
-----------
Demucs 分离后，finalize 只做了"统一增益 + 目标峰值 0.89"的**峰值**定标。
峰值一样不代表听起来一样响：鼓点稀疏的抒情歌和密度很高的电子舞曲，
peak 都是 -1dBFS，实际响度能差 6~10 LUFS。现场一首接一首放，DJ 就得不停调音量。

所以这里用 FFmpeg 的 `loudnorm` **分析模式**测出 ITU-R BS.1770 的：
  - Integrated LUFS（整体响度）
  - True Peak dBFS（真峰值，考虑采样点之间的过冲，比 sample peak 准）
  - LRA（响度范围，动态大小）

**只测不改**：本脚本不碰任何音频文件，测完把数字写进数据库，播放时由前端
Web Audio 的 GainNode 实时补偿（见 public/karaoke-mixer.js）。

用法
----
    # 按曲库里的伴奏路径测（推荐）
    python scripts/measure_loudness.py --spotify-id <22位ID>
    # 直接测一个文件（不写库，除非也给了 --spotify-id）
    python scripts/measure_loudness.py --file path/to/accompaniment.mp3
    # 强制重测（忽略"已经有数据"）
    python scripts/measure_loudness.py --spotify-id <id> --force

输出：最后一行是一个 JSON（`{"ok":true,...}`），Node 侧（lib/loudness.js）解析它。
退出码恒为 0 —— Windows 上靠退出码分不清"Python 崩了"和"这首歌没法测"，
统一用 JSON 里的 ok/code 表达。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))

def resolve_ffmpeg() -> Path:
    """定位 ffmpeg。

    顺序与 finalize_track.py 一致（KARAOKE_FFMPEG → KARAOKE_ENV_DIR/bin），
    但**额外回退到项目根的 env\\**：直接 `python scripts\\measure_loudness.py`
    手工跑时没有启动器注入环境变量，而 ffmpeg 其实就在 `..\\env\\bin\\`
    （和 lib/env.js 找 env 目录的逻辑一样，先项目根再工程根）。
    """
    explicit = os.environ.get("KARAOKE_FFMPEG", "").strip()
    if explicit:
        return Path(explicit)
    env_dir = os.environ.get("KARAOKE_ENV_DIR", "").strip()
    candidates = []
    if env_dir:
        candidates.append(Path(env_dir) / "bin" / "ffmpeg.exe")
    candidates += [
        ROOT.parent / "env" / "bin" / "ffmpeg.exe",   # 项目根（实际安装位置）
        ROOT / "env" / "bin" / "ffmpeg.exe",          # 工程内（旧布局）
        ROOT.parent / "env" / "bin" / "ffmpeg",       # 非 Windows
    ]
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return candidates[0] if candidates else Path("ffmpeg.exe")


FFMPEG = resolve_ffmpeg()

# 测量算法版本。改测量方式（滤镜参数/单位/取值口径）时必须 +1，
# 否则老数据会被当成"已测过"而永远不刷新。
LOUDNESS_VERSION = 1

# loudnorm 的分析传参。这里的 I/TP/LRA 只影响它**内部**的动态归一化计算，
# 我们要的是 input_i / input_tp / input_lra 这三个"输入测量值"，与这些目标值无关，
# 所以给一组标准值即可（EBU R128 广播常用 I=-23；这里用 -18 更接近流媒体口径）。
_ANALYSIS_TARGET = "I=-18:TP=-1.0:LRA=11"

_TIMEOUT_SEC = 900


def find_accompaniment(spotify_id: str) -> Path | None:
    """从曲库里找伴奏文件。优先 stems.no_vocals_path（finalize 写回的绝对路径）。"""
    import library

    conn = library.init_db()
    try:
        track = library.get_track(conn, spotify_id)
        if not track:
            return None
        for row in library.get_stems(conn, track["id"]):
            candidate = (row.get("no_vocals_path") or "").strip()
            if candidate and Path(candidate).is_file():
                return Path(candidate)
        # 兜底：按固定布局找（老数据可能没写回 no_vocals_path）
        fallback = ROOT / "assets" / "output" / "library" / spotify_id / "accompaniment.mp3"
        return fallback if fallback.is_file() else None
    finally:
        conn.close()


def measure(path: Path) -> dict:
    """跑一次 ffmpeg loudnorm 分析，返回测量值。

    loudnorm 的 JSON 打在 **stderr** 上（-loglevel info 的常规输出），
    而且前面还夹着 ffmpeg 自己的横幅/流信息，所以只取**最后一段 {...}**。
    """
    proc = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"loudnorm={_ANALYSIS_TARGET}:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, timeout=_TIMEOUT_SEC, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败（{proc.returncode}）：{(proc.stderr or '').strip()[-300:]}")

    blob = proc.stderr or ""
    # 取最后一对大括号：JSON 是 loudnorm 打印的最后一坨内容
    start = blob.rfind("{")
    end = blob.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError("ffmpeg 没有输出 loudnorm JSON（滤镜可能不可用）")
    data = json.loads(blob[start:end + 1])

    def num(key):
        try:
            return float(data[key])
        except (KeyError, TypeError, ValueError):
            return None

    lufs = num("input_i")
    if lufs is None:
        raise RuntimeError("loudnorm 结果里没有 input_i")
    # 极端值兜底：ffmpeg 偶尔给出 -inf / nan（静音文件）
    if lufs in (float("-inf"), float("inf")) or lufs != lufs:
        raise RuntimeError(f"响度测量值无效：{lufs}")
    return {
        "lufs": round(lufs, 2),
        "truePeakDbfs": round(num("input_tp"), 2) if num("input_tp") is not None else None,
        "lra": round(num("input_lra"), 2) if num("input_lra") is not None else None,
        "thresholdDbfs": round(num("input_thresh"), 2) if num("input_thresh") is not None else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spotify-id", default=None)
    ap.add_argument("--file", default=None)
    ap.add_argument("--force", action="store_true", help="已有测量数据时也重测")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not args.spotify_id and not args.file:
        print(json.dumps({"ok": False, "code": "BAD_INPUT", "error": "需要 --spotify-id 或 --file"}, ensure_ascii=False))
        return 0

    path = None
    if args.file:
        path = Path(args.file)
        if not path.is_file():
            print(json.dumps({"ok": False, "code": "FILE_MISSING", "error": f"文件不存在：{path}"}, ensure_ascii=False))
            return 0
    else:
        try:
            path = find_accompaniment(args.spotify_id)
        except Exception as error:
            print(json.dumps({"ok": False, "code": "DB_ERROR", "error": str(error)[:200]}, ensure_ascii=False))
            return 0
        if not path:
            print(json.dumps({"ok": False, "code": "NO_ACCOMPANIMENT",
                              "spotifyId": args.spotify_id,
                              "error": "曲库里没有可用的伴奏文件"}, ensure_ascii=False))
            return 0

    if not FFMPEG.is_file():
        print(json.dumps({"ok": False, "code": "NO_FFMPEG", "error": f"找不到 ffmpeg：{FFMPEG}"}, ensure_ascii=False))
        return 0

    try:
        values = measure(path)
    except Exception as error:
        print(json.dumps({"ok": False, "code": "MEASURE_FAILED", "spotifyId": args.spotify_id,
                          "error": str(error)[:300]}, ensure_ascii=False))
        return 0

    payload = {
        "ok": True,
        "spotifyId": args.spotify_id,
        "file": str(path),
        "version": LOUDNESS_VERSION,
        **values,
    }

    # 写库：只有给了 spotify_id 才写（--file 单独跑时只当测量器用）
    if args.spotify_id:
        try:
            import library

            conn = library.init_db()
            try:
                wrote = library.update_loudness(conn, args.spotify_id, {
                    "lufs": values["lufs"],
                    "true_peak_dbfs": values["truePeakDbfs"],
                    "lra": values["lra"],
                    "version": LOUDNESS_VERSION,
                    "source": path.name,
                }, force=args.force)
            finally:
                conn.close()
            payload["written"] = bool(wrote)
            if not wrote:
                payload["note"] = "已有测量数据（--force 可重测）"
        except Exception as error:
            # 测量成功了但写库失败：数字还是要吐出去，别浪费一次 ffmpeg
            payload["written"] = False
            payload["dbError"] = str(error)[:200]

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
