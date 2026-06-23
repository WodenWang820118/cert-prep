from __future__ import annotations

import argparse
import atexit
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from io import BytesIO
import json
from pathlib import Path
import sys
from time import perf_counter
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_ROOT = SCRIPT_DIR.parents[1]
BACKEND_ROOT = SCRIPTS_ROOT.parent
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_MODEL_DIR = DEFAULT_OUTPUT_DIR / "ocr-windowsml-models"

sys.path.insert(0, str(BACKEND_ROOT / "src"))

from exam_prep_backend.domains.source_documents.adapters.windowsml.npu_prepass import (  # noqa: E402
    CPU_PROVIDER,
    NPU_PREPASS_MODEL_FILE,
    VITISAI_PROVIDER,
    build_text_density_feed,
    end_session_profiling,
    npu_prepass_providers,
    ort_execution_provider_policy,
)


NPU_PROVIDER_HINTS = ("npu", "vitis", "qnn")
DEFAULT_DURATION_SECONDS = 8.0
DEFAULT_MIN_ITERATIONS = 3
_BOOTSTRAP_HANDLE: Any | None = None


@dataclass(frozen=True)
class SchedulingAssessment:
    npu_available: bool
    npu_scheduled: bool
    npu_provider_names: list[str]
    provider_node_counts: dict[str, int]
    reason: str


@dataclass(frozen=True)
class NpuSmokeRun:
    state: str
    iterations: int
    duration_ms: int
    session_providers: list[str]
    providers_requested: list[str]
    profile_files: list[str]
    profile_provider_node_counts: dict[str, int]
    error: str | None = None


PrepassRunner = Callable[[Path, str, float, int], NpuSmokeRun]


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-npu-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--windowsml-device-policy", default="PREFER_NPU")
    parser.add_argument("--duration-seconds", type=float, default=DEFAULT_DURATION_SECONDS)
    parser.add_argument("--min-iterations", type=int, default=DEFAULT_MIN_ITERATIONS)
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    device_policy: str = "PREFER_NPU",
    duration_seconds: float = DEFAULT_DURATION_SECONDS,
    min_iterations: int = DEFAULT_MIN_ITERATIONS,
    prepass_runner: PrepassRunner | None = None,
) -> dict[str, Any]:
    normalized_policy = normalize_device_policy(device_policy)
    model_path = model_dir / NPU_PREPASS_MODEL_FILE
    registration = register_windows_ml_execution_providers()
    onnxruntime = onnxruntime_snapshot()

    if not model_path.is_file():
        smoke = NpuSmokeRun(
            state="blocked",
            iterations=0,
            duration_ms=0,
            session_providers=[],
            providers_requested=[normalized_policy],
            profile_files=[],
            profile_provider_node_counts={},
            error="npu_prepass_model_missing",
        )
    else:
        runner = prepass_runner or run_npu_prepass_smoke
        smoke = runner(
            model_path,
            normalized_policy,
            max(0.1, duration_seconds),
            max(1, min_iterations),
        )

    catalog_npu_provider_names = catalog_npu_provider_names_from_registration(registration)
    assessment = assess_npu_scheduling(
        ort_ep_devices=onnxruntime.get("ort_ep_devices") or [],
        session_providers=smoke.session_providers,
        profile_provider_node_counts=smoke.profile_provider_node_counts,
        catalog_npu_provider_names=catalog_npu_provider_names,
    )
    status = classify_npu_smoke_status(
        model_file_present=model_path.is_file(),
        run_error=smoke.error,
        assessment=assessment,
    )

    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_windowsml_npu_smoke",
            "scope": "windowsml_npu_prepass_only",
            "goal": (
                "Prove whether the internal WindowsML text-density prepass "
                "scheduled ONNX Runtime nodes to an NPU execution provider."
            ),
            "does_not_run_full_paddleocr": True,
            "does_not_prove_full_paddleocr_npu_inference": True,
            "does_not_change_runtime_defaults": True,
        },
        "input": {
            "model_dir": str(model_dir),
            "model_file": str(model_path),
            "windowsml_device_policy": normalized_policy,
            "duration_seconds": max(0.1, duration_seconds),
            "min_iterations": max(1, min_iterations),
        },
        "registration": registration,
        "onnxruntime": onnxruntime,
        "npu_prepass": asdict(smoke),
        "iterations": smoke.iterations,
        "profile_files": smoke.profile_files,
        "profile_provider_node_counts": assessment.provider_node_counts,
        "npu_provider_names": assessment.npu_provider_names,
        "npu_scheduled": assessment.npu_scheduled,
        "npu_status_reason": assessment.reason,
        "status": status,
    }


