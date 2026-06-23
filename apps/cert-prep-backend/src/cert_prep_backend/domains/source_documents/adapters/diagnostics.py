from __future__ import annotations

from dataclasses import asdict
from io import BytesIO
from typing import Any

from PIL import Image, ImageDraw

from cert_prep_backend.config import Settings
from cert_prep_backend.domains.source_documents.ocr import (
    OCRProvider,
    ocr_provider_from_settings,
)
from cert_prep_backend.domains.source_documents.adapters.paddle_runtime import (
    import_paddle_stack,
)


def run_ocr_diagnostics(
    settings: Settings,
    *,
    provider: OCRProvider | None = None,
    strict_lane: str | None = None,
) -> dict[str, Any]:
    ocr_provider = provider or ocr_provider_from_settings(settings)
    health = ocr_provider.health()
    result: dict[str, Any] = {
        "health": asdict(health),
        "paddle_run_check": _paddle_run_check(),
        "lane_errors": _lane_errors(strict_lane),
        "self_test": None,
    }
    if health.available:
        try:
            self_test = ocr_provider.extract_page_text(_self_test_png(), page_number=1)
            result["self_test"] = asdict(self_test)
            if health.provider == "paddle" and not self_test.text.strip():
                result["self_test"]["error"] = "Paddle OCR self-test returned no text."
        except Exception as exc:
            result["self_test"] = {"error": str(exc)}
    result["ok"] = not result["lane_errors"] and not _has_error(result["self_test"])
    return result


def _paddle_run_check() -> dict[str, Any]:
    paddle, _create_pipeline, import_error = import_paddle_stack()
    if paddle is None or import_error is not None:
        return {"ok": False, "error": str(import_error)}
    try:
        paddle.utils.run_check()
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def _lane_errors(strict_lane: str | None) -> list[str]:
    if strict_lane is None:
        return []
    from importlib import metadata

    installed_cpu = _is_installed(metadata, "paddlepaddle")
    installed_gpu = _is_installed(metadata, "paddlepaddle-gpu")
    if strict_lane == "cpu":
        return _errors_for_lane(
            required=installed_cpu,
            forbidden=installed_gpu,
            required_name="paddlepaddle",
            forbidden_name="paddlepaddle-gpu",
        )
    if strict_lane == "gpu":
        return _errors_for_lane(
            required=installed_gpu,
            forbidden=installed_cpu,
            required_name="paddlepaddle-gpu",
            forbidden_name="paddlepaddle",
        )
    return [f"unsupported strict lane: {strict_lane}"]


def _errors_for_lane(
    *,
    required: bool,
    forbidden: bool,
    required_name: str,
    forbidden_name: str,
) -> list[str]:
    errors: list[str] = []
    if not required:
        errors.append(f"missing required distribution: {required_name}")
    if forbidden:
        errors.append(f"conflicting distribution installed: {forbidden_name}")
    return errors


def _is_installed(metadata_module, package_name: str) -> bool:
    try:
        metadata_module.version(package_name)
        return True
    except metadata_module.PackageNotFoundError:
        return False


def _self_test_png() -> bytes:
    image = Image.new("RGB", (160, 56), "white")
    draw = ImageDraw.Draw(image)
    draw.text((8, 16), "OCR TEST", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _has_error(value: Any) -> bool:
    return isinstance(value, dict) and "error" in value
