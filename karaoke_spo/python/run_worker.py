# 让 worker 把模型与缓存放在项目内（用户主目录下的 torch 缓存不可写）
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("TORCH_HOME", os.path.join(ROOT, ".cache", "torch"))
os.environ.setdefault("HF_HOME", os.path.join(ROOT, ".cache", "huggingface"))
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from worker import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