def run_npu_prepass_smoke(
    model_path: Path,
    device_policy: str,
    duration_seconds: float,
    min_iterations: int,
) -> NpuSmokeRun:
    started = perf_counter()
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]

        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_profiling = True
        options.profile_file_prefix = str(profile_file_prefix(model_path.parent))

        providers = resolve_npu_prepass_providers(ort, options, device_policy)
        session_kwargs: dict[str, Any] = {"sess_options": options}
        if providers is not None:
            session_kwargs["providers"] = providers
        session = ort.InferenceSession(str(model_path), **session_kwargs)
        feed = build_text_density_feed(session, deterministic_image_png())
        iterations = 0
        deadline = perf_counter() + duration_seconds
        while iterations < min_iterations or perf_counter() < deadline:
            session.run(None, feed)
            iterations += 1
        profile_path = end_session_profiling(session)
        counts = provider_node_counts(profile_path)
        return NpuSmokeRun(
            state="completed",
            iterations=iterations,
            duration_ms=elapsed_ms(started),
            session_providers=safe_session_providers(session),
            providers_requested=provider_names(providers) if providers is not None else [device_policy],
            profile_files=[str(profile_path)] if profile_path is not None else [],
            profile_provider_node_counts=counts,
        )
    except Exception as exc:
        return NpuSmokeRun(
            state="failed",
            iterations=0,
            duration_ms=elapsed_ms(started),
            session_providers=[],
            providers_requested=[device_policy],
            profile_files=[],
            profile_provider_node_counts={},
            error=compact_error(exc),
        )


def resolve_npu_prepass_providers(ort: Any, options: Any, device_policy: str) -> list[Any] | None:
    try:
        return npu_prepass_providers(ort, options, device_policy)
    except Exception:
        policy_setter = getattr(options, "set_provider_selection_policy", None)
        if callable(policy_setter):
            policy_setter(ort_execution_provider_policy(ort, device_policy))
            return None
        raise


def assess_npu_scheduling(
    *,
    ort_ep_devices: Sequence[dict[str, Any]],
    session_providers: Sequence[str],
    profile_provider_node_counts: dict[str, int],
    catalog_npu_provider_names: Sequence[str] = (),
) -> SchedulingAssessment:
    hinted_session_providers = [
        provider for provider in session_providers if is_npu_provider_name(provider)
    ]
    npu_candidates = sorted(
        set(
            ep_device_npu_provider_names(ort_ep_devices)
            + list(catalog_npu_provider_names)
            + hinted_npu_provider_names(profile_provider_node_counts)
            + hinted_session_providers
        )
    )
    scheduled_names = [
        provider
        for provider in npu_candidates
        if profile_provider_node_counts.get(provider, 0) > 0
    ]

    if scheduled_names:
        reason = "ORT profile contains node execution on NPU provider(s): " + ", ".join(
            scheduled_names
        )
    elif not npu_candidates:
        reason = "No NPU execution provider was discovered or profiled."
    elif not profile_provider_node_counts:
        reason = "NPU provider exists, but no ORT profile provider node data was available."
    else:
        reason = (
            "NPU provider exists, but profiled nodes ran on "
            + ", ".join(sorted(profile_provider_node_counts))
            + "."
        )

    provider_names = sorted(set(npu_candidates))
    return SchedulingAssessment(
        npu_available=bool(provider_names),
        npu_scheduled=bool(scheduled_names),
        npu_provider_names=provider_names,
        provider_node_counts=dict(sorted(profile_provider_node_counts.items())),
        reason=reason,
    )


def classify_npu_smoke_status(
    *,
    model_file_present: bool,
    run_error: str | None,
    assessment: SchedulingAssessment,
) -> dict[str, Any]:
    blockers: list[str] = []
    if not model_file_present:
        blockers.append("npu_prepass_model_missing")
    if run_error and model_file_present:
        blockers.append("npu_prepass_failed")
    if assessment.npu_scheduled:
        state = "npu_scheduled"
    elif blockers:
        state = "blocked"
    else:
        state = "not_scheduled"
    return {
        "state": state,
        "strict_proof_passed": assessment.npu_scheduled,
        "blockers": blockers,
        "current_safe_action": (
            "Treat this as NPU prepass proof only. Full PaddleOCR det/rec remains "
            "WindowsML DML/CPU unless a separate strict OCR-stage NPU proof exists."
        ),
    }


