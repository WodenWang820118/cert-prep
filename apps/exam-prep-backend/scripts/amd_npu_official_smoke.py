from __future__ import annotations

import argparse
from collections.abc import Sequence
from datetime import UTC, datetime
import json
from pathlib import Path
import shutil
import sys
import subprocess
from time import perf_counter
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parents[0]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_ARTIFACT_DIR = DEFAULT_OUTPUT_DIR / "amd-npu-official-smoke"
TINY_CNN_MODEL_NAME = "tiny-cnn-opset17.onnx"

sys.path.insert(0, str(BACKEND_ROOT / "src"))

from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    AMD_NPU_PROVIDER_NAME,
    create_npu_preferred_session_options,
    ep_devices_with_metadata,
    select_vitisai_npu_device,
    windows_ml_bootstrap_snapshot,
)


OFFICIAL_REFERENCES = [
    {
        "name": "AMD Ryzen AI Windows ML ResNet example",
        "url": "https://ryzenai.docs.amd.com/en/latest/winml/winml_example.html",
        "note": "AMD's official Windows ML sample runs ResNet with ep_policy NPU.",
    },
    {
        "name": "AMD Ryzen AI Windows ML execution providers",
        "url": "https://ryzenai.docs.amd.com/en/latest/winml/winml_ep.html",
        "note": "Windows ML can target VitisAIExecutionProvider on an AMD NPU.",
    },
    {
        "name": "AMD Ryzen AI supported operators",
        "url": "https://ryzenai.docs.amd.com/en/latest/ops_support.html",
        "note": "The generated CNN uses ONNX operators listed as supported by Ryzen AI.",
    },
]


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"amd-npu-official-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR)
    parser.add_argument("--ensure-ready", action="store_true")
    parser.add_argument("--amd-npu-device-id", default="auto")
    parser.add_argument("--amd-npu-policy", default="PREFER_NPU")
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--fail-if-not-npu-active", action="store_true")
    return parser.parse_args(argv)


def build_report(
    *,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    artifact_dir: Path = DEFAULT_ARTIFACT_DIR,
    ensure_ready: bool = False,
    device_id: str = "auto",
    policy: str = "PREFER_NPU",
    iterations: int = 20,
) -> dict[str, Any]:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    bootstrap = windows_ml_bootstrap_snapshot(ensure_ready=ensure_ready)
    model_path = artifact_dir / TINY_CNN_MODEL_NAME
    model_report = ensure_tiny_cnn_model(model_path)
    execution = run_vitisai_cnn_smoke(
        model_path=model_path,
        artifact_dir=artifact_dir,
        device_id=device_id,
        policy=policy,
        iterations=max(1, iterations),
    )
    status = classify_smoke_status(bootstrap=bootstrap, execution=execution)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "amd_npu_official_smoke",
            "goal": (
                "Use AMD's documented Windows ML + ONNX Runtime + VitisAI "
                "pattern to prove the Ryzen AI NPU can execute a CNN subgraph."
            ),
            "does_not_change_runtime_defaults": True,
            "ocr_gate": "separate; PaddleOCR remains blocked until its own models profile on NPU",
            "iterations": max(1, iterations),
        },
        "official_references": OFFICIAL_REFERENCES,
        "model": model_report,
        "bootstrap": bootstrap,
        "execution": execution,
        "status": status,
    }


def ensure_tiny_cnn_model(model_path: Path) -> dict[str, Any]:
    if model_path.is_file():
        return model_report(model_path=model_path, created=False)
    create_tiny_cnn_model(model_path)
    return model_report(model_path=model_path, created=True)


def model_report(*, model_path: Path, created: bool) -> dict[str, Any]:
    return {
        "kind": "generated_tiny_cnn",
        "path": str(model_path),
        "created": created,
        "onnx_opset": 17,
        "input_shape": [1, 3, 32, 32],
        "output_shape": [1, 10],
        "operator_set": [
            "Conv",
            "Relu",
            "MaxPool",
            "Conv",
            "Relu",
            "GlobalAveragePool",
            "Flatten",
            "Gemm",
        ],
        "why_not_full_resnet": (
            "AMD's official ResNet sample requires exporting/downloading a large "
            "model and optional torch/torchvision dependencies. This smoke keeps "
            "the same Windows ML VitisAI execution pattern with a deterministic "
            "small CNN so the hardware gate stays fast."
        ),
    }


