# -*- coding: utf-8 -*-
"""跨进程的"名额锁"（模式 B 后台并发用）。

为什么需要：
- Node 侧同时跑 3 个 `pipeline.py`，但 Demucs 在 XPU 上每个进程要 ≈4.5GB 内存，
  并发跑并不能让 GPU 更快（实测 2 个并发各慢 1.8 倍，吞吐只高 ~20%），
  所以 GPU 分离必须**跨进程串行**。finalize 也要限制并发（每个 ≈900MB numpy）。
- 用文件锁而不是 Node 侧调度：pipeline.py 单独运行（手动跑、重跑某一步）时
  也要遵守同一把锁，否则手工命令和后台队列会撞车。

实现：
- Windows 用 `msvcrt.locking()`，POSIX 用 `fcntl.lockf()`；都是**操作系统级**锁，
  进程崩溃时由系统自动释放，不会留下死锁文件。
- 一个文件可以当"计数信号量"用：capacity=N 时依次尝试锁第 0..N-1 个字节。
- 环境变量：
    KARAOKE_LOCKS=0            完全关掉锁（调试/基准测试用）
    KARAOKE_LOCK_DIR=<dir>     锁文件目录（默认 <项目根>/.tmp）
    KARAOKE_GPU_LOCK_TIMEOUT   等锁超时秒数（默认 3600）

用法：
    with acquire("demucs", timeout=1800, on_wait=print_wait):
        ... 占 GPU 的代码 ...
"""
from __future__ import annotations

import contextlib
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK_DIR = Path(os.environ.get("KARAOKE_LOCK_DIR") or (ROOT / ".tmp"))
DEFAULT_TIMEOUT = float(os.environ.get("KARAOKE_GPU_LOCK_TIMEOUT") or 3600)


class FileSlotLock:
    """在 lock 文件的字节槽位上抢一个名额。"""

    def __init__(self, name: str, capacity: int = 1):
        if capacity < 1:
            raise ValueError("capacity 必须 >= 1")
        self.path = LOCK_DIR / f"{name}.lock"
        self.capacity = capacity
        self.slot: int | None = None
        self.fd: int | None = None

    def _ensure_file(self) -> None:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            try:
                self.path.touch()
            except OSError:
                pass
        # 文件至少要覆盖 capacity 个字节，否则 Windows 上锁越界区域行为不明确
        try:
            with open(self.path, "r+b") as f:
                if os.fstat(f.fileno()).st_size < self.capacity:
                    f.write(b"\0" * self.capacity)
        except OSError:
            pass

    def _try_lock(self, fd: int, slot: int) -> bool:
        try:
            os.lseek(fd, slot, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, slot, os.SEEK_SET)
            return True
        except OSError:
            return False

    def _unlock(self, fd: int, slot: int) -> None:
        try:
            os.lseek(fd, slot, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.lockf(fd, fcntl.LOCK_UN, 1, slot, os.SEEK_SET)
        except OSError:
            pass

    def acquire(self, timeout: float | None = None, poll: float = 0.5,
                on_wait=None) -> float:
        """抢名额。返回等待秒数；超时抛 TimeoutError。"""
        self._ensure_file()
        timeout = DEFAULT_TIMEOUT if timeout is None else timeout
        deadline = time.monotonic() + timeout
        started = time.monotonic()
        last_report = -10.0
        while True:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666)
            for slot in range(self.capacity):
                if self._try_lock(fd, slot):
                    self.fd = fd
                    self.slot = slot
                    return time.monotonic() - started
            os.close(fd)
            elapsed = time.monotonic() - started
            if elapsed >= timeout:
                raise TimeoutError(
                    f"等待 {self.path.name} 超时（{timeout:.0f}s）"
                )
            if on_wait is not None and elapsed - last_report >= 10.0:
                last_report = elapsed
                try:
                    on_wait(elapsed)
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(min(poll, max(0.05, deadline - time.monotonic())))

    def release(self) -> None:
        if self.fd is None:
            return
        slot = self.slot if self.slot is not None else 0
        self._unlock(self.fd, slot)
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.fd = None
        self.slot = None


@contextlib.contextmanager
def acquire(name: str, capacity: int = 1, timeout: float | None = None, on_wait=None):
    """with acquire("demucs"): ...；拿不到锁时按 on_wait(elapsed) 报告等待。"""
    if os.environ.get("KARAOKE_LOCKS", "1") == "0":
        yield 0.0
        return
    lock = FileSlotLock(name, capacity)
    waited = lock.acquire(timeout=timeout, on_wait=on_wait)
    try:
        yield waited
    finally:
        lock.release()