def provider_node_counts(profile_path: str | Path | None) -> dict[str, int]:
    if profile_path is None:
        return {}
    path = Path(profile_path)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    events = payload if isinstance(payload, list) else []
    counts = Counter(
        provider
        for provider in (provider_from_profile_event(event) for event in events)
        if provider
    )
    return dict(sorted(counts.items()))


def provider_from_profile_event(event: Any) -> str:
    if not isinstance(event, dict):
        return ""
    args = event.get("args")
    candidates: list[str] = []
    if isinstance(args, dict):
        for key in ("provider", "provider_name", "provider_name_", "execution_provider"):
            value = args.get(key)
            if isinstance(value, str):
                candidates.append(value)
    for candidate in candidates:
        normalized = normalize_provider_name(candidate)
        if normalized:
            return normalized
    return ""


def normalize_provider_name(value: str) -> str:
    stripped = value.strip()
    lowered = stripped.lower()
    if "vitisai" in lowered:
        return VITISAI_PROVIDER
    if "cpuexecutionprovider" in lowered:
        return CPU_PROVIDER
    if "dmlexecutionprovider" in lowered:
        return "DmlExecutionProvider"
    if stripped.endswith("ExecutionProvider"):
        return stripped
    return ""


def register_windows_ml_execution_providers() -> dict[str, Any]:
    result: dict[str, Any] = {
        "bootstrapped": False,
        "registered_provider_names": [],
        "providers": [],
        "errors": [],
    }
    try:
        bootstrap_windows_app_sdk()
        result["bootstrapped"] = True
    except Exception as exc:
        result["errors"].append(f"Windows App SDK bootstrap failed: {compact_error(exc)}")
        return result

    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
        from winui3.microsoft.windows.ai import machinelearning as winml
    except Exception as exc:
        result["errors"].append(f"Windows ML import failed: {compact_error(exc)}")
        return result

    try:
        catalog = winml.ExecutionProviderCatalog.get_default()
        providers = list(catalog.find_all_providers())
    except Exception as exc:
        result["errors"].append(f"Provider catalog query failed: {compact_error(exc)}")
        return result

    for provider in providers:
        info = provider_info(provider)
        if not is_npu_provider_name(f"{info['name']} {info['library_path']}"):
            info["registered"] = False
            info["error"] = "Skipped non-NPU provider."
            result["providers"].append(info)
            continue
        try:
            ensure_ready = getattr(provider, "ensure_ready_async", None)
            if callable(ensure_ready):
                await_windows_async(ensure_ready())
        except Exception as exc:
            info["error"] = f"ensure_ready_async failed: {compact_error(exc)}"
        try:
            if info["library_path"]:
                ort.register_execution_provider_library(info["name"], info["library_path"])
                info["registered"] = True
                result["registered_provider_names"].append(info["name"])
        except Exception as exc:
            info["registered"] = False
            info["error"] = f"ORT registration failed: {compact_error(exc)}"
        result["providers"].append(info)
    return result


def bootstrap_windows_app_sdk() -> None:
    global _BOOTSTRAP_HANDLE
    if _BOOTSTRAP_HANDLE is not None:
        return
    from winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap import (
        InitializeOptions,
        initialize,
    )

    handle = initialize(options=InitializeOptions.ON_NO_MATCH_SHOW_UI)
    enter = getattr(handle, "__enter__", None)
    _BOOTSTRAP_HANDLE = enter() if callable(enter) else handle
    atexit.register(close_bootstrap_handle)


def close_bootstrap_handle() -> None:
    global _BOOTSTRAP_HANDLE
    handle = _BOOTSTRAP_HANDLE
    _BOOTSTRAP_HANDLE = None
    exit_method = getattr(handle, "__exit__", None)
    if callable(exit_method):
        exit_method(None, None, None)


def await_windows_async(operation: Any) -> Any:
    for method_name in ("get", "GetResults"):
        method = getattr(operation, method_name, None)
        if callable(method):
            return method()
    return operation


