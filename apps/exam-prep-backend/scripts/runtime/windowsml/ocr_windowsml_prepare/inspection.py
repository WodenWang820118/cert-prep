from __future__ import annotations

from collections.abc import Sequence
import importlib.util
from pathlib import Path
import platform
import shutil
import sys
from typing import Any

from .constants import DOCKER_PADDLEX_IMAGE


def inspect_prepared_model_artifacts(model_dir: Path) -> dict[str, Any]:
    required_files = (
        "det/inference.onnx",
        "det/inference.yml",
        "rec/inference.onnx",
        "rec/inference.yml",
        "rec/ppocr_keys_v1.txt",
        "npu-prepass/text-density.onnx",
        "pipeline.json",
    )
    required = [model_file_state(model_dir / name) for name in required_files]
    missing_required = [item["name"] for item in required if item["state"] != "present"]
    return {
        "model_dir": str(model_dir),
        "required": required,
        "missing_required": missing_required,
        "ready": len(missing_required) == 0,
    }


def model_file_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"name": path.as_posix(), "path": str(path), "state": "missing", "bytes": 0}
    if not path.is_file():
        return {"name": path.as_posix(), "path": str(path), "state": "not_file", "bytes": 0}
    size = path.stat().st_size
    return {
        "name": path.as_posix(),
        "path": str(path),
        "state": "present" if size > 0 else "empty",
        "bytes": size,
    }


def inspect_conversion_tool() -> dict[str, Any]:
    paddle2onnx_spec = importlib.util.find_spec("paddle2onnx")
    paddlex_spec = importlib.util.find_spec("paddlex")
    docker_exe = shutil.which("docker")
    return {
        "python_version": platform.python_version(),
        "paddlex_available": paddlex_spec is not None,
        "paddle2onnx_module_available": paddle2onnx_spec is not None,
        "docker_cli_available": docker_exe is not None,
        "docker_paddlex_image": DOCKER_PADDLEX_IMAGE,
        "preferred_command": [
            sys.executable,
            "-m",
            "paddlex",
            "--paddle2onnx",
            "--paddle_model_dir",
            "<source>",
            "--onnx_model_dir",
            "<output>",
            "--opset_version",
            "14",
        ],
        "note": (
            "PaddleX local high-performance/plugin docs target Python 3.8-3.12; "
            "the backend now allows Python 3.12 compatibility, so conversion can "
            "use an explicit Python 3.12 release-prep environment. The Docker "
            "converter is the reproducible Windows release-prep lane when Docker "
            "Desktop is available."
        ),
    }


def classify_prepare_status(
    *,
    sources: Sequence[dict[str, Any]],
    extractions: Sequence[dict[str, Any]],
    metadata: dict[str, Any],
    conversions: Sequence[dict[str, Any]],
    model_artifacts: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    blockers.extend(str(item["blocker"]) for item in sources if item.get("blocker"))
    blockers.extend(
        str(item["reason"])
        for item in extractions
        if item.get("state") not in {"ready", "skipped"} and item.get("reason")
    )
    if metadata.get("state") != "ready":
        blockers.append(str(metadata.get("reason") or "metadata_not_ready"))
    blockers.extend(str(item["blocker"]) for item in conversions if item.get("blocker"))
    if not model_artifacts.get("ready"):
        blockers.append("model_artifacts_missing")

    unique_blockers = list(dict.fromkeys(blockers))
    source_ready = all(item.get("state") == "present" for item in sources)
    extraction_ready = len(extractions) > 0 and all(item.get("state") == "ready" for item in extractions)
    metadata_ready = metadata.get("state") == "ready"
    onnx_ready = all(item.get("state") == "ready" for item in conversions)
    if model_artifacts.get("ready"):
        state = "ready"
    elif not source_ready or not extraction_ready or not metadata_ready:
        state = "blocked"
    elif any(item.get("blocker") == "conversion_tool_unavailable" for item in conversions):
        state = "blocked"
    elif not onnx_ready:
        state = "ready_for_conversion"
    else:
        state = "blocked"

    return {
        "state": state,
        "source_archives_ready": source_ready,
        "source_extractions_ready": extraction_ready,
        "metadata_ready": metadata_ready,
        "onnx_models_ready": bool(model_artifacts.get("ready")),
        "blockers": unique_blockers,
        "current_safe_action": (
            "Keep WindowsML OCR behind the production gate. Do not use CPU OCR as "
            "a silent fallback while ONNX assets or conversion tooling are missing."
        ),
        "recommended_next_step": recommended_next_step(state, unique_blockers),
    }


def recommended_next_step(state: str, blockers: Sequence[str]) -> str:
    if state == "ready":
        return "Run ocr-windowsml-session-smoke and then packaged WindowsML streaming QA."
    if "conversion_tool_unavailable" in blockers:
        return (
            "Run PaddleX/Paddle2ONNX conversion in a Python 3.8-3.12 release-prep "
            "environment, then publish the ONNX assets by release URL."
        )
    if "model_artifacts_missing" in blockers:
        return "Finish conversion so det/inference.onnx and rec/inference.onnx exist."
    return "Inspect the prepare-models artifact and resolve the first listed blocker."
