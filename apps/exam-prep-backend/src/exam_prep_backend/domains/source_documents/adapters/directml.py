from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import platform
import tempfile
from time import perf_counter
from typing import Any

from exam_prep_backend.domains.source_documents.adapters.directml_device import (
    AUTO_DIRECTML_DEVICE_ID,
    DirectMLDeviceSelectionError,
    directml_device_label,
    resolve_directml_device_id,
)
from exam_prep_backend.domains.source_documents.ocr_contracts import OCRHealth, OCRPageResult
from exam_prep_backend.exceptions import ProviderUnavailableError


_UNRESOLVED_DEVICE_ID = object()
PADDLEOCR37_DET_MODEL_NAME = "PP-OCRv6_medium_det"
PADDLEOCR37_REC_MODEL_NAME = "PP-OCRv6_medium_rec"
PADDLEOCR37_REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)


class DirectMLOCRProvider:
    """Blocked-until-ready DirectML OCR provider for the AMD iGPU production gate."""

    provider = "directml"
    engine = "onnxruntime-directml"
    page_workers = 1

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        directml_available = "DmlExecutionProvider" in providers
        unavailable_reason = _unavailable_reason(import_error, directml_available)
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=False,
            detail=_detail(import_error, directml_available),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=version,
            selected_device="amd_directml" if directml_available else None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason=unavailable_reason,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise ProviderUnavailableError(
            "DirectML OCR is gated until model artifacts, deterministic inference, "
            "benchmark, and AMD/Nvidia routing evidence pass."
        )


class DirectMLRuntimeOCRProvider:
    """Runnable DirectML OCR provider used inside the packaged DirectML runtime."""

    provider = "directml"
    engine = "paddleocr-3.7-onnxruntime-directml"
    page_workers = 1

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_DIRECTML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._runner = DirectMLOCRRunner(model_dir=model_dir, device_id=device_id)

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        paddleocr_version, paddleocr_error = _paddleocr_state()
        directml_available = "DmlExecutionProvider" in providers
        selected_device_id, device_error = _resolve_health_device_id(
            self.device_id,
            directml_available=directml_available,
            import_error=import_error,
        )
        selected_device = (
            directml_device_label(selected_device_id)
            if directml_available and device_error is None
            else None
        )
        missing_files = [
            name
            for name in PADDLEOCR37_REQUIRED_MODEL_FILES
            if not (self.model_dir / name).is_file()
        ]
        available = (
            import_error is None
            and paddleocr_error is None
            and directml_available
            and device_error is None
            and not missing_files
        )
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=available,
            detail=_runtime_detail(
                import_error,
                paddleocr_error,
                directml_available,
                missing_files,
                device_error,
            ),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=paddleocr_version or version,
            selected_device=selected_device,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=str(self.model_dir),
            fallback_reason=None,
            unavailable_reason=_runtime_unavailable_reason(
                import_error,
                paddleocr_error,
                directml_available,
                missing_files,
                device_error,
            ),
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = self._runner.extract_text(image_png)
        return OCRPageResult(
            text=result.text,
            extraction_method="directml_ocr",
            device=result.device,
            fallback_reason=result.fallback_reason,
            duration_ms=result.duration_ms,
        )


@dataclass(frozen=True)
class DirectMLOCRTextResult:
    text: str
    duration_ms: int
    box_count: int
    recognized_count: int
    device: str = "amd_directml"
    fallback_reason: str | None = None


class DirectMLOCRRunner:
    """PaddleOCR 3.7 ONNXRuntime runner pinned to the AMD DirectML iGPU lane."""

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_DIRECTML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._selected_device_id: int | None | object = _UNRESOLVED_DEVICE_ID
        self._paddleocr: Any | None = None

    def extract_text(self, image_png: bytes) -> DirectMLOCRTextResult:
        started = perf_counter()
        image_path = self._write_temp_png(image_png)
        try:
            results = self._paddleocr_pipeline().predict(str(image_path))
        finally:
            image_path.unlink(missing_ok=True)
        lines = _extract_paddleocr_texts(results)
        return DirectMLOCRTextResult(
            text="\n".join(lines),
            duration_ms=_elapsed_ms(started),
            box_count=_count_paddleocr_boxes(results),
            recognized_count=len(lines),
            device=self._device_label(),
            fallback_reason=None,
        )

    def _write_temp_png(self, image_png: bytes) -> Path:
        with tempfile.NamedTemporaryFile(prefix="exam-prep-directml-", suffix=".png", delete=False) as file:
            file.write(image_png)
            return Path(file.name)

    def _paddleocr_pipeline(self) -> Any:
        if self._paddleocr is None:
            PaddleOCR = _import_paddleocr()
            self._paddleocr = PaddleOCR(
                text_detection_model_name=PADDLEOCR37_DET_MODEL_NAME,
                text_detection_model_dir=str(self.model_dir / "det"),
                text_recognition_model_name=PADDLEOCR37_REC_MODEL_NAME,
                text_recognition_model_dir=str(self.model_dir / "rec"),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                engine="onnxruntime",
                engine_config=self._engine_config(),
            )
        return self._paddleocr

    def _engine_config(self) -> dict[str, Any]:
        return {
            "providers": ["DmlExecutionProvider", "CPUExecutionProvider"],
            "provider_options": [{"device_id": self._directml_device_id()}, {}],
            "enable_mem_pattern": False,
            "execution_mode": "sequential",
        }

    def _directml_device_id(self) -> int | None:
        if self._selected_device_id is _UNRESOLVED_DEVICE_ID:
            try:
                self._selected_device_id = resolve_directml_device_id(self.device_id)
            except DirectMLDeviceSelectionError as exc:
                raise ProviderUnavailableError(str(exc)) from exc
        return self._selected_device_id  # type: ignore[return-value]

    def _device_label(self) -> str:
        return directml_device_label(self._directml_device_id())


