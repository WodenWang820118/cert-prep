from __future__ import annotations

import argparse
from collections.abc import Sequence
from datetime import UTC, datetime
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parents[0]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(BACKEND_ROOT / "src"))

from ocr_windowsml_probe import (  # noqa: E402
    DEFAULT_MODEL_DIR,
    inspect_model_artifacts,
    resolve_powershell_executable,
)
from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    AMD_NPU_REQUIRED_MODEL_FILES,
    AMD_NPU_PROVIDER_NAME,
    windows_ml_bootstrap_snapshot,
)


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-amd-npu-probe-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--ensure-ready", action="store_true")
    parser.add_argument("--fail-if-blocked", action="store_true")
    parser.add_argument("--fail-if-not-ready", action="store_true")
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    ensure_ready: bool = False,
) -> dict[str, Any]:
    bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=ensure_ready)
    artifacts = inspect_model_artifacts(model_dir)
    xrt_smi = xrt_smi_summary()
    status = classify_probe_status(
        bootstrap=bootstrap,
        model_artifacts=artifacts,
        xrt_smi=xrt_smi,
    )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_amd_npu_probe",
            "goal": (
                "Verify the opt-in Windows ML VitisAI lane for AMD NPU OCR "
                "without changing the production WindowsML default."
            ),
            "does_not_change_runtime_defaults": True,
            "does_not_run_ocr_inference": True,
            "ensure_ready_requested": ensure_ready,
        },
        "host": {
            "platform": platform.platform(),
            "python_version": platform.python_version(),
        },
        "pnp_npu_devices": pnp_npu_devices(),
        "onnxruntime_windows_ml": bootstrap,
        "xrt_smi_summary": xrt_smi,
        "model_contract": {
            "description": (
                "PaddleOCR 3.7 PP-OCRv6 ONNXRuntime artifact contract; "
                "detection and recognition are the strict VitisAI NPU-only targets."
            ),
            "required_files": list(AMD_NPU_REQUIRED_MODEL_FILES),
            "target_stage": "detection_and_recognition",
        },
        "model_artifacts": artifacts,
        "status": status,
    }


def classify_probe_status(
    *,
    bootstrap: dict[str, Any],
    model_artifacts: dict[str, Any],
    xrt_smi: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    if bootstrap.get("import_error"):
        blockers.append("amd_npu_runtime_missing")
    if not bootstrap.get("vitisai_npu_ready"):
        blockers.append("amd_npu_session_failed")
    if not model_artifacts.get("ready"):
        blockers.append("amd_npu_runtime_missing")

    if not bootstrap.get("vitisai_npu_ready"):
        state = "blocked"
    elif model_artifacts.get("ready"):
        state = "ready_for_session"
    else:
        state = "ready_for_model"
    return {
        "state": state,
        "target_ep": AMD_NPU_PROVIDER_NAME,
        "windows_ml_bootstrap_ready": bool(bootstrap.get("vitisai_npu_ready")),
        "vitisai_ep_registered": bool(bootstrap.get("vitisai_ep_registered")),
        "vitisai_npu_ready": bool(bootstrap.get("vitisai_npu_ready")),
        "model_artifacts_ready": bool(model_artifacts.get("ready")),
        "xrt_smi_npu_detected": bool(xrt_smi.get("npu_detected")),
        "power_watts_available": bool(xrt_smi.get("power_watts_available")),
        "blockers": list(dict.fromkeys(blockers)),
        "current_safe_action": (
            "Keep windowsml as the packaged default until strict NPU session, "
            "real OCR inference, routing, and no-regression gates pass."
        ),
    }


def pnp_npu_devices() -> list[dict[str, Any]]:
    if platform.system().lower() != "windows":
        return []
    command = (
        "Get-PnpDevice | "
        "Where-Object { $_.FriendlyName -match 'NPU|Ryzen AI|Compute Accelerator' -or "
        "$_.Class -match 'ComputeAccelerator' } | "
        "Select-Object FriendlyName,Class,Status,InstanceId | ConvertTo-Json -Depth 4"
    )
    payload = run_powershell_json(command, timeout_seconds=10.0)
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return [payload] if isinstance(payload, dict) else []


def xrt_smi_summary() -> dict[str, Any]:
    executable = resolve_xrt_smi()
    if executable is None:
        return {
            "available": False,
            "executable": None,
            "npu_detected": False,
            "power_watts_available": False,
        }
    version = run_command([str(executable), "--version"], timeout_seconds=10.0)
    examine = run_command([str(executable), "examine", "--batch"], timeout_seconds=20.0)
    text = f"{version.get('stdout', '')}\n{examine.get('stdout', '')}"
    return {
        "available": True,
        "executable": str(executable),
        "version": version,
        "examine_batch": examine,
        "npu_detected": "NPU" in text.upper(),
        "power_watts_available": " W" in text or "Watts" in text,
    }


def resolve_xrt_smi() -> Path | None:
    found = shutil.which("xrt-smi") or shutil.which("xrt-smi.exe")
    if found:
        return Path(found)
    for candidate in (
        Path("C:/Windows/System32/AMD/xrt-smi.exe"),
        Path("C:/Program Files/AMD/XRT/bin/xrt-smi.exe"),
    ):
        if candidate.is_file():
            return candidate
    return None


def run_powershell_json(command: str, *, timeout_seconds: float) -> Any:
    completed = run_command(
        [
            resolve_powershell_executable(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        timeout_seconds=timeout_seconds,
    )
    if completed.get("exit_code") != 0:
        return None
    try:
        return json.loads(str(completed.get("stdout") or "").strip() or "[]")
    except json.JSONDecodeError:
        return None


def run_command(command: Sequence[str], *, timeout_seconds: float) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            list(command),
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        return {"available": False, "error": str(exc), "command": list(command)}
    except subprocess.TimeoutExpired as exc:
        return {"available": False, "error": f"timeout:{exc}", "command": list(command)}
    return {
        "available": completed.returncode == 0,
        "command": list(command),
        "exit_code": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(model_dir=args.model_dir, ensure_ready=args.ensure_ready)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    state = report["status"]["state"]
    if args.fail_if_blocked and state == "blocked":
        raise SystemExit(1)
    if args.fail_if_not_ready and state != "ready_for_session":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
