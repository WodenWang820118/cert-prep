from __future__ import annotations

import argparse
from collections.abc import Sequence
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

from ocr_amd_npu_inference_smoke import build_report as build_inference_report  # noqa: E402
from ocr_amd_npu_probe import DEFAULT_MODEL_DIR, xrt_smi_summary  # noqa: E402


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-amd-npu-benchmark-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--ensure-ready", action="store_true")
    parser.add_argument("--compare-directml", action="store_true")
    parser.add_argument("--amd-npu-device-id", default="auto")
    parser.add_argument("--amd-npu-policy", default="PREFER_NPU")
    parser.add_argument("--fail-if-not-benchmark-ready", action="store_true")
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    ensure_ready: bool = False,
    compare_directml: bool = False,
    device_id: str = "auto",
    policy: str = "PREFER_NPU",
) -> dict[str, Any]:
    inference_report = build_inference_report(
        model_dir=model_dir,
        ensure_ready=ensure_ready,
        device_id=device_id,
        policy=policy,
    )
    benchmark = build_benchmark(inference_report, compare_directml=compare_directml)
    status = classify_benchmark_status(inference_report["status"], benchmark)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_amd_npu_benchmark",
            "goal": (
                "Compare AMD NPU OCR efficiency against DirectML only after "
                "strict session and real OCR gates pass."
            ),
            "does_not_change_runtime_defaults": True,
            "compare_directml_requested": compare_directml,
        },
        "inference_report": inference_report,
        "amd_npu_benchmark": benchmark,
        "status": status,
    }


def build_benchmark(
    inference_report: dict[str, Any],
    *,
    compare_directml: bool,
) -> dict[str, Any]:
    inference_status = inference_report.get("status", {})
    power = xrt_smi_summary()
    if inference_status.get("state") != "inference_ready":
        return {
            "state": "skipped",
            "reason": inference_status.get("state") or "inference_not_ready",
            "compare_directml_requested": compare_directml,
            "npu_power_or_efficiency_observations": {
                "power_watts_available": bool(power.get("power_watts_available")),
                "xrt_smi_summary": power,
            },
        }
    return {
        "state": "blocked",
        "reason": "amd_npu_benchmark_not_implemented",
        "compare_directml_requested": compare_directml,
        "npu_power_or_efficiency_observations": {
            "power_watts_available": bool(power.get("power_watts_available")),
            "xrt_smi_summary": power,
        },
    }


def classify_benchmark_status(
    inference_status: dict[str, Any],
    benchmark: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(inference_status.get("blockers", []))
    state = str(benchmark.get("state") or "unknown")
    if state != "passed":
        reason = str(benchmark.get("reason") or "amd_npu_benchmark_failed")
        if reason not in {"blocked", "skipped"}:
            blockers.append(reason)
    benchmark_ready = state == "passed"
    power = benchmark.get("npu_power_or_efficiency_observations", {})
    return {
        "state": "benchmark_ready" if benchmark_ready else "blocked",
        "blockers": list(dict.fromkeys(blockers)),
        "inference_ready": bool(inference_status.get("inference_ready")),
        "benchmark_ready": benchmark_ready,
        "power_watts_available": bool(power.get("power_watts_available")),
        "current_safe_action": (
            "Do not compare or default amd_npu until real OCR inference and "
            "routing evidence exist; missing watts is recorded explicitly."
        ),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        model_dir=args.model_dir,
        ensure_ready=args.ensure_ready,
        compare_directml=args.compare_directml,
        device_id=args.amd_npu_device_id,
        policy=args.amd_npu_policy,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if (args.compare_directml or args.fail_if_not_benchmark_ready) and report["status"]["state"] != "benchmark_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
