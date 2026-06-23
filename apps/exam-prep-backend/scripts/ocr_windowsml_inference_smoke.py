from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from dataclasses import asdict
from io import BytesIO
import json
from pathlib import Path
import sys
from time import perf_counter
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parents[0]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"

sys.path.insert(0, str(SCRIPT_DIR))

from ocr_windowsml_probe import DEFAULT_MODEL_DIR  # noqa: E402
from ocr_windowsml_smoke import (  # noqa: E402
    WINDOWSML_DEVICE_LABEL,
    build_report as build_session_report,
)
from exam_prep_backend.domains.source_documents.adapters.windowsml import (  # noqa: E402
    WindowsMLRuntimeOCRProvider,
)


InferenceRunner = Callable[[dict[str, Any]], dict[str, Any]]
DETERMINISTIC_TEXT = "OCRTEST"
DETERMINISTIC_IMAGE_SIZE = (640, 180)


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-inference-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-not-inference-ready",
        action="store_true",
        help="Exit non-zero unless the deterministic WindowsML OCR inference gate passes.",
    )
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_report = build_session_report(model_dir=model_dir)
    inference_smoke = build_inference_smoke(
        session_report,
        inference_runner=inference_runner,
    )
    status = classify_inference_status(session_report["status"], inference_smoke)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_windowsml_inference_smoke",
            "goal": (
                "Run a deterministic PP-OCR ONNX inference on AMD WindowsML before "
                "allowing WindowsML OCR to become a production provider."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
        },
        "session_report": session_report,
        "windowsml_inference_smoke": inference_smoke,
        "status": status,
    }


def build_inference_smoke(
    session_report: dict[str, Any],
    *,
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_status = session_report.get("status", {})
    if session_status.get("state") != "session_ready":
        return {
            "state": "skipped",
            "reason": session_status.get("state") or "session_not_ready",
            "device": None,
            "text": "",
        }
    if inference_runner is None:
        return run_windowsml_recognition_smoke(session_report)
    return inference_runner(session_report)


def run_windowsml_recognition_smoke(session_report: dict[str, Any]) -> dict[str, Any]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:
        return failed_inference_smoke("windowsml_inference_import_failed", exc)

    model_dir = model_dir_from_session_report(session_report)
    if model_dir is None:
        return {
            "state": "skipped",
            "reason": "model_dir_missing",
            "device": "amd_windowsml",
            "text": "",
        }

    started = perf_counter()
    try:
        provider = WindowsMLRuntimeOCRProvider(
            model_dir=model_dir,
            device_id=windowsml_device_id(session_report),
        )
        image = create_deterministic_text_image(
            text=DETERMINISTIC_TEXT,
            image_class=Image,
            draw_class=ImageDraw,
            font_class=ImageFont,
        )
        result = provider.extract_page_text(image_to_png(image), 1)
    except Exception as exc:
        return failed_inference_smoke("windowsml_inference_failed", exc)

    duration_ms = int((perf_counter() - started) * 1000)
    text = result.text.replace(" ", "").replace("\n", "")
    expected_text_matched = DETERMINISTIC_TEXT in text
    return {
        "state": "passed" if expected_text_matched else "failed",
        "reason": None if expected_text_matched else "windowsml_inference_text_mismatch",
        "scope": "full_page_ocr",
        "model_dir": str(model_dir),
        "device": WINDOWSML_DEVICE_LABEL,
        "windowsml_device_id": windowsml_device_id(session_report),
        "expected_text": DETERMINISTIC_TEXT,
        "text": result.text,
        "expected_text_matched": expected_text_matched,
        "duration_ms": duration_ms,
        "provider_result": asdict(result),
        "input_image_size": list(DETERMINISTIC_IMAGE_SIZE),
        "full_page_ocr_ready": True,
        "remaining_gate": "pdf_page_latency_and_gpu_routing",
    }


def failed_inference_smoke(reason: str, exc: Exception) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": reason,
        "error": str(exc),
        "device": WINDOWSML_DEVICE_LABEL,
        "text": "",
    }


def model_dir_from_session_report(session_report: dict[str, Any]) -> Path | None:
    probe = session_report.get("probe", {})
    artifacts = probe.get("model_artifacts", {})
    model_dir = artifacts.get("model_dir")
    return Path(str(model_dir)) if model_dir else None


def windowsml_device_id(session_report: dict[str, Any]) -> int | None:
    smoke = session_report.get("windowsml_session_smoke", {})
    raw = smoke.get("windowsml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def create_deterministic_text_image(
    *,
    text: str,
    image_class: Any,
    draw_class: Any,
    font_class: Any,
) -> Any:
    image = image_class.new("RGB", DETERMINISTIC_IMAGE_SIZE, "white")
    draw = draw_class.Draw(image)
    draw.text((30, 40), text, font=load_test_font(font_class), fill="black")
    return image


def load_test_font(font_class: Any) -> Any:
    for font_path in (
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/meiryo.ttc",
    ):
        try:
            return font_class.truetype(font_path, 72)
        except Exception:
            continue
    return font_class.load_default()


def image_to_png(image: Any) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def classify_inference_status(
    session_status: dict[str, Any],
    inference_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(session_status.get("blockers", []))
    inference_state = str(inference_smoke.get("state") or "unknown")
    text = str(inference_smoke.get("text") or "").strip()
    device = str(inference_smoke.get("device") or "")
    expected_text = str(inference_smoke.get("expected_text") or "")
    expected_text_matched = (
        bool(inference_smoke.get("expected_text_matched"))
        if expected_text
        else bool(text)
    )

    if inference_state == "blocked":
        blockers.append(str(inference_smoke.get("reason") or "windowsml_inference_blocked"))
    elif inference_state == "failed":
        blockers.append(str(inference_smoke.get("reason") or "windowsml_inference_failed"))

    inference_ready = (
        inference_state == "passed"
        and bool(text)
        and device == WINDOWSML_DEVICE_LABEL
        and expected_text_matched
    )
    if inference_ready:
        state = "inference_ready"
    elif session_status.get("state") == "session_ready":
        state = "blocked"
    else:
        state = session_status.get("state") or "ready_for_model"

    return {
        "state": state,
        "blockers": blockers,
        "session_ready": bool(session_status.get("session_ready")),
        "inference_ready": inference_ready,
        "recognition_model_ready": inference_ready,
        "full_page_ocr_ready": bool(inference_smoke.get("full_page_ocr_ready")),
        "device": device or None,
        "non_empty_text": bool(text),
        "current_safe_action": (
            "Keep WindowsML OCR behind the production gate until deterministic "
            "inference, full-page latency, and GPU routing evidence pass."
        ),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(model_dir=args.model_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_inference_ready and report["status"]["state"] != "inference_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
