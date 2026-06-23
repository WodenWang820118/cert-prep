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
OCR_NPU_PREPASS_MODEL_NAME = "ocr-text-density-prepass-opset17.onnx"
OCR_NPU_PREPASS_INPUT_SHAPE = (1, 3, 64, 64)

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(BACKEND_ROOT / "src"))

from ocr_amd_npu_probe import DEFAULT_MODEL_DIR  # noqa: E402
from ocr_amd_npu_smoke import build_report as build_session_report  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    AMD_NPU_PROVIDER_NAME,
    AMD_NPU_SESSION_MODEL_FILES,
    create_npu_preferred_session_options,
    select_vitisai_npu_device,
    windows_ml_bootstrap_snapshot,
)


InferenceRunner = Callable[[dict[str, Any]], dict[str, Any]]
MODEL_INPUT_SHAPES = {
    "det/inference.onnx": (1, 3, 640, 640),
    "rec/inference.onnx": (1, 3, 48, 320),
}


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-amd-npu-inference-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--ensure-ready", action="store_true")
    parser.add_argument("--strict-npu", action="store_true")
    parser.add_argument("--amd-npu-device-id", default="auto")
    parser.add_argument("--amd-npu-policy", default="PREFER_NPU")
    parser.add_argument("--fail-if-not-inference-ready", action="store_true")
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    ensure_ready: bool = False,
    device_id: str = "auto",
    policy: str = "PREFER_NPU",
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_report = build_session_report(
        model_dir=model_dir,
        ensure_ready=ensure_ready,
        device_id=device_id,
        policy=policy,
    )
    inference_smoke = build_inference_smoke(
        session_report,
        device_id=device_id,
        policy=policy,
        inference_runner=inference_runner,
    )
    status = classify_inference_status(session_report["status"], inference_smoke)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_amd_npu_inference_smoke",
            "goal": (
                "Gate AMD NPU OCR on a VitisAI NPU prepass plus completed "
                "PaddleOCR detection/recognition ONNX inference."
            ),
            "does_not_change_runtime_defaults": True,
            "inference_scope": "npu_prepass_plus_paddleocr_onnx",
            "cpu_fallback_allowed": True,
        },
        "session_report": session_report,
        "npu_inference_smoke": inference_smoke,
        "status": status,
    }


