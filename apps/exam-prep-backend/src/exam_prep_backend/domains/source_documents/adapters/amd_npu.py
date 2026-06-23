from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import importlib.util
import json
import os
import platform
import subprocess
import tempfile
from time import perf_counter
from typing import Any

from exam_prep_backend.domains.source_documents.adapters.directml import (
    DirectMLOCRRunner,
    PADDLEOCR37_REQUIRED_MODEL_FILES,
    _onnxruntime_state,
    _paddleocr_state,
)
from exam_prep_backend.domains.source_documents.ocr_contracts import OCRHealth, OCRPageResult
from exam_prep_backend.exceptions import ProviderUnavailableError


AMD_NPU_PROVIDER_NAME = "VitisAIExecutionProvider"
AMD_NPU_DEVICE_LABEL = "amd_npu:vitisai"
AMD_NPU_REQUIRED_MODEL_FILES = PADDLEOCR37_REQUIRED_MODEL_FILES
AMD_NPU_SESSION_MODEL_FILES = ("det/inference.onnx", "rec/inference.onnx")
AMD_NPU_PREPASS_MODEL_NAME = "ocr-text-density-prepass-opset17.onnx"
AMD_NPU_PREPASS_INPUT_SHAPE = (1, 3, 64, 64)
AMD_NPU_POLICY_NAMES = {
    "DEFAULT",
    "MAX_EFFICIENCY",
    "MIN_OVERALL_POWER",
    "PREFER_NPU",
    "PREFER_GPU",
    "MAX_PERFORMANCE",
}
REAL_OCR_GATE_DETAIL = (
    "AMD NPU PaddleOCR sessions are ready for NPU-preferred execution, but "
    "packaged OCR remains gated until real OCR inference and routing evidence pass."
)


class AmdNpuOCRProvider:
    """Blocked-until-ready AMD NPU OCR provider for the Windows ML lane."""

    provider = "amd_npu"
    engine = "onnxruntime-windowsml-vitisai"
    page_workers = 1

    def health(self) -> OCRHealth:
        bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=False)
        unavailable_reason = _bootstrap_unavailable_reason(bootstrap)
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=False,
            detail=_bootstrap_detail(bootstrap),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=bootstrap.get("onnxruntime_version"),
            selected_device=AMD_NPU_DEVICE_LABEL
            if bootstrap.get("vitisai_npu_ready")
            else None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason=unavailable_reason,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise ProviderUnavailableError(
            "AMD NPU OCR is gated until VitisAI participation inference, "
            "real OCR inference, packaged streaming, and routing evidence pass."
        )


class AmdNpuRuntimeOCRProvider:
    """Packaged AMD NPU OCR runtime gate.

    The current product lane intentionally reports unavailable until the
    PaddleOCR ONNX detection and recognition sessions run in NPU-preferred
    mode and record VitisAI participation evidence.
    """

    provider = "amd_npu"
    engine = "paddleocr-3.7-onnxruntime-windowsml-vitisai-participation"
    page_workers = 1

    def __init__(
        self,
        *,
        model_dir: Path,
        directml_device_id: int = -1,
        npu_device_id: str = "auto",
        npu_policy: str = "PREFER_NPU",
        ensure_ready: bool = False,
    ) -> None:
        self.model_dir = model_dir
        self.directml_device_id = directml_device_id
        self.npu_device_id = npu_device_id
        self.npu_policy = normalize_npu_policy(npu_policy)
        self.ensure_ready = ensure_ready
        self._ocr_runner = DirectMLOCRRunner(
            model_dir=model_dir,
            device_id=directml_device_id,
        )
        self._prepass_runner = AmdNpuPrepassRunner(
            model_dir=model_dir,
            device_id=npu_device_id,
            policy=self.npu_policy,
        )

    def health(self) -> OCRHealth:
        _providers, ort_version, ort_import_error = _onnxruntime_state()
        paddleocr_version, paddleocr_error = _paddleocr_state()
        directml_available = "DmlExecutionProvider" in _providers
        missing_files = missing_model_files(self.model_dir)
        session_report = npu_preferred_session_report(
            model_dir=self.model_dir,
            ensure_ready=self.ensure_ready,
            policy=self.npu_policy,
            device_id=self.npu_device_id,
        )
        session_state = str(session_report["status"]["state"])
        unavailable_reason = _runtime_unavailable_reason(
            ort_import_error=ort_import_error,
            paddleocr_error=paddleocr_error,
            missing_files=missing_files,
            session_report=session_report,
            directml_available=directml_available,
        )
        available = (
            unavailable_reason is None
            and session_report["status"].get("state") == "session_ready"
        )
        detail = _runtime_detail(
            ort_import_error=ort_import_error,
            paddleocr_error=paddleocr_error,
            missing_files=missing_files,
            session_report=session_report,
            directml_available=directml_available,
        )
        selected_device = AMD_NPU_DEVICE_LABEL if session_state == "session_ready" else None
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=available,
            detail=detail,
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=paddleocr_version or ort_version,
            selected_device=selected_device,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=str(self.model_dir),
            fallback_reason=None,
            unavailable_reason=unavailable_reason,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        health = self.health()
        if not health.available:
            raise ProviderUnavailableError(health.detail or REAL_OCR_GATE_DETAIL)
        prepass = self._prepass_runner.run(image_png)
        result = self._ocr_runner.extract_text(image_png)
        return OCRPageResult(
            text=result.text,
            extraction_method="amd_npu_ocr",
            device=f"{AMD_NPU_DEVICE_LABEL}+{result.device}",
            fallback_reason=(
                "npu_prepass=text_density_vitisai;"
                f"vitisai_events={prepass.vitisai_event_count};"
                "paddleocr_det_rec=directml"
            ),
            duration_ms=result.duration_ms + prepass.duration_ms,
        )