def create_tiny_cnn_model(model_path: Path) -> None:
    import numpy as np  # type: ignore[import-not-found]
    import onnx  # type: ignore[import-not-found]
    from onnx import TensorProto, helper, numpy_helper  # type: ignore[import-not-found]

    rng = np.random.default_rng(20260623)
    input_value = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 32, 32])
    output_value = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 10])
    initializers = [
        numpy_helper.from_array(
            rng.normal(0, 0.02, (8, 3, 3, 3)).astype(np.float32),
            "conv1_w",
        ),
        numpy_helper.from_array(np.zeros((8,), dtype=np.float32), "conv1_b"),
        numpy_helper.from_array(
            rng.normal(0, 0.02, (8, 8, 3, 3)).astype(np.float32),
            "conv2_w",
        ),
        numpy_helper.from_array(np.zeros((8,), dtype=np.float32), "conv2_b"),
        numpy_helper.from_array(
            rng.normal(0, 0.02, (8, 10)).astype(np.float32),
            "gemm_w",
        ),
        numpy_helper.from_array(np.zeros((10,), dtype=np.float32), "gemm_b"),
    ]
    nodes = [
        helper.make_node(
            "Conv",
            ["input", "conv1_w", "conv1_b"],
            ["conv1"],
            pads=[1, 1, 1, 1],
            strides=[1, 1],
            name="conv1",
        ),
        helper.make_node("Relu", ["conv1"], ["relu1"], name="relu1"),
        helper.make_node(
            "MaxPool",
            ["relu1"],
            ["pool1"],
            kernel_shape=[2, 2],
            strides=[2, 2],
            name="pool1",
        ),
        helper.make_node(
            "Conv",
            ["pool1", "conv2_w", "conv2_b"],
            ["conv2"],
            pads=[1, 1, 1, 1],
            strides=[1, 1],
            name="conv2",
        ),
        helper.make_node("Relu", ["conv2"], ["relu2"], name="relu2"),
        helper.make_node("GlobalAveragePool", ["relu2"], ["gap"], name="gap"),
        helper.make_node("Flatten", ["gap"], ["flat"], axis=1, name="flatten"),
        helper.make_node(
            "Gemm",
            ["flat", "gemm_w", "gemm_b"],
            ["output"],
            alpha=1.0,
            beta=1.0,
            transB=0,
            name="gemm",
        ),
    ]
    graph = helper.make_graph(
        nodes,
        "exam_prep_tiny_cnn",
        [input_value],
        [output_value],
        initializers,
    )
    model = helper.make_model(
        graph,
        opset_imports=[helper.make_operatorsetid("", 17)],
        producer_name="exam-prep-amd-npu-official-smoke",
    )
    model.ir_version = 10
    onnx.checker.check_model(model)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, model_path)