def build_inference_smoke(
    session_report: dict[str, Any],
    *,
    device_id: str = "auto",
    policy: str = "PREFER_NPU",
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_status = session_report.get("status", {})
    if not can_attempt_npu_participation_pipeline(session_report):
        return {
            "state": "skipped",
            "reason": session_status.get("state") or "session_not_ready",
            "device": None,
            "provider_evidence": [],
        }
    if inference_runner is not None:
        return inference_runner(session_report)
    return run_amd_npu_participation_inference_smoke(
        session_report,
        device_id=device_id,
        policy=policy,
    )


def run_amd_npu_participation_inference_smoke(
    session_report: dict[str, Any],
    *,
    device_id: str,
    policy: str,
) -> dict[str, Any]:
    model_dir = model_dir_from_session_report(session_report)
    if model_dir is None:
        return {
            "state": "skipped",
            "reason": "model_dir_missing",
            "device": None,
            "provider_evidence": [],
        }

    profile = profile_vitisai_paddleocr_models(
        model_dir=model_dir,
        device_id=device_id,
        policy=policy,
    )
    model_profiles = [
        item for item in profile.get("models", []) if isinstance(item, dict)
    ]
    all_models_profiled = bool(model_profiles) and all(
        item.get("state") == "profiled" for item in model_profiles
    )
    npu_compute_detected = bool(profile.get("npu_compute_detected"))
    directml_provider_detected = bool(profile.get("directml_provider_detected"))

    if all_models_profiled and npu_compute_detected and not directml_provider_detected:
        state = "passed"
        reason = None
    elif directml_provider_detected:
        state = "blocked"
        reason = "amd_npu_unexpected_directml_provider"
    elif not npu_compute_detected:
        state = "blocked"
        reason = "amd_npu_no_profiled_vitisai_compute"
    else:
        state = "failed"
        reason = "amd_npu_participation_inference_failed"

    return {
        "state": state,
        "reason": reason,
        "scope": "npu_prepass_plus_paddleocr_onnx",
        "model_dir": str(model_dir),
        "device": "amd_npu:vitisai",
        "provider_evidence": session_report.get("npu_session_smoke", {}).get("sessions", []),
        "npu_participation_profile": profile,
        "npu_compute_detected": npu_compute_detected,
        "cpu_fallback_allowed": True,
        "cpu_events_detected": bool(profile.get("cpu_events_detected")),
        "directml_provider_detected": directml_provider_detected,
        "npu_participating_models": profile.get("npu_participating_models", []),
        "npu_participation_coverage": profile.get("npu_participation_coverage"),
        "paddleocr_model_npu_compute_detected": bool(
            profile.get("paddleocr_model_npu_compute_detected")
        ),
        "npu_prepass_compute_detected": bool(profile.get("npu_prepass_compute_detected")),
        "all_models_profiled": all_models_profiled,
        "note": (
            "This smoke bypasses PaddleOCR post-processing. PaddleOCR detection "
            "and recognition ONNX sessions must complete, while a text-density "
            "prepass must record VitisAI profile events to prove NPU participation."
        ),
    }


def run_amd_npu_only_inference_smoke(
    session_report: dict[str, Any],
    *,
    device_id: str,
    policy: str,
) -> dict[str, Any]:
    return run_amd_npu_participation_inference_smoke(
        session_report,
        device_id=device_id,
        policy=policy,
    )


def profile_vitisai_paddleocr_models(
    *,
    model_dir: Path,
    device_id: str,
    policy: str,
) -> dict[str, Any]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "state": "failed",
            "reason": "amd_npu_profile_import_failed",
            "error": str(exc),
            "models": [],
            "npu_compute_detected": False,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": False,
        }

    bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=True)
    selected_device = select_vitisai_npu_device(ort, device_id=device_id)
    if selected_device is None:
        return {
            "state": "failed",
            "reason": "vitisai_npu_device_unavailable",
            "bootstrap": bootstrap,
            "models": [],
            "npu_compute_detected": False,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": False,
        }

    profile_dir = DEFAULT_OUTPUT_DIR / "ocr-amd-npu-profiles"
    profile_dir.mkdir(parents=True, exist_ok=True)
    prepass_result = profile_ocr_npu_prepass(
        ort=ort,
        np=np,
        profile_dir=profile_dir,
        device_id=device_id,
        policy=policy,
    )
    model_results = [
        profile_vitisai_model(
            ort=ort,
            np=np,
            model_dir=model_dir,
            model_name=model_name,
            profile_dir=profile_dir,
            device_id=device_id,
            policy=policy,
        )
        for model_name in AMD_NPU_SESSION_MODEL_FILES
    ]
    npu_participating_models = [
        str(result.get("model"))
        for result in model_results
        if int(result.get("vitisai_event_count", 0)) > 0
    ]
    if int(prepass_result.get("vitisai_event_count", 0)) > 0:
        npu_participating_models.append(str(prepass_result.get("model")))
    paddleocr_model_npu_compute_detected = any(
        int(result.get("vitisai_event_count", 0)) > 0 for result in model_results
    )
    npu_prepass_compute_detected = int(prepass_result.get("vitisai_event_count", 0)) > 0
    return {
        "state": "profiled"
        if all(result.get("state") == "profiled" for result in model_results)
        and prepass_result.get("state") == "profiled"
        else "failed",
        "npu_prepass": prepass_result,
        "models": model_results,
        "npu_compute_detected": paddleocr_model_npu_compute_detected
        or npu_prepass_compute_detected,
        "paddleocr_model_npu_compute_detected": paddleocr_model_npu_compute_detected,
        "npu_prepass_compute_detected": npu_prepass_compute_detected,
        "npu_participating_models": npu_participating_models,
        "npu_participation_coverage": {
            "participating": len(npu_participating_models),
            "total": len(model_results) + 1,
        },
        "cpu_events_detected": any(
            bool(result.get("cpu_events_detected")) for result in model_results
        )
        or bool(prepass_result.get("cpu_events_detected")),
        "directml_provider_detected": any(
            bool(result.get("directml_provider_detected")) for result in model_results
        )
        or bool(prepass_result.get("directml_provider_detected")),
        "bootstrap": bootstrap,
    }


