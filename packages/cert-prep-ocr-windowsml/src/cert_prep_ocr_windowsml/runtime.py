from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import platform
import tempfile
from time import perf_counter
from typing import Any

from cert_prep_ocr_windowsml.contracts import OCRHealth, OCRPageResult
from cert_prep_ocr_windowsml.device import (
    AUTO_WINDOWSML_DEVICE_ID,
    WindowsMLDeviceSelectionError,
    windowsml_device_label,
    resolve_windowsml_device_id,
)
from cert_prep_ocr_windowsml.exceptions import ProviderUnavailableError


_UNRESOLVED_DEVICE_ID = object()
WINDOWSML_IGPU_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
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


class WindowsMLRuntimeOCRProvider:
    """Runnable WindowsML OCR provider used inside the packaged WindowsML runtime."""

    provider = "windowsml"
    engine = "paddleocr-3.7-onnxruntime-windowsml"
    page_workers = 1

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_WINDOWSML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._runner = WindowsMLOCRRunner(
            model_dir=model_dir,
            device_id=device_id,
        )

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        paddleocr_version, paddleocr_error = _paddleocr_state()
        windowsml_available = WINDOWSML_IGPU_PROVIDER in providers
        selected_device_id, device_error = _resolve_health_device_id(
            self.device_id,
            windowsml_available=windowsml_available,
            import_error=import_error,
        )
        selected_device = (
            windowsml_device_label(selected_device_id)
            if windowsml_available and device_error is None
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
            and windowsml_available
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
                windowsml_available,
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
                windowsml_available,
                missing_files,
                device_error,
            ),
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        result = self._runner.extract_text(image_png)
        return OCRPageResult(
            text=result.text,
            extraction_method="windowsml_ocr",
            device=result.device,
            fallback_reason=result.fallback_reason,
            duration_ms=result.duration_ms,
        )


@dataclass(frozen=True)
class WindowsMLOCRTextResult:
    text: str
    duration_ms: int
    box_count: int
    recognized_count: int
    device: str = "amd_windowsml"
    fallback_reason: str | None = None


class WindowsMLOCRRunner:
    """PaddleOCR 3.7 ONNXRuntime runner using the WindowsML execution lane."""

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_WINDOWSML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._selected_device_id: int | None | object = _UNRESOLVED_DEVICE_ID
        self._paddleocr: Any | None = None

    def extract_text(self, image_png: bytes) -> WindowsMLOCRTextResult:
        started = perf_counter()
        image_path = self._write_temp_png(image_png)
        try:
            results = self._paddleocr_pipeline().predict(str(image_path))
        finally:
            image_path.unlink(missing_ok=True)
        lines = _extract_paddleocr_texts(results)
        return WindowsMLOCRTextResult(
            text="\n".join(lines),
            duration_ms=_elapsed_ms(started),
            box_count=_count_paddleocr_boxes(results),
            recognized_count=len(lines),
            device=self._device_label(),
            fallback_reason=None,
        )

    def _write_temp_png(self, image_png: bytes) -> Path:
        with tempfile.NamedTemporaryFile(
            prefix="cert-prep-windowsml-",
            suffix=".png",
            delete=False,
        ) as file:
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
            "providers": [WINDOWSML_IGPU_PROVIDER, CPU_PROVIDER],
            "provider_options": [{"device_id": self._windowsml_device_id()}, {}],
            "enable_mem_pattern": False,
            "execution_mode": "sequential",
        }

    def _windowsml_device_id(self) -> int | None:
        if self._selected_device_id is _UNRESOLVED_DEVICE_ID:
            try:
                self._selected_device_id = resolve_windowsml_device_id(self.device_id)
            except WindowsMLDeviceSelectionError as exc:
                raise ProviderUnavailableError(str(exc)) from exc
        return self._selected_device_id  # type: ignore[return-value]

    def _device_label(self) -> str:
        return windowsml_device_label(self._windowsml_device_id())


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


def _runtime_unavailable_reason(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    windowsml_available: bool,
    missing_files: list[str],
    device_error: Exception | None,
) -> str | None:
    if import_error is not None:
        return "windowsml_runtime_missing"
    if paddleocr_error is not None:
        return "paddleocr37_runtime_missing"
    if not windowsml_available:
        return "windowsml_provider_unavailable"
    if device_error is not None:
        return "windowsml_device_unavailable"
    if missing_files:
        return "windowsml_model_artifacts_missing"
    return None


def _runtime_detail(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    windowsml_available: bool,
    missing_files: list[str],
    device_error: Exception | None,
) -> str:
    if import_error is not None:
        return f"WindowsML OCR runtime unavailable: {import_error}"
    if paddleocr_error is not None:
        return f"PaddleOCR 3.7 runtime unavailable: {paddleocr_error}"
    if not windowsml_available:
        return "WindowsML OCR runtime is installed but the iGPU provider is unavailable."
    if device_error is not None:
        return f"WindowsML OCR adapter selection failed: {device_error}"
    if missing_files:
        return f"WindowsML OCR model artifacts are missing: {', '.join(missing_files)}."
    return (
        "WindowsML OCR runtime is ready with PaddleOCR 3.7, PP-OCRv6 medium, "
        "WindowsML iGPU selection, and CPU fallback for unsupported operators."
    )


def _resolve_health_device_id(
    device_id: int | None,
    *,
    windowsml_available: bool,
    import_error: Exception | None,
) -> tuple[int | None, Exception | None]:
    if import_error is not None or not windowsml_available:
        return None, None
    try:
        return resolve_windowsml_device_id(device_id), None
    except WindowsMLDeviceSelectionError as exc:
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
