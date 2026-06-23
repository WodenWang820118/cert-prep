from __future__ import annotations

import argparse
from collections.abc import Sequence
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sys
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_ROOT = SCRIPT_DIR.parents[1]
BACKEND_ROOT = SCRIPTS_ROOT.parent
REPO_ROOT = BACKEND_ROOT
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
CPU_BASELINE_LATENCY_MS = 34_900

sys.path.insert(0, str(SCRIPTS_ROOT))
sys.path.insert(0, str(BACKEND_ROOT / "src"))

from benchmark_ocr import DEFAULT_PAGE_3_ANCHORS  # noqa: E402
from runtime.windowsml.ocr_windowsml_inference_smoke import build_report as build_inference_report  # noqa: E402
from runtime.windowsml.ocr_windowsml_smoke import WINDOWSML_DEVICE_LABEL  # noqa: E402
from runtime.windowsml.ocr_windowsml_probe import DEFAULT_MODEL_DIR  # noqa: E402
from exam_prep_backend.config import Settings  # noqa: E402
from exam_prep_backend.domains.source_documents.adapters.benchmark import (  # noqa: E402
    benchmark_pdf_page,
)
from exam_prep_backend.domains.source_documents.adapters.windowsml.runtime import (  # noqa: E402
    WindowsMLOCRRunner,
)
from exam_prep_backend.domains.source_documents.ocr import OCRPageResult  # noqa: E402


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-benchmark-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--pdf", type=Path, default=_default_pdf_path())
    parser.add_argument("--page", type=int, default=3)
    parser.add_argument(
        "--fail-if-not-benchmark-ready",
        action="store_true",
        help="Exit non-zero unless WindowsML OCR benchmark evidence is ready.",
    )
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    pdf_path: Path | None = None,
    page_number: int = 3,
) -> dict[str, Any]:
    inference_report = build_inference_report(model_dir=model_dir)
    benchmark = build_benchmark(
        inference_report,
        model_dir=model_dir,
        pdf_path=pdf_path or _default_pdf_path(),
        page_number=page_number,
    )
    status = classify_benchmark_status(inference_report["status"], benchmark)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_windowsml_benchmark",
            "goal": (
                "Benchmark AMD WindowsML OCR on the JLPT page-3 fixture after "
                "deterministic inference is implemented and passing."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
        },
        "inference_report": inference_report,
        "windowsml_benchmark": benchmark,
        "status": status,
    }


def build_benchmark(
    inference_report: dict[str, Any],
    *,
    model_dir: Path,
    pdf_path: Path,
    page_number: int,
) -> dict[str, Any]:
    inference_status = inference_report.get("status", {})
    if inference_status.get("state") != "inference_ready":
        return {
            "state": "skipped",
            "reason": inference_status.get("state") or "inference_not_ready",
            "warm_ocr_latency_ms": None,
            "cpu_baseline_latency_ms": CPU_BASELINE_LATENCY_MS,
            "device": None,
        }
    if not pdf_path.is_file():
        return {
            "state": "blocked",
            "reason": "benchmark_pdf_missing",
            "pdf_path": str(pdf_path),
            "warm_ocr_latency_ms": None,
            "cpu_baseline_latency_ms": CPU_BASELINE_LATENCY_MS,
            "device": WINDOWSML_DEVICE_LABEL,
        }
    provider = _WindowsMLBenchmarkProvider(
        model_dir=model_dir,
        device_id=_windowsml_device_id(inference_report),
    )
    try:
        result = benchmark_pdf_page(
            Settings(ocr_provider="windowsml"),
            pdf_path=pdf_path,
            page_number=page_number,
            anchors=DEFAULT_PAGE_3_ANCHORS if page_number == 3 else [],
            provider=provider,
        )
    except Exception as exc:
        return {
            "state": "failed",
            "reason": "windowsml_benchmark_failed",
            "error": str(exc),
            "pdf_path": str(pdf_path),
            "page_number": page_number,
            "warm_ocr_latency_ms": None,
            "cpu_baseline_latency_ms": CPU_BASELINE_LATENCY_MS,
            "device": WINDOWSML_DEVICE_LABEL,
        }
    warm_ms = int(result["warm_ocr_ms"])
    anchors_present = result.get("anchors_present", {})
    missing_anchors = [
        anchor for anchor, present in anchors_present.items() if not present
    ]
    latency_beats_cpu = warm_ms < CPU_BASELINE_LATENCY_MS
    text_present = int(result["chars"]) > 0
    passed = text_present and latency_beats_cpu and not missing_anchors
    return {
        "state": "passed" if passed else "failed",
        "reason": None if passed else "windowsml_benchmark_gate_failed",
        "pdf_path": str(pdf_path),
        "page_number": page_number,
        "warm_ocr_latency_ms": warm_ms,
        "cold_ocr_latency_ms": int(result["cold_ocr_ms"]),
        "cpu_baseline_latency_ms": CPU_BASELINE_LATENCY_MS,
        "latency_beats_cpu_baseline": latency_beats_cpu,
        "text_present": text_present,
        "missing_anchors": missing_anchors,
        "benchmark_result": result,
        "device": WINDOWSML_DEVICE_LABEL,
    }


def classify_benchmark_status(
    inference_status: dict[str, Any],
    benchmark: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(inference_status.get("blockers", []))
    benchmark_state = str(benchmark.get("state") or "unknown")
    if benchmark_state == "blocked":
        blockers.append(str(benchmark.get("reason") or "windowsml_benchmark_blocked"))
    elif benchmark_state == "failed":
        blockers.append(str(benchmark.get("reason") or "windowsml_benchmark_failed"))
    benchmark_ready = benchmark_state == "passed"
    return {
        "state": "benchmark_ready" if benchmark_ready else "ready_for_inference",
        "blockers": blockers,
        "inference_ready": bool(inference_status.get("inference_ready")),
        "benchmark_ready": benchmark_ready,
        "current_safe_action": (
            "Keep OCR on the AMD iGPU WindowsML lane only when benchmark and routing "
            "evidence beat the CPU baseline and avoid Nvidia residency."
        ),
    }


class _WindowsMLBenchmarkProvider:
    provider = "windowsml"
    engine = "onnxruntime-windowsml"
    page_workers = 1

    def __init__(self, *, model_dir: Path, device_id: int | None) -> None:
        self._runner = WindowsMLOCRRunner(model_dir=model_dir, device_id=device_id)

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = self._runner.extract_text(image_png)
        return OCRPageResult(
            text=result.text,
            extraction_method="windowsml_ocr",
            device=result.device,
            fallback_reason=None,
            duration_ms=result.duration_ms,
        )


def _windowsml_device_id(inference_report: dict[str, Any]) -> int | None:
    smoke = inference_report.get("windowsml_inference_smoke", {})
    raw = smoke.get("windowsml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def _default_pdf_path() -> Path:
    configured = os.environ.get("EXAM_PREP_OCR_BENCHMARK_PDF")
    if configured:
        return Path(configured)
    candidates = sorted((REPO_ROOT / "pdfs").glob("*N1*.pdf"))
    if candidates:
        return candidates[0]
    return REPO_ROOT / "pdfs" / "jlpt-n1.pdf"


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(
        model_dir=args.model_dir,
        pdf_path=args.pdf,
        page_number=args.page,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_benchmark_ready and report["status"]["state"] != "benchmark_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
