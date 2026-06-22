from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
import json
from pathlib import Path
import sys
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parents[0]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"

sys.path.insert(0, str(SCRIPT_DIR))

from ocr_directml_probe import (  # noqa: E402
    DEFAULT_MODEL_DIR,
    REQUIRED_MODEL_FILES,
    build_report as build_probe_report,
)


SESSION_MODEL_FILES = tuple(name for name in REQUIRED_MODEL_FILES if name.endswith(".onnx"))
SessionSmokeRunner = Callable[[dict[str, Path], int | None], dict[str, Any]]


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-directml-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-blocked",
        action="store_true",
        help="Exit non-zero only when DirectML itself is unavailable.",
    )
    parser.add_argument(
        "--fail-if-not-session-ready",
        action="store_true",
        help="Exit non-zero unless DirectML sessions can be created for required models.",
    )
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    session_runner: SessionSmokeRunner | None = None,
) -> dict[str, Any]:
    probe = build_probe_report(model_dir)
    session_smoke = build_session_smoke(probe, session_runner=session_runner)
    status = classify_smoke_status(probe["status"], session_smoke)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_directml_session_smoke",
            "goal": (
                "Verify that required PP-OCR ONNX model files can create ONNX "
                "Runtime sessions with DirectML before any production OCR routing "
                "changes."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
            "runs_ocr_inference": False,
        },
        "probe": probe,
        "directml_session_smoke": session_smoke,
        "status": status,
    }


def build_session_smoke(
    probe: dict[str, Any],
    *,
    session_runner: SessionSmokeRunner | None = None,
) -> dict[str, Any]:
    session_runner = session_runner or run_directml_session_smoke
    status = probe.get("status", {})
    if not status.get("directml_provider_available"):
        return skipped_session_smoke("directml_provider_unavailable")
    if not status.get("amd_igpu_detected"):
        return skipped_session_smoke("amd_igpu_not_detected")

    artifacts = probe.get("model_artifacts", {})
    if not artifacts.get("ready"):
        return skipped_session_smoke("model_artifacts_missing")

    model_files = required_model_paths(artifacts)
    missing_names = [name for name in SESSION_MODEL_FILES if name not in model_files]
    if missing_names:
        return {
            **skipped_session_smoke("model_artifacts_missing"),
            "missing_required": missing_names,
        }
    return session_runner(model_files, directml_device_id(status))


def skipped_session_smoke(reason: str) -> dict[str, Any]:
    return {
        "state": "skipped",
        "reason": reason,
        "providers_requested": directml_providers(None),
        "session_options": directml_session_options_metadata(),
        "sessions": [],
        "errors": [],
    }


def required_model_paths(model_artifacts: dict[str, Any]) -> dict[str, Path]:
    required = model_artifacts.get("required", [])
    if not isinstance(required, list):
        return {}
    result: dict[str, Path] = {}
    for item in required:
        if not isinstance(item, dict):
            continue
        if item.get("state") != "present":
            continue
        name = str(item.get("name") or "")
        path = item.get("path")
        if name in SESSION_MODEL_FILES and path:
            result[name] = Path(str(path))
    return result


def directml_device_id(probe_status: dict[str, Any]) -> int | None:
    raw = probe_status.get("directml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def directml_providers(device_id: int | None) -> list[Any]:
    if device_id is None:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    return [
        ("DmlExecutionProvider", {"device_id": str(device_id)}),
        "CPUExecutionProvider",
    ]


def directml_session_options_metadata() -> dict[str, Any]:
    return {
        "enable_mem_pattern": False,
        "execution_mode": "ORT_SEQUENTIAL",
        "reason": (
            "ONNX Runtime DirectML requires memory-pattern optimization disabled "
            "and sequential execution."
        ),
    }


def create_directml_session_options(ort: Any) -> Any:
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return options


def run_directml_session_smoke(
    model_files: dict[str, Path],
    device_id: int | None,
) -> dict[str, Any]:
    providers = directml_providers(device_id)
    sessions: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "state": "session_failed",
            "providers_requested": providers,
            "session_options": directml_session_options_metadata(),
            "sessions": sessions,
            "errors": [{"model": "*", "error": str(exc)}],
        }

    for model_name in SESSION_MODEL_FILES:
        model_path = model_files[model_name]
        try:
            session = ort.InferenceSession(
                str(model_path),
                sess_options=create_directml_session_options(ort),
                providers=providers,
            )
            sessions.append(session_metadata(model_name, model_path, session))
        except Exception as exc:
            errors.append({"model": model_name, "error": str(exc)})

    return {
        "state": "session_ready" if not errors else "session_failed",
        "providers_requested": providers,
        "directml_device_id": device_id,
        "session_options": directml_session_options_metadata(),
        "sessions": sessions,
        "errors": errors,
    }


def session_metadata(model_name: str, model_path: Path, session: Any) -> dict[str, Any]:
    return {
        "model": model_name,
        "path": str(model_path),
        "providers": _safe_call_list(session, "get_providers"),
        "inputs": [_node_arg_metadata(value) for value in _safe_call_list(session, "get_inputs")],
        "outputs": [_node_arg_metadata(value) for value in _safe_call_list(session, "get_outputs")],
    }


def _safe_call_list(source: Any, method_name: str) -> list[Any]:
    method = getattr(source, method_name, None)
    if not callable(method):
        return []
    try:
        value = method()
    except Exception:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _node_arg_metadata(value: Any) -> dict[str, Any]:
    return {
        "name": str(getattr(value, "name", "")),
        "type": str(getattr(value, "type", "")),
        "shape": [_json_safe_shape_dim(dim) for dim in getattr(value, "shape", [])],
    }


def _json_safe_shape_dim(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def classify_smoke_status(
    probe_status: dict[str, Any],
    session_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(probe_status.get("blockers", []))
    session_state = str(session_smoke.get("state") or "unknown")
    if session_state == "session_failed":
        blockers.append("directml_session_failed")

    if not probe_status.get("directml_provider_available") or not probe_status.get("amd_igpu_detected"):
        state = "blocked"
    elif session_state == "session_ready":
        state = "session_ready"
    elif session_state == "session_failed":
        state = "session_failed"
    else:
        state = "ready_for_model"

    return {
        "state": state,
        "blockers": blockers,
        "directml_provider_available": bool(probe_status.get("directml_provider_available")),
        "amd_igpu_detected": bool(probe_status.get("amd_igpu_detected")),
        "model_artifacts_ready": bool(probe_status.get("model_artifacts_ready")),
        "session_ready": session_state == "session_ready",
        "current_safe_action": (
            "Keep production OCR on Paddle CUDA until DirectML session creation, "
            "inference correctness, latency, and adapter telemetry all pass."
        ),
        "recommended_next_step": _recommended_next_step(state),
    }


def _recommended_next_step(state: str) -> str:
    if state == "session_ready":
        return (
            "Add a deterministic DirectML OCR inference smoke with a small image and "
            "adapter telemetry before wiring an experimental provider."
        )
    if state == "session_failed":
        return "Inspect ONNX compatibility errors and adjust/export PP-OCR artifacts."
    if state == "blocked":
        return "Restore DirectML provider and AMD adapter visibility before model work."
    return "Place required PP-OCR ONNX artifacts in the model directory and rerun this smoke."


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(model_dir=args.model_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    state = report["status"]["state"]
    if args.fail_if_blocked and state == "blocked":
        raise SystemExit(1)
    if args.fail_if_not_session_ready and state != "session_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
