from __future__ import annotations

from importlib import metadata
import os
from pathlib import Path
from typing import Any


_DLL_DIRECTORY_HANDLES: list[Any] = []


def import_paddle_stack() -> tuple[Any | None, Any | None, Exception | None]:
    os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
    _augment_windows_cuda_path()
    try:
        import paddle  # type: ignore[import-not-found]
        from paddleocr import PaddleOCR  # type: ignore[import-not-found]

        return paddle, PaddleOCR, None
    except Exception as exc:
        return None, None, exc


def cuda_available(paddle: Any) -> bool:
    try:
        return bool(paddle.is_compiled_with_cuda())
    except Exception:
        return False


def gpu_count(paddle: Any) -> int:
    try:
        return int(paddle.device.cuda.device_count())
    except Exception:
        return 0


def package_versions() -> dict[str, str | None]:
    return {
        "paddle": _package_version("paddlepaddle")
        or _package_version("paddlepaddle-gpu")
        or _module_version("paddle"),
        "paddleocr": _package_version("paddleocr"),
        "paddlex": _package_version("paddlex"),
    }


def model_cache_dir() -> str:
    home = Path.home()
    candidates = [home / ".paddlex", home / ".paddleocr", home / ".paddle"]
    existing = [str(path) for path in candidates if path.exists()]
    return ";".join(existing) if existing else str(candidates[0])


def _package_version(package_name: str) -> str | None:
    try:
        return metadata.version(package_name)
    except metadata.PackageNotFoundError:
        return None


def _module_version(module_name: str) -> str | None:
    try:
        module = __import__(module_name)
    except Exception:
        return None
    version = getattr(module, "__version__", None)
    return version if isinstance(version, str) else None


def _augment_windows_cuda_path() -> None:
    if os.name != "nt":
        return
    candidate_dirs = _windows_cuda_candidate_dirs()
    existing_dirs = [path for path in candidate_dirs if path.is_dir()]
    if not existing_dirs:
        return
    path_parts = os.environ.get("PATH", "").split(os.pathsep)
    normalized_path_parts = {part.lower() for part in path_parts}
    additions = [str(path) for path in existing_dirs if str(path).lower() not in normalized_path_parts]
    if additions:
        os.environ["PATH"] = os.pathsep.join([*additions, os.environ.get("PATH", "")])
    if hasattr(os, "add_dll_directory"):
        for path in existing_dirs:
            try:
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(path)))
            except OSError:
                continue


def _windows_cuda_candidate_dirs() -> list[Path]:
    candidates: list[Path] = []
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        candidates.append(Path(cuda_path) / "bin")
    candidates.extend(Path("C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA").glob("v*/bin"))
    candidates.extend(Path("C:/Program Files/NVIDIA/CUDNN").glob("v*/bin/*/x64"))
    return candidates
