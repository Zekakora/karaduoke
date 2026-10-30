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

临时文件的生命周期（见 `step_cleanup`）：
  1. `download` 把音频来源下载/转成 `data/library/<videoId>.wav`（Demucs 的输入）；
  2. `separate` 读它，产出 4 轨 WAV 到 `assets/output/library/<spotifyId>/`；
  3. `finalize` 把 4 轨编成终端用户要的 4 个 MP3，并清掉中间轨；
  4. `cleanup`（**默认在最后自动跑**）确认 4 个 MP3 都合格后，才删掉
     `data/library/<videoId>.wav` 这个音频处理输入，以及下载阶段的中间文件。
     确认不了（MP3 缺失 / 太小 / 读不出来）就**什么都不删**，把情况记进 jobs。
  `--keep-audio` 可以关掉这一步（排查问题时用）。任何清理失败都只记日志，
  不影响已经生成、正在被 KaraokeMixer 播放的 MP3。
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
# 音频处理输入（下载/转码得到的 44.1k WAV）与下载匹配记录都放在这里。
# fetch_audio 的默认输出目录也是它（脚本里叫 UPSTREAM），保持同一份定义语义。
AUDIO_IN_DIR = ROOT / "data" / "library"


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
    # 只下载音频：官方 MV 由 Node 侧的 lib/official-mv.js 单独匹配，不在这里下载
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


# ---------------------------------------------------------------- 临时文件清理（成功收尾）
#
# 涉及的资源有三类，**不要混淆**：
#   1. 音频处理输入 `data/library/<videoId>.wav`：download 产出、separate 消费。
#      成片成功之后就不再需要，可以删（本文件的 step_cleanup）。
#   2. 最终交付的 4 个 MP3（assets/output/library/<spotifyId>/）：**永久保留**，
#      KaraokeMixer 播放的就是它们。任何清理逻辑都不许碰。
#   3. 官方 MV：根本不下载，来自 YouTube IFrame（lib/official-mv.js）。
FINAL_MP3_NAMES = ("accompaniment.mp3", "vocals.mp3", "guide.mp3", "original.mp3")
# 一个 320kbps 的 MP3 每秒约 40KB；1 秒的歌也有 ~40KB。小于 16KB 的几乎必然是空文件/失败产物。
MIN_MP3_BYTES = 16 * 1024


def verify_final_mp3s(out_dir: Path) -> dict:
    """检查 4 个最终 MP3 是否都在、非空、真能读。

    只做**基础**检查（存在 / 大小 / 文件头），不重新解码整首歌 —— 解码 4 个 320k MP3
    要几秒，而这里只是确认"文件是好的才删输入"，不是质检。
    MP3 帧头：ID3v2（"ID3"）或 MPEG 帧同步（0xFF 且第二个字节高 3 位全 1）。

    返回 {"ok": bool, "files": {name: bytes}, "problems": [str]}
    """
    files: dict[str, int] = {}
    problems: list[str] = []
    for name in FINAL_MP3_NAMES:
        path = out_dir / name
        if not path.is_file():
            problems.append(f"{name} 不存在")
            continue
        size = path.stat().st_size
        files[name] = size
        if size < MIN_MP3_BYTES:
            problems.append(f"{name} 太小（{size}B）")
            continue
        try:
            with path.open("rb") as fh:
                head = fh.read(4)
        except OSError as e:
            problems.append(f"{name} 读不出来：{e}")
            continue
        looks_mp3 = head[:3] == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
        if not looks_mp3:
            problems.append(f"{name} 不是 MP3 文件头")
    return {"ok": not problems and len(files) == len(FINAL_MP3_NAMES), "files": files, "problems": problems}


