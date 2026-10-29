# -*- coding: utf-8 -*-
"""把一首歌的分离结果整理成最终产物：**只保留 4 个 MP3**。

最终产物（就是这 4 个，不存别的）：
  accompaniment.mp3  纯伴奏 = drums + bass + other（不单独存 4 轨）
  vocals.mp3         纯人声
  guide.mp3          引导版 = 伴奏 + 人声 -12dB（学新歌用）
  original.mp3       原曲 = 四轨求和 = 原始混音

中间产物（分离出的 4 轨 WAV、实验用的对比文件）**默认全部删除**，
需要复查时加 --keep-intermediate。

为什么这 4 个就够：
  - 纯伴奏：KTV 要的
  - 纯人声：可以做和声/对唱/参考
  - 引导版：原唱小声带唱
  - 原曲：A/B 对照、需要原唱全开时
  播放时根据"原唱音量"滑块在这几轨之间切换/混音，不需要 4 轨原件。

用法:
    python\\.venv-xpu\\Scripts\\python.exe scripts\\finalize_track.py --spotify-id <id>
    python\\.venv-xpu\\Scripts\\python.exe scripts\\finalize_track.py --stems-dir <dir> --keep-intermediate
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))
import gpu_lock  # noqa: E402
FFMPEG = Path(os.environ.get("KARAOKE_FFMPEG") or (Path(os.environ.get("KARAOKE_ENV_DIR") or (ROOT / "env")) / "bin" / "ffmpeg.exe"))

# 最终保留的 4 个文件
FINAL_NAMES = ("accompaniment", "vocals", "guide", "original")
# 分离出来的中间 WAV
SOURCE_STEMS = ("drums", "bass", "other", "vocals")
# 实验/对比产物，一律清理
EXPERIMENTAL_PREFIXES = ("karaoke_", "karaoke-")

# 混音算法版本。改动混音规则时必须提升，否则旧产物会被误判为"已完成"。
#   1 = 初版（只有 guide/original 防削波，accompaniment 会削波到 1.37）— 已废弃
#   2 = 统一增益 + 目标峰值 0.89（按 original 定标，accompaniment 余量不足）
#   3 = 定标基准改为 max(original, accompaniment, vocals)，保证所有轨都有余量
ALGORITHM_VERSION = 3


def read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return data.reshape(-1, ch).T, sr


def write_wav(path: Path, data, sr: int) -> None:
    import numpy as np

    pcm = (np.clip(data.T, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(data.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def to_mp3(wav: Path, mp3: Path, bitrate: str = "320k") -> dict:
    proc = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
         "-codec:a", "libmp3lame", "-b:a", bitrate, "-map_metadata", "-1", str(mp3)],
        capture_output=True, text=True, timeout=900,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败: {proc.stderr.strip()[:300]}")
    return {"path": str(mp3), "bytes": mp3.stat().st_size}


def db_to_linear(db: float | None) -> float:
    return 0.0 if db is None else 10.0 ** (db / 20.0)


def _finalize_wait_log(elapsed: float) -> None:
    print(f"[i] 等待成片锁 {int(elapsed)}s…（另一首歌正在生成成品）", flush=True)


def _cleanup_intermediates(stems_dir: Path) -> list[str]:
    """删掉中间产物，只留 4 个最终 MP3 + manifest.json。

    可重复调用（幂等）：目录里只剩最终产物时返回空列表。
    """
    final_mp3 = {f"{n}.mp3" for n in FINAL_NAMES}
    stem_mp3 = {f"{s}.mp3" for s in SOURCE_STEMS} - final_mp3  # vocals.mp3 是最终产物
    removed: list[str] = []
    for p in list(stems_dir.iterdir()):
        if p.is_dir():
            # 遗留的临时目录
            for q in p.glob("*"):
                try: q.unlink()
                except OSError: pass
            try:
                p.rmdir(); removed.append(p.name + "/")
            except OSError:
                pass
            continue
        name = p.name
        if name in final_mp3 or name == "manifest.json":
            continue
        if (p.suffix.lower() == ".wav"
                or name in stem_mp3
                or name in ("encode-report.json", "karaoke-compare.json", "karaoke-mix.json")
                or any(name.startswith(pref) for pref in EXPERIMENTAL_PREFIXES)):
            try:
                p.unlink(); removed.append(name)
            except OSError:
                pass
    return removed


def _write_back(args, stems_dir: Path, final_files: dict[str, Path], total_mb: float, duration_s: float | None = None) -> None:
    """把 4 个最终 MP3 的路径写回曲库。

    只写 finalize 自己负责的字段（vocals_path / no_vocals_path / out_dir），
    device/segment/rtf/processing_s 传 None，由库层 COALESCE 保留分离阶段的真实值。
    """
    if not args.spotify_id:
        return
    import library

    conn = library.init_db()
    t = library.get_track(conn, args.spotify_id)
    if not t:
        print(f"[!] 曲库没有 {args.spotify_id}，跳过写回")
        return
    library.add_stem(conn, t["id"], {
        "model": args.model, "device": None, "segment": None,
        "out_dir": str(stems_dir),
        "vocals_path": str(final_files["vocals"]),
        "no_vocals_path": str(final_files["accompaniment"]),
        "drums_path": None, "bass_path": None, "other_path": None,
        "input_duration_s": round(duration_s, 2) if duration_s else None,
        "processing_s": None, "rtf": None,
    })
    library.log_job(conn, t["id"], "finalize", "ok", f"4 mp3, {total_mb} MB", None)
    print("[+] 已写回曲库（vocals_path / no_vocals_path）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spotify-id", default=None)
    ap.add_argument("--stems-dir", default=None)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--bitrate", default="320k")
    ap.add_argument("--guide-db", type=float, default=-12.0, help="引导版人声增益 dB")
    ap.add_argument("--keep-intermediate", action="store_true", help="保留 4 轨 WAV 和实验文件")
    args = ap.parse_args()

    import numpy as np

    # ---- 定位目录 ----
    stems_dir = Path(args.stems_dir) if args.stems_dir else None
    if stems_dir is None:
        if not args.spotify_id:
            print("[x] 需要 --spotify-id 或 --stems-dir")
            return 1
        import library

        conn = library.init_db()
        t = library.get_track(conn, args.spotify_id)
        if not t:
            print(f"[x] 曲库没有 {args.spotify_id}")
            return 2
        rows = [r for r in library.get_stems(conn, t["id"]) if r["model"] == args.model]
        if not rows:
            print(f"[x] 没有 {args.model} 的分离结果")
            return 2
        stems_dir = Path(rows[0]["out_dir"])

    if not stems_dir.is_dir():
        print(f"[x] 目录不存在: {stems_dir}")
        return 2

    # ---- 幂等：4 个最终产物都在就跳过（中间轨已被清理，重跑会失败）----
    # 但要校验算法版本：混音规则一改（如增益策略），旧产物必须重建，
    # 否则会"跳过"出过时的音频（曾发生：改了统一增益，产物仍是旧的削波版本）。
    final_files = {n: stems_dir / f"{n}.mp3" for n in FINAL_NAMES}
    manifest_path = stems_dir / "manifest.json"
    recorded_version = None
    if manifest_path.exists():
        try:
            recorded_version = json.loads(manifest_path.read_text(encoding="utf-8")).get("algorithmVersion")
        except (ValueError, OSError):
            recorded_version = None

    stale = recorded_version != ALGORITHM_VERSION
    if (not args.keep_intermediate and not stale
            and all(p.exists() and p.stat().st_size > 1024 for p in final_files.values())):
        total = sum(p.stat().st_size for p in final_files.values()) / 1024 / 1024
        print("[=] 4 个最终产物已存在，跳过编码")
        removed = _cleanup_intermediates(stems_dir)
        if removed:
            print(f"[=] 顺带清理了 {len(removed)} 个残留中间文件: {', '.join(sorted(removed)[:8])}")
        for name, p in final_files.items():
            print(f"    {name}.mp3  {p.stat().st_size / 1024 / 1024:.1f} MB")
        print(f"    合计 {total:.1f} MB")
        _write_back(args, stems_dir, final_files, round(total, 1))
        return 0

    # 版本过期时：如果中间轨还在，就直接重建；只有中间轨已清理才报错。
    # （曾误写成无条件报错，导致刚跑完 separate 也拒绝执行）
    has_sources = all(
        (stems_dir / f"{n}.wav").exists() or (stems_dir / f"{n}.mp3").exists()
        for n in SOURCE_STEMS
    )
    if stale and recorded_version and not has_sources:
        print(f"[!] 算法版本变了（{recorded_version} → {ALGORITHM_VERSION}），需要重建产物")
        print("    但中间 4 轨已被清理，无法重建 —— 请重跑 separate 步骤")
        return 4
    if stale and recorded_version and has_sources:
        print(f"[i] 算法版本变了（{recorded_version} → {ALGORITHM_VERSION}），用现有中间轨重建")

    # ---- 找出 4 轨（优先 WAV，退回 MP3 解码）----
    sources = {}
    for name in SOURCE_STEMS:
        wav = stems_dir / f"{name}.wav"
        mp3 = stems_dir / f"{name}.mp3"
        if wav.exists():
            sources[name] = wav
        elif mp3.exists():
            sources[name] = mp3
        else:
            print(f"[x] 缺少 {name}.wav / {name}.mp3")
            return 3
    print(f"[i] 源轨: {', '.join(f'{k}={v.name}' for k, v in sources.items())}")

    # 成片阶段也限并发：每个 finalize 进程要把 4 轨 WAV 读进 numpy（≈900MB），
    # 3 首同时跑会白吃 2.7GB 内存；串行化后 GPU 分离（另一把锁）仍然可以和成片重叠。
    with gpu_lock.acquire("finalize", on_wait=_finalize_wait_log) as waited:
        if waited and waited >= 0.5:
            print(f"[i] 成片锁等待 {waited:.1f}s 后获得", flush=True)

        tmp_dir = stems_dir / ".tmp-final"
        tmp_dir.mkdir(exist_ok=True)

        # 把 MP3 源解回 WAV 以便计算（保证 4 轨长度/采样率一致）
        decoded = {}
        sr = None
        for name, src in sources.items():
            if src.suffix.lower() == ".wav":
                decoded[name], sr = read_wav(src)
            else:
                wav = tmp_dir / f"{name}.wav"
                subprocess.run(
                    [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                     "-ac", "2", "-ar", "44100", "-sample_fmt", "s16", str(wav)],
                    capture_output=True, text=True, timeout=600, check=True,
                )
                decoded[name], sr = read_wav(wav)

        length = min(v.shape[-1] for v in decoded.values())
        for k in decoded:
            decoded[k] = decoded[k][:, :length]
        duration_s = length / sr
        print(f"[i] 长度对齐: {length} 样本 / {duration_s:.1f}s / {sr}Hz")

        drums, bass, other, vocals = (decoded[k] for k in SOURCE_STEMS)
        accompaniment = drums + bass + other
        original = accompaniment + vocals

        # ---- 统一增益（关键）----
        # 三轨相加后 peak 可能远超 1.0（实测 1.37）。若只对 guide/original 做防削波，
        # accompaniment 和 vocals 会各自削波，且**两轨电平不再对应**：
        # 播放时 acc*g + voc*g 的和就不再等于 original，混音滑块会失真。
        # 因此用一个**统一增益**缩放所有轨，保持彼此的相对比例。
        # 目标峰值 0.89（-1dBFS 左右）：MP3 是有损编码，解码后会有过冲，
        # PCM 压到 0.99 解码后仍可能超过 1.0（实测过冲约 0.03~0.05）。
        TARGET_PEAK = 0.89
        raw_peak = float(np.abs(original).max())

        # 定标基准不能只看 original：accompaniment 是三轨相加，缺少人声的相位抵消，
        # 峰值可能比 original 更接近满刻度（实测 Mr. Brightside 只差 0.005 余量）。
        # 所以取"最大和"作为基准 —— 即让所有轨里最高的那个峰落在 TARGET_PEAK。
        # 这不影响轨间相对比例（全轨乘同一系数），只是把基准选得更保守。
        comp_peak = float(np.abs(accompaniment).max())
        voc_peak = float(np.abs(vocals).max())
        base_peak = max(raw_peak, comp_peak, voc_peak)
        unity_gain = (TARGET_PEAK / base_peak) if base_peak > TARGET_PEAK else 1.0

        accompaniment = accompaniment * unity_gain
        vocals = vocals * unity_gain
        original = original * unity_gain
        # guide 用缩放后的伴奏/人声重新计算，保证与其它轨同基准
        guide = accompaniment + vocals * db_to_linear(args.guide_db)

        guide_peak = float(np.abs(guide).max())
        if guide_peak > TARGET_PEAK:
            # 引导人声叠上去又超了，只对 guide 单独再压一次（不影响其它轨比例）
            guide = guide * (TARGET_PEAK / guide_peak)
            # 缩放后重新测量，否则 manifest 里记的是压限前的旧值
            guide_peak = float(np.abs(guide).max())
        original_peak = float(np.abs(original).max())

        mixes = {
            "accompaniment": accompaniment,
            "vocals": vocals,
            "guide": guide,
            "original": original,
        }

        print(f"[i] 统一增益 {unity_gain:.4f}（定标基准 peak={base_peak:.4f}："
              f"original={raw_peak:.4f} acc={comp_peak:.4f} voc={voc_peak:.4f}）")
        for _n, _d in mixes.items():
            print(f"     {_n:<14} peak={float(np.abs(_d).max()):.4f}")

        # ---- 写出 4 个 WAV（顺序写，避免同时占更多内存），再并行编码 MP3 ----
        wav_paths = {}
        for name, data in mixes.items():
            wav_path = tmp_dir / f"{name}.wav"
            write_wav(wav_path, data, sr)
            wav_paths[name] = wav_path

        results = {}
        total_bytes = 0
        # 4 个 ffmpeg 并行编码；CPU 很少的机器上按核数收敛，别把 GPU 外的负载打满
        encode_workers = max(1, min(len(mixes), os.cpu_count() or len(mixes)))
        with ThreadPoolExecutor(max_workers=encode_workers, thread_name_prefix="mp3") as pool:
            futures = {
                name: pool.submit(to_mp3, wav_paths[name], stems_dir / f"{name}.mp3", args.bitrate)
                for name in mixes
            }
            for name in mixes:
                info = futures[name].result()
                total_bytes += info["bytes"]
                results[name] = {"mp3": info["path"], "mb": round(info["bytes"] / 1024 / 1024, 1)}
                print(f"[+] {name}.mp3  {info['bytes'] / 1024 / 1024:.1f} MB")

        # ---- 清理中间产物 ----
        if not args.keep_intermediate:
            removed = _cleanup_intermediates(stems_dir)
            print(f"[=] 清理了 {len(removed)} 个中间文件: {', '.join(sorted(removed)[:12])}{' …' if len(removed) > 12 else ''}")
        else:
            for p in tmp_dir.glob("*"):
                p.unlink()
            tmp_dir.rmdir()
            print("[i] 保留中间产物（--keep-intermediate）")

    # ---- 写回曲库 ----
    manifest = {
        "spotifyId": args.spotify_id,
        "stemsDir": str(stems_dir),
        "sampleRate": sr,
        "durationS": round(duration_s, 2),
        "algorithmVersion": ALGORITHM_VERSION,
        "guideDb": args.guide_db,
        "bitrate": args.bitrate,
        "peak": {"guide": round(guide_peak, 3), "original": round(original_peak, 3)},
        "files": results,
        "totalMB": round(total_bytes / 1024 / 1024, 1),
    }
    (stems_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    _write_back(args, stems_dir, {n: Path(results[n]["mp3"]) for n in FINAL_NAMES},
                manifest["totalMB"], duration_s)

    print("\n=== 最终产物 ===")
    for name in FINAL_NAMES:
        print(f"  {name}.mp3  {results[name]['mb']:>5} MB")
    print(f"  合计 {manifest['totalMB']} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
