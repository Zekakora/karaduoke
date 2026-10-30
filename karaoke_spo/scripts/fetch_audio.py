# -*- coding: utf-8 -*-
"""从 YouTube 取音频并转成 Demucs 需要的 44.1kHz / 16-bit / stereo WAV。

**这里只管音频。** 视频画面（官方 MV）由 Node 侧的 lib/official-mv.js 单独匹配，
经 YouTube IFrame 静音在线播放，**不下载、不落盘**。早先的 `--keep-video`
（额外下载 720p/1080p 背景视频到 assets/output/library/<id>/video.mp4）已经移除。

支持两条下载路径（`--provider`）：

  ytdlp    现有实现：yt-dlp `ytsearch N:` 搜索 + 自算匹配分（标题 55 / 歌手 15 /
           时长 30-18-5-(-20) / 负向词 -25），低于 `--min-score` 就拒绝下载。
  spotdl   spotDL（spotDL 4.6.0）的搜索与下载器：YouTube Music 搜索 + spotDL
           自己的匹配打分（order_results）。**不重复造搜索轮子**。
  auto     先 spotdl，失败（搜索无结果 / 时长校验不过 / 下载失败）再回落 ytdlp。

两条路径的共同约束：
  1. **时长校验**：Spotify 的 `duration_ms` 是权威值，下载结果的实际时长与它相差
     超过 `--dur-tolerance` 秒（默认 5s）就判失败、删文件、不写 match.json。
     注意 spotDL 自己**不做**这个校验（它会同时接受 165s 的 Live Aid 版和 355s 的
     录音室版），所以这一关必须由我们兜住。
  2. **统一产物**：44.1kHz / 16bit / stereo WAV。spotDL 虽然支持 `--format wav`，
     但它只给 ffmpeg 传 `-codec:a pcm_s16le`，采样率/声道跟随源，所以下载后统一
     用 ffmpeg 重采样落盘。
  3. **文件名**：`<videoId>.wav`（YouTube 视频 ID）；spotDL 也能拿到 videoId，所以
     两条路径命名一致。拿不到时退回 `<spotifyId>.wav` 并在 match.json 里记明。

match.json 记录：provider、来源（videoId/url/title/歌手）、时长校验结果、匹配分。
这里的 videoId 是**音频来源**，写进曲库的 `source_video_id`；官方 MV（画面）是另一个
独立字段 `visual_video_id`，由 Node 侧 resolver 维护，两者互不覆盖。

临时文件：下载/转码的中间文件都在 `.tmp/`（spotDL 输出目录、yt-dlp 缓存），本脚本
结束时清理自己用过的中间文件。`data/library/<videoId>.wav` 是**音频处理输入**，
由 pipeline 在成片成功后统一清理（见 scripts/pipeline.py 的 cleanup 步骤）。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_audio.py --title "Bohemian Rhapsody" `
        --artist "Queen" --duration 355 --provider auto
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / "data" / "library"
TMP_DIR = ROOT / ".tmp"
os.environ.setdefault("TMP", str(TMP_DIR))
os.environ.setdefault("TEMP", str(TMP_DIR))

NOISE = re.compile(
    r"\b(official|video|audio|lyrics?|lyric|remaster(ed)?|hd|hq|mv|m/v|visualizer|"
    r"explicit|clean|full|album|single|version|edit)\b",
    re.IGNORECASE,
)
NEGATIVE = [
    "live", "cover", "karaoke", "instrumental", "remix", "slowed", "reverb",
    "nightcore", "8d", "bass boosted", "acoustic", "reaction", "tutorial",
    "伴奏", "翻唱", "现场",
]

PROVIDERS = ("auto", "spotdl", "ytdlp")


# ---------------------------------------------------------------- 打分 / 工具


def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", s)          # 去括号内容
    s = NOISE.sub(" ", s)
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", s)      # 只留字母数字与中文
    return re.sub(r"\s+", " ", s).strip()


def score_candidate(title: str, dur_s, want_title: str, want_artists: list[str], want_dur_s: float) -> tuple[float, list[str]]:
    reasons: list[str] = []
    nt = norm(title)
    nt_title = norm(want_title)
    score = SequenceMatcher(None, nt_title, nt).ratio() * 55
    reasons.append(f"标题相似 {score:.0f}/55")

    # 歌手出现在标题里
    artist_hit = any(norm(a) in nt for a in want_artists if a)
    if artist_hit:
        score += 15
        reasons.append("标题含歌手 +15")
    else:
        reasons.append("标题不含歌手 +0")

    # 时长匹配
    if dur_s and want_dur_s:
        diff = abs(float(dur_s) - want_dur_s)
        if diff <= 5:
            score += 30
            reasons.append(f"时长差 {diff:.0f}s +30")
        elif diff <= 15:
            score += 18
            reasons.append(f"时长差 {diff:.0f}s +18")
        elif diff <= 40:
            score += 5
            reasons.append(f"时长差 {diff:.0f}s +5")
        else:
            score -= 20
            reasons.append(f"时长差 {diff:.0f}s -20")
    else:
        reasons.append("无时长信息 +0")

    low = title.lower()
    hits = [w for w in NEGATIVE if w in low]
    if hits:
        score -= 25
        reasons.append(f"负向词 {hits} -25")

    return max(0.0, min(100.0, score)), reasons


def ffmpeg_location() -> str | None:
    """定位 ffmpeg/ffprobe 所在目录。

    优先级：env/bin/（控制面板管理的默认位置）→ data/bin/（旧布局）→ PATH。
    说明：不依赖 imageio-ffmpeg，因为它的包只带 ffmpeg、不带 ffprobe，
    而 yt-dlp 提取音频时两者都会调用。
    """
    candidates = [
        Path(os.environ.get("KARAOKE_BIN_DIR") or (Path(os.environ.get("KARAOKE_ENV_DIR") or (ROOT / "env")) / "bin")),
        ROOT / "data" / "bin",
    ]
    for bin_dir in candidates:
        if (bin_dir / "ffmpeg.exe").exists() and (bin_dir / "ffprobe.exe").exists():
            return str(bin_dir)
    import shutil

    ff = shutil.which("ffmpeg")
    return str(Path(ff).parent) if ff else None


def probe_duration_s(path: Path) -> float | None:
    """用 ffprobe 读实际时长（秒）。读不到返回 None。"""
    bin_dir = ffmpeg_location()
    if not bin_dir:
        return None
    ffprobe = Path(bin_dir) / "ffprobe.exe"
    if not ffprobe.exists():
        ffprobe = Path(bin_dir) / "ffprobe"   # 非 Windows 兜底
    try:
        proc = subprocess.run(
            [str(ffprobe), "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace",
        )
        val = (proc.stdout or "").strip().splitlines()
        return float(val[0]) if val and val[0] else None
    except Exception:  # noqa: BLE001
        return None


def check_duration(path: Path, want_s: float | None, tolerance: float) -> dict:
    """时长校验：Spotify 时长是权威值，|实际-期望| <= tolerance 才算通过。"""
    actual = probe_duration_s(path)
    res = {
        "spotify_duration_s": round(want_s, 3) if want_s else None,
        "actual_duration_s": round(actual, 3) if actual else None,
        "tolerance_s": tolerance,
        "ok": False,
        "diff_s": None,
    }
    if want_s is None or actual is None:
        res["reason"] = "缺少期望时长或读不到实际时长（无法校验 → 判失败）"
        return res
    diff = abs(actual - want_s)
    res["diff_s"] = round(diff, 3)
    res["ok"] = diff <= tolerance
    res["reason"] = f"时长差 {diff:.2f}s {'<=' if res['ok'] else '>'} {tolerance}s"
    return res


def to_demucs_wav(src: Path, dest: Path) -> None:
    """统一成 44.1kHz / 16bit / stereo WAV。"""
    bin_dir = ffmpeg_location()
    if not bin_dir:
        raise RuntimeError("找不到 ffmpeg，无法转 44.1k WAV")
    ffmpeg = Path(bin_dir) / "ffmpeg.exe"
    if not ffmpeg.exists():
        ffmpeg = Path(bin_dir) / "ffmpeg"
    proc = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
         "-vn", "-ac", "2", "-ar", "44100", "-sample_fmt", "s16", str(dest)],
        capture_output=True, text=True, timeout=600, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0 or not dest.exists():
        raise RuntimeError(f"ffmpeg 转码失败：{(proc.stderr or '')[-400:]}")


def load_dotenv() -> dict:
    """读 Spotify 凭证：**进程环境优先**，项目 .env 兜底。

    启动器会把控制面板里配置的 client_id/secret 注入子进程环境（.env 里是空的），
    早先这里只看 .env，导致明明有官方凭证却一直走 spotDL 的匿名客户端：
    `Song.from_url()` 从 3s 变成 40s+。现在先读 os.environ，再让 .env 补缺。
    """
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for key in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"):
        value = (os.environ.get(key) or "").strip()
        if value:
            env[key] = value
    return env


def write_match(out_dir: Path, stem: str, meta: dict, explicit: str | None = None) -> Path:
    path = Path(explicit) if explicit else out_dir / f"{stem}.match.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[i] 匹配记录 => {path}")
    return path


# ---------------------------------------------------------------- yt-dlp 路径


def search(ydl_opts_base: dict, query: str, limit: int = 8) -> list[dict]:
    import yt_dlp

    opts = dict(ydl_opts_base)
    opts.update({"extract_flat": True, "quiet": True, "no_warnings": True})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    return [
        {"id": e.get("id"), "title": e.get("title"), "duration": e.get("duration"), "url": e.get("url") or f"https://www.youtube.com/watch?v={e.get('id')}"}
        for e in (info.get("entries") or [])
        if e.get("id")
    ]


def download(ydl_opts_base: dict, video_id: str, out_path: Path) -> Path:
    """下载最佳音轨并转成 44.1k 16bit stereo WAV。"""
    import yt_dlp

    opts = dict(ydl_opts_base)
    opts.update({
        "format": "bestaudio/best",
        "outtmpl": str(out_path.with_suffix(".%(ext)s")),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
            "preferredquality": "0",
        }],
        "postprocessor_args": {
            "extractaudio": ["-ac", "2", "-ar", "44100", "-sample_fmt", "s16"],
        },
        "quiet": False,
        "no_warnings": True,
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
    if not out_path.exists():
        candidates = list(out_path.parent.glob(out_path.stem + ".*"))
        raise RuntimeError(f"下载后未找到 WAV：{candidates}")
    return out_path


def run_ytdlp(args, out_dir: Path, want_dur: float | None) -> dict:
    """返回 {ok, reason, chosen, candidates, path, timings, duration_check}。"""
    ff = ffmpeg_location()
    base = {
        "noplaylist": True,
        "js_runtimes": {"node": {}},
        "postprocessors": [],
        "cachedir": str(ROOT / ".cache" / "yt-dlp"),
    }
    if ff:
        base["ffmpeg_location"] = ff
        print(f"[i] ffmpeg 位置: {ff}")
    else:
        print("[!] 未找到 ffmpeg/ffprobe，下载后无法转 WAV（搜索与打分仍可用）")

    query = f"{' '.join(args.artist)} {args.title}".strip()
    print(f"[i] (>ytdlp) 搜索: {query}")
    t_search = time.perf_counter()
    cands = search(base, query, limit=8)
    search_s = time.perf_counter() - t_search
    if not cands:
        return {"ok": False, "reason": "yt-dlp 没有搜索结果", "timings": {"search_s": round(search_s, 2)}}

    scored = []
    for c in cands:
        s, reasons = score_candidate(c["title"], c.get("duration"), args.title, args.artist, want_dur or 0)
        scored.append({**c, "score": round(s, 1), "reasons": reasons})
    scored.sort(key=lambda x: x["score"], reverse=True)

    print(f"{'score':>6} {'dur':>5}  id            title")
    for c in scored:
        print(f"{c['score']:>6} {str(c.get('duration')):>5}  {c['id']:<12} {c['title'][:70]}")
        print(f"       └─ {'; '.join(c['reasons'])}")

    best = scored[0]
    print(f"\n[i] 最佳候选: {best['id']} score={best['score']} ({best['title']})")
    base_res = {"candidates": scored, "chosen": best, "timings": {"search_s": round(search_s, 2)}}
    if best["score"] < args.min_score:
        print(f"[x] 最高分 {best['score']} 低于阈值 {args.min_score}，拒绝下载（不猜）")
        return {**base_res, "ok": False, "reason": f"匹配分 {best['score']} < 阈值 {args.min_score}"}
    if args.dry_run:
        return {**base_res, "ok": True, "dry_run": True, "path": None}

    out_path = out_dir / f"{best['id']}.wav"
    if out_path.exists():
        print(f"[i] 已存在，跳过下载: {out_path}")
        dl_s = 0.0
    else:
        t_dl = time.perf_counter()
        download(base, best["id"], out_path)
        dl_s = time.perf_counter() - t_dl
        print(f"[+] 下载完成 {out_path} ({out_path.stat().st_size / 1024 / 1024:.1f} MB, {dl_s:.1f}s)")

    dc = check_duration(out_path, want_dur, args.dur_tolerance)
    base_res["timings"] = {"search_s": round(search_s, 2), "download_s": round(dl_s, 2)}
    base_res["duration_check"] = dc
    if not dc["ok"]:
        print(f"[x] 时长校验失败：{dc['reason']}（丢弃 {out_path.name}）")
        try:
            out_path.unlink()
        except OSError:
            pass
        return {**base_res, "ok": False, "reason": f"时长校验失败：{dc['reason']}", "path": None}
    print(f"[+] 时长校验通过：{dc['reason']}")
    return {**base_res, "ok": True, "path": out_path}


# ---------------------------------------------------------------- spotDL 路径


_spotdl_ready = {"init": False}


def spotdl_init() -> None:
    """初始化 spotDL 的 Spotify 客户端（进程内只做一次）。

    spotDL 的 `Song.from_url()` 需要 `SpotifyClient` 已初始化。凭据来源优先
    进程环境（启动器注入控制面板里的值），其次项目 .env。有官方凭据时约 3-4s；
    凭据缺失时退回 spotDL 自带的 FreeSpotify 匿名客户端（约 40s，且依赖第三方
    服务，仅作兜底）。
    """
    if _spotdl_ready["init"]:
        return
    from spotdl.types.song import Song
    from spotdl.utils.spotify import SpotifyClient

    if SpotifyClient._instance is not None:
        _spotdl_ready["init"] = True
        return

    env = load_dotenv()
    cid, secret = env.get("SPOTIFY_CLIENT_ID"), env.get("SPOTIFY_CLIENT_SECRET")
    try:
        if cid and secret:
            SpotifyClient.init(
                client_id=cid, client_secret=secret, no_cache=True,
                use_official_api=True, cache_path=str(ROOT / ".cache" / "spotdl"),
            )
        else:
            raise RuntimeError("no client id/secret")
    except Exception as e:  # noqa: BLE001
        print(f"[!] spotDL 官方 API 初始化失败（{e}），退回匿名客户端")
        SpotifyClient._instance = None
        SpotifyClient.init(client_id="", client_secret="", no_cache=True,
                           cache_path=str(ROOT / ".cache" / "spotdl"))
    _spotdl_ready["init"] = True


def spotdl_song(spotify_id: str, args):
    """构造 spotDL 的 Song。拿不到 Spotify 元数据时用库里/pipeline 传的值兜底。"""
    spotdl_init()
    from spotdl.types.song import Song

    try:
        return Song.from_url(f"https://open.spotify.com/track/{spotify_id}")
    except Exception as e:  # noqa: BLE001
        print(f"[!] Song.from_url 失败（{e}），用本地元数据构造 Song")
        return Song(
            name=args.title, artists=list(args.artist) or ["unknown"],
            artist=(args.artist or ["unknown"])[0], genres=[], disc_number=1, disc_count=1,
            album_name=getattr(args, "album", None) or "", album_artist=(args.artist or ["unknown"])[0],
            duration=int(args.duration or 0), year=0, date="", track_number=1, tracks_count=1,
            song_id=spotify_id, explicit=False, publisher="", url=f"https://open.spotify.com/track/{spotify_id}",
            isrc=None, cover_url=None, copyright_text=None,
        )


def spotdl_make_downloader(args):
    from spotdl.download.downloader import Downloader

    bin_dir = ffmpeg_location()
    ffmpeg = str(Path(bin_dir) / "ffmpeg.exe") if bin_dir else "ffmpeg"
    workdir = TMP_DIR / "spotdl-out"
    workdir.mkdir(parents=True, exist_ok=True)
    settings = {
        # 输出到临时目录，最后由我们统一转码 + 改名 + 落 data/library
        "output": str(workdir / "{track-id}.{output-ext}"),
        "format": "wav",
        "ffmpeg": ffmpeg,
        "audio_providers": ["youtube-music", "youtube"],
        "lyrics_providers": [],
        "simple_tui": True,
        "log_level": "ERROR",
        "overwrite": "force",
        "threads": 1,
    }
    return Downloader(settings), ffmpeg


def spotdl_collect_results(provider, song) -> tuple[list, list[str]]:
    """用 spotDL 的 YouTube Music provider 收集搜索候选（**不下载**）。

    为什么不用 `provider.search(song)`：spotDL 4.6.0 的 YouTubeMusic.search() 会先拿
    artist ID 去 `get_results(artist_id)`，而 ytmusicapi 1.12.x 的
    `YTMusic.search(artist_id)` 会把 filter 强制成 "profiles"、返回一堆 artist 结果，
    `get_results` 又因为没有 `videoId` 把它们全部丢掉 → 返回 []。
    spotDL 随后退回普通标题搜索，但在标题搜索的 `filter='videos'` 轮次、以及
    "取播放量" 的轮次里会抛 `YTMusicError` 把整个 search() 打断（实测 25s 后失败）。

    所以这里直接调 `get_results()`（两个 filter 都显式给，不触发那个 bug），
    再用 spotDL 自己的 `order_results()` 打分 —— 匹配算法还是 spotDL 的，只是
    绕开了它的调度缺陷。候选列表拿到后由我们逐个做**时长校验**。
    """
    seen: dict[str, object] = {}
    terms = []
    queries = [f"{song.name} {song.artist}".strip()]
    if song.isrc:
        queries.insert(0, song.isrc)
    for query in queries:
        for opts in ({"filter": "songs", "limit": 50}, {"filter": "videos", "limit": 50}):
            try:
                for r in provider.get_results(query, **opts):
                    seen.setdefault(r.result_id, r)
            except Exception as e:  # noqa: BLE001
                print(f"[!] spotDL 搜索 '{query}' {opts.get('filter')} 失败：{e}")
        if len(seen) >= 8:
            break
    return list(seen.values()), queries


def spotdl_candidates(dl, song, want_dur: float | None) -> list[dict]:
    """用 spotDL 的 provider 取候选并用 spotDL 自己的 order_results 打分（不下载）。"""
    from spotdl.utils.matching import order_results

    provider = dl.audio_providers[0]
    results, queries = spotdl_collect_results(provider, song)
    if not results:
        return []
    scored = order_results(results, song, None)
    out = []
    for r, sc in scored.items():
        vid = getattr(r, "result_id", None) or ""
        dur = getattr(r, "duration", None)
        # 同时给出我们的打分，便于人工对照 / 记进 match.json
        our_score, our_reasons = score_candidate(
            getattr(r, "name", "") or "", dur, song.name, song.artists, want_dur or 0
        )
        out.append({
            "id": vid,
            "title": getattr(r, "name", "") or "",
            "duration": dur,
            "url": f"https://www.youtube.com/watch?v={vid}" if vid else None,
            "score": round(float(sc), 1),          # spotDL 的匹配分（0-100）
            "score_source": "spotdl",
            "local_score": round(our_score, 1),    # 我们的打分（仅供参考）
            "reasons": [f"spotDL 匹配分 {sc:.1f}"] + our_reasons,
            "verified": bool(getattr(r, "verified", False)),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


def run_spotdl(args, out_dir: Path, want_dur: float | None, spotify_id: str | None) -> dict:
    if not spotify_id:
        return {"ok": False, "reason": "spotdl 路径需要 --spotify-id"}

    t0 = time.perf_counter()
    try:
        dl, ffmpeg = spotdl_make_downloader(args)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"spotDL Downloader 初始化失败：{e}"}
    init_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    try:
        song = spotdl_song(spotify_id, args)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": f"spotDL 拿 Spotify 元数据失败：{e}"}
    meta_s = time.perf_counter() - t0
    if want_dur is None and song.duration:
        want_dur = float(song.duration)

    # 1) 搜索 + 候选打分
    print(f"[i] (>spotdl) 搜索: {song.name} {song.artist}")
    t0 = time.perf_counter()
    cands = spotdl_candidates(dl, song, want_dur)
    search_s = time.perf_counter() - t0
    timings = {"init_s": round(init_s, 2), "meta_s": round(meta_s, 2), "search_s": round(search_s, 2)}
    if not cands:
        return {"ok": False, "reason": "spotdl（YouTube Music）没有搜索结果", "timings": timings}

    print(f"{'score':>6} {'dur':>5}  id            title")
    for c in cands[:8]:
        print(f"{c['score']:>6} {str(c.get('duration')):>5}  {c['id']:<12} {c['title'][:70]}")

    # 2) 按 spotDL 排名依次尝试，**每个候选都要过时长校验**
    #    spotDL 本身不看时长，这里是我们唯一能挡住 "Live 版 / 翻唱版" 的地方。
    tried = []
    chosen = None
    dl_s = 0.0
    for cand in cands[:args.spotdl_try]:
        vid = cand.get("id")
        if not vid:
            continue
        cand_dur = cand.get("duration")
        if want_dur and cand_dur and abs(float(cand_dur) - want_dur) > args.dur_tolerance:
            # 搜索结果自身时长就对不上，直接跳过（省下一次下载）
            print(f"[!] 跳过 {vid}：候选时长 {cand_dur}s vs Spotify {want_dur:.0f}s 超差")
            tried.append({**cand, "result": "skipped: duration"})
            continue
        if args.dry_run:
            chosen = cand
            break
        src = TMP_DIR / "spotdl-out" / f"{song.song_id}.wav"
        if src.exists():
            src.unlink()
        t1 = time.perf_counter()
        try:
            _, got = dl.search_and_download(song)
        except Exception as e:  # noqa: BLE001
            print(f"[!] spotDL 下载异常（{vid}）：{e}")
            tried.append({**cand, "result": f"error: {e}"})
            continue
        step = time.perf_counter() - t1
        dl_s += step
        if not got or not Path(got).exists():
            print(f"[!] spotDL 没产出文件（{vid}）")
            tried.append({**cand, "result": "no file"})
            continue
        dc = check_duration(Path(got), want_dur, args.dur_tolerance)
        if not dc["ok"]:
            print(f"[x] {vid} 下载结果时长校验失败：{dc['reason']}")
            tried.append({**cand, "result": f"duration: {dc['reason']}", "duration_check": dc})
            continue
        chosen = cand
        chosen["duration_check"] = dc
        chosen["downloaded_file"] = str(got)
        print(f"[+] spotDL 下载完成 {Path(got).name} ({Path(got).stat().st_size / 1024 / 1024:.1f} MB, {step:.1f}s)")
        print(f"[+] 时长校验通过：{dc['reason']}")
        break

    timings["download_s"] = round(dl_s, 2)
    if not chosen:
        return {"ok": False, "reason": "所有 spotDL 候选都没通过（时长校验/下载）",
                "candidates": cands, "tried": tried, "timings": timings}
    if args.dry_run:
        return {"ok": True, "dry_run": True, "chosen": chosen, "candidates": cands,
                "tried": tried, "path": None, "timings": timings}

    # 3) 统一转 44.1k/16bit/stereo WAV，命名 <videoId>.wav
    vid = chosen.get("id") or song.song_id
    out_path = out_dir / f"{vid}.wav"
    out_dir.mkdir(parents=True, exist_ok=True)
    t1 = time.perf_counter()
    to_demucs_wav(Path(chosen["downloaded_file"]), out_path)
    timings["convert_s"] = round(time.perf_counter() - t1, 2)
    dc = check_duration(out_path, want_dur, args.dur_tolerance)
    if not dc["ok"]:
        print(f"[x] 转码后时长校验失败：{dc['reason']}")
        try:
            out_path.unlink()
        except OSError:
            pass
        return {"ok": False, "reason": f"转码后时长校验失败：{dc['reason']}",
                "candidates": cands, "tried": tried, "timings": timings}
    chosen["duration_check"] = dc
    return {"ok": True, "chosen": chosen, "candidates": cands, "tried": tried,
            "path": out_path, "timings": timings, "ffmpeg": ffmpeg}


# ---------------------------------------------------------------- 背景视频（已移除）
#
# 这里曾经是 --keep-video：用 yt-dlp 额外下载 1080p/720p 背景 MP4（剥掉音轨）到
# assets/output/library/<spotifyId>/video.mp4，供视频模式本地播放。
# 现在视频模式改成 YouTube 官方 MV（IFrame 静音在线播放，见 lib/official-mv.js），
# 本地背景 MP4 不再生成、不再保存、不再播放，所以整段下载/转码逻辑删掉了。
# 注意：**音频来源**的下载（yt-dlp/spotDL 取音频 → 44.1k WAV）与它无关，完整保留。

# ---------------------------------------------------------------- main


def build_match(provider: str, result: dict, args, spotify_id: str | None) -> dict:
    chosen = result.get("chosen") or {}
    return {
        "spotify_id": spotify_id,
        "provider": provider,
        "used_provider": result.get("used_provider", provider),
        "fallback": result.get("fallback") or None,
        "fallback_reason": result.get("fallback_reason"),
        "chosen": chosen,
        "candidates": result.get("candidates") or [],
        "tried": result.get("tried") or [],
        "duration_check": result.get("duration_check") or chosen.get("duration_check"),
        "timings": result.get("timings") or {},
        "path": str(result["path"]) if result.get("path") else None,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "query": {"title": args.title, "artists": args.artist,
                  "spotify_duration_s": round(args.duration, 3) if args.duration else None},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", action="append", default=[])
    ap.add_argument("--duration", type=float, default=None, help="Spotify 时长（秒）")
    ap.add_argument("--spotify-id", default=None, help="Spotify track id（spotdl 路径必需）")
    ap.add_argument("--out-dir", default=str(UPSTREAM))
    ap.add_argument("--min-score", type=float, default=45.0)
    ap.add_argument("--provider", choices=PROVIDERS, default="auto",
                    help="auto=先 spotdl 后 ytdlp；spotdl；ytdlp（旧逻辑）")
    ap.add_argument("--dur-tolerance", type=float, default=5.0,
                    help="下载结果与 Spotify 时长的最大允许偏差（秒），默认 5")
    ap.add_argument("--spotdl-try", type=int, default=3,
                    help="spotdl 路径最多尝试几个候选（每个都要过时长校验）")
    ap.add_argument("--dry-run", action="store_true", help="只搜索与打分，不下载")
    ap.add_argument("--match-out", default=None,
                    help="把 match.json 写到指定路径（pipeline 用，避免和旧记录抢目录）")
    args = ap.parse_args()

    if args.provider in ("spotdl", "auto") and not args.spotify_id:
        print("[!] 没有 --spotify-id，spotdl 路径不可用，改用 ytdlp")
        args.provider = "ytdlp"

    want_dur = args.duration
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {}
    if args.provider in ("spotdl", "auto"):
        result = run_spotdl(args, out_dir, want_dur, args.spotify_id)
        result["used_provider"] = "spotdl"
        if not result.get("ok") and args.provider == "auto" and not args.dry_run:
            print(f"\n[!] spotdl 路径失败（{result.get('reason')}），回落到 ytdlp")
            fallback = run_ytdlp(args, out_dir, want_dur)
            fallback["used_provider"] = "ytdlp"
            fallback["fallback"] = True
            fallback["fallback_reason"] = result.get("reason")
            fallback["spotdl_attempt"] = {
                "ok": False, "reason": result.get("reason"),
                "candidates": result.get("candidates"), "timings": result.get("timings"),
            }
            result = fallback
    else:
        result = run_ytdlp(args, out_dir, want_dur)
        result["used_provider"] = "ytdlp"

    if not result.get("ok"):
        print(f"\n[x] 下载失败：{result.get('reason')}")
        # 失败也落一份记录（文件名用 spotifyId 或 title 的 slug），方便排查
        stem = args.spotify_id or re.sub(r"[^A-Za-z0-9_-]+", "_", args.title)[:40] or "unknown"
        meta = build_match(args.provider, result, args, args.spotify_id)
        meta["ok"] = False
        meta["error"] = result.get("reason")
        p = write_match(out_dir, stem, meta, args.match_out)
        print(f"[i] 失败记录已写入")
        return {"spotdl": 3, "ytdlp": 3}.get(args.provider, 3)

    if result.get("dry_run"):
        print("[i] dry-run，不下载")
        return 0

    path = Path(result["path"])
    chosen = result.get("chosen") or {}
    stem = chosen.get("id") or path.stem
    # 只记录音频来源。官方 MV（visual_video_id）由 Node 侧 lib/official-mv.js 单独匹配，
    # 这里既不下载视频、也不写任何视频字段。
    meta = build_match(args.provider, result, args, args.spotify_id)
    meta["ok"] = True
    p = write_match(out_dir, stem, meta, args.match_out)
    print(f"[+] provider={meta['used_provider']} source={chosen.get('url')} "
          f"{path.stat().st_size / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
