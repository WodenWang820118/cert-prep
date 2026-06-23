from __future__ import annotations

import argparse
from collections.abc import Sequence
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from cert_prep_backend.domains.source_documents.adapters.paddle_runtime import (  # noqa: E402
    import_paddle_stack,
    package_versions,
)


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
COMMAND_TIMEOUT_SECONDS = 10.0


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-igpu-probe-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--fail-if-unavailable", action="store_true")
    return parser.parse_args(argv)


def build_report() -> dict[str, Any]:
    generated_at = datetime.now(UTC).isoformat()
    windows_video_controllers = windows_video_controller_snapshot()
    nvidia_smi = nvidia_smi_snapshot()
    paddle = paddle_capability_snapshot()
    onnxruntime = onnxruntime_capability_snapshot()
    status = classify_igpu_status(
        windows_video_controllers=windows_video_controllers,
        paddle=paddle,
        onnxruntime=onnxruntime,
    )

    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "mode": {
            "name": "ocr_igpu_probe",
            "goal": (
                "Determine whether the current local PaddleOCR runtime can target "
                "the AMD iGPU while reserving the Nvidia GPU for reasoning models."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
            "does_not_run_ocr_inference": True,
        },
        "host": {
            "platform": platform.platform(),
            "python_version": platform.python_version(),
        },
        "windows_video_controllers": windows_video_controllers,
        "nvidia_smi": nvidia_smi,
        "paddle": paddle,
        "onnxruntime": onnxruntime,
        "status": status,
    }


def classify_igpu_status(
    *,
    windows_video_controllers: Sequence[dict[str, Any]],
    paddle: dict[str, Any],
    onnxruntime: dict[str, Any],
) -> dict[str, Any]:
    amd_adapters = [
        controller
        for controller in windows_video_controllers
        if is_amd_adapter(str(controller.get("Name") or controller.get("name") or ""))
    ]
    nvidia_adapters = [
        controller
        for controller in windows_video_controllers
        if is_nvidia_adapter(str(controller.get("Name") or controller.get("name") or ""))
    ]
    available_devices = [
        str(device).lower() for device in paddle.get("available_devices", []) or []
    ]
    custom_device_types = [
        str(device).lower() for device in paddle.get("custom_device_types", []) or []
    ]
    providers = [str(provider) for provider in onnxruntime.get("providers", []) or []]
    has_windowsml_provider = "DmlExecutionProvider" in providers

    blockers: list[str] = []
    if not amd_adapters:
        blockers.append("amd_igpu_not_detected")
    if paddle.get("import_error"):
        blockers.append("paddle_import_failed")
    if not paddle.get("compiled_with_rocm"):
        blockers.append("paddle_wheel_not_rocm")
    if "dml" not in custom_device_types and "windowsml" not in custom_device_types:
        blockers.append("paddle_has_no_windowsml_custom_device")
    if available_devices and all(device.startswith("gpu") for device in available_devices):
        blockers.append("paddle_devices_are_cuda_only")
    if not has_windowsml_provider:
        blockers.append("onnxruntime_windowsml_not_available")

    paddle_can_target_amd = bool(paddle.get("compiled_with_rocm")) or any(
        device in {"dml", "windowsml", "rocm"} for device in custom_device_types
    )
    onnx_windowsml_candidate = bool(amd_adapters and has_windowsml_provider)
    if amd_adapters and paddle_can_target_amd:
        state = "candidate"
    elif onnx_windowsml_candidate:
        state = "needs_alternative_backend"
    else:
        state = "blocked"

    return {
        "state": state,
        "amd_igpu_detected": bool(amd_adapters),
        "nvidia_dgpu_detected": bool(nvidia_adapters),
        "paddle_can_target_amd_igpu": paddle_can_target_amd,
        "onnx_windowsml_candidate": onnx_windowsml_candidate,
        "blockers": blockers,
        "current_safe_action": (
            "Keep PaddleOCR off the experimental iGPU lane. The current Paddle "
            "wheel exposes CUDA gpu:0 only, so production OCR remains Nvidia-routed "
            "until an AMD-capable backend is implemented."
        ),
        "recommended_next_step": (
            "Prototype a separate OCR backend using ONNX Runtime WindowsML or Windows "
            "ML after exporting PP-OCR models to ONNX; do not silently fall back to "
            "CPU for the iGPU lane."
        ),
    }