def collect_temp_files(conn, track_id: int, args) -> list[Path]:
    """列出"这一首歌处理过程中会产生、成功后就不再需要的临时文件"。

    严格限定在这些**明确属于当前曲目**的位置上，绝不按通配符扫整个目录：
      * data/library/<sourceVideoId>.wav        —— 音频处理输入（separate 读它）
      * data/library/<sourceVideoId>.match.json —— 下载匹配记录（已写进 DB）
      * data/library/__pipeline_<spotifyId>.match.json —— 下载失败时留下的记录
      —— 注意：**只删自己这一首的 videoId**。两首歌可能共用同一个 audio_path
         （同一段音频被不同曲目引用），所以删之前还要确认没有别的曲目在用它。
      * .tmp/spotdl-out/<spotifyId>.wav 等下载中间产物的**目录**，仅当它为空时删目录本身。
      * assets/output/library/<spotifyId>/video.mp4 —— 旧版本管线留下的本地背景视频；
        视频模式已经改成官方 MV，本地背景 MP4 不再需要（有 4 个 MP3 就能删）。
    """
    upstream = AUDIO_IN_DIR
    stems_dir = STEMS_DIR / args.spotify_id
    out: list[Path] = []

    def safe(resolved: Path, root: Path) -> bool:
        try:
            resolved.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            return False

    # 1) 本曲目的音频输入。以曲目实际记录 + match.json 里选中的 videoId 为准。
    row = library.get_track(conn, args.spotify_id) or {}
    video_ids: list[str] = []
    if row.get("source_video_id"):
        video_ids.append(str(row["source_video_id"]))
    audio_path = row.get("audio_path")
    if audio_path:
        p = Path(audio_path)
        if p.parent.resolve() == upstream.resolve():
            video_ids.append(p.stem)

    candidates = [upstream / f"{vid}.wav" for vid in dict.fromkeys(video_ids) if vid]
    candidates.append(upstream / f"__pipeline_{args.spotify_id}.match.json")

    # 2) 别的曲目是否还在用同一个文件（同一音频被两首歌引用时绝不能删）
    used_by_others: set[Path] = set()
    for other in library.list_tracks(conn, limit=1000):
        if other.get("spotify_id") == args.spotify_id:
            continue
        other_path = other.get("audio_path")
        if other_path:
            used_by_others.add(Path(other_path).resolve())

    for cand in candidates:
        resolved = cand.resolve()
        if not safe(resolved, upstream):
            continue
        if resolved in used_by_others:
            print(f"[i] 跳过 {cand.name}：还有别的曲目在用它")
            continue
        out.append(cand)

    # 3) 旧版本留下的本地背景视频（只在 MP3 确认合格之后才会走到这里）
    legacy_video = stems_dir / "video.mp4"
    if safe(legacy_video.resolve(), STEMS_DIR) and legacy_video.exists():
        out.append(legacy_video)

    return out


