# -*- coding: utf-8 -*-
"""从 Spotify 抓取曲目元数据 + 封面图，写入本地曲库。

Spotify 是元数据的**唯一可信源**：歌名、歌手、专辑、时长、封面、发行日、
碟号、音轨号、explicit、热度全部来自官方 API，不从 YouTube 标题去猜。

封面图下载到本地（不长期依赖 CDN），同时保留原始 URL 备查。

用法：
    # 单首（会调 Spotify API 补全元数据）
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_metadata.py --spotify-id 003vvx7Niy0yvhvHt4a68B

    # 曲库里所有缺元数据的曲目
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_metadata.py --all

    # 只补封面（不重新拉元数据）
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_metadata.py --all --covers-only
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

COVER_DIR = ROOT / "assets" / "covers"


def _resolve_node() -> str:
    """找到 node 可执行文件。

    优先用调用方传进来的 NODE_EXE（服务端 spawn 时会设成 process.execPath）。
    原因：打包后服务跑在 dist\\...\\runtime\\node.exe，那个目录不一定在 PATH 里，
    直接写 "node" 会失败（launcher 环境下 metadata 步骤会挂）。
    """
    env_exe = os.environ.get("NODE_EXE", "").strip()
    if env_exe and Path(env_exe).exists():
        return env_exe
    found = shutil.which("node")
    if found:
        return found
    return "node"


NODE = _resolve_node()


def node_json(script: str, timeout: int = 60) -> dict:
    """用 Node 调 Spotify（Python 侧不方便复用 JS 的 token 刷新逻辑）。"""
    proc = subprocess.run(
        [NODE, "-e", script],
        capture_output=True, text=True, timeout=timeout, cwd=str(ROOT),
        encoding="utf-8", errors="replace",
    )
    out = (proc.stdout or "").strip()
    # Node 可能有 warning 输出到 stderr，只取 stdout 的 JSON
    if not out:
        raise RuntimeError(f"Node 无输出: {(proc.stderr or '')[:300]}")
    # 取最后一行合法 JSON
    for line in reversed(out.splitlines()):
        line = line.strip().lstrip("\ufeff")
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError(f"未找到 JSON 输出: {out[:300]}")


def spotify_track(spotify_id: str) -> dict:
    """取单曲完整元数据。"""
    script = f"""
const s = require('./lib/spotify.js');
(async () => {{
  const t = await s.getTrack({json.dumps(spotify_id)});
  console.log(JSON.stringify(t));
}})().catch(e => {{ console.log(JSON.stringify({{error: e.message, status: e.status||0}})); }});
"""
    res = node_json(script)
    if res.get("error"):
        raise RuntimeError(f"Spotify: {res['error']}")
    return res


def download_cover(url: str, dest: Path) -> int:
    """下载封面到本地，返回字节数。已存在且非空则跳过。"""
    if dest.exists() and dest.stat().st_size > 1024:
        return dest.stat().st_size
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    if len(data) < 1024:
        raise RuntimeError(f"封面太小（{len(data)} 字节），可能不是图片")
    dest.write_bytes(data)
    return len(data)


def to_library_meta(t: dict) -> dict:
    """把 Spotify 结果映射成曲库字段。"""
    return {
        "spotify_id": t["id"],
        "title": t["name"],
        "artists": t.get("artists") or [],
        "album": t.get("album"),
        "album_art": t.get("coverUrl"),
        "album_id": t.get("albumId"),
        "release_date": t.get("albumReleaseDate"),
        "track_number": t.get("trackNumber"),
        "disc_number": t.get("discNumber"),
        "explicit": t.get("explicit"),
        "popularity": t.get("popularity"),
        "duration_ms": t.get("durationMs"),
        "uri": t.get("uri"),
    }


def apply_one(conn, spotify_id: str, covers_only: bool = False, force: bool = False) -> dict:
    import library

    existing = library.get_track(conn, spotify_id)

    if covers_only:
        # 只补封面：用库里已有的 album_art URL
        if not existing or not existing.get("album_art"):
            return {"spotifyId": spotify_id, "skipped": "无封面 URL"}
        dest = COVER_DIR / f"{spotify_id}.jpg"
        try:
            n = download_cover(existing["album_art"], dest)
        except Exception as e:  # noqa: BLE001
            return {"spotifyId": spotify_id, "error": str(e)}
        library.upsert_track(conn, {**existing, "album_art_path": str(dest)})
        return {"spotifyId": spotify_id, "cover": str(dest), "bytes": n}

    # 元数据：库里已完整且不强制，就跳过
    if existing and not force:
        need = not existing.get("album_art_path") or not existing.get("release_date")
        if not need:
            return {"spotifyId": spotify_id, "skipped": "元数据已完整"}

    t = spotify_track(spotify_id)
    meta = to_library_meta(t)

    # 封面落盘
    cover_info = None
    if meta.get("album_art"):
        dest = COVER_DIR / f"{spotify_id}.jpg"
        try:
            n = download_cover(meta["album_art"], dest)
            meta["album_art_path"] = str(dest)
            cover_info = {"path": str(dest), "bytes": n}
        except Exception as e:  # noqa: BLE001
            cover_info = {"error": str(e)}

    track_id = library.upsert_track(conn, meta)
    library.log_job(conn, track_id, "metadata", "ok", "spotify", None)

    return {
        "spotifyId": spotify_id,
        "trackId": track_id,
        "title": meta["title"],
        "artists": meta["artists"],
        "album": meta.get("album"),
        "releaseDate": meta.get("release_date"),
        "durationMs": meta.get("duration_ms"),
        "cover": cover_info,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spotify-id", action="append", default=[])
    ap.add_argument("--all", action="store_true", help="处理曲库里所有曲目")
    ap.add_argument("--covers-only", action="store_true")
    ap.add_argument("--force", action="store_true", help="即使已有元数据也重新拉")
    args = ap.parse_args()

    import library

    conn = library.init_db()

    ids = list(args.spotify_id)
    if args.all:
        ids += [r["spotify_id"] for r in conn.execute("SELECT spotify_id FROM tracks").fetchall()]
    if not ids:
        print("[x] 需要 --spotify-id 或 --all")
        return 1

    results = []
    for i, sid in enumerate(dict.fromkeys(ids), 1):
        try:
            r = apply_one(conn, sid, args.covers_only, args.force)
        except Exception as e:  # noqa: BLE001
            r = {"spotifyId": sid, "error": str(e)}
        results.append(r)
        tag = "=" if r.get("skipped") else ("x" if r.get("error") else "+")
        print(f"[{tag}] ({i}/{len(ids)}) {sid} {json.dumps(r, ensure_ascii=False)}")

    ok = sum(1 for r in results if not r.get("error") and not r.get("skipped"))
    skipped = sum(1 for r in results if r.get("skipped"))
    errors = sum(1 for r in results if r.get("error"))
    print(f"\n完成：{ok} 更新，{skipped} 跳过，{errors} 失败")
    return 0 if errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
