from __future__ import annotations

from pathlib import Path
import platform
import tempfile
from time import perf_counter
from typing import Any

from PIL import Image, ImageDraw

from cert_prep_backend.domains.source_documents.adapters.paddle_runtime import (
    cuda_available,
    gpu_count,
    import_paddle_stack,
    model_cache_dir,
    package_versions,
)
from cert_prep_backend.domains.source_documents.adapters.paddle_text import (
    extract_prediction_text,
)
from cert_prep_backend.errors import ProviderUnavailableError
from cert_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult


class PaddleOCRProvider:
    provider = "paddle"
    engine = "paddleocr"

    def __init__(self, device: str = "auto", page_workers: int = 1) -> None:
        self.requested_device = device
        self.page_workers = max(1, page_workers)
        self._pipelines: dict[str, Any] = {}
        self._self_tested_devices: set[str] = set()
        self._last_fallback_reason: str | None = None

    def health(self) -> OCRHealth:
        paddle, paddle_ocr, import_error = import_paddle_stack()
        versions = package_versions()
        selected_device: str | None = None
        cuda_is_available = False
        visible_gpu_count = 0
        fallback_reason: str | None = None
        if paddle is not None:
            cuda_is_available = cuda_available(paddle)
            visible_gpu_count = gpu_count(paddle)
            selected_device, fallback_reason = self._select_device(paddle)
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=import_error is None and paddle_ocr is not None,
            detail=(
                "PaddleOCR imports available"
                if import_error is None and paddle_ocr is not None
                else f"Paddle OCR unavailable: {import_error}"
            ),
            python_version=platform.python_version(),
            paddle_version=versions["paddle"],
            paddleocr_version=versions["paddleocr"] or versions["paddlex"],
            selected_device=selected_device,
            cuda_available=cuda_is_available,
            gpu_count=visible_gpu_count,
            model_cache_dir=model_cache_dir(),
            fallback_reason=self._last_fallback_reason or fallback_reason,
            unavailable_reason=_unavailable_reason(import_error, versions),
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        paddle, _create_pipeline, import_error = import_paddle_stack()
        if paddle is None or import_error is not None:
            raise ProviderUnavailableError(f"Paddle OCR unavailable: {import_error}")

        selected_device, fallback_reason = self._select_device(paddle)
        try:
            text, duration_ms = self._run_ocr(image_png, selected_device)
            return OCRPageResult(
                text=text,
                extraction_method=_paddle_method(selected_device, fallback_reason),
                device=selected_device,
                fallback_reason=fallback_reason,
                duration_ms=duration_ms,
            )
        except Exception as exc:
            if selected_device == "cpu":
                raise ProviderUnavailableError(f"Paddle OCR failed on CPU: {exc}") from exc
            fallback_reason = f"{selected_device} failed: {exc}"
            self._last_fallback_reason = fallback_reason
            text, duration_ms = self._run_ocr(image_png, "cpu")
            return OCRPageResult(
                text=text,
                extraction_method="paddle_ocr_cpu_fallback",
                device="cpu",
                fallback_reason=fallback_reason,
                duration_ms=duration_ms,
            )

    def _select_device(self, paddle: Any) -> tuple[str, str | None]:
        requested_device = self.requested_device.strip().lower()
        if requested_device == "cpu":
            return "cpu", None
        if requested_device == "auto":
            if cuda_available(paddle) and gpu_count(paddle) > 0:
                return "gpu:0", None
            return "cpu", "cuda_unavailable"
        if requested_device.startswith("gpu"):
            if cuda_available(paddle) and gpu_count(paddle) > 0:
                return requested_device, None
            return "cpu", "cuda_unavailable"
        return "cpu", f"unsupported_device:{self.requested_device}"

    def _run_ocr(self, image_png: bytes, device: str) -> tuple[str, int]:
        pipeline = self._pipeline_for_device(device)
        self._self_test_device(pipeline, device)
        image_path = _write_temp_png(image_png)
        started_at = perf_counter()
        try:
            predictions = pipeline.predict(str(image_path))
            return extract_prediction_text(predictions), _elapsed_ms(started_at)
        finally:
            image_path.unlink(missing_ok=True)

    def _pipeline_for_device(self, device: str) -> Any:
        if device in self._pipelines:
            return self._pipelines[device]
        _paddle, paddle_ocr, import_error = import_paddle_stack()
        if paddle_ocr is None or import_error is not None:
            raise ProviderUnavailableError(f"Paddle OCR unavailable: {import_error}")
        pipeline = paddle_ocr(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device=device,
        )
        self._pipelines[device] = pipeline
        return pipeline

    def _self_test_device(self, pipeline: Any, device: str) -> None:
        if device in self._self_tested_devices:
            return
        if not device.startswith("gpu"):
            self._self_tested_devices.add(device)
            return
        image_path = _create_self_test_png()
        try:
            list(
                pipeline.predict(str(image_path))
            )
        finally:
            image_path.unlink(missing_ok=True)
        self._self_tested_devices.add(device)


def _paddle_method(device: str, fallback_reason: str | None) -> str:
    if device == "cpu" and fallback_reason:
        return "paddle_ocr_cpu_fallback"
    if device.startswith("gpu"):
        return "paddle_ocr_gpu"
    return "paddle_ocr_cpu"


def _write_temp_png(image_png: bytes) -> Path:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
        image_file.write(image_png)
        return Path(image_file.name)


def _create_self_test_png() -> Path:
    image = Image.new("RGB", (96, 36), "white")
    draw = ImageDraw.Draw(image)
    draw.text((8, 8), "OCR", fill="black")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
        image.save(image_file, format="PNG")
        return Path(image_file.name)


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))


def _unavailable_reason(import_error: Exception | None, versions: dict[str, str | None]) -> str | None:
    if import_error is None:
        return None
    if versions["paddle"] is None and versions["paddleocr"] is None and versions["paddlex"] is None:
        return "paddle_runtime_missing"
    return "paddle_runtime_unhealthy"