@dataclass(frozen=True)
class AmdNpuPrepassResult:
    duration_ms: int
    vitisai_event_count: int
    cpu_event_count: int
    features_checksum: float
    profile_path: str | None


class AmdNpuPrepassRunner:
    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: str,
        policy: str,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self.policy = normalize_npu_policy(policy)

    def run(self, image_png: bytes) -> AmdNpuPrepassResult:
        started = perf_counter()
        try:
            import numpy as np  # type: ignore[import-not-found]
            import onnxruntime as ort  # type: ignore[import-not-found]
        except Exception as exc:
            raise ProviderUnavailableError(f"AMD NPU prepass runtime unavailable: {exc}") from exc

        model_path = self._model_path()
        ensure_ocr_text_density_prepass_model(model_path)
        profile_dir = self._profile_dir()
        profile_dir.mkdir(parents=True, exist_ok=True)
        profile_prefix = profile_dir / "amd-npu-ocr-prepass"
        options = create_npu_preferred_session_options(
            ort,
            policy=self.policy,
            device_id=self.device_id,
            cache_key="paddleocr37_text_density_prepass_npu",
            cache_dir=profile_dir,
        )
        options.enable_profiling = True
        options.profile_file_prefix = str(profile_prefix)
        session = ort.InferenceSession(str(model_path), sess_options=options)
        input_arg = session.get_inputs()[0]
        outputs = session.run(None, {input_arg.name: image_png_to_prepass_input(np, image_png)})
        profile_path = Path(session.end_profiling())
        provider_event_counts = _provider_event_counts_from_profile(profile_path)
        vitisai_event_count = provider_event_counts.get(AMD_NPU_PROVIDER_NAME, 0)
        if vitisai_event_count <= 0:
            raise ProviderUnavailableError("AMD NPU prepass did not record VitisAI execution.")
        return AmdNpuPrepassResult(
            duration_ms=_elapsed_ms(started),
            vitisai_event_count=vitisai_event_count,
            cpu_event_count=provider_event_counts.get("CPUExecutionProvider", 0),
            features_checksum=float(np.asarray(outputs[0]).sum()) if outputs else 0.0,
            profile_path=str(profile_path),
        )

    def _model_path(self) -> Path:
        candidate = self.model_dir / "_npu_prepass" / AMD_NPU_PREPASS_MODEL_NAME
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            return candidate
        except Exception:
            fallback = Path(tempfile.gettempdir()) / "exam-prep-amd-npu-prepass"
            return fallback / AMD_NPU_PREPASS_MODEL_NAME

    def _profile_dir(self) -> Path:
        candidate = self.model_dir / "_npu_prepass" / "profiles"
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except Exception:
            fallback = Path(tempfile.gettempdir()) / "exam-prep-amd-npu-prepass" / "profiles"
            fallback.mkdir(parents=True, exist_ok=True)
            return fallback


def normalize_npu_policy(policy: str) -> str:
    normalized = str(policy or "PREFER_NPU").strip().upper()
    return normalized if normalized in AMD_NPU_POLICY_NAMES else "PREFER_NPU"


def missing_model_files(model_dir: Path) -> list[str]:
    return [
        name
        for name in AMD_NPU_REQUIRED_MODEL_FILES
        if not (model_dir / name).is_file()
    ]


def ensure_ocr_text_density_prepass_model(model_path: Path) -> None:
    if model_path.is_file():
        return

    import numpy as np  # type: ignore[import-not-found]
    import onnx  # type: ignore[import-not-found]
    from onnx import TensorProto, helper, numpy_helper  # type: ignore[import-not-found]

    input_value = helper.make_tensor_value_info(
        "page_rgb",
        TensorProto.FLOAT,
        list(AMD_NPU_PREPASS_INPUT_SHAPE),
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
    initializers = [
        numpy_helper.from_array(filters, "edge_filters"),
        numpy_helper.from_array(np.zeros((4,), dtype=np.float32), "edge_bias"),
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


def image_png_to_prepass_input(np: Any, image_png: bytes) -> Any:
    from PIL import Image  # type: ignore[import-not-found]

    with Image.open(BytesIO(image_png)) as image:
        rgb = image.convert("RGB").resize(
            (AMD_NPU_PREPASS_INPUT_SHAPE[3], AMD_NPU_PREPASS_INPUT_SHAPE[2])
        )
        array = np.asarray(rgb, dtype=np.float32) / 255.0
    return np.transpose(array, (2, 0, 1))[None, :, :, :]


def _provider_event_counts_from_profile(profile_path: Path) -> dict[str, int]:
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    events = payload if isinstance(payload, list) else []
    counts: dict[str, int] = {}
    for event in events:
        args = event.get("args", {}) if isinstance(event, dict) else {}
        provider = args.get("provider") if isinstance(args, dict) else None
        if not provider:
            continue
        provider_name = str(provider)
        counts[provider_name] = counts.get(provider_name, 0) + 1
    return counts


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))


