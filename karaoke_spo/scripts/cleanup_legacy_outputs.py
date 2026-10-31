# -*- coding: utf-8 -*-
"""一次性清理旧版管线的冗余成品：只长期保留 accompaniment.mp3 + vocals.mp3。

背景：播放端已改为 Web Audio 实时混音（原唱 / 伴奏 / 人声导唱三种模式全部
前端合成），不再需要 guide.mp3 / original.mp3 预混成品；官方 MV 走
YouTube IFrame 在线播放，本地 video.mp4 也早已不再使用。

安全规则（每一条都独立生效）：
  * 只处理 assets/output/library/<id>/ 目录内的**固定文件名**
    （guide.mp3 / original.mp3 / video.mp4），绝不按通配符扫整个目录；
  * 每个目录必须先通过校验：accompaniment.mp3 与 vocals.mp3 都在、
    非空（>16KB）、MP3 文件头正确 —— 校验不过的歌一个文件都不删；
  * 只删文件本身，绝不递归删目录；
  * 删除失败只记日志，不影响其余目录。

用法:
    python scripts/cleanup_legacy_outputs.py --dry-run   # 只列出会删的文件
    python scripts/cleanup_legacy_outputs.py             # 实际清理
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STEMS_DIR = ROOT / "assets" / "output" / "library"

# 长期保留的最终产物
FINAL_NAMES = ("accompaniment.mp3", "vocals.mp3")
# 旧版本留下的冗余成品，确认最终产物合格后删除
LEGACY_NAMES = ("guide.mp3", "original.mp3", "video.mp4")
MIN_MP3_BYTES = 16 * 1024


def looks_like_mp3(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            head = fh.read(4)
    except OSError:
        return False
    return head[:3] == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)


def verify_finals(track_dir: Path) -> list[str]:
    """校验 2 个最终 MP3 是否合格；返回问题列表（空 = 通过）。"""
    problems: list[str] = []
    for name in FINAL_NAMES:
        path = track_dir / name
        if not path.is_file():
            problems.append(f"{name} 不存在")
            continue
        size = path.stat().st_size
        if size < MIN_MP3_BYTES:
            problems.append(f"{name} 太小（{size}B）")
            continue
        if not looks_like_mp3(path):
            problems.append(f"{name} 不是 MP3 文件头")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只列出会删的文件，不实际删除")
    args = ap.parse_args()

    if not STEMS_DIR.is_dir():
        print(f"[x] 目录不存在: {STEMS_DIR}")
        return 2

    removed: list[Path] = []
    failed: list[str] = []
    skipped: list[str] = []
    freed = 0

    for track_dir in sorted(p for p in STEMS_DIR.iterdir() if p.is_dir()):
        problems = verify_finals(track_dir)
        if problems:
            skipped.append(f"{track_dir.name}: " + "；".join(problems))
            continue
        for name in LEGACY_NAMES:
            target = track_dir / name
            if not target.is_file():
                continue
            size = target.stat().st_size
            if args.dry_run:
                removed.append(target)
                freed += size
                continue
            try:
                target.unlink()
                removed.append(target)
                freed += size
            except OSError as error:
                failed.append(f"{target.name}: {error}")

    label = "将删除" if args.dry_run else "已删除"
    print(f"[=] {label} {len(removed)} 个冗余文件，释放 {freed / 1024 / 1024:.1f} MB")
    for path in removed[:12]:
        print(f"    {path}")
    if len(removed) > 12:
        print(f"    … 共 {len(removed)} 个")
    if skipped:
        print(f"[!] 跳过 {len(skipped)} 个目录（最终 MP3 校验未通过，一个文件都没删）:")
        for line in skipped[:8]:
            print(f"    {line}")
        if len(skipped) > 8:
            print(f"    … 共 {len(skipped)} 个")
    if failed:
        print(f"[!] {len(failed)} 个文件删除失败:")
        for line in failed[:8]:
            print(f"    {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