def provider_info(provider: Any) -> dict[str, Any]:
    return {
        "name": text_attr(provider, "name"),
        "ready_state": text_attr(provider, "ready_state"),
        "library_path": text_attr(provider, "library_path"),
        "registered": False,
        "error": None,
    }


def onnxruntime_snapshot() -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "available": False,
            "error": compact_error(exc),
            "available_providers": [],
            "ort_ep_devices": [],
        }

    try:
        providers = list(ort.get_available_providers())
    except Exception:
        providers = []
    ep_devices: list[dict[str, Any]] = []
    get_ep_devices_error = None
    try:
        ep_devices = [serialize_ep_device(device) for device in ort.get_ep_devices()]
    except Exception as exc:
        get_ep_devices_error = compact_error(exc)
    return {
        "available": True,
        "version": getattr(ort, "__version__", None),
        "available_providers": providers,
        "ort_ep_devices": ep_devices,
        "get_ep_devices_error": get_ep_devices_error,
    }


def serialize_ep_device(ep_device: Any) -> dict[str, Any]:
    hardware = getattr(ep_device, "hardware_device", None)
    return {
        "ep_name": str(getattr(ep_device, "ep_name", "")),
        "device_type": str(getattr(hardware, "type", "")),
        "hardware_name": str(getattr(hardware, "name", "")),
        "vendor_id": str(getattr(hardware, "vendor_id", "")),
        "device_id": str(getattr(hardware, "device_id", "")),
    }


def ep_device_npu_provider_names(ep_devices: Sequence[dict[str, Any]]) -> list[str]:
    provider_names: set[str] = set()
    for device in ep_devices:
        ep_name = str(device.get("ep_name") or "")
        device_type = str(device.get("device_type") or "").lower()
        hardware_name = str(device.get("hardware_name") or "").lower()
        if "npu" in device_type or "npu" in hardware_name:
            provider_names.add(ep_name)
    return sorted(provider_names)


def catalog_npu_provider_names_from_registration(registration: dict[str, Any]) -> list[str]:
    names: set[str] = set()
    providers = registration.get("providers")
    if not isinstance(providers, list):
        return []
    for provider in providers:
        if not isinstance(provider, dict):
            continue
        name = str(provider.get("name") or "")
        library_path = str(provider.get("library_path") or "")
        if is_npu_provider_name(f"{name} {library_path}"):
            names.add(name)
    return sorted(names)


def hinted_npu_provider_names(profile_provider_node_counts: dict[str, int]) -> list[str]:
    return [
        provider
        for provider, count in profile_provider_node_counts.items()
        if count > 0 and is_npu_provider_name(provider)
    ]


def is_npu_provider_name(value: str) -> bool:
    lowered = value.lower()
    return any(hint in lowered for hint in NPU_PROVIDER_HINTS)


def deterministic_image_png() -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (96, 96), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((8, 8, 88, 88), outline="black", width=4)
    draw.text((18, 36), "NPU", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def profile_file_prefix(model_dir: Path) -> Path:
    profile_dir = model_dir.parent / "onnxruntime-profiles"
    profile_dir.mkdir(parents=True, exist_ok=True)
    return profile_dir / "npu-smoke"


def safe_session_providers(session: Any) -> list[str]:
    get_providers = getattr(session, "get_providers", None)
    if not callable(get_providers):
        return []
    try:
        return [str(provider) for provider in get_providers()]
    except Exception:
        return []


def provider_names(providers: Sequence[Any]) -> list[str]:
    names: list[str] = []
    for provider in providers:
        if isinstance(provider, tuple) and provider:
            names.append(str(provider[0]))
        else:
            names.append(str(provider))
    return names


def normalize_device_policy(value: str) -> str:
    normalized = str(value or "PREFER_NPU").strip().upper()
    return normalized or "PREFER_NPU"


def text_attr(source: Any, name: str) -> str:
    value = getattr(source, name, "")
    return value if isinstance(value, str) else str(value or "")


def compact_error(error: Exception) -> str:
    return " ".join(f"{type(error).__name__}: {error}".strip().split())[:300]


def elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        model_dir=args.model_dir,
        device_policy=args.windowsml_device_policy,
        duration_seconds=args.duration_seconds,
        min_iterations=args.min_iterations,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["npu_scheduled"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