def windows_ml_bootstrap_snapshot(*, ensure_ready: bool = False) -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "available": False,
            "import_error": str(exc),
            "onnxruntime_version": None,
            "providers": [],
            "ep_devices": [],
            "vitisai_npu_devices": [],
            "vitisai_npu_ready": False,
        }

    providers_before = _available_providers(ort)
    devices_before = ep_device_metadata(ort)
    registration = (
        register_vitisai_ep_library(ort) if ensure_ready else {"requested": False}
    )
    providers_after = _available_providers(ort)
    devices_after = ep_device_metadata(ort)
    vitisai_devices = _vitisai_devices(devices_after)
    return {
        "available": True,
        "target_ep": AMD_NPU_PROVIDER_NAME,
        "register_requested": ensure_ready,
        "onnxruntime_version": getattr(ort, "__version__", None),
        "providers_before_windows_ml": providers_before,
        "providers_after_windows_ml": providers_after,
        "ep_devices_before_windows_ml": devices_before,
        "ep_devices_after_windows_ml": devices_after,
        "ep_devices": devices_after,
        "registration": registration,
        "vitisai_library_path": registration.get("library_path"),
        "vitisai_ep_registered": bool(registration.get("registered"))
        or bool(vitisai_devices),
        "vitisai_npu_devices": vitisai_devices,
        "vitisai_npu_ready": bool(vitisai_devices),
    }


def strict_npu_session_report(
    *,
    model_dir: Path,
    ensure_ready: bool = False,
    policy: str = "PREFER_NPU",
    device_id: str = "auto",
) -> dict[str, Any]:
    bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=ensure_ready)
    missing_files = missing_model_files(model_dir)
    if bootstrap.get("import_error"):
        session_smoke = skipped_session_smoke("onnxruntime_import_failed")
    elif missing_files:
        session_smoke = skipped_session_smoke("model_artifacts_missing") | {
            "missing_required": missing_files,
        }
    elif not bootstrap.get("vitisai_npu_ready"):
        session_smoke = skipped_session_smoke("vitisai_npu_not_ready")
    else:
        session_smoke = run_strict_npu_session_smoke(
            model_dir=model_dir,
            policy=policy,
            device_id=device_id,
        )
    status = classify_strict_npu_status(
        bootstrap=bootstrap,
        missing_files=missing_files,
        session_smoke=session_smoke,
    )
    return {
        "schema_version": 1,
        "model_dir": str(model_dir),
        "bootstrap": bootstrap,
        "model_artifacts": {
            "model_dir": str(model_dir),
            "required_files": list(AMD_NPU_REQUIRED_MODEL_FILES),
            "session_model_files": list(AMD_NPU_SESSION_MODEL_FILES),
            "missing_required": missing_files,
            "ready": not missing_files,
        },
        "npu_session_smoke": session_smoke,
        "status": status,
    }


def npu_preferred_session_report(
    *,
    model_dir: Path,
    ensure_ready: bool = False,
    policy: str = "PREFER_NPU",
    device_id: str = "auto",
) -> dict[str, Any]:
    bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=ensure_ready)
    missing_files = missing_model_files(model_dir)
    if bootstrap.get("import_error"):
        session_smoke = skipped_participation_session_smoke("onnxruntime_import_failed")
    elif missing_files:
        session_smoke = skipped_participation_session_smoke("model_artifacts_missing") | {
            "missing_required": missing_files,
        }
    elif not bootstrap.get("vitisai_npu_ready"):
        session_smoke = skipped_participation_session_smoke("vitisai_npu_not_ready")
    else:
        session_smoke = run_npu_preferred_session_smoke(
            model_dir=model_dir,
            policy=policy,
            device_id=device_id,
        )
    status = classify_npu_preferred_session_status(
        bootstrap=bootstrap,
        missing_files=missing_files,
        session_smoke=session_smoke,
    )
    return {
        "schema_version": 1,
        "model_dir": str(model_dir),
        "bootstrap": bootstrap,
        "model_artifacts": {
            "model_dir": str(model_dir),
            "required_files": list(AMD_NPU_REQUIRED_MODEL_FILES),
            "session_model_files": list(AMD_NPU_SESSION_MODEL_FILES),
            "missing_required": missing_files,
            "ready": not missing_files,
        },
        "npu_session_smoke": session_smoke,
        "status": status,
    }


def skipped_session_smoke(reason: str) -> dict[str, Any]:
    return {
        "state": "skipped",
        "reason": reason,
        "providers_requested": [AMD_NPU_PROVIDER_NAME],
        "cpu_fallback_allowed": False,
        "cpu_fallback_detected": False,
        "sessions": [],
        "errors": [],
    }


def skipped_participation_session_smoke(reason: str) -> dict[str, Any]:
    return {
        "state": "skipped",
        "reason": reason,
        "providers_requested": [AMD_NPU_PROVIDER_NAME, "CPUExecutionProvider"],
        "cpu_fallback_allowed": True,
        "cpu_events_detected": False,
        "vitisai_provider_detected": False,
        "directml_provider_detected": False,
        "sessions": [],
        "errors": [],
    }


def run_strict_npu_session_smoke(
    *,
    model_dir: Path,
    policy: str = "PREFER_NPU",
    device_id: str = "auto",
) -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return failed_session_smoke(
            reason="onnxruntime_import_failed",
            errors=[{"model": "*", "error": str(exc)}],
            cpu_fallback_detected=False,
        )

    sessions: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    cpu_fallback_detected = False
    for model_name in AMD_NPU_SESSION_MODEL_FILES:
        model_path = model_dir / model_name
        try:
            options = create_strict_npu_session_options(
                ort,
                policy=policy,
                device_id=device_id,
            )
            session = ort.InferenceSession(str(model_path), sess_options=options)
            providers = list(session.get_providers())
            cpu_fallback = "CPUExecutionProvider" in providers
            cpu_fallback_detected = cpu_fallback_detected or cpu_fallback
            sessions.append(
                {
                    "model": model_name,
                    "path": str(model_path),
                    "providers": providers,
                    "inputs": [_node_arg_metadata(value) for value in session.get_inputs()],
                    "outputs": [_node_arg_metadata(value) for value in session.get_outputs()],
                    "cpu_fallback_detected": cpu_fallback,
                }
            )
        except Exception as exc:
            message = str(exc)
            cpu_fallback_detected = cpu_fallback_detected or _looks_like_cpu_fallback(
                message
            )
            errors.append({"model": model_name, "error": message})

    if errors:
        return failed_session_smoke(
            reason="amd_npu_cpu_fallback_detected"
            if cpu_fallback_detected
            else "amd_npu_session_failed",
            errors=errors,
            cpu_fallback_detected=cpu_fallback_detected,
        )
    if cpu_fallback_detected:
        return failed_session_smoke(
            reason="amd_npu_cpu_fallback_detected",
            errors=[],
            cpu_fallback_detected=True,
            sessions=sessions,
        )
    return {
        "state": "session_ready",
        "providers_requested": [AMD_NPU_PROVIDER_NAME],
        "cpu_fallback_allowed": False,
        "cpu_fallback_detected": False,
        "policy": normalize_npu_policy(policy),
        "device_id": device_id,
        "sessions": sessions,
        "errors": [],
    }