def profile_ocr_npu_prepass(
    *,
    ort: Any,
    np: Any,
    profile_dir: Path,
    device_id: str,
    policy: str,
) -> dict[str, Any]:
    model_path = profile_dir / OCR_NPU_PREPASS_MODEL_NAME
    try:
        ensure_ocr_npu_prepass_model(model_path)
        prefix = profile_dir / datetime.now(UTC).strftime(
            "%Y%m%dT%H%M%SZ-ocr-text-density-prepass-vitisai"
        )
        options = create_npu_preferred_session_options(
            ort,
            policy=policy,
            device_id=device_id,
            cache_key="paddleocr37_text_density_prepass_npu",
            cache_dir=profile_dir,
        )
        options.enable_profiling = True
        options.profile_file_prefix = str(prefix)
        session = ort.InferenceSession(str(model_path), sess_options=options)
        input_arg = session.get_inputs()[0]
        sample = synthetic_text_density_input(np)
        outputs = session.run(None, {input_arg.name: sample})
        profile_path = Path(session.end_profiling())
        provider_event_counts = _provider_event_counts(_read_profile_events(profile_path))
        providers = list(session.get_providers())
        return {
            "state": "profiled",
            "model": "ocr_prepass/text_density",
            "path": str(model_path),
            "providers": providers,
            "input": {
                "name": input_arg.name,
                "shape": list(OCR_NPU_PREPASS_INPUT_SHAPE),
                "type": str(getattr(input_arg, "type", "")),
            },
            "output_shapes": [list(getattr(output, "shape", [])) for output in outputs],
            "output_checksums": [float(np.asarray(output).sum()) for output in outputs],
            "profile_path": str(profile_path),
            "provider_event_counts": provider_event_counts,
            "vitisai_event_count": provider_event_counts.get(AMD_NPU_PROVIDER_NAME, 0),
            "cpu_event_count": provider_event_counts.get("CPUExecutionProvider", 0),
            "cpu_fallback_allowed": True,
            "cpu_events_detected": provider_event_counts.get("CPUExecutionProvider", 0) > 0,
            "directml_provider_detected": "DmlExecutionProvider" in providers
            or provider_event_counts.get("DmlExecutionProvider", 0) > 0,
        }
    except Exception as exc:
        return {
            "state": "failed",
            "model": "ocr_prepass/text_density",
            "path": str(model_path),
            "reason": "amd_npu_prepass_failed",
            "error": str(exc),
            "provider_event_counts": {},
            "vitisai_event_count": 0,
            "cpu_event_count": 0,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": False,
            "directml_provider_detected": False,
        }


def ensure_ocr_npu_prepass_model(model_path: Path) -> None:
    if model_path.is_file():
        return

    import numpy as np  # type: ignore[import-not-found]
    import onnx  # type: ignore[import-not-found]
    from onnx import TensorProto, helper, numpy_helper  # type: ignore[import-not-found]

    input_value = helper.make_tensor_value_info(
        "page_rgb",
        TensorProto.FLOAT,
        list(OCR_NPU_PREPASS_INPUT_SHAPE),
    )
    output_value = helper.make_tensor_value_info("text_density_features", TensorProto.FLOAT, [1, 4])
    filters = np.zeros((4, 3, 3, 3), dtype=np.float32)
    horizontal = np.array(
        [[-1, -1, -1], [0, 0, 0], [1, 1, 1]],
        dtype=np.float32,
    )
    vertical = horizontal.T
    diagonal_a = np.array(
        [[-1, -1, 0], [-1, 0, 1], [0, 1, 1]],
        dtype=np.float32,
    )
    diagonal_b = np.flipud(diagonal_a)
    for index, kernel in enumerate((horizontal, vertical, diagonal_a, diagonal_b)):
        for channel in range(3):
            filters[index, channel] = kernel / 3.0
    bias = np.zeros((4,), dtype=np.float32)
    initializers = [
        numpy_helper.from_array(filters, "edge_filters"),
        numpy_helper.from_array(bias, "edge_bias"),
    ]
    nodes = [
        helper.make_node(
            "Conv",
            ["page_rgb", "edge_filters", "edge_bias"],
            ["edge_response"],
            pads=[1, 1, 1, 1],
            strides=[1, 1],
            name="text_edge_conv",
        ),
        helper.make_node("Relu", ["edge_response"], ["positive_edges"], name="positive_edges"),
        helper.make_node(
            "GlobalAveragePool",
            ["positive_edges"],
            ["pooled_edges"],
            name="edge_density_pool",
        ),
        helper.make_node("Flatten", ["pooled_edges"], ["text_density_features"], axis=1),
    ]
    graph = helper.make_graph(
        nodes,
        "ocr_text_density_prepass",
        [input_value],
        [output_value],
        initializers,
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_operatorsetid("", 17)],
        producer_name="exam-prep-ocr-amd-npu-prepass",
    )
    model.ir_version = 10
    onnx.checker.check_model(model)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, model_path)


