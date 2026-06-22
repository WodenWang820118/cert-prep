from __future__ import annotations

import argparse
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
import json
import math
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

from ocr_directml_probe import DEFAULT_MODEL_DIR  # noqa: E402
from ocr_directml_smoke import (  # noqa: E402
    build_report as build_session_report,
    create_directml_session_options,
    directml_providers,
)


InferenceRunner = Callable[[dict[str, Any]], dict[str, Any]]
DETERMINISTIC_TEXT = "TEST"
RECOGNITION_IMAGE_SIZE = (320, 64)
RECOGNITION_INPUT_SHAPE = (3, 48, 320)


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-directml-inference-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-not-inference-ready",
        action="store_true",
        help="Exit non-zero unless the deterministic DirectML OCR inference gate passes.",
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
            "name": "ocr_directml_inference_smoke",
            "goal": (
                "Run a deterministic PP-OCR ONNX inference on AMD DirectML before "
                "allowing DirectML OCR to become a production provider."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
        },
        "session_report": session_report,
        "directml_inference_smoke": inference_smoke,
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
        return run_directml_recognition_smoke(session_report)
    return inference_runner(session_report)


def run_directml_recognition_smoke(session_report: dict[str, Any]) -> dict[str, Any]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import onnxruntime as ort  # type: ignore[import-not-found]
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:
        return failed_inference_smoke("directml_inference_import_failed", exc)

    rec_model = model_artifact_path(session_report, "rec_model.onnx")
    char_dict = model_artifact_path(session_report, "rec_char_dict.txt")
    if rec_model is None or char_dict is None:
        return {
            "state": "skipped",
            "reason": "recognition_artifacts_missing",
            "device": "amd_directml",
            "text": "",
        }

    device_id = directml_device_id(session_report)
    started = perf_counter()
    try:
        session = ort.InferenceSession(
            str(rec_model),
            sess_options=create_directml_session_options(ort),
            providers=directml_providers(device_id),
        )
        image = create_deterministic_text_image(
            text=DETERMINISTIC_TEXT,
            image_class=Image,
            draw_class=ImageDraw,
            font_class=ImageFont,
        )
        input_tensor = preprocess_recognition_image(image, np_module=np)
        output = session.run(None, {session.get_inputs()[0].name: input_tensor})[0]
        decoded = decode_ctc_output(output, read_character_dict(char_dict))
    except Exception as exc:
        return failed_inference_smoke("directml_inference_failed", exc)

    duration_ms = int((perf_counter() - started) * 1000)
    providers = list(session.get_providers())
    text = str(decoded["text"])
    expected_text_matched = text == DETERMINISTIC_TEXT
    return {
        "state": "passed" if expected_text_matched else "failed",
        "reason": None if expected_text_matched else "directml_inference_text_mismatch",
        "scope": "recognition_model_only",
        "model": str(rec_model),
        "device": "amd_directml",
        "directml_device_id": device_id,
        "providers": providers,
        "expected_text": DETERMINISTIC_TEXT,
        "text": text,
        "expected_text_matched": expected_text_matched,
        "confidence": decoded["confidence"],
        "duration_ms": duration_ms,
        "input_image_size": list(RECOGNITION_IMAGE_SIZE),
        "input_tensor_shape": list(input_tensor.shape),
        "full_page_ocr_ready": False,
        "remaining_gate": "detection_crop_pipeline_benchmark_and_gpu_routing",
    }


def failed_inference_smoke(reason: str, exc: Exception) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": reason,
        "error": str(exc),
        "device": "amd_directml",
        "text": "",
    }


def model_artifact_path(session_report: dict[str, Any], name: str) -> Path | None:
    probe = session_report.get("probe", {})
    artifacts = probe.get("model_artifacts", {})
    required = artifacts.get("required", [])
    if not isinstance(required, list):
        return None
    for item in required:
        if not isinstance(item, dict):
            continue
        if item.get("name") == name and item.get("state") == "present" and item.get("path"):
            return Path(str(item["path"]))
    return None


def directml_device_id(session_report: dict[str, Any]) -> int | None:
    smoke = session_report.get("directml_session_smoke", {})
    raw = smoke.get("directml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def create_deterministic_text_image(
    *,
    text: str,
    image_class: Any,
    draw_class: Any,
    font_class: Any,
) -> Any:
    image = image_class.new("RGB", RECOGNITION_IMAGE_SIZE, "white")
    draw = draw_class.Draw(image)
    draw.text((8, 8), text, font=load_test_font(font_class), fill="black")
    return image


def load_test_font(font_class: Any) -> Any:
    for font_path in (
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/meiryo.ttc",
    ):
        try:
            return font_class.truetype(font_path, 42)
        except Exception:
            continue
    return font_class.load_default()


def preprocess_recognition_image(image: Any, *, np_module: Any) -> Any:
    image_c, image_h, image_w = RECOGNITION_INPUT_SHAPE
    array = np_module.asarray(image).astype("float32")
    height, width = array.shape[:2]
    ratio = width / float(height)
    resized_width = (
        image_w
        if math.ceil(image_h * ratio) > image_w
        else int(math.ceil(image_h * ratio))
    )
    resized = image.resize((resized_width, image_h))
    resized_array = np_module.asarray(resized).astype("float32")
    resized_array = resized_array.transpose(2, 0, 1) / 255.0
    resized_array = (resized_array - 0.5) / 0.5
    padded = np_module.zeros((image_c, image_h, image_w), dtype="float32")
    padded[:, :, 0:resized_width] = resized_array
    return padded.reshape((1, image_c, image_h, image_w))


def read_character_dict(path: Path) -> list[str]:
    chars = path.read_text(encoding="utf-8").splitlines()
    if not chars:
        raise ValueError(f"recognition character dictionary is empty: {path}")
    return chars


def decode_ctc_output(output: Any, character_dict: Sequence[str]) -> dict[str, Any]:
    predictions = output[0]
    indexes = predictions.argmax(axis=1).tolist()
    probabilities = predictions.max(axis=1).tolist()
    text_parts: list[str] = []
    confidences: list[float] = []
    previous_index: int | None = None
    for index, probability in zip(indexes, probabilities, strict=True):
        if index != 0 and index != previous_index:
            char_index = int(index) - 1
            if 0 <= char_index < len(character_dict):
                text_parts.append(character_dict[char_index])
                confidences.append(float(probability))
        previous_index = int(index)
    return {
        "text": "".join(text_parts),
        "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
    }


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
        blockers.append(str(inference_smoke.get("reason") or "directml_inference_blocked"))
    elif inference_state == "failed":
        blockers.append(str(inference_smoke.get("reason") or "directml_inference_failed"))

    inference_ready = (
        inference_state == "passed"
        and bool(text)
        and device == "amd_directml"
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
        "recognition_model_ready": inference_ready
        and inference_smoke.get("scope") == "recognition_model_only",
        "full_page_ocr_ready": bool(inference_smoke.get("full_page_ocr_ready")),
        "device": device or None,
        "non_empty_text": bool(text),
        "current_safe_action": (
            "Keep DirectML OCR behind the production gate until deterministic "
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