def run_npu_preferred_session_smoke(
    *,
    model_dir: Path,
    policy: str = "PREFER_NPU",
    device_id: str = "auto",
) -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return failed_participation_session_smoke(
            reason="onnxruntime_import_failed",
            errors=[{"model": "*", "error": str(exc)}],
            sessions=[],
        )

    sessions: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for model_name in AMD_NPU_SESSION_MODEL_FILES:
        model_path = model_dir / model_name
        try:
            options = create_npu_preferred_session_options(
                ort,
                policy=policy,
                device_id=device_id,
                cache_key=_cache_key_for_model(model_name),
                cache_dir=Path(os.environ["EXAM_PREP_AMD_NPU_CACHE_DIR"])
                if os.environ.get("EXAM_PREP_AMD_NPU_CACHE_DIR")
                else None,
            )
            session = ort.InferenceSession(str(model_path), sess_options=options)
            providers = list(session.get_providers())
            sessions.append(
                {
                    "model": model_name,
                    "path": str(model_path),
                    "providers": providers,
                    "inputs": [_node_arg_metadata(value) for value in session.get_inputs()],
                    "outputs": [_node_arg_metadata(value) for value in session.get_outputs()],
                    "cpu_fallback_allowed": True,
                    "cpu_provider_detected": "CPUExecutionProvider" in providers,
                    "vitisai_provider_detected": AMD_NPU_PROVIDER_NAME in providers,
                    "directml_provider_detected": "DmlExecutionProvider" in providers,
                }
            )
        except Exception as exc:
            errors.append({"model": model_name, "error": str(exc)})

    if errors:
        return failed_participation_session_smoke(
            reason="amd_npu_session_failed",
            errors=errors,
            sessions=sessions,
        )

    vitisai_provider_detected = all(
        bool(session.get("vitisai_provider_detected")) for session in sessions
    )
    directml_provider_detected = any(
        bool(session.get("directml_provider_detected")) for session in sessions
    )
    if not vitisai_provider_detected or directml_provider_detected:
        return failed_participation_session_smoke(
            reason="amd_npu_session_failed",
            errors=[],
            sessions=sessions,
        )

    return {
        "state": "session_ready",
        "providers_requested": [AMD_NPU_PROVIDER_NAME, "CPUExecutionProvider"],
        "cpu_fallback_allowed": True,
        "cpu_events_detected": any(
            bool(session.get("cpu_provider_detected")) for session in sessions
        ),
        "vitisai_provider_detected": vitisai_provider_detected,
        "directml_provider_detected": directml_provider_detected,
        "policy": normalize_npu_policy(policy),
        "device_id": device_id,
        "sessions": sessions,
        "errors": [],
    }


def failed_participation_session_smoke(
    *,
    reason: str,
    errors: list[dict[str, str]],
    sessions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "state": "session_failed",
        "reason": reason,
        "providers_requested": [AMD_NPU_PROVIDER_NAME, "CPUExecutionProvider"],
        "cpu_fallback_allowed": True,
        "cpu_events_detected": any(
            bool(session.get("cpu_provider_detected")) for session in sessions
        ),
        "vitisai_provider_detected": bool(sessions)
        and all(bool(session.get("vitisai_provider_detected")) for session in sessions),
        "directml_provider_detected": any(
            bool(session.get("directml_provider_detected")) for session in sessions
        ),
        "sessions": sessions,
        "errors": errors,
    }


def failed_session_smoke(
    *,
    reason: str,
    errors: list[dict[str, str]],
    cpu_fallback_detected: bool,
    sessions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "state": "session_failed",
        "reason": reason,
        "providers_requested": [AMD_NPU_PROVIDER_NAME],
        "cpu_fallback_allowed": False,
        "cpu_fallback_detected": cpu_fallback_detected,
        "sessions": sessions or [],
        "errors": errors,
    }


def create_strict_npu_session_options(
    ort: Any,
    *,
    policy: str,
    device_id: str,
) -> Any:
    options = ort.SessionOptions()
    options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    if hasattr(ort, "ExecutionMode"):
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    normalized_policy = normalize_npu_policy(policy)
    if normalized_policy != "DEFAULT" and hasattr(options, "set_provider_selection_policy"):
        policy_value = _provider_policy_value(ort, normalized_policy)
        if policy_value is not None:
            options.set_provider_selection_policy(policy_value)

    selected_device = select_vitisai_npu_device(ort, device_id=device_id)
    if selected_device is None:
        raise ProviderUnavailableError("VitisAI NPU EP device is not available.")
    add_for_devices = getattr(options, "add_provider_for_devices", None)
    if not callable(add_for_devices):
        raise ProviderUnavailableError(
            "ONNX Runtime does not expose SessionOptions.add_provider_for_devices()."
        )
    provider_options = _vitisai_provider_options(cache_key="paddleocr37_strict_rec")
    try:
        add_for_devices([selected_device], provider_options)
    except TypeError:
        add_for_devices([selected_device])
    return options