def _onnxruntime_state() -> tuple[list[str], str | None, Exception | None]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return [], None, exc
    try:
        providers = list(ort.get_available_providers())
    except Exception as exc:
        return [], getattr(ort, "__version__", None), exc
    return providers, getattr(ort, "__version__", None), None


def _paddleocr_state() -> tuple[str | None, Exception | None]:
    try:
        import paddleocr  # type: ignore[import-not-found]
    except Exception as exc:
        return None, exc
    return getattr(paddleocr, "__version__", None), None


def _import_paddleocr() -> Any:
    try:
        from paddleocr import PaddleOCR  # type: ignore[import-not-found]
    except Exception as exc:
        raise ProviderUnavailableError(f"PaddleOCR 3.7 runtime unavailable: {exc}") from exc
    return PaddleOCR


def _unavailable_reason(
    import_error: Exception | None,
    directml_available: bool,
) -> str:
    if import_error is not None:
        return "directml_runtime_missing"
    if not directml_available:
        return "directml_provider_unavailable"
    return "directml_ocr_not_ready"


def _detail(import_error: Exception | None, directml_available: bool) -> str:
    if import_error is not None:
        return f"AMD DirectML OCR runtime unavailable: {import_error}"
    if not directml_available:
        return "AMD DirectML OCR runtime is installed but DmlExecutionProvider is unavailable."
    return (
        "AMD DirectML OCR runtime is present, but production OCR is blocked until "
        "ONNX model artifacts, inference smoke, benchmark, and GPU routing checks pass."
    )


def _runtime_unavailable_reason(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    directml_available: bool,
    missing_files: list[str],
    device_error: Exception | None,
) -> str | None:
    if import_error is not None:
        return "directml_runtime_missing"
    if paddleocr_error is not None:
        return "paddleocr37_runtime_missing"
    if not directml_available:
        return "directml_provider_unavailable"
    if device_error is not None:
        return "directml_device_unavailable"
    if missing_files:
        return "directml_model_artifacts_missing"
    return None


def _runtime_detail(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    directml_available: bool,
    missing_files: list[str],
    device_error: Exception | None,
) -> str:
    if import_error is not None:
        return f"AMD DirectML OCR runtime unavailable: {import_error}"
    if paddleocr_error is not None:
        return f"PaddleOCR 3.7 runtime unavailable: {paddleocr_error}"
    if not directml_available:
        return "AMD DirectML OCR runtime is installed but DmlExecutionProvider is unavailable."
    if device_error is not None:
        return f"AMD DirectML OCR adapter selection failed: {device_error}"
    if missing_files:
        return f"AMD DirectML OCR model artifacts are missing: {', '.join(missing_files)}."
    return "AMD DirectML OCR runtime is ready with PaddleOCR 3.7, PP-OCRv6 medium, and AMD iGPU DirectML."


def _directml_providers(device_id: int | None) -> list[Any]:
    if device_id is not None and device_id < 0:
        device_id = resolve_directml_device_id(device_id)
    if device_id is None:
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    return [
        ("DmlExecutionProvider", {"device_id": str(device_id)}),
        "CPUExecutionProvider",
    ]


def _resolve_health_device_id(
    device_id: int | None,
    *,
    directml_available: bool,
    import_error: Exception | None,
) -> tuple[int | None, Exception | None]:
    if import_error is not None or not directml_available:
        return None, None
    try:
        return resolve_directml_device_id(device_id), None
    except DirectMLDeviceSelectionError as exc:
        return None, exc


def _paddleocr_payloads(results: Any) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    if results is None:
        return payloads
    sequence = results if isinstance(results, list | tuple) else [results]
    for result in sequence:
        data = getattr(result, "json", None)
        if not isinstance(data, dict):
            to_dict = getattr(result, "to_dict", None)
            data = to_dict() if callable(to_dict) else {}
        res = data.get("res", {}) if isinstance(data, dict) else {}
        if isinstance(res, dict):
            payloads.append(res)
    return payloads


def _extract_paddleocr_texts(results: Any) -> list[str]:
    texts: list[str] = []
    for payload in _paddleocr_payloads(results):
        rec_texts = payload.get("rec_texts", [])
        if isinstance(rec_texts, list):
            texts.extend(str(text) for text in rec_texts if str(text).strip())
    return texts


def _count_paddleocr_boxes(results: Any) -> int:
    count = 0
    for payload in _paddleocr_payloads(results):
        for key in ("dt_polys", "rec_boxes", "rec_polys"):
            boxes = payload.get(key)
            if isinstance(boxes, list):
                count += len(boxes)
                break
    return count


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