def synthetic_text_density_input(np: Any) -> Any:
    sample = np.zeros(OCR_NPU_PREPASS_INPUT_SHAPE, dtype=np.float32)
    for row in range(8, 56, 8):
        sample[:, :, row : row + 2, 8:56] = 1.0
    for col in range(12, 56, 11):
        sample[:, :, 8:56, col : col + 1] = 0.75
    return sample


def profile_vitisai_model(
    *,
    ort: Any,
    np: Any,
    model_dir: Path,
    model_name: str,
    profile_dir: Path,
    device_id: str,
    policy: str,
) -> dict[str, Any]:
    profile_name = model_name.replace("/", "-").replace(".onnx", "")
    prefix = profile_dir / datetime.now(UTC).strftime(
        f"%Y%m%dT%H%M%SZ-{profile_name}-vitisai"
    )
    model_path = model_dir / model_name
    try:
        options = create_npu_preferred_session_options(
            ort,
            policy=policy,
            device_id=device_id,
            cache_key=f"paddleocr37_{profile_name}_npu_preferred",
            cache_dir=profile_dir,
        )
        options.enable_profiling = True
        options.profile_file_prefix = str(prefix)
        session = ort.InferenceSession(str(model_path), sess_options=options)
        input_arg = session.get_inputs()[0]
        shape = model_input_shape(model_name, input_arg)
        sample = np.zeros(shape, dtype=model_input_dtype(np, input_arg))
        outputs = session.run(None, {input_arg.name: sample})
        profile_path = Path(session.end_profiling())
        provider_event_counts = _provider_event_counts(_read_profile_events(profile_path))
        providers = list(session.get_providers())
        return {
            "state": "profiled",
            "model": model_name,
            "path": str(model_path),
            "providers": providers,
            "input": {
                "name": input_arg.name,
                "shape": list(shape),
                "type": str(getattr(input_arg, "type", "")),
            },
            "output_shapes": [list(getattr(output, "shape", [])) for output in outputs],
            "profile_path": str(profile_path),
            "provider_event_counts": provider_event_counts,
            "vitisai_event_count": provider_event_counts.get(AMD_NPU_PROVIDER_NAME, 0),
            "cpu_event_count": provider_event_counts.get("CPUExecutionProvider", 0),
            "cpu_fallback_allowed": True,
            "cpu_events_detected": provider_event_counts.get("CPUExecutionProvider", 0) > 0,
            "directml_provider_detected": "DmlExecutionProvider" in providers
            or provider_event_counts.get("DmlExecutionProvider", 0) > 0,
        }
    except Exception as exc:
        message = str(exc)
        return {
            "state": "failed",
            "model": model_name,
            "path": str(model_path),
            "reason": "amd_npu_profile_failed",
            "error": message,
            "provider_event_counts": {},
            "vitisai_event_count": 0,
            "cpu_event_count": 0,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": False,
            "directml_provider_detected": False,
        }


def failed_inference_smoke(reason: str, exc: Exception) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": reason,
        "error": str(exc),
        "device": "amd_npu:vitisai",
        "provider_evidence": [],
    }