def create_npu_preferred_session_options(
    ort: Any,
    *,
    policy: str,
    device_id: str,
    cache_key: str,
    cache_dir: Path | None = None,
) -> Any:
    """Create Windows ML options that prefer the VitisAI NPU.

    This mirrors AMD's Windows ML examples: target the VitisAI NPU device, keep
    CPU fallback available for shape/bookkeeping nodes, and verify NPU use with
    profiling evidence at the caller.
    """

    options = ort.SessionOptions()
    if hasattr(ort, "ExecutionMode"):
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    normalized_policy = normalize_npu_policy(policy)
    if normalized_policy != "DEFAULT" and hasattr(options, "set_provider_selection_policy"):
        policy_value = _provider_policy_value(ort, normalized_policy)
        if policy_value is not None:
            options.set_provider_selection_policy(policy_value)

    selected_device = select_vitisai_npu_device(ort, device_id=device_id)
    if selected_device is None:
        raise ProviderUnavailableError("VitisAI NPU EP device is not available.")
    add_for_devices = getattr(options, "add_provider_for_devices", None)
    if not callable(add_for_devices):
        raise ProviderUnavailableError(
            "ONNX Runtime does not expose SessionOptions.add_provider_for_devices()."
        )
    provider_options = _vitisai_windows_ml_provider_options(
        cache_key=cache_key,
        cache_dir=cache_dir,
    )
    try:
        add_for_devices([selected_device], provider_options)
    except TypeError:
        add_for_devices([selected_device])
    return options


def select_vitisai_npu_device(ort: Any, *, device_id: str = "auto") -> Any | None:
    desired = str(device_id or "auto").strip().lower()
    for device, metadata in ep_devices_with_metadata(ort):
        if str(metadata.get("ep_name")) != AMD_NPU_PROVIDER_NAME:
            continue
        if _normalize_device_type(metadata.get("device_type")) != "npu":
            continue
        if desired in {"", "auto", "-1"} or str(metadata.get("device_id")).lower() == desired:
            return device
    return None


def ep_device_metadata(ort: Any) -> list[dict[str, Any]]:
    return [metadata for _device, metadata in ep_devices_with_metadata(ort)]


def ep_devices_with_metadata(ort: Any) -> list[tuple[Any, dict[str, Any]]]:
    get_devices = getattr(ort, "get_ep_devices", None)
    if not callable(get_devices):
        return []
    try:
        devices = list(get_devices())
    except Exception:
        return []
    return [(device, _ep_device_metadata(device)) for device in devices]


def register_vitisai_ep_library(ort: Any) -> dict[str, Any]:
    configured = os.environ.get("EXAM_PREP_AMD_NPU_VITISAI_EP_LIBRARY_PATH", "").strip()
    if configured:
        return _register_vitisai_library_path(ort, Path(configured), source="env")

    catalog_registration = _register_vitisai_with_windows_ml_catalog(ort)
    if catalog_registration.get("registered"):
        return catalog_registration

    library_path = _resolve_vitisai_library_path()
    if library_path is None:
        return {
            "requested": True,
            "registered": False,
            "source": "manual_windows_appx_scan",
            "windows_ml_catalog": catalog_registration,
            "error": "vitisai_ep_library_not_found",
        }
    registration = _register_vitisai_library_path(
        ort,
        library_path,
        source="manual_windows_appx_scan",
    )
    registration["windows_ml_catalog"] = catalog_registration
    return registration


def _ensure_vitisai_registered() -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "requested": True,
            "registered": False,
            "error": str(exc),
        }
    return register_vitisai_ep_library(ort)


def _register_vitisai_library_path(
    ort: Any,
    library_path: Path,
    *,
    source: str,
) -> dict[str, Any]:
    if not library_path.is_file():
        return {
            "requested": True,
            "registered": False,
            "source": source,
            "library_path": str(library_path),
            "error": "vitisai_ep_library_not_found",
        }
    register = getattr(ort, "register_execution_provider_library", None)
    if not callable(register):
        return {
            "requested": True,
            "registered": False,
            "source": source,
            "library_path": str(library_path),
            "error": "register_execution_provider_library_unavailable",
        }
    try:
        register(AMD_NPU_PROVIDER_NAME, str(library_path))
    except Exception as exc:
        if _is_already_registered_error(str(exc)):
            return {
                "requested": True,
                "registered": True,
                "source": source,
                "library_path": str(library_path),
                "note": str(exc),
            }
        return {
            "requested": True,
            "registered": False,
            "source": source,
            "library_path": str(library_path),
            "error": str(exc),
        }
    return {
        "requested": True,
        "registered": True,
        "source": source,
        "library_path": str(library_path),
    }


