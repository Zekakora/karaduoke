# -*- coding: utf-8 -*-
"""端到端流水线：Spotify 元数据 → 下载音频 → 歌词 → Demucs 分离 → 入库。

用法:
    # 单曲
    python\\.venv-xpu\\Scripts\\python.exe scripts\\pipeline.py --title "Bohemian Rhapsody" --artist "Queen" --duration 359 --spotify-id 2JiDi0qAXsPwhPqA2qaKGt
    # 只跑到下载
    python\\.venv-xpu\\Scripts\\python.exe scripts\\pipeline.py ... --steps download,lyrics

设计原则：
- 每一步都是**幂等**的：已下载就跳过，已分离就跳过，已抓歌词就跳过；
- 每步结果写 SQLite（`tracks/stems/lyrics/jobs`），失败记 `failed` 与原因；
- 不猜：匹配分低于阈值就失败，不下载错误的音频；
- 一首歌内 `download` 和 `lyrics` 默认并行（互不依赖）；`separate` / `finalize`
  这类重资源步骤用 scripts/gpu_lock.py 的跨进程文件锁串行，允许后台同时跑多首歌。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))
os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))

import library  # noqa: E402
import fetch_audio  # noqa: E402
import fetch_lyrics  # noqa: E402
import gpu_lock  # noqa: E402

STEMS_DIR = ROOT / "assets" / "output" / "library"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def step_resolve(conn, track_id: int, args) -> dict:
    """下载音频并转 44.1k WAV。

    `--provider`：
      ytdlp   旧逻辑（yt-dlp 搜索 + 自算匹配分）
      spotdl  spotDL 搜索/打分/下载 + 我们的时长校验
      auto    先 spotdl，失败再回落 ytdlp

    两条路径都用 Spotify 的 duration_ms 做 ±5s 校验，产物统一 44.1k/16bit/stereo WAV。
    """
    row = library.get_track(conn, args.spotify_id)
    out_dir = ROOT / "data" / "library"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 已经下过就跳过
    if row and row.get("audio_path") and Path(row["audio_path"]).exists():
        print(f"[=] 已下载，跳过：{row['audio_path']}")
        return {"path": row["audio_path"], "skipped": True}

    t0 = time.perf_counter()
    match_path = out_dir / f"__pipeline_{args.spotify_id}.match.json"
    if match_path.exists():
        match_path.unlink()
    argv = [
        "--title", args.title,
        "--artist", args.artist[0] if args.artist else "",
        "--duration", str(args.duration or 0),
        "--spotify-id", args.spotify_id,
        "--provider", getattr(args, "provider", "auto"),
        "--out-dir", str(out_dir),
        "--match-out", str(match_path),
    ]
    for a in args.artist[1:]:
        argv += ["--artist", a]
    # 视频保留：只透传给 fetch_audio，本函数不碰任何匹配/算法逻辑
    if getattr(args, "keep_video", False):
        argv += ["--keep-video"]
    rc = _run_fetch(argv)
    ms = int((time.perf_counter() - t0) * 1000)
    if rc != 0:
        library.mark_failed(conn, track_id, f"下载失败 rc={rc}")
        library.log_job(conn, track_id, "download", "failed", f"rc={rc}", ms)
        return {"error": f"rc={rc}"}

    # 只读本次运行写出的那份 match.json（不再"取目录里最新的"——
    # 旧写法会误取到上一次下载的记录）
    if not match_path.exists():
        library.mark_failed(conn, track_id, "下载后找不到 match.json")
        library.log_job(conn, track_id, "download", "failed", "no match.json", ms)
        return {"error": "no match.json"}
    meta = json.loads(match_path.read_text(encoding="utf-8"))
    match_path.unlink(missing_ok=True)
    path = Path(meta["path"])
    digest = sha256_file(path)

    # 内容级去重：已有同内容就不重复入库
    dup = library.get_track_by_sha(conn, digest)
    if dup and dup["spotify_id"] != args.spotify_id:
        print(f"[!] 内容重复：{dup['spotify_id']} 已有相同音频")

    chosen = meta.get("chosen") or {}
    provider = meta.get("used_provider") or getattr(args, "provider", "ytdlp")
    dc = meta.get("duration_check") or {}
    reasons = chosen.get("reasons") or []
    reason = "; ".join(reasons)
    if dc:
        reason += f" | 时长校验 {dc.get('reason')}"
    if meta.get("fallback"):
        reason += f" | spotdl 失败回落：{meta.get('fallback_reason')}"

    library.update_source(
        conn, track_id,
        source=provider,
        video_id=chosen.get("id"),
        url=chosen.get("url"),
        title=chosen.get("title"),
        score=chosen.get("score"),
        reason=reason,
    )
    library.update_audio(conn, track_id, path=str(path), bytes_=path.stat().st_size, sha256=digest)
    library.log_job(conn, track_id, "download", "ok",
                    f"{provider}: {chosen.get('title')} ({dc.get('reason', '未校验')})", ms)
    print(f"[+] 下载完成 {path.name} ({path.stat().st_size / 1024 / 1024:.1f} MB) "
          f"provider={provider} score={chosen.get('score')}")
    return {"path": str(path), "provider": provider, "videoId": chosen.get("id"),
            "score": chosen.get("score"), "duration": dc, "timings": meta.get("timings"),
            "fallback": bool(meta.get("fallback"))}


def _run_fetch(argv: list[str]) -> int:
    """以函数调用方式跑 fetch_audio（不 spawn 子进程）。"""
    old = sys.argv
    try:
        sys.argv = ["fetch_audio.py", *argv]
        return fetch_audio.main()
    finally:
        sys.argv = old


def step_lyrics(conn, track_id: int, args, quiet: bool = False) -> dict:
    def say(text: str) -> None:
        if not quiet:
            print(text)

    existing = library.get_lyrics(conn, track_id)
    if existing:
        say(f"[=] 已有歌词（{existing['provider']}，synced={existing['synced']}），跳过")
        return {"skipped": True}
    row = library.get_track(conn, args.spotify_id)
    dur_s = (row.get("duration_ms") or 0) / 1000 if row else None
    t0 = time.perf_counter()
    res = fetch_lyrics.fetch_lyrics(args.title, args.artist[0] if args.artist else "", dur_s)
    ms = int((time.perf_counter() - t0) * 1000)
    if not res:
        library.log_job(conn, track_id, "lyrics", "failed", "lrclib 无结果", ms)
        say("[!] 歌词：没有找到")
        return {"found": False}
    library.add_lyrics(conn, track_id, res)
    library.log_job(conn, track_id, "lyrics", "ok", f"{res['provider']} synced={res['synced']}", ms)
    say(f"[+] 歌词：{res['provider']} synced={res['synced']} ({len(res['content'])} 字符)")
    # 同时落一份本地文件，供前端直接读取
    out = ROOT / "assets" / "lyrics" / f"{args.spotify_id}.lrc"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(res["content"], encoding="utf-8")
    return {"provider": res["provider"], "synced": res["synced"], "file": str(out)}


def _separate_wait_log(elapsed: float) -> None:
    print(f"[i] 等待 GPU 分离锁 {int(elapsed)}s…（另一首歌正在分离）", flush=True)


def step_separate(conn, track_id: int, args) -> dict:
    row = library.get_track(conn, args.spotify_id)
    audio = row.get("audio_path") if row else None
    if not audio or not Path(audio).exists():
        print("[x] 没有音频，无法分离")
        return {"error": "no audio"}
    existing = [s for s in library.get_stems(conn, track_id) if s["model"] == args.model]
    if existing and not getattr(args, "force_separate", False):
        print(f"[=] 已有 {args.model} 分离结果，跳过（RTF={existing[0]['rtf']}）")
        return {"skipped": True, "rtf": existing[0]["rtf"]}

    out_dir = STEMS_DIR / args.spotify_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # 跨进程串行：同一时刻只让一个进程占 GPU。等待时不要把 torch/demucs
    # 先 import 进来（模型加载本身也吃内存），拿到锁之后再做。
    with gpu_lock.acquire("demucs", on_wait=_separate_wait_log) as waited:
        if waited and waited >= 0.5:
            print(f"[i] GPU 分离锁等待 {waited:.1f}s 后获得", flush=True)
        import torch
        from demucs.api import Separator, save_audio

        device = os.environ.get("DEMUCS_DEVICE") or ("xpu" if torch.xpu.is_available() else "cpu")
        t0 = time.perf_counter()
        sep = Separator(model=args.model, device=device, segment=args.segment or 7.8, progress=False)
        init_ms = int((time.perf_counter() - t0) * 1000)
        t1 = time.perf_counter()
        origin, separated = sep.separate_audio_file(str(audio))
        proc = time.perf_counter() - t1
        sr = sep.samplerate
        paths = {}
        for stem, src in separated.items():
            p = out_dir / f"{stem}.wav"
            save_audio(src, str(p), samplerate=sr)
            paths[stem] = str(p)
    input_s = origin.shape[-1] / sr
    rtf = proc / input_s
    library.add_stem(conn, track_id, {
        "model": args.model, "device": device, "segment": args.segment or 7.8,
        "out_dir": str(out_dir), "vocals_path": paths.get("vocals"),
        "no_vocals_path": paths.get("no_vocals"), "drums_path": paths.get("drums"),
        "bass_path": paths.get("bass"), "other_path": paths.get("other"),
        "input_duration_s": round(input_s, 3), "processing_s": round(proc, 3), "rtf": round(rtf, 4),
    })
    library.set_status(conn, track_id, "separated")
    library.log_job(conn, track_id, "separate", "ok", f"{device} rtf={rtf:.4f}", int(proc * 1000))
    print(f"[+] 分离完成 device={device} init={init_ms}ms rtf={rtf:.4f}")
    return {"device": device, "rtf": round(rtf, 4), "files": paths}


def step_metadata_pre(conn, args) -> dict:
    """在**建库之前**从 Spotify 拉元数据，并用它校正 args。

    Spotify 是元数据唯一可信源：歌名/歌手/专辑/时长/封面全部取自官方 API。
    CLI 只需要 --spotify-id，其余都不用传（传了也会被 Spotify 覆盖）。
    """
    import fetch_metadata

    try:
        t = fetch_metadata.spotify_track(args.spotify_id)
    except Exception as e:  # noqa: BLE001
        print(f"[!] Spotify 元数据失败：{e}")
        print("[!] 如果 --title 是占位值，后续匹配会不准")
        return {"error": str(e)}

    meta = fetch_metadata.to_library_meta(t)
    # 封面落盘
    cover = None
    if meta.get("album_art"):
        dest = fetch_metadata.COVER_DIR / f"{args.spotify_id}.jpg"
        try:
            n = fetch_metadata.download_cover(meta["album_art"], dest)
            meta["album_art_path"] = str(dest)
            cover = {"path": str(dest), "bytes": n}
        except Exception as e:  # noqa: BLE001
            cover = {"error": str(e)}

    library.upsert_track(conn, meta)
    # 校正后续步骤入参
    args.title = meta["title"]
    args.artist = list(meta.get("artists") or [])
    args.album = meta.get("album")
    args.duration = (meta.get("duration_ms") or 0) / 1000 or None
    args.album_art = meta.get("album_art")
    print(f"[+] 元数据：{meta['title']} / {', '.join(args.artist)} / {meta.get('release_date')} / "
          f"{args.duration:.1f}s")
    if cover and cover.get("path"):
        print(f"[+] 封面：{cover['bytes'] / 1024:.0f} KB")
    return {"spotifyId": args.spotify_id, "title": meta["title"], "artists": args.artist,
            "album": meta.get("album"), "releaseDate": meta.get("release_date"),
            "durationMs": meta.get("duration_ms"), "cover": cover}


def step_finalize(conn, track_id: int, args) -> dict:
    """把 4 轨分离结果整理成最终的 4 个 MP3，并清理中间产物。

    产物（每首歌只有这 4 个）：
      accompaniment.mp3  纯伴奏
      vocals.mp3         纯人声
      guide.mp3          伴奏 + 人声 -12dB
      original.mp3       原曲
    """
    import finalize_track

    argv = ["--spotify-id", args.spotify_id, "--model", args.model, "--bitrate", args.bitrate]
    if args.keep_intermediate:
        argv.append("--keep-intermediate")
    old = sys.argv
    try:
        sys.argv = ["finalize_track.py", *argv]
        rc = finalize_track.main()
    finally:
        sys.argv = old
    if rc != 0:
        library.log_job(conn, track_id, "finalize", "failed", f"rc={rc}", None)
        return {"error": f"rc={rc}"}
    return {"ok": True, "files": [f"{n}.mp3" for n in ("accompaniment", "vocals", "guide", "original")]}


def run_download_lyrics(conn, track_id: int, args, steps: list[str]) -> dict:
    """同一首歌内跑下载 + 歌词：两者都要跑时**并行**，只跑一个时串行。

    并行时两个线程各开自己的 SQLite 连接（sqlite3 连接不能跨线程共享；
    WAL + busy_timeout 保证两个写操作排队而不是 "database is locked"）。
    歌词步骤用 quiet：等下载也结束后再打一行汇总，避免 Node 侧进度条
    在下载还没完成时就跳到「匹配歌词」。
    """
    out: dict = {}
    if "download" in steps and "lyrics" in steps and not getattr(args, "no_parallel_steps", False):
        from concurrent.futures import ThreadPoolExecutor

        print("[i] 并行：下载音频 + 匹配歌词", flush=True)

        def _download_step():
            c = library.connect()
            try:
                return step_resolve(c, track_id, args)
            finally:
                c.close()

        def _lyrics_step():
            c = library.connect()
            try:
                return step_lyrics(c, track_id, args, quiet=True)
            finally:
                c.close()

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="pipeline") as pool:
            f_download = pool.submit(_download_step)
            f_lyrics = pool.submit(_lyrics_step)
            out["download"] = f_download.result()
            out["lyrics"] = f_lyrics.result()

        lyrics = out["lyrics"]
        if lyrics.get("skipped"):
            print("[=] 歌词：已有，跳过", flush=True)
        elif lyrics.get("found") is False or lyrics.get("error"):
            print("[!] 歌词：没有找到", flush=True)
        else:
            print(f"[+] 歌词：{lyrics.get('provider')} synced={lyrics.get('synced')}", flush=True)
        return out

    if "download" in steps:
        out["download"] = step_resolve(conn, track_id, args)
    if "lyrics" in steps:
        out["lyrics"] = step_lyrics(conn, track_id, args)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spotify-id", required=True)
    # title 只有在不跑 metadata 步骤时才必须（那时没有可信源可用）
    ap.add_argument("--title", default=None, help="歌名；走 metadata 步骤时可省略（由 Spotify 提供）")
    ap.add_argument("--artist", action="append", default=[])
    ap.add_argument("--album", default=None)
    ap.add_argument("--duration", type=float, default=None, help="秒")
    ap.add_argument("--album-art", default=None)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--segment", type=float, default=7.8)
    ap.add_argument("--bitrate", default="320k")
    ap.add_argument("--keep-intermediate", action="store_true")
    ap.add_argument("--force-metadata", action="store_true", help="已完整也重新拉 Spotify 元数据")
    ap.add_argument("--force-separate", action="store_true",
                    help="已有分离结果也重跑（混音算法变更后需要重建 4 轨）")
    ap.add_argument("--steps", default="metadata,download,lyrics,separate,finalize")
    ap.add_argument("--provider", choices=("auto", "spotdl", "ytdlp"), default="auto",
                    help="下载路径：auto=先 spotdl 失败回落 ytdlp（默认）；spotdl；ytdlp")
    ap.add_argument("--keep-video", action="store_true",
                    help="下载时额外保留 720p MP4（无音轨）到 "
                         "assets/output/library/<spotifyId>/video.mp4")
    ap.add_argument("--no-parallel-steps", action="store_true",
                    help="下载和歌词串行跑（默认并行；排查问题时用）")
    args = ap.parse_args()

    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    conn = library.init_db()

    # 先取 Spotify 元数据，再建记录 —— 顺序很重要。
    # 若先用 CLI 传的占位标题建库，metadata 步骤会因"已完整"而跳过，
    # 占位值就永久留在库里（曾发生：title 变成 "placeholder"）。 
    result = {}
    if "metadata" in steps:
        result["metadata"] = step_metadata_pre(conn, args)

    # 曲库已有这首歌，就用库里的元数据补齐 args —— 重跑 separate/finalize
    # 时不需要再传 --title，也不需要联网拉 Spotify。
    existing = library.get_track(conn, args.spotify_id)
    if existing:
        args.title = args.title or existing.get("title")
        if not args.artist:
            args.artist = list(existing.get("artists") or [])
        args.album = args.album or existing.get("album")
        args.album_art = args.album_art or existing.get("album_art")
        if not args.duration and existing.get("duration_ms"):
            args.duration = existing["duration_ms"] / 1000

    if not args.title:
        # 没跑 metadata、库里也没有、又没手填 —— 无法继续
        print("[x] 缺少歌名。要么把 metadata 加进 --steps，要么手动传 --title。")
        return 1

    track_id = library.upsert_track(conn, {
        "spotify_id": args.spotify_id, "title": args.title, "artists": args.artist,
        "album": args.album, "album_art": args.album_art,
        "duration_ms": int(args.duration * 1000) if args.duration else None,
        "uri": f"spotify:track:{args.spotify_id}",
    })
    print(f"[i] track_id={track_id} steps={steps}")

    if "download" in steps or "lyrics" in steps:
        result.update(run_download_lyrics(conn, track_id, args, steps))
    if "separate" in steps:
        result["separate"] = step_separate(conn, track_id, args)
    if "finalize" in steps:
        result["finalize"] = step_finalize(conn, track_id, args)

    print("\n=== 结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(library.library_summary(conn), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