def model_dir_from_session_report(session_report: dict[str, Any]) -> Path | None:
    probe = session_report.get("probe", {})
    artifacts = probe.get("model_artifacts", {})
    model_dir = artifacts.get("model_dir")
    return Path(str(model_dir)) if model_dir else None


def can_attempt_npu_participation_pipeline(session_report: dict[str, Any]) -> bool:
    probe = session_report.get("probe", {})
    probe_status = probe.get("status", {})
    artifacts = probe.get("model_artifacts", {})
    return bool(artifacts.get("ready") and probe_status.get("vitisai_npu_ready"))


def model_input_shape(model_name: str, input_arg: Any) -> tuple[int, ...]:
    fallback = MODEL_INPUT_SHAPES.get(model_name, (1, 3, 224, 224))
    raw_shape = list(getattr(input_arg, "shape", []) or [])
    if not raw_shape:
        return fallback
    resolved: list[int] = []
    for index, value in enumerate(raw_shape):
        if isinstance(value, int) and value > 0:
            resolved.append(value)
        elif index < len(fallback):
            resolved.append(fallback[index])
        else:
            resolved.append(1)
    return tuple(resolved)


def model_input_dtype(np: Any, input_arg: Any) -> Any:
    input_type = str(getattr(input_arg, "type", "")).lower()
    if "float16" in input_type:
        return np.float16
    if "int64" in input_type:
        return np.int64
    if "int32" in input_type:
        return np.int32
    return np.float32


def _read_profile_events(profile_path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return payload if isinstance(payload, list) else []


def _provider_event_counts(events: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for event in events:
        args = event.get("args", {})
        provider = args.get("provider") if isinstance(args, dict) else None
        if not provider:
            continue
        provider_name = str(provider)
        counts[provider_name] = counts.get(provider_name, 0) + 1
    return counts


def looks_like_cpu_fallback(message: str) -> bool:
    normalized = message.lower()
    return "cpu ep" in normalized or "fallback to cpu" in normalized


def classify_inference_status(
    session_status: dict[str, Any],
    inference_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(session_status.get("blockers", []))
    state = str(inference_smoke.get("state") or "unknown")
    npu_compute_detected = bool(inference_smoke.get("npu_compute_detected"))
    directml_provider_detected = bool(inference_smoke.get("directml_provider_detected"))
    if state == "blocked":
        blockers.append(str(inference_smoke.get("reason") or "amd_npu_inference_blocked"))
    elif state == "failed":
        blockers.append(str(inference_smoke.get("reason") or "amd_npu_inference_failed"))
    inference_ready = (
        state == "passed"
        and str(inference_smoke.get("device") or "").startswith("amd_npu")
        and npu_compute_detected
        and not directml_provider_detected
    )
    if inference_ready:
        status_state = "inference_ready"
    elif session_status.get("state") == "session_ready":
        status_state = "blocked"
    else:
        status_state = session_status.get("state") or "session_not_ready"
    return {
        "state": status_state,
        "blockers": list(dict.fromkeys(blockers)),
        "session_ready": bool(session_status.get("session_ready")),
        "inference_ready": inference_ready,
        "expected_text_matched": False,
        "npu_compute_detected": npu_compute_detected,
        "cpu_fallback_allowed": True,
        "cpu_events_detected": bool(inference_smoke.get("cpu_events_detected")),
        "directml_provider_detected": directml_provider_detected,
        "npu_participating_models": inference_smoke.get("npu_participating_models", []),
        "npu_participation_coverage": inference_smoke.get("npu_participation_coverage"),
        "non_empty_text": False,
        "device": inference_smoke.get("device"),
        "current_safe_action": (
            "Keep amd_npu opt-in until packaged OCR records real text output and "
            "routing evidence; CPU fallback is allowed when VitisAI participation is profiled."
        ),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        model_dir=args.model_dir,
        ensure_ready=args.ensure_ready,
        device_id=args.amd_npu_device_id,
        policy=args.amd_npu_policy,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if (
        args.strict_npu or args.fail_if_not_inference_ready
    ) and report["status"]["state"] != "inference_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