def _register_vitisai_with_windows_ml_catalog(ort: Any) -> dict[str, Any]:
    cleanup = _remove_pywinrt_msvcp140_conflict()
    try:
        from winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap import (  # type: ignore[import-not-found]
            InitializeOptions,
            initialize,
        )
        import winui3.microsoft.windows.ai.machinelearning as winml  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "requested": True,
            "registered": False,
            "source": "windows_ml_catalog",
            "cleanup": cleanup,
            "error": f"windows_ml_catalog_unavailable:{exc}",
        }

    try:
        with initialize(options=InitializeOptions.ON_NO_MATCH_SHOW_UI):
            catalog = winml.ExecutionProviderCatalog.get_default()
            providers = list(catalog.find_all_providers())
            provider = next(
                (
                    candidate
                    for candidate in providers
                    if str(getattr(candidate, "name", "")) == AMD_NPU_PROVIDER_NAME
                ),
                None,
            )
            if provider is None:
                return {
                    "requested": True,
                    "registered": False,
                    "source": "windows_ml_catalog",
                    "cleanup": cleanup,
                    "catalog_providers": [_catalog_provider_metadata(item) for item in providers],
                    "error": "vitisai_provider_not_in_catalog",
                }
            ready_before = _ready_state_metadata(getattr(provider, "ready_state", None))
            ensure_result = None
            if not ready_before["is_ready"]:
                ensure_result = provider.ensure_ready_async().get()
            ready_after = _ready_state_metadata(getattr(provider, "ready_state", None))
            library_path = Path(str(getattr(provider, "library_path", "") or ""))
            if not library_path.is_file():
                return {
                    "requested": True,
                    "registered": False,
                    "source": "windows_ml_catalog",
                    "cleanup": cleanup,
                    "ready_state_before": ready_before,
                    "ready_state_after": ready_after,
                    "ensure_ready_result": _json_safe_value(ensure_result),
                    "error": "vitisai_catalog_library_path_missing",
                    "library_path": str(library_path) if str(library_path) != "." else "",
                }
            registration = _register_vitisai_library_path(
                ort,
                library_path,
                source="windows_ml_catalog",
            )
            registration.update(
                {
                    "cleanup": cleanup,
                    "ready_state_before": ready_before,
                    "ready_state_after": ready_after,
                    "ensure_ready_result": _json_safe_value(ensure_result),
                    "catalog_provider": _catalog_provider_metadata(provider),
                }
            )
            return registration
    except Exception as exc:
        return {
            "requested": True,
            "registered": False,
            "source": "windows_ml_catalog",
            "cleanup": cleanup,
            "error": str(exc),
        }


def _remove_pywinrt_msvcp140_conflict() -> dict[str, Any]:
    """Apply the PyWinRT cleanup required by the Windows ML Python packages."""

    spec = importlib.util.find_spec("winrt")
    if spec is None or not spec.submodule_search_locations:
        return {"attempted": False, "reason": "winrt_package_not_found"}
    removed: list[str] = []
    errors: list[str] = []
    for location in spec.submodule_search_locations:
        candidate = Path(location) / "msvcp140.dll"
        if not candidate.is_file():
            continue
        try:
            candidate.unlink()
            removed.append(str(candidate))
        except Exception as exc:
            errors.append(f"{candidate}:{exc}")
    return {
        "attempted": True,
        "removed": removed,
        "errors": errors,
    }


def _ready_state_metadata(value: Any) -> dict[str, Any]:
    name = getattr(value, "name", None)
    text = str(name if name is not None else value)
    numeric: int | None = None
    try:
        numeric = int(value)
    except Exception:
        numeric = None
    normalized = text.upper()
    return {
        "name": text,
        "value": numeric,
        "is_ready": normalized == "READY" or numeric == 0,
    }


def _catalog_provider_metadata(provider: Any) -> dict[str, Any]:
    return {
        "name": str(getattr(provider, "name", "")),
        "ready_state": _ready_state_metadata(getattr(provider, "ready_state", None)),
        "library_path": str(getattr(provider, "library_path", "") or ""),
        "runtime_version": _metadata_value(provider, "runtime_version"),
        "package_full_name": _metadata_value(provider, "package_full_name"),
    }


def _json_safe_value(value: Any) -> Any:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set):
        return [_json_safe_value(item) for item in value]
    name = getattr(value, "name", None)
    if name is not None:
        return str(name)
    return str(value)


def _is_already_registered_error(message: str) -> bool:
    normalized = message.lower()
    return "already registered" in normalized or "already been registered" in normalized


