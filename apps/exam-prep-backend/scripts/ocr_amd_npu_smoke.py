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
sys.path.insert(0, str(BACKEND_ROOT / "src"))

from ocr_amd_npu_probe import DEFAULT_MODEL_DIR, build_report as build_probe_report  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.amd_npu import (  # noqa: E402
    npu_preferred_session_report,
    strict_npu_session_report,
)


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-amd-npu-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--ensure-ready", action="store_true")
    parser.add_argument("--strict-npu", action="store_true")
    parser.add_argument("--amd-npu-device-id", default="auto")
    parser.add_argument("--amd-npu-policy", default="PREFER_NPU")
    parser.add_argument("--fail-if-not-session-ready", action="store_true")
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    ensure_ready: bool = False,
    device_id: str = "auto",
    policy: str = "PREFER_NPU",
    strict_npu: bool = False,
) -> dict[str, Any]:
    probe = build_probe_report(model_dir=model_dir, ensure_ready=ensure_ready)
    session_report = (
        strict_npu_session_report if strict_npu else npu_preferred_session_report
    )(
        model_dir=model_dir,
        ensure_ready=ensure_ready,
        policy=policy,
        device_id=device_id,
    )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_amd_npu_session_smoke",
            "goal": (
                "Verify PaddleOCR 3.7 detection and recognition ONNX session "
                "creation through Windows ML VitisAI NPU-preferred execution."
            ),
            "does_not_change_runtime_defaults": True,
            "runs_ocr_inference": False,
            "ensure_ready_requested": ensure_ready,
            "strict_npu": strict_npu,
            "cpu_fallback_allowed": not strict_npu,
        },
        "probe": probe,
        "npu_session_smoke": session_report["npu_session_smoke"],
        "status": session_report["status"],
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        model_dir=args.model_dir,
        ensure_ready=args.ensure_ready,
        device_id=args.amd_npu_device_id,
        policy=args.amd_npu_policy,
        strict_npu=args.strict_npu,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if (args.strict_npu or args.fail_if_not_session_ready) and report["status"]["state"] != "session_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