def paddle_capability_snapshot() -> dict[str, Any]:
    paddle, _paddle_ocr, import_error = import_paddle_stack()
    result: dict[str, Any] = {
        "package_versions": package_versions(),
        "import_error": str(import_error) if import_error else None,
        "compiled_with_cuda": None,
        "compiled_with_rocm": None,
        "cuda_device_count": None,
        "available_devices": [],
        "custom_device_types": [],
    }
    if paddle is None:
        return result

    result["compiled_with_cuda"] = _call_bool(
        getattr(paddle, "is_compiled_with_cuda", None)
    )
    result["compiled_with_rocm"] = _call_bool(
        getattr(getattr(paddle, "device", None), "is_compiled_with_rocm", None)
    )
    result["cuda_device_count"] = _call_int(
        getattr(getattr(paddle.device, "cuda", None), "device_count", None)
    )
    result["available_devices"] = _call_list(
        getattr(paddle.device, "get_available_device", None)
    )
    result["custom_device_types"] = _call_list(
        getattr(paddle.device, "get_all_custom_device_type", None)
    )
    return result


def onnxruntime_capability_snapshot() -> dict[str, Any]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return {
            "available": False,
            "import_error": str(exc),
            "providers": [],
        }
    try:
        providers = list(ort.get_available_providers())
    except Exception as exc:
        return {
            "available": True,
            "provider_error": str(exc),
            "providers": [],
        }
    return {
        "available": True,
        "providers": providers,
    }


def windows_video_controller_snapshot() -> list[dict[str, Any]]:
    if platform.system().lower() != "windows":
        return []
    command = (
        "Get-CimInstance Win32_VideoController | "
        "Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID | "
        "ConvertTo-Json -Depth 4"
    )
    result = _run_command(
        [
            resolve_powershell_executable(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
    )
    if not result["available"]:
        return [{"error": result.get("error") or result.get("stderr") or result.get("stdout")}]
    try:
        payload = json.loads(str(result["stdout"] or "").strip() or "[]")
    except json.JSONDecodeError as exc:
        return [{"error": f"video_controller_json_error:{exc}"}]
    return payload if isinstance(payload, list) else [payload]


def nvidia_smi_snapshot() -> dict[str, Any]:
    return _run_command(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ]
    )


def resolve_powershell_executable() -> str:
    configured = os.environ.get("CERT_PREP_POWERSHELL_EXE", "").strip()
    if configured:
        return configured
    windows_root = os.environ.get("SystemRoot", "").strip() or os.environ.get("WINDIR", "").strip()
    if windows_root:
        candidate = Path(windows_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if candidate.is_file():
            return str(candidate)
    return "powershell.exe"


def _run_command(command: Sequence[str]) -> dict[str, Any]:
    try:
        result = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        return {"available": False, "error": str(exc), "command": list(command)}
    except subprocess.TimeoutExpired as exc:
        return {"available": False, "error": f"timeout:{exc}", "command": list(command)}
    return {
        "available": result.returncode == 0,
        "command": list(command),
        "exit_code": result.returncode,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
    }


def _call_bool(function: Any) -> bool | None:
    if not callable(function):
        return None
    try:
        return bool(function())
    except Exception:
        return None


def _call_int(function: Any) -> int | None:
    if not callable(function):
        return None
    try:
        return int(function())
    except Exception:
        return None


def _call_list(function: Any) -> list[str]:
    if not callable(function):
        return []
    try:
        value = function()
    except Exception:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value]
    return [str(value)]


def is_amd_adapter(name: str) -> bool:
    return bool(re.search(r"\bAMD\b|Radeon", name, re.IGNORECASE))


def is_nvidia_adapter(name: str) -> bool:
    return bool(re.search(r"\bNVIDIA\b|GeForce|RTX", name, re.IGNORECASE))


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.fail_if_unavailable and report["status"]["state"] != "candidate":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
