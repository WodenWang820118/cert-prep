from __future__ import annotations

import argparse
from collections import Counter
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
import json
from pathlib import Path
import sys
from typing import Any

from cert_prep_ocr_windowsml.paths import DEFAULT_OUTPUT_DIR
from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_probe import (
    DEFAULT_MODEL_DIR,
    build_report as build_probe_report,
)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


SESSION_MODEL_FILES = (
    "det/inference.onnx",
    "rec/inference.onnx",
)
WINDOWSML_DEVICE_LABEL = "amd_windowsml"
WINDOWSML_IGPU_PROVIDER = "DmlExecutionProvider"
WINDOWSML_PROVIDERS = [WINDOWSML_IGPU_PROVIDER, "CPUExecutionProvider"]
SessionSmokeRunner = Callable[[dict[str, Path], int | None], dict[str, Any]]


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-blocked",
        action="store_true",
        help="Exit non-zero only when WindowsML itself is unavailable.",
    )
    parser.add_argument(
        "--fail-if-not-session-ready",
        action="store_true",
        help="Exit non-zero unless WindowsML sessions can be created for required models.",
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
            "name": "ocr_windowsml_session_smoke",
            "goal": (
                "Verify that required PP-OCRv6 ONNX model files can create ONNX "
                "Runtime WindowsML sessions and collect profiling evidence for "
                "provider scheduling before production OCR packaging."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
            "runs_ocr_inference": False,
        },
        "probe": probe,
        "windowsml_session_smoke": session_smoke,
        "status": status,
    }


def build_session_smoke(
    probe: dict[str, Any],
    *,
    session_runner: SessionSmokeRunner | None = None,
) -> dict[str, Any]:
    session_runner = session_runner or run_windowsml_session_smoke
    status = probe.get("status", {})
    if not status.get("windowsml_provider_available"):
        return skipped_session_smoke("windowsml_provider_unavailable")
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
    return session_runner(model_files, windowsml_device_id(status))