def run_vitisai_cnn_smoke(
    *,
    model_path: Path,
    artifact_dir: Path,
    device_id: str,
    policy: str,
    iterations: int,
) -> dict[str, Any]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return failed_execution("amd_npu_smoke_import_failed", exc)

    profile_prefix = artifact_dir / datetime.now(UTC).strftime("tiny-cnn-vitisai-%Y%m%dT%H%M%SZ")
    try:
        selected_device_metadata = selected_vitisai_device_metadata(ort, device_id=device_id)
        nvidia_before = nvidia_smi_snapshot()
        xrt_before = xrt_smi_examine_snapshot(
            artifact_dir / "xrt-smi-before.json",
            artifact_dir / "xrt-smi-before.txt",
        )
        options = create_npu_preferred_session_options(
            ort,
            policy=policy,
            device_id=device_id,
            cache_key="examPrepTinyCnnSmoke",
            cache_dir=artifact_dir,
        )
        options.enable_profiling = True
        options.profile_file_prefix = str(profile_prefix)
        session = ort.InferenceSession(str(model_path), sess_options=options)
        input_arg = session.get_inputs()[0]
        sample = np.zeros((1, 3, 32, 32), dtype=np.float32)
        start = perf_counter()
        outputs = []
        for _ in range(iterations):
            outputs = session.run(None, {input_arg.name: sample})
        elapsed_ms = (perf_counter() - start) * 1000.0
        profile_path = Path(session.end_profiling())
        nvidia_after = nvidia_smi_snapshot()
        xrt_after = xrt_smi_examine_snapshot(
            artifact_dir / "xrt-smi-after.json",
            artifact_dir / "xrt-smi-after.txt",
        )
        provider_event_counts = provider_event_counts_from_profile(profile_path)
        vitisai_event_count = provider_event_counts.get(AMD_NPU_PROVIDER_NAME, 0)
        cpu_event_count = provider_event_counts.get("CPUExecutionProvider", 0)
        providers = list(session.get_providers())
        return {
            "state": "profiled",
            "model_path": str(model_path),
            "iterations": iterations,
            "elapsed_ms": elapsed_ms,
            "providers": providers,
            "provider_binding": {
                "session_providers": providers,
                "selected_ep_device": selected_device_metadata,
                "windowsml_provider_in_session": "DmlExecutionProvider" in providers,
                "vitisai_provider_in_session": AMD_NPU_PROVIDER_NAME in providers,
                "nvidia_provider_in_session": False,
                "nvidia_ep_device_bound": False,
                "nvidia_ep_devices_may_be_enumerated": True,
                "note": (
                    "NVIDIA devices may appear in Windows ML enumeration, but this "
                    "session is bound to VitisAIExecutionProvider on an AMD NPU and "
                    "does not include DmlExecutionProvider."
                ),
            },
            "input": {
                "name": input_arg.name,
                "shape": [1, 3, 32, 32],
                "type": str(getattr(input_arg, "type", "")),
            },
            "output_shapes": [list(getattr(output, "shape", [])) for output in outputs],
            "output_checksums": [float(np.asarray(output).sum()) for output in outputs],
            "profile_path": str(profile_path),
            "provider_event_counts": provider_event_counts,
            "vitisai_event_count": vitisai_event_count,
            "cpu_event_count": cpu_event_count,
            "npu_compute_detected": vitisai_event_count > 0,
            "cpu_fallback_allowed": True,
            "cpu_events_detected": cpu_event_count > 0,
            "device_snapshots": {
                "nvidia_smi_before": nvidia_before,
                "nvidia_smi_after": nvidia_after,
                "xrt_smi_before": xrt_before,
                "xrt_smi_after": xrt_after,
            },
        }
    except Exception as exc:
        return failed_execution("amd_npu_smoke_execution_failed", exc)


def failed_execution(reason: str, exc: Exception) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": reason,
        "error": str(exc),
        "providers": [],
        "provider_event_counts": {},
        "vitisai_event_count": 0,
        "cpu_event_count": 0,
        "npu_compute_detected": False,
        "cpu_fallback_allowed": True,
        "cpu_events_detected": False,
    }


def provider_event_counts_from_profile(profile_path: Path) -> dict[str, int]:
    events = read_profile_events(profile_path)
    counts: dict[str, int] = {}
    for event in events:
        args = event.get("args", {}) if isinstance(event, dict) else {}
        provider = args.get("provider") if isinstance(args, dict) else None
        if not provider:
            continue
        provider_name = str(provider)
        counts[provider_name] = counts.get(provider_name, 0) + 1
    return counts


def selected_vitisai_device_metadata(ort: Any, *, device_id: str) -> dict[str, Any] | None:
    selected = select_vitisai_npu_device(ort, device_id=device_id)
    if selected is None:
        return None
    for device, metadata in ep_devices_with_metadata(ort):
        if device is selected:
            return metadata
    return None