def step_cleanup(conn, track_id: int, args) -> dict:
    """成功收尾：确认最终产物合格 → 删除音频处理输入与下载中间文件。

    安全规则（每一条都独立生效，任何一条不满足就不删）：
      A. **先校验，后删除**：4 个最终 MP3 必须都在、非空、文件头正确；
         校验不过就什么都不删 —— 这时唯一的音频输入可能就是重试/恢复的唯一依据。
      B. **只在成功路径调用**：main() 只在 separate/finalize 都成功后才跑这一步。
      C. **只删本曲目的文件**：路径必须落在 data/library/ 或本曲目的输出目录内，
         而且不能是别的曲目也在用的 audio_path。
      D. **异常安全**：每个文件独立 try，失败只记日志，绝不让清理异常影响已生成的 MP3。
    """
    import datetime

    stems_dir = STEMS_DIR / args.spotify_id
    check = verify_final_mp3s(stems_dir)
    if not check["ok"]:
        msg = "最终 MP3 校验未通过，保留所有临时文件：" + "；".join(check["problems"])
        print(f"[!] {msg}")
        library.log_job(conn, track_id, "cleanup", "skipped", msg, None)
        return {"ok": False, "skipped": True, "reason": msg, "problems": check["problems"]}

    targets = collect_temp_files(conn, track_id, args)
    removed: list[dict] = []
    failed: list[dict] = []
    freed = 0
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    manifest = ROOT / "data" / f"cleanup-{args.spotify_id}-{stamp}.json"
    for path in targets:
        # 双保险：只允许删文件（不递归删目录），且必须还在受管目录里
        try:
            if not path.is_file():
                continue
            resolved = path.resolve()
            allowed_roots = [AUDIO_IN_DIR, stems_dir]
            if not any(_is_within(resolved, root) for root in allowed_roots):
                failed.append({"path": str(path), "error": "路径不在受管目录内"})
                continue
            size = path.stat().st_size
            path.unlink()
            removed.append({"path": str(path), "name": path.name, "bytes": size})
            freed += size
            print(f"[=] 已删除临时文件 {path.name}（{size / 1024 / 1024:.1f} MB）")
        except OSError as e:
            # 文件被别的进程占着（例如 Windows 上还有句柄）就跳过，留到下次
            failed.append({"path": str(path), "error": str(e)})
            print(f"[!] 删除临时文件失败（忽略，不影响播放）：{path.name}：{e}")

    # 下载工具留下的空输出目录（只删空目录，里面还有东西就留着）
    spotdl_out = ROOT / ".tmp" / "spotdl-out"
    if spotdl_out.is_dir():
        try:
            leftovers = list(spotdl_out.iterdir())
            if not leftovers:
                spotdl_out.rmdir()
        except OSError:
            pass

    if removed:
        # 清单落盘：删是真删（不进回收站），至少能查到删过什么
        try:
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({
                "spotifyId": args.spotify_id,
                "at": datetime.datetime.now().isoformat(timespec="seconds"),
                "reason": "4 个最终 MP3 已确认合格，清理音频处理输入与中间文件",
                "keptMp3": check["files"],
                "removed": removed,
                "failed": failed,
                "freedBytes": freed,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as e:
            print(f"[!] 清理清单写入失败（忽略）：{e}")

    summary = f"删除 {len(removed)} 个临时文件，释放 {freed / 1024 / 1024:.1f} MB"
    if failed:
        summary += f"；{len(failed)} 个失败（见日志）"
    print(f"[+] 清理完成：{summary}")
    library.log_job(conn, track_id, "cleanup", "ok" if not failed else "partial", summary, None)
    return {
        "ok": True,
        "removed": removed,
        "failed": failed,
        "freedBytes": freed,
        "keptMp3": check["files"],
        "manifest": str(manifest) if removed else None,
    }


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


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
    ap.add_argument("--steps", default="metadata,download,lyrics,separate,finalize,cleanup",
                    help="要跑的步骤。cleanup（成功收尾清理）默认包含，详见 step_cleanup")
    ap.add_argument("--provider", choices=("auto", "spotdl", "ytdlp"), default="auto",
                    help="下载路径：auto=先 spotdl 失败回落 ytdlp（默认）；spotdl；ytdlp")
    ap.add_argument("--keep-audio", action="store_true",
                    help="成片成功后**保留**音频处理的输入（data/library/<videoId>.wav），"
                         "默认会删掉它和下载中间文件；排查问题或需要重跑 separate 时用")
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

    # ---- 成功收尾：清理音频处理输入（临时文件）----
    # 只在"这次真的跑到了 finalize 而且成功"时才清：
    #   * 只跑 --steps download 的调试流程不能清（音频输入是下一步的输入）；
    #   * 任何一步失败都不能清（失败时那个 .wav 往往是唯一能重试的输入）；
    #   * step_cleanup 自己还会再校验一遍 4 个 MP3 是否合格。
    if "cleanup" in steps:
        finalize_ok = bool(result.get("finalize", {}).get("ok"))
        if not finalize_ok:
            print("[i] 没有成功完成 finalize，跳过临时文件清理（保留音频输入以便重试）")
            result["cleanup"] = {"skipped": True, "reason": "finalize 未成功"}
        elif args.keep_audio:
            print("[i] --keep-audio：保留音频处理输入，不清理")
            result["cleanup"] = {"skipped": True, "reason": "--keep-audio"}
        else:
            try:
                result["cleanup"] = step_cleanup(conn, track_id, args)
            except Exception as e:  # noqa: BLE001
                # 清理是收尾动作：它自己炸了不能影响已经生成、正在播放的 MP3
                print(f"[!] 临时文件清理异常（忽略，MP3 不受影响）：{e}")
                library.log_job(conn, track_id, "cleanup", "failed", str(e)[:500], None)
                result["cleanup"] = {"ok": False, "error": str(e)}

    print("\n=== 结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(library.library_summary(conn), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
