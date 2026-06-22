from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_MODELS = ("qwen3.5:4b", "deepseek-r1:14b", "gemma4:12b")
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
DEFAULT_LIMIT = 4