def nvidia_smi_snapshot() -> dict[str, Any]:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return {"available": False, "reason": "nvidia_smi_not_found"}
    gpu = run_text_command(
        [
            executable,
            "--query-gpu=name,utilization.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ],
        timeout_seconds=10.0,
    )
    compute_apps = run_text_command(
        [
            executable,
            "--query-compute-apps=pid,process_name,used_gpu_memory",
            "--format=csv,noheader,nounits",
        ],
        timeout_seconds=10.0,
    )
    return {
        "available": True,
        "path": executable,
        "gpu": parse_nvidia_gpu_query(gpu.get("stdout", "")),
        "compute_apps": parse_nvidia_compute_apps(compute_apps.get("stdout", "")),
        "raw": {
            "gpu": gpu,
            "compute_apps": compute_apps,
        },
    }


def parse_nvidia_gpu_query(stdout: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        rows.append(
            {
                "name": parts[0],
                "utilization_gpu_percent": parse_float(parts[1]),
                "power_draw_watts": parse_float(parts[2]),
            }
        )
    return rows


def parse_nvidia_compute_apps(stdout: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        rows.append(
            {
                "pid": parts[0],
                "process_name": parts[1],
                "used_gpu_memory_mib": parts[2],
            }
        )
    return rows


def xrt_smi_examine_snapshot(json_path: Path, text_path: Path) -> dict[str, Any]:
    executable = resolve_xrt_smi()
    if executable is None:
        return {"available": False, "reason": "xrt_smi_not_found"}

    json_path.parent.mkdir(parents=True, exist_ok=True)
    result = run_text_command(
        [
            str(executable),
            "examine",
            "--format",
            "JSON",
            "--output",
            str(json_path),
        ],
        timeout_seconds=30.0,
    )
    text = run_text_command([str(executable), "--batch", "examine"], timeout_seconds=30.0)
    if text.get("stdout"):
        text_path.write_text(str(text["stdout"]), encoding="utf-8")
    payload: Any = None
    if json_path.is_file():
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            payload = None
    text_stdout = str(text.get("stdout") or "")
    return {
        "available": True,
        "path": str(executable),
        "json_path": str(json_path) if json_path.is_file() else None,
        "text_path": str(text_path) if text_path.is_file() else None,
        "npu_detected": "NPU" in text_stdout or "NPU" in json.dumps(payload),
        "summary": extract_xrt_summary(text_stdout),
        "raw": {
            "json_command": result,
            "text_command": text,
        },
    }


def resolve_xrt_smi() -> Path | None:
    configured = shutil.which("xrt-smi")
    if configured:
        return Path(configured)
    for candidate in (
        Path("C:/Windows/System32/AMD/xrt-smi.exe"),
        Path("C:/Windows/System32/xrt-smi.exe"),
    ):
        if candidate.is_file():
            return candidate
    return None


def extract_xrt_summary(stdout: str) -> dict[str, str]:
    summary: dict[str, str] = {}
    for line in stdout.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower().replace(" ", "_")
        if key in {"npu_driver_version", "npu_firmware_version", "version"}:
            summary[key] = value.strip()
    if "NPU Strix" in stdout:
        summary["device_name"] = "NPU Strix"
    return summary


def run_text_command(command: list[str], *, timeout_seconds: float) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except Exception as exc:
        return {
            "returncode": None,
            "stdout": "",
            "stderr": str(exc),
        }
    return {
        "returncode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def parse_float(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def read_profile_events(profile_path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return payload if isinstance(payload, list) else []


def classify_smoke_status(
    *,
    bootstrap: dict[str, Any],
    execution: dict[str, Any],
) -> dict[str, Any]:
    blockers: list[str] = []
    if bootstrap.get("import_error"):
        blockers.append("amd_npu_runtime_missing")
    if not bootstrap.get("vitisai_npu_ready"):
        blockers.append("amd_npu_session_failed")
    if execution.get("state") == "failed":
        blockers.append(str(execution.get("reason") or "amd_npu_smoke_execution_failed"))
    if not execution.get("npu_compute_detected"):
        blockers.append("amd_npu_no_profiled_vitisai_compute")

    blockers = list(dict.fromkeys(blockers))
    npu_active = not blockers and int(execution.get("vitisai_event_count", 0)) > 0
    return {
        "state": "npu_active" if npu_active else "blocked",
        "npu_active": npu_active,
        "vitisai_npu_ready": bool(bootstrap.get("vitisai_npu_ready")),
        "npu_compute_detected": bool(execution.get("npu_compute_detected")),
        "windowsml_provider_in_session": bool(
            execution.get("provider_binding", {}).get("windowsml_provider_in_session")
        ),
        "nvidia_ep_device_bound": bool(
            execution.get("provider_binding", {}).get("nvidia_ep_device_bound")
        ),
        "cpu_fallback_allowed": bool(execution.get("cpu_fallback_allowed", True)),
        "cpu_events_detected": bool(execution.get("cpu_events_detected")),
        "blockers": blockers,
        "current_safe_action": (
            "Use this as hardware evidence only. Keep OCR-specific amd_npu unavailable "
            "until PaddleOCR models produce their own VitisAI inference evidence."
        ),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        output_dir=args.output.parent,
        artifact_dir=args.artifact_dir,
        ensure_ready=args.ensure_ready,
        device_id=args.amd_npu_device_id,
        policy=args.amd_npu_policy,
        iterations=args.iterations,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_npu_active and report["status"]["state"] != "npu_active":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
