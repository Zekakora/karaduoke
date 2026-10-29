# -*- coding: utf-8 -*-
"""从 YouTube 取音频并转成 Demucs 需要的 44.1kHz / 16-bit / stereo WAV。

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

可选：`--keep-video` 额外保留一份 **720p MP4（无音轨）** 视频，供前端播放时做画面：
    assets/output/library/<spotifyId>/video.mp4
注意它和音频产物不在同一棵树（音频在 data/library/，视频在 assets/output/library/），
所以视频必须靠 `--spotify-id` 定位目录；没有 spotifyId 时跳过视频（不猜路径）。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_audio.py --title "Bohemian Rhapsody" `
        --artist "Queen" --duration 355 --provider auto
    # 同时保留 720p 视频
    python\\.venv-xpu\\Scripts\\python.exe scripts\\fetch_audio.py --title "..." --artist "Queen" `
        --duration 355 --spotify-id 2JiDi0qAXsPwhPqA2qaKGt --keep-video
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
LIBRARY_DIR = ROOT / "assets" / "output" / "library"   # 前端可见的曲库（视频落这里）
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


# ---------------------------------------------------------------- 720p 视频（--keep-video）


# 选格式：**1080p H.264 优先**，720p 兜底。
#
# 为什么锁 avc1(H.264) 而不用 `best`：YouTube 同分辨率会同时给 av01 / vp9 / avc1，
# `best` 会选 AV1（码率低但老设备兼容性差、软解吃 CPU）。卡拉OK常见设备是
# 电视盒/平板/投影，H.264 最保险。
#
# 实测各档体积（Bohemian Rhapsody 359s）：
#   137 = 1920x1080 avc1 1974kbps ≈ 87 MB   ← 选这个
#   248 = 1920x1080 vp9  1391kbps ≈ 61 MB
#   399 = 1920x1080 av01 1024kbps ≈ 45 MB
#   136 = 1280x720  avc1  784kbps ≈ 34 MB   ← 兜底
#
# 注意：必须显式要 video-only 流（[acodec=none]）。带音轨的 1080p 合成体
# 体积更大，且我们本来就要剥音轨（音频走 MP3 混音，视频全程 muted）。
VIDEO_FORMAT = (
    "137[acodec=none]"
    "/137"
    "/bestvideo[height=1080][ext=mp4][vcodec^=avc1][acodec=none]"
    "/bestvideo[height=1080][vcodec^=avc1][acodec=none]"
    # 720p 兜底（有些老视频没有 1080p）
    "/136[acodec=none]"
    "/bestvideo[height<=720][ext=mp4][vcodec^=avc1][acodec=none]"
    "/bestvideo[height<=720][vcodec^=avc1][acodec=none]"
    # 最后才考虑非 avc1（AV1/VP9），总比没有强
    "/bestvideo[height<=1080][acodec=none]"
    "/best[height<=1080]"
)


def ffbin(name: str) -> Path:
    """ffmpeg/ffprobe 可执行文件路径（Windows 优先 .exe）。"""
    bin_dir = ffmpeg_location()
    if not bin_dir:
        raise RuntimeError("找不到 ffmpeg/ffprobe，无法处理视频")
    exe = Path(bin_dir) / f"{name}.exe"
    return exe if exe.exists() else Path(bin_dir) / name


def probe_streams(path: Path) -> dict:
    """读第一条视频流的分辨率/编码 + 是否有音频流。"""
    ffprobe = ffbin("ffprobe")
    proc = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe 失败：{(proc.stderr or '')[-300:]}")
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    dur = (data.get("format") or {}).get("duration")
    return {
        "width": video.get("width"),
        "height": video.get("height"),
        "video_codec": video.get("codec_name"),
        "has_audio": has_audio,
        "duration_s": round(float(dur), 3) if dur else None,
    }


def download_video(video_id: str, dest: Path, *, force: bool = False, timeout_s: int = 900) -> dict:
    """下载 1080p(H.264) MP4 并剥成无音轨，落到 `dest`。

    流程：yt-dlp 下到 `.tmp/video-mux/`（带音轨的 720p MP4，下载更稳）
          → `ffmpeg -an -c:v copy` 剥音轨 → `dest`
          → 删掉中间文件（成功或失败都删）。
    失败抛 RuntimeError（不静默跳过）。
    """
    import yt_dlp

    dest = Path(dest)
    work = TMP_DIR / "video-mux" / video_id
    work.mkdir(parents=True, exist_ok=True)
    leftover = list(work.glob(f"{video_id}.*"))

    t0 = time.perf_counter()
    info: dict = {}
    src: Path | None = None
    try:
        # 注意：调用方（add_video / fetch_audio）已负责判断"要不要下载"，
        # 本函数只管下载 → 剥音轨 → 落盘，所以这里不自己跳过错失与 `--force` 相关的语义。
        opts = {
            "format": VIDEO_FORMAT,
            "noplaylist": True,
            "js_runtimes": {"node": {}},
            "quiet": True,
            "no_warnings": True,
            "outtmpl": str(work / f"{video_id}.%(ext)s"),
            "ffmpeg_location": ffmpeg_location(),
            "cachedir": str(ROOT / ".cache" / "yt-dlp"),
            "socket_timeout": 30,
            # 720p video + audio 需要合并时才用到 ffmpeg，这里显式指定
            "merge_output_format": "mp4",
        }
        print(f"[i] (>video) 下载 1080p MP4: {video_id}")
        t_dl = time.perf_counter()
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                raw = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"yt-dlp 下载视频失败（{video_id}）：{e}") from e
        dl_s = time.perf_counter() - t_dl
        info = {
            "video_id": video_id,
            "title": raw.get("title"),
            "format_id": raw.get("format_id"),
            "download_s": round(dl_s, 2),
        }
        # 找到实际落盘的文件（可能是 .mp4 / .mkv / .webm）
        made = [p for p in work.glob(f"{video_id}.*")
                if p.is_file() and p.suffix.lower() not in (".part", ".ytdl")]
        if not made:
            raise RuntimeError(f"yt-dlp 报告完成但没找到文件：{work}")
        src = max(made, key=lambda p: p.stat().st_size)
        print(f"[+] 原始视频 {src.name} ({src.stat().st_size / 1024 / 1024:.1f} MB, {dl_s:.1f}s)")

        # 剥音轨（纯拷贝视频流，不重编码）
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp_out = dest.with_suffix(".part.mp4")
        proc = subprocess.run(
            [str(ffbin("ffmpeg")), "-hide_banner", "-loglevel", "error", "-y",
             "-i", str(src), "-an", "-c:v", "copy", "-movflags", "+faststart", str(tmp_out)],
            capture_output=True, text=True, timeout=timeout_s, encoding="utf-8", errors="replace",
        )
        if proc.returncode != 0 or not tmp_out.exists() or tmp_out.stat().st_size == 0:
            tmp_out.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg 剥音轨失败：{(proc.stderr or '')[-400:]}")

        # 先校验**暂存文件**，通过才落到 dest —— 否则一个不合格的文件会就这样留在
        # assets/output/library/<id>/video.mp4 里，被后续逻辑当成"已有视频"跳过。
        stream = probe_streams(tmp_out)
        if stream["has_audio"]:
            tmp_out.unlink(missing_ok=True)
            raise RuntimeError("剥音轨后仍检测到音频流（未落盘）")
        # 分辨率校验：接受 1080p / 720p。不强制等于某个值，因为源视频画幅
        # 可能不是标准 16:9（例如 Mr. Brightside 源就是 720x732），
        # 只要高度落在可播范围内即可；过低（<700）说明降级到了渣源，判失败。
        height = stream.get("height") or 0
        if height < 700:
            tmp_out.unlink(missing_ok=True)
            raise RuntimeError(
                f"分辨率过低：{stream['width']}x{stream['height']}（<700p，源视频画质不足；未落盘）"
            )
        tmp_out.replace(dest)

        return {
            "ok": True,
            "path": str(dest),
            "bytes": dest.stat().st_size,
            "elapsed_s": round(time.perf_counter() - t0, 2),
            **{k: v for k, v in info.items() if k},
            **stream,
        }
    finally:
        # 中间文件一律删掉（含上次残留的 .part 和本次的暂存 .part.mp4）
        junk = leftover + list(work.glob(f"{video_id}.*"))
        staged = dest.with_suffix(".part.mp4")
        if staged.exists():
            junk.append(staged)
        for p in junk:
            try:
                if p.is_file():
                    p.unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass


def video_dest(spotify_id: str) -> Path:
    return LIBRARY_DIR / spotify_id / "video.mp4"


def maybe_keep_video(args, video_id: str | None) -> dict | None:
    """--keep-video 的入口：没有 spotifyId / videoId 就明确跳过并说明原因。"""
    if not getattr(args, "keep_video", False):
        return None
    if not args.spotify_id:
        print("[!] --keep-video 需要 --spotify-id 才能定位 assets/output/library/<id>/，跳过视频")
        return {"ok": False, "skipped": True, "reason": "缺少 --spotify-id"}
    if not video_id:
        print("[!] 没有可用的 YouTube videoId，跳过视频")
        return {"ok": False, "skipped": True, "reason": "没有 videoId"}
    dest = video_dest(args.spotify_id)
    if dest.exists():
        try:
            stream = probe_streams(dest)
        except Exception as e:  # noqa: BLE001
            print(f"[!] 已有 video.mp4 但探测失败（{e}），重新下载")
        else:
            print(f"[=] 视频已存在，跳过：{dest} ({dest.stat().st_size / 1024 / 1024:.1f} MB)")
            return {"ok": True, "path": str(dest), "skipped": True,
                    "bytes": dest.stat().st_size, **stream}
    try:
        res = download_video(video_id, dest)
    except Exception as e:  # noqa: BLE001
        print(f"[x] 视频保留失败（{video_id}）：{e}")
        return {"ok": False, "reason": str(e)}
    print(f"[+] 视频 => {dest} ({res['bytes'] / 1024 / 1024:.1f} MB, "
          f"{res['width']}x{res['height']}, 无音轨, {res['elapsed_s']}s)")
    return res


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
    ap.add_argument("--keep-video", action="store_true",
                    help="额外下载 720p MP4（剥掉音轨）到 assets/output/library/<spotifyId>/video.mp4；"
                         "需要 --spotify-id，默认关闭")
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
    # 视频按"音频最终采用的同一个 videoId"取，保证画面与音频同源
    video = maybe_keep_video(args, chosen.get("id"))
    meta = build_match(args.provider, result, args, args.spotify_id)
    meta["ok"] = True
    if video is not None:
        meta["video"] = video
        if not video.get("ok"):
            # 音频成功但视频失败：明确报错（退出码 4），不静默
            p = write_match(out_dir, stem, meta, args.match_out)
            print(f"[x] 音频已下载，但视频保留失败：{video.get('reason')}")
            return 4
    p = write_match(out_dir, stem, meta, args.match_out)
    print(f"[+] provider={meta['used_provider']} source={chosen.get('url')} "
          f"{path.stat().st_size / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