def classify_strict_npu_status(
    *,
    bootstrap: dict[str, Any],
    missing_files: list[str],
    session_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    if bootstrap.get("import_error"):
        blockers.append("amd_npu_runtime_missing")
    if not bootstrap.get("vitisai_npu_ready"):
        blockers.append("amd_npu_session_failed")
    if missing_files:
        blockers.append("amd_npu_runtime_missing")
    session_state = str(session_smoke.get("state") or "unknown")
    if session_state == "session_failed":
        reason = str(session_smoke.get("reason") or "amd_npu_session_failed")
        blockers.append(reason)
        if session_smoke.get("cpu_fallback_detected"):
            blockers.append("amd_npu_cpu_fallback_detected")
    blockers = list(dict.fromkeys(blockers))

    if session_state == "session_ready":
        state = "session_ready"
    elif bootstrap.get("vitisai_npu_ready") and not missing_files:
        state = "session_failed" if session_state == "session_failed" else "ready_for_session"
    else:
        state = "blocked"
    return {
        "state": state,
        "target_ep": AMD_NPU_PROVIDER_NAME,
        "vitisai_npu_ready": bool(bootstrap.get("vitisai_npu_ready")),
        "model_artifacts_ready": not missing_files,
        "session_ready": session_state == "session_ready",
        "cpu_fallback_detected": bool(session_smoke.get("cpu_fallback_detected")),
        "blockers": blockers,
        "current_safe_action": (
            "Keep amd_npu opt-in and unavailable until PaddleOCR detection and "
            "recognition sessions execute on VitisAI with CPU fallback disabled."
        ),
    }


def classify_npu_preferred_session_status(
    *,
    bootstrap: dict[str, Any],
    missing_files: list[str],
    session_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    if bootstrap.get("import_error"):
        blockers.append("amd_npu_runtime_missing")
    if not bootstrap.get("vitisai_npu_ready"):
        blockers.append("amd_npu_session_failed")
    if missing_files:
        blockers.append("amd_npu_runtime_missing")
    session_state = str(session_smoke.get("state") or "unknown")
    if session_state == "session_failed":
        blockers.append(str(session_smoke.get("reason") or "amd_npu_session_failed"))
    if session_smoke.get("directml_provider_detected"):
        blockers.append("amd_npu_unexpected_directml_provider")
    if session_state == "session_ready" and not session_smoke.get("vitisai_provider_detected"):
        blockers.append("amd_npu_session_failed")
    blockers = list(dict.fromkeys(blockers))

    if not blockers and session_state == "session_ready":
        state = "session_ready"
    elif bootstrap.get("vitisai_npu_ready") and not missing_files:
        state = "session_failed" if session_state == "session_failed" else "ready_for_session"
    else:
        state = "blocked"
    return {
        "state": state,
        "target_ep": AMD_NPU_PROVIDER_NAME,
        "vitisai_npu_ready": bool(bootstrap.get("vitisai_npu_ready")),
        "model_artifacts_ready": not missing_files,
        "session_ready": not blockers and session_state == "session_ready",
        "cpu_fallback_allowed": True,
        "cpu_events_detected": bool(session_smoke.get("cpu_events_detected")),
        "vitisai_provider_detected": bool(session_smoke.get("vitisai_provider_detected")),
        "directml_provider_detected": bool(session_smoke.get("directml_provider_detected")),
        "blockers": blockers,
        "current_safe_action": (
            "Keep amd_npu opt-in until PaddleOCR inference records VitisAI/NPU "
            "profile events; CPU fallback is allowed for unsupported OCR nodes."
        ),
    }


def _available_providers(ort: Any) -> list[str]:
    try:
        return list(ort.get_available_providers())
    except Exception:
        return []


def _ep_device_metadata(device: Any) -> dict[str, Any]:
    hardware_device = _metadata_raw_value(device, "device")
    ep_metadata = _metadata_raw_value(device, "ep_metadata")
    device_metadata = _metadata_raw_value(hardware_device, "metadata")
    if not isinstance(device_metadata, dict):
        device_metadata = {}

    metadata: dict[str, Any] = {
        "ep_name": _metadata_value(device, "ep_name"),
        "ep_vendor": _metadata_value(device, "ep_vendor"),
        "device_type": _metadata_value(hardware_device, "type")
        or _metadata_value(device, "device_type"),
        "device_vendor": _metadata_value(hardware_device, "vendor")
        or _metadata_value(device, "device_vendor"),
        "device_id": _metadata_value(hardware_device, "device_id")
        or _metadata_value(device, "device_id"),
        "device_vendor_id": _metadata_value(hardware_device, "vendor_id"),
        "device_description": str(device_metadata.get("Description") or ""),
        "device_luid": str(device_metadata.get("LUID") or ""),
        "ep_library_path": _metadata_value(ep_metadata, "library_path"),
        "ep_version": _metadata_value(ep_metadata, "version"),
    }
    if device_metadata:
        metadata["device_metadata"] = {
            str(key): _json_safe_value(value) for key, value in device_metadata.items()
        }
    if not any(str(value or "") for value in metadata.values()):
        metadata["repr"] = repr(device)
    return metadata


def _metadata_value(source: Any, key: str) -> str:
    value = _metadata_raw_value(source, key)
    if value is None:
        return ""
    return _stringify_metadata_value(value)


def _metadata_raw_value(source: Any, key: str) -> Any:
    if source is None:
        return None
    value = getattr(source, key, None)
    if callable(value):
        try:
            value = value()
        except Exception:
            value = None
    if value is None:
        method = getattr(source, f"get_{key}", None)
        if callable(method):
            try:
                value = method()
            except Exception:
                value = None
    return value


def _stringify_metadata_value(value: Any) -> str:
    enum_name = getattr(value, "name", None)
    if enum_name is not None:
        return str(enum_name)
    return str(value)


def _vitisai_devices(devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        device
        for device in devices
        if device.get("ep_name") == AMD_NPU_PROVIDER_NAME
        and _normalize_device_type(device.get("device_type")) == "npu"
    ]


def _normalize_device_type(value: Any) -> str:
    text = _stringify_metadata_value(value).strip().lower()
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _vitisai_provider_options(*, cache_key: str) -> dict[str, str]:
    cache_dir = os.environ.get("EXAM_PREP_AMD_NPU_CACHE_DIR", "").strip()
    options = {
        "cache_key": cache_key,
        "log_level": os.environ.get("EXAM_PREP_AMD_NPU_LOG_LEVEL", "error").strip() or "error",
    }
    if cache_dir:
        options["cache_dir"] = cache_dir
    return options


def _cache_key_for_model(model_name: str) -> str:
    safe_name = (
        model_name.replace("\\", "_")
        .replace("/", "_")
        .replace(".", "_")
        .replace("-", "_")
    )
    return f"paddleocr37_{safe_name}_npu_preferred"


def _vitisai_windows_ml_provider_options(
    *,
    cache_key: str,
    cache_dir: Path | None,
) -> dict[str, str]:
    options = {"cacheKey": cache_key}
    if cache_dir is not None:
        options["cacheDir"] = str(cache_dir)
    return options


def _provider_policy_value(ort: Any, policy: str) -> Any | None:
    enum_type = getattr(ort, "OrtExecutionProviderDevicePolicy", None)
    if enum_type is not None:
        value = getattr(enum_type, policy, None)
        if value is not None:
            return value
    return getattr(ort, policy, None)


def _resolve_vitisai_library_path() -> Path | None:
    for package in sorted(
        _windows_ml_appx_packages(),
        key=_vitisai_appx_package_sort_key,
        reverse=True,
    ):
        install_location = package.get("InstallLocation")
        if not install_location:
            continue
        root = Path(str(install_location))
        for candidate in (
            root / "ExecutionProvider" / "onnxruntime_vitisai_ep.dll",
            root / "onnxruntime_vitisai_ep.dll",
        ):
            if candidate.is_file():
                return candidate
    return None


def _vitisai_appx_package_sort_key(package: dict[str, Any]) -> tuple[int, tuple[int, ...], str]:
    name = str(package.get("Name") or "")
    version = _version_tuple(str(package.get("Version") or ""))
    if "MicrosoftCorporationII.WinML.AMD.NPU.EP" in name:
        priority = 3
    elif "WindowsWorkload.EP.AMD.VitisAI" in name:
        priority = 2
    elif "VitisAI" in name:
        priority = 1
    else:
        priority = 0
    return priority, version, name


def _version_tuple(version: str) -> tuple[int, ...]:
    values: list[int] = []
    for part in version.split("."):
        try:
            values.append(int(part))
        except ValueError:
            values.append(0)
    return tuple(values)


def _windows_ml_appx_packages() -> list[dict[str, Any]]:
    if platform.system().lower() != "windows":
        return []
    command = (
        "Get-AppxPackage | "
        "Where-Object { $_.Name -match 'VitisAI|AMD.*NPU|WinML.*AMD' } | "
        "Select-Object Name,Version,PackageFullName,InstallLocation | "
        "ConvertTo-Json -Depth 4"
    )
    result = _run_powershell_json(command, timeout_seconds=15.0)
    if isinstance(result, list):
        return [item for item in result if isinstance(item, dict)]
    return [result] if isinstance(result, dict) else []


def _run_powershell_json(command: str, *, timeout_seconds: float) -> Any:
    try:
        completed = subprocess.run(
            [
                _powershell_executable(),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except Exception:
        return None
    if completed.returncode != 0:
        return None
    try:
        return json.loads(completed.stdout.strip() or "[]")
    except json.JSONDecodeError:
        return None


def _powershell_executable() -> str:
    configured = os.environ.get("EXAM_PREP_POWERSHELL_EXE", "").strip()
    if configured:
        return configured
    windows_root = os.environ.get("SystemRoot", "").strip() or os.environ.get("WINDIR", "").strip()
    if windows_root:
        candidate = Path(windows_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if candidate.is_file():
            return str(candidate)
    return "powershell.exe"


def _node_arg_metadata(value: Any) -> dict[str, Any]:
    return {
        "name": str(getattr(value, "name", "")),
        "type": str(getattr(value, "type", "")),
        "shape": [_json_safe_shape_dim(dim) for dim in getattr(value, "shape", [])],
    }


def _json_safe_shape_dim(value: Any) -> str | int | float | bool | None:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _looks_like_cpu_fallback(message: str) -> bool:
    normalized = message.lower()
    return "cpu ep" in normalized or "fallback to cpu" in normalized


def _bootstrap_unavailable_reason(bootstrap: dict[str, Any]) -> str:
    if bootstrap.get("import_error"):
        return "amd_npu_runtime_missing"
    if not bootstrap.get("vitisai_npu_ready"):
        return "amd_npu_session_failed"
    return "amd_npu_runtime_unhealthy"


def _bootstrap_detail(bootstrap: dict[str, Any]) -> str:
    if bootstrap.get("import_error"):
        return f"AMD NPU OCR runtime unavailable: {bootstrap['import_error']}"
    if not bootstrap.get("vitisai_npu_ready"):
        return "AMD NPU VitisAI EP device is not ready."
    return (
        "AMD NPU VitisAI EP device is visible, but OCR remains gated until "
        "PaddleOCR inference records VitisAI participation and real OCR output passes."
    )


def _runtime_unavailable_reason(
    *,
    ort_import_error: Exception | None,
    paddleocr_error: Exception | None,
    missing_files: list[str],
    session_report: dict[str, Any],
    directml_available: bool,
) -> str | None:
    if ort_import_error is not None or missing_files:
        return "amd_npu_runtime_missing"
    if paddleocr_error is not None:
        return "amd_npu_runtime_unhealthy"
    if not directml_available:
        return "amd_npu_runtime_unhealthy"
    if session_report["status"].get("cpu_fallback_detected"):
        return "amd_npu_cpu_fallback_detected"
    if session_report["status"].get("state") != "session_ready":
        return "amd_npu_session_failed"
    return None


def _runtime_detail(
    *,
    ort_import_error: Exception | None,
    paddleocr_error: Exception | None,
    missing_files: list[str],
    session_report: dict[str, Any],
    directml_available: bool,
) -> str:
    if ort_import_error is not None:
        return f"AMD NPU OCR runtime unavailable: {ort_import_error}"
    if missing_files:
        return f"AMD NPU OCR model artifacts are missing: {', '.join(missing_files)}."
    if paddleocr_error is not None:
        return f"PaddleOCR 3.7 runtime unavailable: {paddleocr_error}"
    if not directml_available:
        return "AMD NPU hybrid OCR runtime requires DmlExecutionProvider for PaddleOCR."
    status = session_report["status"]
    if status.get("cpu_fallback_detected"):
        return "AMD NPU VitisAI OCR session attempted CPU fallback with strict mode enabled."
    if status.get("state") != "session_ready":
        blockers = ", ".join(status.get("blockers") or ["amd_npu_session_failed"])
        return f"AMD NPU VitisAI OCR session is not ready: {blockers}."
    return (
        "AMD NPU hybrid OCR runtime is ready: VitisAI NPU prepass plus "
        "PaddleOCR 3.7 DirectML detection/recognition."
    )