def skipped_session_smoke(reason: str) -> dict[str, Any]:
    return {
        "state": "skipped",
        "reason": reason,
        "providers_requested": windowsml_provider_names(),
        "session_options": windowsml_session_options_metadata(),
        "sessions": [],
        "errors": [],
        "provider_mix": {
            "providers_seen": [],
            "provider_counts": {},
            "mixed_execution_detected": False,
            "inference_executed": False,
        },
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


def windowsml_device_id(probe_status: dict[str, Any]) -> int | None:
    raw = probe_status.get("windowsml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def windowsml_providers(device_id: int | None) -> list[Any]:
    if device_id is None:
        return windowsml_provider_names()
    return [
        (WINDOWSML_IGPU_PROVIDER, {"device_id": str(device_id)}),
        "CPUExecutionProvider",
    ]


def windowsml_provider_names() -> list[str]:
    return list(WINDOWSML_PROVIDERS)


def windowsml_session_options_metadata() -> dict[str, Any]:
    return {
        "enable_mem_pattern": False,
        "execution_mode": "ORT_SEQUENTIAL",
        "execution_policy": "paddleocr37_windowsml",
        "selection_mode": "windowsml_amd_igpu",
        "providers_requested": windowsml_provider_names(),
        "reason": (
            "PaddleOCR 3.7 engine='onnxruntime' validates provider names through "
            "ONNX Runtime and currently uses the WindowsML iGPU lane plus CPU "
            "fallback for unsupported operators."
        ),
    }


def create_windowsml_session_options(ort: Any) -> Any:
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    try:
        options.profile_file_prefix = str(onnxruntime_profile_prefix())
    except Exception:
        pass
    _enable_session_profiling(options)
    return options


def onnxruntime_profile_prefix() -> Path:
    profile_dir = DEFAULT_OUTPUT_DIR / "onnxruntime-profiles"
    profile_dir.mkdir(parents=True, exist_ok=True)
    return profile_dir / "session-smoke"


def run_windowsml_session_smoke(
    model_files: dict[str, Path],
    device_id: int | None,
) -> dict[str, Any]:
    sessions: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "state": "session_failed",
            "providers_requested": windowsml_provider_names(),
            "device": WINDOWSML_DEVICE_LABEL,
            "session_options": windowsml_session_options_metadata(),
            "sessions": sessions,
            "errors": [{"model": "*", "error": str(exc)}],
        }

    for model_name in SESSION_MODEL_FILES:
        model_path = model_files[model_name]
        try:
            options = create_windowsml_session_options(ort)
            session = ort.InferenceSession(
                str(model_path),
                sess_options=options,
                providers=windowsml_providers(device_id),
            )
            sessions.append(
                {
                    **session_metadata(model_name, model_path, session),
                    "provider_mix": collect_provider_mix(session, model_name),
                }
            )
        except Exception as exc:
            errors.append({"model": model_name, "error": str(exc)})

    return {
        "state": "session_ready" if not errors else "session_failed",
        "providers_requested": windowsml_provider_names(),
        "device": WINDOWSML_DEVICE_LABEL,
        "windowsml_device_id": device_id,
        "session_options": windowsml_session_options_metadata(),
        "sessions": sessions,
        "errors": errors,
        "provider_mix": aggregate_provider_mix_from_sessions(sessions),
    }


def collect_provider_mix(
    session: Any,
    model_name: str,
) -> dict[str, Any]:
    base_report = {
        "profile_file": None,
        "providers_seen": [],
        "provider_counts": {},
        "mixed_execution_detected": False,
        "inference_executed": False,
    }
    try:
        profile_path = run_profile_capture(session, model_name)
    except Exception as exc:
        base_report["profiling_error"] = str(exc)
        return base_report

    if profile_path is None:
        return base_report

    try:
        provider_summary = summarize_provider_mix(profile_path)
        base_report["inference_executed"] = True
        base_report.update(provider_summary)
    except Exception as exc:
        base_report["profiling_error"] = str(exc)
    return base_report


def _enable_session_profiling(options: Any) -> bool:
    try:
        options.enable_profiling = True
    except Exception:
        return False
    return True


def run_profile_capture(session: Any, model_name: str) -> Path | None:
    profile_path: Path | None = None
    try:
        feed = build_profile_feed(session)
        session.run(None, feed)
    except Exception as exc:
        profile_path = end_session_profiling(session)
        raise RuntimeError(f"{model_name}: profiling run failed: {exc}") from exc
    finally:
        if profile_path is None:
            profile_path = end_session_profiling(session)

    return profile_path


def end_session_profiling(session: Any) -> Path | None:
    end_profiling = getattr(session, "end_profiling", None)
    if not callable(end_profiling):
        return None
    try:
        resolved_path = end_profiling()
    except Exception:
        return None
    if not resolved_path:
        return None
    try:
        return Path(str(resolved_path))
    except Exception:
        return None


def build_profile_feed(session: Any) -> dict[str, Any]:
    inputs = _safe_call_list(session, "get_inputs")
    if not inputs:
        return {}
    return build_zero_inputs_for_nodes(inputs)


def build_zero_inputs_for_nodes(inputs: Sequence[Any]) -> dict[str, Any]:
    import numpy as np

    feed: dict[str, Any] = {}
    for node in inputs:
        name = str(getattr(node, "name", ""))
        if not name:
            continue
        dtype = numpy_dtype_from_node_type(str(getattr(node, "type", "")))
        shape = normalize_node_shape(getattr(node, "shape", ()))
        feed[name] = np.zeros(shape, dtype=dtype)
    return feed


def numpy_dtype_from_node_type(type_name: str) -> Any:
    normalized = type_name.strip().lower()
    if normalized.startswith("tensor(") and normalized.endswith(")"):
        normalized = normalized[len("tensor(") : -1]
    return {
        "float": __import__("numpy").float32,
        "float16": __import__("numpy").float16,
        "float32": __import__("numpy").float32,
        "float64": __import__("numpy").float64,
        "double": __import__("numpy").float64,
        "int8": __import__("numpy").int8,
        "int16": __import__("numpy").int16,
        "int32": __import__("numpy").int32,
        "int64": __import__("numpy").int64,
        "uint8": __import__("numpy").uint8,
        "uint16": __import__("numpy").uint16,
        "uint32": __import__("numpy").uint32,
        "uint64": __import__("numpy").uint64,
        "bool": __import__("numpy").bool_,
    }.get(normalized, __import__("numpy").float32)


def normalize_node_shape(shape: Any) -> list[int]:
    if not isinstance(shape, (list, tuple)) or not shape:
        return [1]

    normalized: list[int] = []
    for dim in shape:
        if isinstance(dim, bool):
            normalized.append(1 if dim else 1)
        elif isinstance(dim, int) and dim > 0:
            normalized.append(dim)
        elif isinstance(dim, str) and dim.isdigit():
            value = int(dim)
            normalized.append(value if value > 0 else 1)
        else:
            normalized.append(1)
    return normalized or [1]


def summarize_provider_mix(profile_path: Path) -> dict[str, Any]:
    events = _load_profile_events(profile_path)
    counts = Counter(_extract_provider_from_profile_event(event) for event in events)
    provider_counts = {
        provider: count
        for provider, count in sorted(counts.items(), key=lambda item: item[0])
        if provider in WINDOWSML_PROVIDERS
    }
    providers_seen = [provider for provider in windowsml_provider_names() if provider in provider_counts]
    if "CPUExecutionProvider" in provider_counts:
        provider_counts["CPUExecutionProvider"] = provider_counts["CPUExecutionProvider"]
    return {
        "profile_file": str(profile_path),
        "providers_seen": providers_seen,
        "provider_counts": provider_counts,
        "mixed_execution_detected": (
            WINDOWSML_IGPU_PROVIDER in provider_counts
            and "CPUExecutionProvider" in provider_counts
        ),
    }


def _extract_provider_from_profile_event(event: Any) -> str:
    if not isinstance(event, dict):
        return ""
    args = event.get("args")
    if isinstance(args, dict):
        for key in ("provider", "provider_name", "provider_name_", "execution_provider"):
            value = args.get(key)
            if isinstance(value, str):
                normalized = _normalize_provider_name(value)
                if normalized:
                    return normalized
    return ""


def _normalize_provider_name(value: str) -> str:
    lowered = value.lower()
    if "dmlexecutionprovider" in lowered:
        return WINDOWSML_IGPU_PROVIDER
    if "cpuexecutionprovider" in lowered:
        return "CPUExecutionProvider"
    if value in WINDOWSML_PROVIDERS:
        return value
    return ""


def _load_profile_events(profile_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(profile_path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else []


def aggregate_provider_mix_from_sessions(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    counts = Counter()
    for session in sessions:
        mix = session.get("provider_mix")
        if not isinstance(mix, dict):
            continue
        for provider, value in mix.get("provider_counts", {}).items():
            if provider in WINDOWSML_PROVIDERS and isinstance(value, int):
                counts[provider] += value
    provider_counts = {provider: counts[provider] for provider in windowsml_provider_names() if provider in counts}
    providers_seen = [provider for provider in windowsml_provider_names() if provider in provider_counts]
    return {
        "providers_seen": providers_seen,
        "provider_counts": provider_counts,
        "mixed_execution_detected": len(providers_seen) >= 2,
    }


def session_metadata(
    model_name: str,
    model_path: Path,
    session: Any,
) -> dict[str, Any]:
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
        blockers.append("windowsml_session_failed")

    if not probe_status.get("windowsml_provider_available") or not probe_status.get("amd_igpu_detected"):
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
        "windowsml_provider_available": bool(probe_status.get("windowsml_provider_available")),
        "amd_igpu_detected": bool(probe_status.get("amd_igpu_detected")),
        "model_artifacts_ready": bool(probe_status.get("model_artifacts_ready")),
        "session_ready": session_state == "session_ready",
        "current_safe_action": (
            "Keep OCR on the AMD iGPU WindowsML lane only when WindowsML session "
            "creation, inference correctness, latency, and adapter telemetry pass."
        ),
        "recommended_next_step": _recommended_next_step(state),
    }


def _recommended_next_step(state: str) -> str:
    if state == "session_ready":
        return (
            "Run deterministic PaddleOCR 3.7 WindowsML inference and adapter telemetry."
        )
    if state == "session_failed":
        return "Inspect ONNX compatibility errors and adjust/export PP-OCR artifacts."
    if state == "blocked":
        return "Restore WindowsML provider and AMD adapter visibility before model work."
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
